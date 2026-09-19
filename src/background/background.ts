import "./utils/tray.ts";
import { GameFlow } from "./gameFlow.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MainWindow } from "./utils/creatWindow.ts";
import { TaskTracker } from "./utils/TaskTracker.ts";
import { configInit, getClientPath } from "@/background/utils/config.ts";
import { installLogBridge } from "@/utils/logBridge";
import { installGlobalErrorHandlers, logger } from "@/utils/logger";

class Background {
	private gameFlow: GameFlow;
	private taskTracker: TaskTracker;

	constructor() {
		new MainWindow();
		configInit();
		this.gameFlow = new GameFlow();
		this.taskTracker = new TaskTracker();
		void this.initializeListeners();
	}

	private async initializeListeners() {
		// 先注册监听，再启动 Rust 侧客户端探测，避免客户端已经运行时丢失首个事件。
		await listen<string>("client_status", (event) =>
			this.handleClientStatus(event.payload),
		);
		await listen("recoverGameWindow", () => {
			void this.gameFlow.recoverGameInWindow();
		});

		try {
			await invoke("listen_for_client_start");
		} catch (error) {
			logger.error({
				tag: "background.listen_for_client_start",
				message: "启动客户端状态监听失败",
				context: { error: String(error).slice(0, 200) },
			});
		}
	}

	private initLocalTestLab() {
		const TIME_LIMIT = 30000;
		let elapsedTime = 0;
		const intervalTime = 3000;

		invoke("init_keyboard");
		const lcuSuccess = setInterval(async () => {
			const isGetPath = await getClientPath();
			if (isGetPath) {
				clearInterval(lcuSuccess);
				setTimeout(() => {
					this.gameFlow.sendStartEvent();
					void (async () => {
						try {
							await invoke("start_listener");
						} finally {
							// WebSocket 不会补发当前阶段，启动监听后主动恢复一次。
							void this.gameFlow.recoverGameInWindow();
						}
					})();
				}, 500);
			}

			elapsedTime += intervalTime;
			if (elapsedTime >= TIME_LIMIT) {
				clearInterval(lcuSuccess);
				logger.warn({
					tag: "background.client_probe_timeout",
					message: "超时，客户端未启动",
					context: { elapsed_ms: elapsedTime, time_limit_ms: TIME_LIMIT },
				});
			}
		}, intervalTime);
	}

	private handleClientStatus(status: string) {
		switch (status) {
			case "ClientStarted":
				this.initLocalTestLab();
				break;
			case "GameStart":
				this.gameFlow.showHideMainWin(false, "GameStart");
				void this.gameFlow.initGameInWindow();
				break;
			case "PreEndOfGame":
				void this.gameFlow.closeWin("recentMatchWindow");
				this.gameFlow.showHideMainWin(true, "EndOfGame");
				this.taskTracker.completeTask();
				break;
			case "Matchmaking":
				this.gameFlow.sendMesToMain("Matchmaking");
				break;
			case "ReadyCheck":
				void this.gameFlow.writeGameInfo();
				break;
			case "Lobby":
				this.gameFlow.sendMesToMain("Lobby");
				break;
			case "None":
				this.gameFlow.sendMesToMain("None");
				break;
		}
	}

}

// background 窗口是唯一的日志聚合点。先完成监听注册，再创建其它窗口和
// 启动业务，避免首批前端日志在桥接器尚未就绪时丢失。
const bootstrap = async () => {
  try {
    await installLogBridge();
  } catch {
    // 日志桥是可选能力，不能因为事件监听失败而阻止主业务启动。
  }
  installGlobalErrorHandlers();
  new Background();
};

void bootstrap();
