import { fetch } from "@tauri-apps/plugin-http";
import { sumInfoTypes } from "@/lcu/types/SummonerTypes";
import { SgpServers } from "@/resources/areaList";
import { GamesBySgp, Participant } from "./types/queryMatchSgpGameTypes";
import { logger } from "@/utils/logger";

export interface SgpRequestParams {
	playerPuuid: string;
	start: number;
	count: number;
	tag?: string | null;
}

// learn from https://github.com/LeagueAkari/LeagueAkari
export class SgpMatchHistoryService {
	private _cachedToken: string | null = null;
	private _tokenRequest: Promise<string | null> | null = null;
	private sgpBaseUrl: string | null = null;
	private readonly matchCache = new Map<number, GamesBySgp>();
	private readonly USER_AGENT = "LeagueClient/14.3.558.1234 (SGP)";
	private readonly TIMEOUT = 5000;

	/**
	 * @param _tokenProvider 一个异步函数，调用你提到的“其他接口”来获取最新的 Token
	 */
	constructor(private _tokenProvider: () => Promise<string | null>) {}

	private getToken = async (): Promise<string | null> => {
		if (this._cachedToken) {
			logger.debug({
				tag: "lcu.sgp",
				message: "SGP token 复用缓存",
				context: { token_bytes: this._cachedToken.length },
			});
			return this._cachedToken;
		}
		if (this._tokenRequest) {
			logger.debug({
				tag: "lcu.sgp",
				message: "SGP token 复用进行中请求",
			});
			return this._tokenRequest;
		}

		const startedAt = Date.now();
		logger.info({
			tag: "lcu.sgp",
			message: "SGP token 拉取发起",
			context: { purpose: "刷新 entitlements token 供 SGP 鉴权" },
		});
		this._tokenRequest = this._tokenProvider().then((token) => {
			if (token) this._cachedToken = token;
			logger.info({
				tag: "lcu.sgp",
				message: "SGP token 拉取完成",
				context: {
					purpose: "刷新 entitlements token 供 SGP 鉴权",
					token_bytes: token ? token.length : 0,
					success: token !== null,
				},
				durationMs: Date.now() - startedAt,
			}, token ?? undefined);
			return token;
		}).finally(() => {
			this._tokenRequest = null;
		});
		return this._tokenRequest;
	};

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
		const startedAt = Date.now();
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
				logger.warn({
					tag: "lcu.sgp",
					message: `SGP 请求超时（${this.TIMEOUT}ms）`,
					context: {
						url,
						duration_ms: Date.now() - startedAt,
						error: String(error).slice(0, 500),
					},
				}, undefined, undefined);
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
		const token = this._cachedToken || await this.getToken();
		if (!token) {
			throw new Error("Failed to fetch SGP entitlement token");
		}

		try {
			return await this._doRequest(params, token, fullParticipants);
		} catch (error) {
			// 只有令牌过期才刷新重试；网络超时等错误应尽快交给界面处理。
			if (!this.isUnauthorizedError(error)) {
				throw error;
			}

			logger.warn({
				tag: "lcu.sgp",
				message: "SGP token 过期，刷新中",
				context: {
					purpose: fullParticipants
						? "SGP 完整参与者历史接口 401 重试"
						: "SGP 摘要历史接口 401 重试",
					player_puuid: params.playerPuuid,
					start: params.start,
					count: params.count,
					full_participants: fullParticipants,
					error: String(error).slice(0, 500),
				},
			});

			// 清掉旧 token 后走 getToken()，并发 401 重试会共享同一个
			// _tokenRequest Promise，避免向 LCU 重复刷 token。
			this._cachedToken = null;
			const refreshedToken = await this.getToken();
			if (!refreshedToken) {
				throw new Error("Failed to refresh SGP entitlement token");
			}
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
		const startedAt = Date.now();

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

		const purpose = fullParticipants
			? "SGP SUMMARY 完整参与者历史（用于团队/开黑关系分析）"
			: "SGP SUMMARY 摘要历史（用于胜率统计）";

		const requestHeaders: Record<string, string> = {
			"User-Agent": this.USER_AGENT,
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"x-akari-force-stream-collect": "true",
			"x-akari-token-type": "entitlements",
		};
		logger.info({
			tag: "lcu.sgp",
			message: "SGP 请求发起",
			context: {
				purpose,
				url,
				method: "GET",
				player_puuid: playerPuuid,
				start,
				count,
				full_participants: fullParticipants,
				tag: tag ?? null,
				query: query.toString(),
				headers: requestHeaders,
			},
		}, undefined, undefined);

		const { response, body, data } = await this.fetchJsonWithTimeout<{
			games?: unknown;
		}>(url, {
			method: "GET",
			headers: requestHeaders,
			connectTimeout: this.TIMEOUT,
		});

		const bodyChars = body.length;
		if (response.ok && bodyChars > 0) {
			logger.info({
				tag: "lcu.sgp",
				message: "SGP 响应成功",
				context: {
					purpose,
					url,
					status: response.status,
					body_chars: bodyChars,
					games_count: Array.isArray(data?.games) ? (data!.games as unknown[]).length : 0,
					duration_ms: Date.now() - startedAt,
				},
				durationMs: Date.now() - startedAt,
			}, body);
		}

		if (!response.ok) {
			// 如果状态码是 401，说明 Token 过期，此处抛出错误触发 catch 块中的重试
			if (response.status === 401) {
				logger.warn({
					tag: "lcu.sgp",
					message: "SGP 401 未授权，token 已失效",
					context: { url, status: response.status, purpose },
				}, body);
			} else {
				logger.warn({
					tag: "lcu.sgp",
					message: "SGP 响应非 2xx",
					context: {
						url,
						status: response.status,
						body_chars: bodyChars,
						duration_ms: Date.now() - startedAt,
						purpose,
					},
				}, body);
			}
			throw new Error(`SGP_HTTP_ERROR_${response.status}: ${body.slice(0, 500)}`);
		}

		if (!Array.isArray(data?.games)) {
			logger.warn({
				tag: "lcu.sgp",
				message: "SGP 响应缺少 games 数组",
				context: { url, purpose, body_chars: bodyChars },
			}, body);
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

		logger.info({
			tag: "lcu.sgp",
			message: "SGP 历史接口解析完成",
			context: {
				purpose,
				url,
				start,
				count,
				full_participants: fullParticipants,
				status: response.status,
				games: gamesList.length,
				cached_games: this.matchCache.size,
				duration_ms: Date.now() - startedAt,
			},
			durationMs: Date.now() - startedAt,
		});
		return gamesList;
	}
}
