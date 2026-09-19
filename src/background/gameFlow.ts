import { window } from "@tauri-apps/api";
import { emitTo } from "@tauri-apps/api/event";
import { invokeLcu } from "@/lcu";
import { RecentMatchWindow } from "@/background/utils/creatWindow.ts";
import { invoke } from "@tauri-apps/api/core";
import { SessionTypes } from "@/recentMatch/utils/queryTypes";

export class GameFlow {
	public mapId = 11;
	public queueId = 420;

	// 给主窗口发生信息
	public sendMesToMain = (messageId: string, content: any = "") => {
		window.Window.getByLabel("mainWindow").then((win) => {
			if (win !== null) {
				emitTo("mainWindow", "clientStatus", {
					messageId: messageId,
					content: content,
				});
			}
		});
	};
	// 显示或者隐藏主窗口
	public showHideMainWin = (isShow: boolean, messageId: string) => {
		window.Window.getByLabel("mainWindow").then(async (win) => {
			if (win === null) {
				return;
			}
			isShow ? await win.show() : await win.hide();
			emitTo("mainWindow", "clientStatus", {
				messageId: messageId,
				content: "",
			});
		});
	};
	// 关闭某个窗口
	public closeWin = (winName: string) => {
		window.Window.getByLabel(winName).then(async (win) => {
			await win?.close();
		});
	};
	// 发送给主窗口游戏启动事件
	public sendStartEvent = async () => {
		window.Window.getByLabel("mainWindow").then((win) => {
			if (win !== null) {
				emitTo("mainWindow", "initHome");
			}
		});
	};
	// 选择英雄阶段结束后执行的操作
	public initGameInWindow = async () => {
		// 游戏启动时只保留统一的对局内历史分析面板。
		this.closeWin("recentMatchWindow");

		let count = 0;
		const unListenGameStart = setInterval(() => {
			invoke<boolean>("is_game_start").then((value) => {
				count++;
				if (count > 10) {
					clearInterval(unListenGameStart);
				}
				if (value) {
					clearInterval(unListenGameStart);

					if (this.mapId === 12 || this.mapId === 11) {
						const configSetting = JSON.parse(
							<string>localStorage.getItem("configSetting"),
						);
						if (configSetting.isGameInWindow) {
							new RecentMatchWindow();
						}
					}
				}
			});
		}, 2000);
	};
	// 写入游戏信息
	public writeGameInfo = async () => {
		const res = await invokeLcu<SessionTypes>(
			"get",
			"/lol-gameflow/v1/session",
		);
		if (res === null) return;
		// 获取对局ID和地图ID
		if (res.gameData !== undefined) {
			this.mapId = res.gameData.queue.mapId;
			this.queueId = res.gameData.queue.id;

			localStorage.setItem(
				"gameInfo",
				String(
					JSON.stringify({
						queueId: res.gameData.queue.id,
						mapId: res.gameData.queue.mapId,
					}),
				),
			);
		}
	};
}
