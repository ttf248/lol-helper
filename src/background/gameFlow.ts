import { window } from "@tauri-apps/api";
import { emitTo } from "@tauri-apps/api/event";
import { invokeLcu } from "@/lcu";
import { RecentMatchWindow } from "@/background/utils/creatWindow.ts";
import { invoke } from "@tauri-apps/api/core";
import { SessionTypes } from "@/recentMatch/utils/queryTypes";

const ACTIVE_GAME_PHASES = new Set(["GameStart", "InProgress"]);
const GAME_START_POLL_INTERVAL = 2000;
const GAME_START_POLL_LIMIT = 10;

const wait = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class GameFlow {
	public mapId = 11;
	public queueId = 420;
	private gameWindowTask: Promise<boolean> | null = null;

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
	public closeWin = async (winName: string) => {
		const win = await window.Window.getByLabel(winName);
		await win?.close();
	};

	// 发送给主窗口游戏启动事件
	public sendStartEvent = async () => {
		window.Window.getByLabel("mainWindow").then((win) => {
			if (win !== null) {
				emitTo("mainWindow", "initHome");
			}
		});
	};

	private isGameInWindowEnabled = () => {
		try {
			const rawSetting = localStorage.getItem("configSetting");
			if (!rawSetting) return true;
			const configSetting = JSON.parse(rawSetting);
			return configSetting?.isGameInWindow !== false;
		} catch (error) {
			console.warn("读取对局内窗口配置失败，暂不打开窗口", error);
			return false;
		}
	};

	private waitForGameStart = async () => {
		for (let count = 0; count <= GAME_START_POLL_LIMIT; count += 1) {
			const isGameStarted = await invoke<boolean>("is_game_start").catch(
				() => false,
			);
			if (isGameStarted) return true;
			if (count < GAME_START_POLL_LIMIT) {
				await wait(GAME_START_POLL_INTERVAL);
			}
		}
		return false;
	};

	private openGameWindow = async (
		closeExistingWindow: boolean,
		requireActivePhase: boolean,
	) => {
		if (closeExistingWindow) {
			// 游戏启动时只保留统一的对局内历史分析面板。
			await this.closeWin("recentMatchWindow");
		}

		if (!this.isGameInWindowEnabled()) return false;

		const initialSession = await this.writeGameInfo();
		if (
			requireActivePhase &&
			initialSession?.phase &&
			!ACTIVE_GAME_PHASES.has(initialSession.phase)
		) {
			return false;
		}

		if (!(await this.waitForGameStart())) return false;

		// 启动较晚时，第一次 session 请求可能正好处于切换阶段，打开前再取一次，
		// 同时确保恢复场景不会使用默认地图误判模式。
		const latestSession = await this.writeGameInfo();
		const session = latestSession ?? initialSession;
		if (
			requireActivePhase &&
			session?.phase &&
			!ACTIVE_GAME_PHASES.has(session.phase)
		) {
			return false;
		}
		if (requireActivePhase && !session?.gameData?.queue) return false;

		if (this.mapId !== 12 && this.mapId !== 11) return false;
		await RecentMatchWindow.ensure();
		return true;
	};

	private ensureGameWindow = (
		closeExistingWindow: boolean,
		requireActivePhase: boolean,
	): Promise<boolean> => {
		if (this.gameWindowTask) return this.gameWindowTask;

		const task = this.openGameWindow(
			closeExistingWindow,
			requireActivePhase,
		)
			.catch((error) => {
				console.warn("初始化对局内战绩窗口失败", error);
				return false;
			})
			.finally(() => {
				this.gameWindowTask = null;
			});
		this.gameWindowTask = task;
		return task;
	};

	// 选择英雄阶段结束后执行的操作。
	public initGameInWindow = () =>
		this.ensureGameWindow(true, false);

	// 软件晚于 GameStart 启动、单实例唤醒或 Shift+Tab 找不到窗口时，
	// 通过当前 LCU session 和游戏端口恢复对局内面板。
	public recoverGameInWindow = async () => {
		const opened = await this.ensureGameWindow(false, true);
		if (opened) this.showHideMainWin(false, "GameStart");
		return opened;
	};

	// 写入游戏信息
	public writeGameInfo = async (): Promise<SessionTypes | null> => {
		const res = await invokeLcu<SessionTypes>(
			"get",
			"/lol-gameflow/v1/session",
		);
		if (res === null) return null;

		// 获取对局ID和地图ID
		if (res.gameData?.queue !== undefined) {
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
		return res;
	};
}
