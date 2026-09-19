// background 窗口日志聚合桥：
// 监听所有窗口 emit 出来的 `log://entry`，统一调用 `write_frontend_log`
// 命令让 Rust 端走 NDJSON 文件落地。
//
// 仅 background 窗口调用 `installLogBridge()` 即可；其它窗口只需要 emit，
// Tauri 的事件广播机制会自动投到 background。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LogEntry } from "./logger";

let installed = false;

/**
 * 安装日志聚合桥。
 * 仅 background 窗口调用，其它窗口通过 emit("log://entry") 投递。
 * 多次调用幂等。
 */
export async function installLogBridge(): Promise<void> {
  if (installed) return;

  await listen<LogEntry>("log://entry", (event) => {
    const entry = event.payload;
    // 加 window label 标识，方便日志里区分来源窗口。
    void invoke("write_frontend_log", { entry }).catch(() => {
      // 静默：失败最常见的原因是 Rust 端尚未初始化；不向 console 抛错。
    });
  });
  installed = true;
}
