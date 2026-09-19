import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { window } from "@tauri-apps/api";
import { ConfigSettingTypes } from "../types";

export class MainWindow {
	constructor() {
		const webview = new WebviewWindow("mainWindow", {
			title: "本地试验台 - 我的战绩",
			url: "src/main/index.html",
			width: 1174,
			height: 668,
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
			width: 1254,
			height: 562,
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
			await existing.show();
			return;
		}

		if (!RecentMatchWindow.creating) {
			new RecentMatchWindow();
		}
	}
}
