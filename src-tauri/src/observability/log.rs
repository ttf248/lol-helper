//! 日志格式化层：把 `tracing` 事件渲染成「人类可读的中文短句」单行/多行文本。
//!
//! 设计：
//! 1. 单行格式：`[HH:mm:ss.SSS] [LEVEL] [tag] 中文消息 | k=v k=v ... | 耗时 Xms`
//! 2. body 类多行日志走 `↳ body:` + 4 空格缩进附加块
//! 3. 顶层 `duration_ms` 单一权威，不再同时出现在 context
//! 4. 本地时区毫秒精度，文件 sink 不带 ANSI 颜色
//!
//! 文件名后缀、滚动策略由 `sink.rs` 单独维护。

use std::sync::Arc;

use chrono::{Local, Timelike};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::observability::sink::FileSink;

static FILE_SINK: OnceCell<Arc<FileSink>> = OnceCell::new();

/// 写入一条外部传入的日志（来自前端 WebView）。
/// `entry` 仍然按 camelCase 的 `LogEntry` 形式传输，但内部走文本格式化器，
/// 保证前后端日志同格式。
#[tauri::command]
pub fn write_frontend_log(entry: LogEntry) -> Result<(), String> {
    if let Some(sink) = FILE_SINK.get() {
        sink.append(format_frontend_entry(&entry));
        Ok(())
    } else {
        Err("日志系统尚未初始化".into())
    }
}

/// 启动 tracing subscriber，把所有事件转为单行/多行文本写入文件 sink。
/// 默认关闭 stdout/stderr 输出；可通过 `RUST_LOG` 调整等级。
pub fn init_logger() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        // 默认关闭 tokio-postgres 自身的 NOTICE（由 `log` 桥到 tracing，
        // 在 info 级全部是英文 "relation X already exists, skipping"），
        // 同时压制 ingame 事件流。db.cache 显式声明便于后续调整。
        EnvFilter::new(
            "info,tokio_postgres::connection=warn,ingame.events=warn,observability=info,db.cache=info",
        )
    });

    let sink = FileSink::start();
    let _ = FILE_SINK.set(sink.clone());

    let text_layer = TextLayer::new(sink);

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(text_layer)
        .try_init();
}

/// 兼容旧契约的 `LogEntry`，前端继续按 `emit("log://entry", entry)` 发送。
/// 字段全部 camelCase；后端不会再 `serde_json::to_string`，而是直接走文本格式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub tag: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// 响应体原文（不走 mask.ts）。开发环境让 body / Authorization /
    /// puuid 等完整值落盘，便于 grep 分析业务流程。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_body: Option<String>,
}

// ---------- TextLayer ----------

pub struct TextLayer {
    sink: Arc<FileSink>,
}

impl TextLayer {
    pub fn new(sink: Arc<FileSink>) -> Self {
        Self { sink }
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: Map<String, Value>,
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let s = format!("{:?}", value);
        self.insert(field.name(), s);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(field.name(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), Value::Number(value.into()));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), Value::Number(value.into()));
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.fields
            .insert(field.name().to_string(), Value::String(value.to_string()));
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.fields
            .insert(field.name().to_string(), Value::String(value.to_string()));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), Value::Bool(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        if let Some(num) = serde_json::Number::from_f64(value) {
            self.fields
                .insert(field.name().to_string(), Value::Number(num));
        }
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.fields.insert(
            field.name().to_string(),
            Value::String(value.to_string()),
        );
    }
}

impl FieldVisitor {
    fn insert(&mut self, name: &str, value: String) {
        if name == "message" {
            self.message = Some(value);
        } else {
            self.fields.insert(name.to_string(), Value::String(value));
        }
    }
}

struct SpanFields(Value);

impl<S> tracing_subscriber::Layer<S> for TextLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let span = ctx.span(id).expect("span must exist");
        let mut visitor = FieldVisitor::default();
        attrs.record(&mut visitor);
        let mut fields = visitor.fields;
        if let Some(message) = visitor.message {
            fields.insert("message".to_string(), Value::String(message));
        }
        let mut ext = span.extensions_mut();
        ext.insert(SpanFields(Value::Object(fields)));
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        let span = ctx.span(id).expect("span must exist");
        let mut ext = span.extensions_mut();
        if let Some(span_fields) = ext.get_mut::<SpanFields>() {
            if let Value::Object(map) = &mut span_fields.0 {
                let mut visitor = FieldVisitor::default();
                values.record(&mut visitor);
                for (k, v) in visitor.fields {
                    map.insert(k, v);
                }
                if let Some(m) = visitor.message {
                    map.insert("message".to_string(), Value::String(m));
                }
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let level = event.metadata().level();
        let tag = event.metadata().target();
        let message = visitor.message.take().unwrap_or_default();
        let mut fields = visitor.fields;

        // 抽出顶层 duration_ms 并从 context 中删除（消除三处重复）
        let duration_ms = extract_and_remove_duration(&mut fields);

        // 仅取最近一层 span 名字
        let span_name = ctx
            .event_scope(event)
            .and_then(|scope| scope.last())
            .map(|span| span.metadata().name().to_string());

        let line = format_log_line(level, tag, &message, span_name.as_deref(), &fields, duration_ms);
        self.sink.append(line);
    }
}

fn extract_and_remove_duration(fields: &mut Map<String, Value>) -> Option<u64> {
    let value = fields.remove("duration_ms")?;
    match value {
        Value::Number(n) => n.as_u64().or_else(|| n.as_i64().map(|v| v as u64)),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    }
}

// ---------- 格式化 ----------

/// 单行日志格式：`[HH:mm:ss.SSS] [LEVEL] [tag] 中文消息 | k=v k=v ... | 耗时 Xms`
pub fn format_log_line(
    level: &Level,
    tag: &str,
    message: &str,
    span: Option<&str>,
    fields: &Map<String, Value>,
    duration_ms: Option<u64>,
) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(span) = span {
        parts.push(format!("span={}", quote_if_needed(span)));
    }

    // 字段顺序：保留插入顺序（Map 已保证），删掉无意义 key
    for (k, v) in fields.iter() {
        if k == "message" || k == "duration_ms" {
            continue;
        }
        parts.push(format!("{}={}", k, render_value(v)));
    }

    let field_str = if parts.is_empty() {
        String::new()
    } else {
        format!(" | {}", parts.join(" "))
    };

    let dur_str = match duration_ms {
        Some(ms) => format!(" | 耗时 {}ms", ms),
        None => String::new(),
    };

    format!(
        "[{}] [{:>4}] [{}] {}{}{}",
        now_hms_ms(),
        level.to_string().to_uppercase(),
        tag,
        message,
        field_str,
        dur_str,
    )
}

/// 前端日志格式：与后端保持完全相同的单行格式，但保留 window/source 字段。
pub fn format_frontend_entry(entry: &LogEntry) -> String {
    let mut fields = match &entry.context {
        Some(Value::Object(map)) => map.clone(),
        Some(other) => {
            // 兼容前端把 context 传成非对象的情况
            let mut m = Map::new();
            m.insert("context".to_string(), other.clone());
            m
        }
        None => Map::new(),
    };

    if let Some(window) = &entry.window {
        fields
            .entry("window".to_string())
            .or_insert(Value::String(window.clone()));
    }
    fields
        .entry("source".to_string())
        .or_insert(Value::String(entry.source.clone()));

    let duration_ms = fields
        .remove("duration_ms")
        .and_then(|v| match v {
            Value::Number(n) => n.as_u64().or_else(|| n.as_i64().map(|i| i as u64)),
            Value::String(s) => s.parse::<u64>().ok(),
            _ => None,
        })
        .or(entry.duration_ms);

    // 前端 level 是字符串，重建为 Level 不必要；直接展示。
    let mut line = format_log_line_by_str(
        &entry.level,
        &entry.tag,
        &entry.message,
        None,
        &fields,
        duration_ms,
    );
    if let Some(raw_body) = &entry.raw_body {
        if !raw_body.is_empty() {
            line.push_str("\n    ↳ raw_body:\n");
            for raw_line in raw_body.split('\n') {
                line.push_str("      ");
                line.push_str(raw_line);
                line.push('\n');
            }
        }
    }
    line
}

fn format_log_line_by_str(
    level_str: &str,
    tag: &str,
    message: &str,
    span: Option<&str>,
    fields: &Map<String, Value>,
    duration_ms: Option<u64>,
) -> String {
    let level_upper = level_str.to_uppercase();
    let mut parts: Vec<String> = Vec::new();
    if let Some(span) = span {
        parts.push(format!("span={}", quote_if_needed(span)));
    }
    for (k, v) in fields.iter() {
        if k == "message" || k == "duration_ms" {
            continue;
        }
        parts.push(format!("{}={}", k, render_value(v)));
    }
    let field_str = if parts.is_empty() {
        String::new()
    } else {
        format!(" | {}", parts.join(" "))
    };
    let dur_str = match duration_ms {
        Some(ms) => format!(" | 耗时 {}ms", ms),
        None => String::new(),
    };
    format!(
        "[{}] [{:>4}] [{}] {}{}{}",
        now_hms_ms(),
        level_upper,
        tag,
        message,
        field_str,
        dur_str,
    )
}

fn render_value(v: &Value) -> String {
    match v {
        Value::String(s) => quote_if_needed(s),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        _ => quote_if_needed(&v.to_string()),
    }
}

fn quote_if_needed(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s.chars().any(|c| {
            c.is_whitespace() || c == '"' || c == '|' || c == '[' || c == ']' || c < ' '
        });
    if needs_quote {
        let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{}\"", escaped)
    } else {
        s.to_string()
    }
}

// ---------- 时间 ----------

/// 本地时区毫秒精度时间戳：`HH:mm:ss.SSS`。
pub fn now_hms_ms() -> String {
    let now = Local::now();
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        now.hour(),
        now.minute(),
        now.second(),
        now.timestamp_subsec_millis()
    )
}