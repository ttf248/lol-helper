import "./utils/tray.ts";
import { GameFlow } from "./gameFlow.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MainWindow } from "./utils/creatWindow.ts";
import { TaskTracker } from "./utils/TaskTracker.ts";
import { configInit, getClientPath } from "@/background/utils/config.ts";

class Background {
	private gameFlow: GameFlow;
	private taskTracker: TaskTracker;

	constructor() {
		new MainWindow();
		configInit();
		this.gameFlow = new GameFlow();
		this.taskTracker = new TaskTracker();
		this.initializeListeners();
	}

	private initializeListeners() {
		invoke("listen_for_client_start").then(async () => {
			listen<string>("client_status", (event) =>
				this.handleClientStatus(event.payload),
			);
		});
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
					invoke("start_listener");
				}, 500);
			}

			elapsedTime += intervalTime;
			if (elapsedTime >= TIME_LIMIT) {
				clearInterval(lcuSuccess);
				console.log("超时，客户端未启动");
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
				this.gameFlow.initGameInWindow();
				break;
			case "PreEndOfGame":
				this.gameFlow.closeWin("recentMatchWindow");
				this.gameFlow.showHideMainWin(true, "EndOfGame");
				this.taskTracker.completeTask();
				break;
			case "Matchmaking":
				this.gameFlow.sendMesToMain("Matchmaking");
				break;
			case "ReadyCheck":
				this.gameFlow.writeGameInfo();
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

new Background();
