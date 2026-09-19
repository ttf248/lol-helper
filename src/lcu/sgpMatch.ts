import { fetch } from "@tauri-apps/plugin-http";
import { sumInfoTypes } from "@/lcu/types/SummonerTypes";
import { SgpServers } from "@/resources/areaList";
import { GamesBySgp, Participant } from "./types/queryMatchSgpGameTypes";

export interface SgpRequestParams {
	playerPuuid: string;
	start: number;
	count: number;
	tag?: string | null;
}

// learn from https://github.com/LeagueAkari/LeagueAkari
export class SgpMatchHistoryService {
	private _cachedToken: string | null = null;
	private sgpBaseUrl: string | null = null;
	private readonly matchCache = new Map<number, GamesBySgp>();
	private readonly USER_AGENT = "LeagueClient/14.3.558.1234 (SGP)";
	private readonly TIMEOUT = 10000;

	/**
	 * @param _tokenProvider 一个异步函数，调用你提到的“其他接口”来获取最新的 Token
	 */
	constructor(private _tokenProvider: () => Promise<string | null>) {}

	/**
	 * SUMMARY 返回的是完整对局数据。保留最近请求过的对局，供详情页在
	 * LCU 无法反查外部召唤师对局时直接使用。
	 */
	getCachedMatch(gameId: number): GamesBySgp | null {
		return this.matchCache.get(gameId) ?? null;
	}

	private getBaseUrl() {
		let localSumInfo: sumInfoTypes | null;
		try {
			localSumInfo = JSON.parse(
				localStorage.getItem("sumInfo") || "null",
			) as sumInfoTypes | null;
		} catch {
			return null;
		}

		if (!localSumInfo) {
			return null;
		}

		const sgpServer = SgpServers[localSumInfo.newPlatformId];
		if (sgpServer === undefined) {
			return null;
		}
		return sgpServer.matchHistory;
	}

	private fetchJsonWithTimeout = async <T = unknown>(
		url: string,
		options: Parameters<typeof fetch>[1],
	): Promise<{ response: Response; body: string; data: T }> => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// SGP 的 SUMMARY 响应可能使用 chunked transfer。超时必须覆盖
			// 建立连接、读取完整 body 和 JSON 解析，并真正中止底层请求，
			// 避免多名玩家并发分析时积累已经失效的网络任务。
			timer = setTimeout(() => controller.abort(), this.TIMEOUT);
			const response = await fetch(url, {
				...options,
				signal: controller.signal,
			});
			const body = await response.text();
			return {
				response,
				body,
				data: JSON.parse(body) as T,
			};
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error(`SGP request timed out after ${this.TIMEOUT}ms`);
			}
			throw error;
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	};

	private isUnauthorizedError = (error: unknown): boolean =>
		error instanceof Error && error.message.includes("SGP_HTTP_ERROR_401");

	/**
	 * 公开的查询方法：具备自动重试机制
	 */
	async getMatchHistory(params: SgpRequestParams): Promise<GamesBySgp[]> {
		return this.requestMatchHistory(params, false);
	}

	/**
	 * 返回 SUMMARY 中的完整对局。普通历史列表只需要目标玩家，
	 * 但组队/开黑分析必须保留同局的全部 participants。
	 */
	async getFullMatchHistory(params: SgpRequestParams): Promise<GamesBySgp[]> {
		return this.requestMatchHistory(params, true);
	}

	private async requestMatchHistory(
		params: SgpRequestParams,
		fullParticipants: boolean,
	): Promise<GamesBySgp[]> {
		if (!this._cachedToken) {
			const token = await this._tokenProvider();
			if (!token) {
				throw new Error("Failed to fetch SGP entitlement token");
			}
			this._cachedToken = token;
		}

		try {
			return await this._doRequest(params, this._cachedToken, fullParticipants);
		} catch (error) {
			// 只有令牌过期才刷新重试；网络超时等错误应尽快交给界面处理。
			if (!this.isUnauthorizedError(error)) {
				throw error;
			}

			const refreshedToken = await this._tokenProvider();
			if (!refreshedToken) {
				throw new Error("Failed to refresh SGP entitlement token");
			}
			this._cachedToken = refreshedToken;
			return await this._doRequest(params, refreshedToken, fullParticipants);
		}
	}

	/**
	 * 内部底层请求逻辑
	 */
	private async _doRequest(
		params: SgpRequestParams,
		token: string,
		fullParticipants = false,
	): Promise<GamesBySgp[]> {
		if (this.sgpBaseUrl === null) {
			const baseUrl = this.getBaseUrl();
			if (!baseUrl) {
				throw new Error(`sgpBaseUrl is null`);
			}
			this.sgpBaseUrl = baseUrl;
		}

		const { playerPuuid, start, count, tag } = params;

		// 构建 URL
		const query = new URLSearchParams({
			startIndex: start.toString(),
			count: count.toString(),
		});
		if (tag) query.append("tag", tag);

		const baseUrl = this.sgpBaseUrl.endsWith("/")
			? this.sgpBaseUrl.slice(0, -1)
			: this.sgpBaseUrl;
		const url = `${baseUrl}/match-history-query/v1/products/lol/player/${playerPuuid}/SUMMARY?${query.toString()}`;

		const { response, body, data } = await this.fetchJsonWithTimeout<{
			games?: unknown;
		}>(url, {
			method: "GET",
			headers: {
				"User-Agent": this.USER_AGENT,
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				// 与 LeagueAkari 的 SGP 适配层保持一致：告知中间层收集
				// chunked 响应，并声明 entitlements token 类型。
				"x-akari-force-stream-collect": "true",
				"x-akari-token-type": "entitlements",
			},
			connectTimeout: this.TIMEOUT,
		});

		if (!response.ok) {
			// 如果状态码是 401，说明 Token 过期，此处抛出错误触发 catch 块中的重试
			throw new Error(`SGP_HTTP_ERROR_${response.status}: ${body.slice(0, 500)}`);
		}

		if (!Array.isArray(data?.games)) {
			throw new Error("SGP match history response has no games array");
		}

		const gamesList: GamesBySgp[] = data.games.reduce(
			(result: GamesBySgp[], item: any) => {
				const games = item?.json as GamesBySgp | undefined;
				if (
					!games ||
					typeof games.gameId !== "number" ||
					!Array.isArray(games.participants)
				) {
					return result;
				}

				// 不修改 SUMMARY 原对象，否则详情页只能拿到一个 participant。
				this.matchCache.set(games.gameId, games);
				const participant = games.participants.find(
					(participant: Participant) => participant.puuid === playerPuuid,
				);

				if (participant) {
					result.push(
						fullParticipants
							? games
							: { ...games, participants: [participant] },
					);
				}
				return result;
			},
			[],
		);

		return gamesList;
	}
}
