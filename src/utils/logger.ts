// 前端统一 logger。
// 设计原则：
// 1) 不输出到 console——所有日志走 `emit("log://entry", entry)` 转到 Rust 落地文件。
// 2) 日志内容保留完整上下文，便于本地排查问题。
// 3) 通过默认导入得到的是「聚合桥已经装上」的 logger；模块加载即自动安装。
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  tag: string;
  message: string;
  context?: unknown;
  source: "backend" | "frontend";
  durationMs?: number;
  window?: string;
}

export interface LogOptions {
  tag: string;
  message?: string;
  context?: unknown;
  durationMs?: number;
}

const DEFAULT_LEVEL: LogLevel = "info";

function nowIso(): string {
  return new Date().toISOString();
}

function currentWindow(): string | undefined {
  try {
    return getCurrentWindow().label;
  } catch {
    return undefined;
  }
}

let installed = false;
let levelFilter: LogLevel = DEFAULT_LEVEL;

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/**
 * 设定当前进程允许输出的最低级别。`trace`/`debug` 噪音较大，
 * 默认 info；可通过 `setLogLevel("debug")` 临时打开。
 */
export function setLogLevel(level: LogLevel): void {
  levelFilter = level;
}

/**
 * 内部：构造 entry 并发送给 Rust 端。若 emit 失败（例如 background 未挂），
 * 不再退回 console——前端唯一的日志目的地就是文件。
 */
function emitEntry(entry: LogEntry): void {
  // 注意：emit 是异步的，但 sync 调用不会阻塞 UI。我们用 fire-and-forget。
  void emit("log://entry", entry).catch(() => {
    // 静默：背景窗口未挂载时其它窗口无法落盘，由 background 桥补
  });
}

function build(level: LogLevel, opts: LogOptions): LogEntry | null {
  if (LEVEL_RANK[level] < LEVEL_RANK[levelFilter]) return null;
  return {
    ts: nowIso(),
    level,
    tag: opts.tag,
    message: opts.message ?? "",
    context: opts.context,
    source: "frontend",
    durationMs: opts.durationMs,
    window: currentWindow(),
  };
}

function log(level: LogLevel, opts: LogOptions | string, context?: unknown): void {
  const normalized: LogOptions =
    typeof opts === "string"
      ? { tag: "app", message: opts, context }
      : opts;
  const entry = build(level, normalized);
  if (!entry) return;
  emitEntry(entry);
}

export const logger = {
  trace(opts: LogOptions | string, context?: unknown) {
    log("trace", opts, context);
  },
  debug(opts: LogOptions | string, context?: unknown) {
    log("debug", opts, context);
  },
  info(opts: LogOptions | string, context?: unknown) {
    log("info", opts, context);
  },
  warn(opts: LogOptions | string, context?: unknown) {
    log("warn", opts, context);
  },
  error(opts: LogOptions | string, context?: unknown) {
    log("error", opts, context);
  },
  /** 标记 logger 已就绪，防止重复挂全局钩子。 */
  isInstalled(): boolean {
    return installed;
  },
};

/**
 * 装上全局错误兜底：Vue 渲染错、window.onerror、unhandledrejection。
 * 在每个窗口的 main.ts 入口处调用一次；多次调用幂等。
 */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;

  // Vue error handler 由调用方在 createApp 时单独挂（logger.error）
  window.addEventListener("error", (e) => {
    log("error", {
      tag: "window.error",
      message: e.message,
      context: {
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        stack: e.error instanceof Error ? e.error.stack : undefined,
      },
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason =
      e.reason instanceof Error
        ? { message: e.reason.message, stack: e.reason.stack }
        : e.reason;
    log("error", {
      tag: "unhandled.promise",
      message: "未捕获的 Promise 拒绝",
      context: { reason },
    });
  });
}
