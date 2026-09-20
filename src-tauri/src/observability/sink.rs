//! 异步文件 sink：单写线程 + 文本追加 + 7 天滚动保留。
//!
//! 所有写入走 `tokio::sync::mpsc` 通道，由后台任务串行化，避免在
//! `tracing` 调用点阻塞业务线程。
//!
//! 文件名：`app-YYYY-MM-DD.log`，单日滚动到 `.1.log`，按 50 MB 切分。

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

/// 日志目录名（位于 exe 父目录下）。
const LOG_DIR_NAME: &str = "log";

/// 单文件名前缀。
const FILE_PREFIX: &str = "app";

/// 保留天数。
const RETENTION_DAYS: i64 = 7;

/// 文件最大尺寸（默认 50MB），超出后滚动到 `.1.log`。
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// 单条日志写入字节上限（UTF-8 字节），超过则截断并追加丢弃提示。
/// 开发环境允许完整响应体落盘，把上限提到 64KB；个别极端请求
/// （如完整全量历史接口）会超出此值，仍会被截断但不会丢结构。
const MAX_LINE_BYTES: usize = 64 * 1024;

/// 当前写入的文件句柄（被写线程独占）。
/// `file` 为 `None` 时表示日志目录不可写，进入静默兜底模式。
struct CurrentWriter {
    file: Option<BufWriter<File>>,
    bytes_written: u64,
    opened_for_date: String,
}

pub struct FileSink {
    tx: mpsc::UnboundedSender<String>,
}

impl FileSink {
    /// 启动后台写线程并返回 sink 句柄。日志目录创建失败时返回哑 sink（不写盘）。
    pub fn start() -> Arc<Self> {
        let log_dir = match resolve_log_dir() {
            Some(dir) => {
                // 启动时清理超期文件，避免磁盘膨胀。
                cleanup_old_files(&dir);
                dir
            }
            None => {
                // exe 父目录不可写且 LOCALAPPDATA 不存在：
                // 进入静默兜底模式，不向控制台写任何东西。
                return Arc::new(Self {
                    tx: dead_sender(),
                });
            }
        };

        let initial = open_writer_for_today(&log_dir);
        let writer = Arc::new(Mutex::new(initial));

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let writer_for_task = writer.clone();
        let log_dir_for_task = log_dir.clone();
        tokio::spawn(async move {
            // 每 60 秒检查一次日期切换。
            let mut ticker = tokio::time::interval(Duration::from_secs(60));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    Some(line) = rx.recv() => {
                        let mut guard = match writer_for_task.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        ensure_writer_for_today(&log_dir_for_task, &mut guard);
                        let sanitized = sanitize_for_single_line(&line);
                        let line_len = sanitized.len() as u64 + 1;
                        let write_ok = match guard.file.as_mut() {
                            Some(file) => {
                                let ok = writeln!(file, "{}", sanitized).is_ok();
                                if ok {
                                    let _ = file.flush();
                                }
                                ok
                            }
                            None => false,
                        };
                        if write_ok {
                            guard.bytes_written += line_len;
                        }
                        let needs_rotate = guard.bytes_written >= MAX_FILE_BYTES;
                        let date_for_rotate = guard.opened_for_date.clone();
                        if needs_rotate {
                            // Windows 不允许重命名仍被打开的文件；先释放 BufWriter
                            // 再执行滚动。
                            guard.file.take();
                            rotate_file(&log_dir_for_task, &date_for_rotate);
                            *guard = open_writer_for_today(&log_dir_for_task);
                        }
                    }
                    _ = ticker.tick() => {
                        let mut guard = match writer_for_task.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        ensure_writer_for_today(&log_dir_for_task, &mut guard);
                    }
                    else => break,
                }
            }
        });

        Arc::new(Self { tx })
    }

    /// 非阻塞追加一行文本日志。内部会做单行转义与 4KB 截断兜底。
    pub fn append(&self, line: String) {
        let _ = self.tx.send(line);
    }
}

/// 把多行内容压成单行：替换换行为 `\n`/`\r`，控制字符替换为空。
/// 超过 `MAX_LINE_BYTES` 字节则截断并在末尾追加丢弃提示。
fn sanitize_for_single_line(input: &str) -> String {
    // 快速路径：长度已经在上限内且没有特殊字符
    if input.len() <= MAX_LINE_BYTES
        && !input.contains(['\n', '\r', '\0'])
    {
        return input.to_string();
    }

    let mut out = String::with_capacity(input.len().min(MAX_LINE_BYTES + 64));
    for ch in input.chars() {
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\0' => out.push_str("\\0"),
            c if (c as u32) < 0x20 => {
                // 其它控制字符丢弃
            }
            c => out.push(c),
        }
    }

    if out.len() > MAX_LINE_BYTES {
        // 在 UTF-8 字符边界上截断，避免截到半个字符产生乱码。
        let mut cut = MAX_LINE_BYTES;
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        let dropped = out.len() - cut;
        out.truncate(cut);
        out.push_str(&format!("…(剩余 {} 字节已丢弃)", dropped));
    }

    out
}

fn dead_sender() -> mpsc::UnboundedSender<String> {
    let (tx, _rx) = mpsc::unbounded_channel::<String>();
    tx
}

/// 解析日志目录：优先 `<exe 父目录>/log`，其次 `%LOCALAPPDATA%/local-test-lab/log`。
/// 任何一步创建失败都向下一个候选降级；全部失败则返回 None，由调用方走静默兜底。
fn resolve_log_dir() -> Option<PathBuf> {
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(LOG_DIR_NAME);
            if directory_writable(parent)
                && fs::create_dir_all(&candidate).is_ok()
                && directory_writable(&candidate)
            {
                return Some(candidate);
            }
        }
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local)
            .join("local-test-lab")
            .join(LOG_DIR_NAME);
        if fs::create_dir_all(&candidate).is_ok() && directory_writable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn directory_writable(directory: &Path) -> bool {
    if !directory.exists() {
        return fs::create_dir_all(directory).is_ok();
    }
    // 目录存在则探测：在目录下创建临时文件。
    let probe = directory.join(".lcu-log-probe");
    let ok = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe)
        .map(|_| true)
        .unwrap_or(false);
    let _ = fs::remove_file(&probe);
    ok
}

fn today_string() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    unix_secs_to_date(secs)
}

/// 把 unix 秒转为 `YYYY-MM-DD`（UTC）。
fn unix_secs_to_date(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let (y, m, d) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn days_to_ymd(days_since_epoch: i64) -> (i64, u32, u32) {
    // 1970-01-01 为基准。
    let mut year = 1970i64;
    let mut remaining = days_since_epoch;
    loop {
        let leap = is_leap(year);
        let year_days = if leap { 366 } else { 365 };
        if remaining < year_days {
            break;
        }
        remaining -= year_days;
        year += 1;
    }
    let leap = is_leap(year);
    let month_days = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 1u32;
    for &md in &month_days {
        if remaining < md {
            return (year, month, (remaining as u32) + 1);
        }
        remaining -= md;
        month += 1;
    }
    (year, 12, 31)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn open_writer_for_today(log_dir: &Path) -> CurrentWriter {
    let date = today_string();
    let path = log_dir.join(format!("{}-{}.log", FILE_PREFIX, date));
    match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map(BufWriter::new)
    {
        Ok(file) => {
            let bytes = file
                .get_ref()
                .metadata()
                .map(|m| m.len())
                .unwrap_or(0);
            CurrentWriter {
                file: Some(file),
                bytes_written: bytes,
                opened_for_date: date,
            }
        }
        Err(error) => {
            tracing::error!(
                target = "observability",
                path = %path.display(),
                error = %error,
                "log file open failed, dropping log line"
            );
            // 文件打开失败时进入静默兜底模式：不阻塞业务，也不输出到 stdout
            // （用户明确要求所有日志只落地文件，不走控制台）。
            CurrentWriter {
                file: None,
                bytes_written: 0,
                opened_for_date: date,
            }
        }
    }
}

fn ensure_writer_for_today(log_dir: &Path, writer: &mut CurrentWriter) {
    let today = today_string();
    if writer.opened_for_date != today {
        *writer = open_writer_for_today(log_dir);
    }
}

fn rotate_file(log_dir: &Path, date: &str) {
    let current = log_dir.join(format!("{}-{}.log", FILE_PREFIX, date));
    let rotated = log_dir.join(format!("{}-{}.1.log", FILE_PREFIX, date));
    if current.exists() {
        // 只保留一个同日滚动文件；先删除旧的 .1，避免 Windows rename 因目标
        // 已存在而失败。
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(&current, &rotated);
    }
}

fn cleanup_old_files(log_dir: &Path) {
    let cutoff_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        - RETENTION_DAYS * 86_400;
    let Ok(entries) = fs::read_dir(log_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(FILE_PREFIX) || !name.ends_with(".log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let modified_secs = modified
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if modified_secs < cutoff_secs {
            let _ = fs::remove_file(&path);
        }
    }
}
