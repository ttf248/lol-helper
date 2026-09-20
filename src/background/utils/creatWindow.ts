import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { window } from "@tauri-apps/api";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { ConfigSettingTypes } from "../types";

const MAIN_WINDOW_SIZE = { width: 1174, height: 760 };
// 对局内面板需要同时容纳双方各 5 名玩家；固定窗口过窄时，
// 玩家卡片会被压缩，历史战绩也无法保持同一条基线。
const RECENT_MATCH_WINDOW_SIZE = { width: 1440, height: 820 };

export class MainWindow {
	constructor() {
		const webview = new WebviewWindow("mainWindow", {
			title: "本地试验台 - 我的战绩",
			url: "src/main/index.html",
			...MAIN_WINDOW_SIZE,
			visible: false,
			resizable: false,
			decorations: false,
			center: true,
			transparent: true,
		});
		webview.once("tauri://created", async function () {
			webview.show();
			const isTracker: ConfigSettingTypes = JSON.parse(
				localStorage.getItem("configSetting") as string,
			);

			const enabled = isTracker.lolTracker > 0;
			const side = isTracker.lolTracker === 1 ? "Left" : "Right";
			// 1. 同步配置到后端状态
			await invoke("sync_tracker_config", { enabled, side });

			// 2. 尝试启动循环（内部有锁，不怕多次执行）
			await invoke("start_tracking_loop");
		});
	}
}

export class RecentMatchWindow {
	private static creating = false;

	constructor() {
		if (RecentMatchWindow.creating) return;
		RecentMatchWindow.creating = true;

		const webview = new WebviewWindow("recentMatchWindow", {
			title: "对局详情",
			url: "src/recentMatch/index.html",
			...RECENT_MATCH_WINDOW_SIZE,
			resizable: false,
			decorations: false,
			center: true,
			visible: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			transparent: true,
		});
		webview.once("tauri://created", async function () {
			try {
				await webview.show();
			} finally {
				RecentMatchWindow.creating = false;
			}
		});
		webview.once("tauri://error", () => {
			RecentMatchWindow.creating = false;
		});
	}

	public static async ensure() {
		const existing = await window.Window.getByLabel("recentMatchWindow");
		if (existing !== null) {
			// 旧版本窗口可能仍然存在于本次进程中，打开时同步到新的纵向布局。
			await existing.setSize(
				new LogicalSize(
					RECENT_MATCH_WINDOW_SIZE.width,
					RECENT_MATCH_WINDOW_SIZE.height,
				),
			);
			await existing.show();
			return;
		}

		if (!RecentMatchWindow.creating) {
			new RecentMatchWindow();
		}
	}
}
