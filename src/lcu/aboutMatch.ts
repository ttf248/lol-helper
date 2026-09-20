import { invokeLcu } from "./index";
import { SgpMatchHistoryService } from "./sgpMatch";
import {
	Games,
	LcuMatchList,
	EntitlementsTokenTypes,
} from "./types/queryMatchLcuTypes";

import { GamesBySgp } from "./types/queryMatchSgpGameTypes";
import { logger } from "@/utils/logger";

export type MatchHistorySource =
	| "lcu-current"
	| "lcu-puuid"
	| "sgp"
	| "postgres"
	| "mixed";

/**
 * 历史数据实际命中的接口。source 只用于兼容旧的聚合标签，
 * endpoints 才是界面展示和排查问题时应该信任的明细。
 */
export type MatchHistoryEndpoint =
	| "lcu-current-summoner"
	| "lcu-puuid"
	| "sgp-summary"
	| "sgp-summary-full"
	| "lcu-game-detail";

export const MATCH_HISTORY_SOURCE_LABELS: Record<MatchHistorySource, string> = {
	"lcu-current": "LCU（当前召唤师）",
	"lcu-puuid": "LCU（PUUID）",
	sgp: "SGP（区域服务）",
	postgres: "PostgreSQL 本地缓存",
	mixed: "LCU + SGP（混合）",
};

export const MATCH_HISTORY_ENDPOINT_LABELS: Record<MatchHistoryEndpoint, string> = {
	"lcu-current-summoner": "LCU 当前召唤师历史接口",
	"lcu-puuid": "LCU PUUID 历史接口",
	"sgp-summary": "SGP SUMMARY 历史接口",
	"sgp-summary-full": "SGP SUMMARY 完整参与者接口",
	"lcu-game-detail": "LCU 对局详情接口",
};

export const MATCH_HISTORY_ENDPOINT_PATHS: Record<MatchHistoryEndpoint, string> = {
	"lcu-current-summoner":
		"/lol-match-history/v1/products/lol/current-summoner/matches?begIndex={start}&endIndex={end}",
	"lcu-puuid":
		"/lol-match-history/v1/products/lol/{puuid}/matches?begIndex={start}&endIndex={end}",
	"sgp-summary":
		"/match-history-query/v1/products/lol/player/{puuid}/SUMMARY?startIndex={start}&count={count}",
	"sgp-summary-full":
		"/match-history-query/v1/products/lol/player/{puuid}/SUMMARY?startIndex={start}&count={count}",
	"lcu-game-detail": "/lol-match-history/v1/games/{gameId}",
};

export type MatchHistoryGame = Games | GamesBySgp;

export interface MatchHistoryQueryResult {
	games: MatchHistoryGame[];
	source: MatchHistorySource;
	endpoints: MatchHistoryEndpoint[];
	/** LCU 在返回完整列表或明确提供总数时给出的历史总场数。 */
	totalCount: number | null;
}

interface MatchHistoryBatchResult extends MatchHistoryQueryResult {}

interface MatchHistoryPageResult {
	games: Games[];
	totalCount: number | null;
}

const combineSources = (sources: MatchHistorySource[]): MatchHistorySource => {
	const uniqueSources = Array.from(new Set(sources));
	return uniqueSources.length === 1 ? uniqueSources[0] : "mixed";
};

const combineEndpoints = (
	endpoints: MatchHistoryEndpoint[],
): MatchHistoryEndpoint[] => Array.from(new Set(endpoints));

const tokenFetcher = async (): Promise<string | null> => {
	const entitlements: EntitlementsTokenTypes | null = await invokeLcu(
		"get",
		"/entitlements/v1/token",
	);
	if (entitlements === null) {
		logger.error({
			tag: "lcu.token",
			message: "entitlements token 获取失败",
		});
		return null;
	}
	return entitlements.accessToken;
};

const sgpService = new SgpMatchHistoryService(tokenFetcher);
const lcuMatchCache = new Map<number, Games>();
const lcuMatchSource = new Map<number, MatchHistoryEndpoint>();

const cacheLcuGames = (games: Games[], endpoint: MatchHistoryEndpoint) => {
	for (const game of games) {
		if (typeof game?.gameId === "number") {
			lcuMatchCache.set(game.gameId, game);
			lcuMatchSource.set(game.gameId, endpoint);
		}
	}
};

/**
 * 把一次 `/games/{gameId}` 响应写进 LCU 历史缓存。MatchDetails 在
 * 详情兜底路径上独立拉到单局响应时复用，避免再次请求同一 gameId。
 */
export const cacheLcuGameDetail = (game: Games) => {
	if (game && typeof game.gameId === "number") {
		lcuMatchCache.set(game.gameId, game);
		lcuMatchSource.set(game.gameId, "lcu-game-detail");
	}
};

export const getCachedLcuMatch = (gameId: number): Games | null =>
	lcuMatchCache.get(gameId) ?? null;

export const getCachedLcuMatchSource = (
	gameId: number,
): MatchHistoryEndpoint | null => lcuMatchSource.get(gameId) ?? null;

const isCurrentSummoner = (puuid: string): boolean => {
	try {
		const localSumInfo = JSON.parse(
			localStorage.getItem("sumInfo") || "null",
		) as { puuid?: string } | null;
		return localSumInfo?.puuid === puuid;
	} catch {
		return false;
	}
};

/**
 * 当前玩家的历史记录使用 LCU 专用 endpoint。新客户端对该 endpoint
 * 的可用性与返回范围都优于按 PUUID 反查的历史接口。
 */
const fetchCurrentSummonerMatchHistory = async (
	begIndex: number,
	count: number,
): Promise<MatchHistoryPageResult | null> => {
	try {
		const query = new URLSearchParams({
			begIndex: String(begIndex),
			endIndex: String(begIndex + count),
		});
		const matchList = await invokeLcu<LcuMatchList>(
			"get",
			`/lol-match-history/v1/products/lol/current-summoner/matches?${query.toString()}`,
		);
		const history = matchList?.games;
		const games = history?.games;
		if (!Array.isArray(games)) {
			return null;
		}
		cacheLcuGames(games, "lcu-current-summoner");
		const responseStart = Number(history?.gameIndexBegin);
		const responseEnd = Number(history?.gameIndexEnd);
		// 新版 LCU 会按 query 参数返回分页结果，旧版可能忽略参数并
		// 返回完整列表。利用响应中的索引避免对新版结果二次 slice。
		const alreadyPaged =
			responseStart === begIndex &&
			Number.isFinite(responseEnd) &&
			responseEnd <= begIndex + count;
		const advertisedCount = Number(history?.gameCount);
		// gameCount 是 LCU 返回的历史总数。不能再要求它必须大于当前页
		// 的末尾：当最后一页正好结束在总数处，旧条件会把有效总数丢成
		// null，页面只能退回到“已缓存多少场就显示多少页”的估算逻辑。
		// 如果客户端没有提供 gameCount，只有未分页返回完整列表时才用
		// games.length 作为兜底。
		const totalCount = Number.isFinite(advertisedCount) && advertisedCount >= 0
			? advertisedCount
			: !alreadyPaged
			? games.length
			: null;
		return {
			games: alreadyPaged ? games : games.slice(begIndex, begIndex + count),
			totalCount,
		};
	} catch {
		return null;
	}
};

/**
 * LCU 仍然提供按 PUUID 查询历史记录的接口。它不应和
 * current-summoner endpoint 混用：前者可查询同区其它召唤师，后者只代表
 * 当前登录用户。腾讯服客户端对这个接口的兼容性通常比 SGP 更好，优先尝试。
 */
const fetchSummonerMatchHistoryFromLcu = async (
	puuid: string,
	begIndex: number,
	count: number,
): Promise<MatchHistoryPageResult | null> => {
	try {
		const query = new URLSearchParams({
			begIndex: String(begIndex),
			endIndex: String(begIndex + count),
		});
		const matchList = await invokeLcu<LcuMatchList>(
			"get",
			`/lol-match-history/v1/products/lol/${encodeURIComponent(puuid)}/matches?${query.toString()}`,
		);
		const games = matchList?.games?.games;
		if (!Array.isArray(games)) {
			return null;
		}
		cacheLcuGames(games, "lcu-puuid");
		const history = matchList?.games;
		const responseStart = Number(history?.gameIndexBegin);
		const responseEnd = Number(history?.gameIndexEnd);
		const alreadyPaged =
			responseStart === begIndex &&
			Number.isFinite(responseEnd) &&
			responseEnd <= begIndex + count;
		const advertisedCount = Number(history?.gameCount);
		// 与 current-summoner 接口保持一致：gameCount 是服务器报告的
		// 历史总数，不能因为当前请求刚好落在末页就将它过滤掉。
		const totalCount = Number.isFinite(advertisedCount) && advertisedCount >= 0
			? advertisedCount
			: !alreadyPaged
			? games.length
			: null;
		return {
			games: alreadyPaged ? games : games.slice(begIndex, begIndex + count),
			totalCount,
		};
	} catch {
		return null;
	}
};

// 关系分析必须拿到同一局的多名参与者。LCU 的部分历史接口虽然返回
// 了对局数量，但 participants 里可能只有目标玩家，不能当作完整历史。
const hasParticipantRoster = (games: MatchHistoryGame[]): boolean =>
	games.length > 0 &&
	games.every(
		(game) => {
			if (!Array.isArray(game.participants) || game.participants.length < 5) {
				return false;
			}
			if ("participantIdentities" in game) {
				const identities = new Set(
					(game.participantIdentities || [])
						.filter((item) => {
							const player = item.player as any;
							return Boolean(
								player?.puuid ||
								player?.summonerId ||
								player?.summonerName,
							);
						})
						.map((item) => item.participantId),
				);
				return identities.size >= 5;
			}
			return game.participants.filter((participant: any) =>
				Boolean(
					participant?.puuid ||
					participant?.summonerId ||
					participant?.summonerName,
				),
			).length >= 5;
		},
	);

// 辅助函数：处理单次请求
const fetchMatchHistory = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants = false,
): Promise<MatchHistoryBatchResult> => {
	// 普通战绩列表可以使用当前召唤师历史 endpoint；它仍然是历史数据，
	// 不是当前正在进行的对局。完整分析则必须继续检查参与者是否齐全。
	if (!fullParticipants && isCurrentSummoner(puuid)) {
		const currentResult = await fetchCurrentSummonerMatchHistory(
			begIndex,
			endIndex,
		);
		if (currentResult !== null) {
			logger.info({
				tag: "lcu.history",
				message: "历史接口解析完成",
				context: {
					puuid,
					beg_index: begIndex,
					count: endIndex,
					full_participants: fullParticipants,
					resolved: "lcu-current-summoner",
					count_games: currentResult.games.length,
				},
			});
			return {
				games: currentResult.games,
				source: "lcu-current",
				endpoints: ["lcu-current-summoner"],
				totalCount: currentResult.totalCount,
			};
		}
	}

	// 先走 LCU 的 PUUID endpoint。对于腾讯服，它通常能直接返回他人的
	// 简要战绩；只有客户端拒绝或返回空结果时才需要 SGP。
	const lcuResult = await fetchSummonerMatchHistoryFromLcu(
		puuid,
		begIndex,
		endIndex,
	);
	if (
		lcuResult !== null &&
		lcuResult.games.length > 0 &&
		(!fullParticipants || hasParticipantRoster(lcuResult.games))
	) {
		logger.info({
			tag: "lcu.history",
			message: "历史接口解析完成",
			context: {
				puuid,
				beg_index: begIndex,
				count: endIndex,
				full_participants: fullParticipants,
				resolved: "lcu-puuid",
				count_games: lcuResult.games.length,
			},
		});
		return {
			games: lcuResult.games,
			source: "lcu-puuid",
			endpoints: ["lcu-puuid"],
			totalCount: lcuResult.totalCount,
		};
	}

	try {
		const sgpRequest = {
			playerPuuid: puuid,
			start: begIndex,
			count: endIndex,
		};
		const sgpGames = fullParticipants
			? await sgpService.getFullMatchHistory(sgpRequest)
			: await sgpService.getMatchHistory(sgpRequest);
		if (sgpGames.length > 0) {
			logger.info({
				tag: "lcu.history",
				message: "历史接口解析完成",
				context: {
					puuid,
					beg_index: begIndex,
					count: endIndex,
					full_participants: fullParticipants,
					resolved: fullParticipants ? "sgp-summary-full" : "sgp-summary",
					count_games: sgpGames.length,
				},
			});
			return {
				games: sgpGames,
				source: "sgp",
				endpoints: [fullParticipants ? "sgp-summary-full" : "sgp-summary"],
				totalCount: null,
			};
		}
	} catch (sgpError) {
		logger.warn({
			tag: "lcu.history",
			message: "SGP 历史接口失败，回退到 LCU",
			context: {
				puuid,
				beg_index: begIndex,
				count: endIndex,
				full_participants: fullParticipants,
				resolved: "sgp-error",
				error: String(sgpError).slice(0, 200),
			},
		});
	}

	// SGP 不可用时，仍允许页面显示目标玩家的历史胜率；但这里明确是
	// 降级数据，调用方会通过 participants 数量判断关系分析是否可信。
	if (isCurrentSummoner(puuid)) {
		const currentResult = await fetchCurrentSummonerMatchHistory(
			begIndex,
			endIndex,
		);
		if (currentResult !== null && currentResult.games.length > 0) {
			logger.info({
				tag: "lcu.history",
				message: "历史接口解析完成（LCU 降级）",
				context: {
					puuid,
					beg_index: begIndex,
					count: endIndex,
					full_participants: fullParticipants,
					resolved: "lcu-current-summoner",
					count_games: currentResult.games.length,
				},
			});
			return {
				games: currentResult.games,
				source: "lcu-current",
				endpoints: ["lcu-current-summoner"],
				totalCount: currentResult.totalCount,
			};
		}
	}
	if (lcuResult !== null) {
		logger.info({
			tag: "lcu.history",
			message: "历史接口解析完成（LCU 降级）",
			context: {
				puuid,
				beg_index: begIndex,
				count: endIndex,
				full_participants: fullParticipants,
				resolved: "lcu-puuid",
				count_games: lcuResult.games.length,
			},
		});
		return {
			games: lcuResult.games,
			source: "lcu-puuid",
			endpoints: ["lcu-puuid"],
			totalCount: lcuResult.totalCount,
		};
	}
	logger.warn({
		tag: "lcu.history",
		message: "历史接口全部失败，无可用数据",
		context: {
			puuid,
			beg_index: begIndex,
			count: endIndex,
			full_participants: fullParticipants,
			resolved: "none",
		},
	});
	throw new Error("Match history interfaces returned no data");
};

/** 返回最近一次 SGP SUMMARY 中缓存的完整对局，供详情展示复用。 */
export const getCachedSgpMatch = (gameId: number): GamesBySgp | null =>
	sgpService.getCachedMatch(gameId);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 历史分析、个人战绩页和对局内面板可能同时请求同一名玩家的同一段
// 历史。只合并进行中的请求，不长期缓存结果，避免客户端切换账号后读到
// 旧数据，同时消除并发页面造成的重复 LCU/SGP 请求。
const inFlightHistoryRequests = new Map<
	string,
	Promise<MatchHistoryQueryResult | null>
>();

// 摘要接口的串行分页实现；完整参与者分页由下面的并行实现处理。
const splitRequestsSequential = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants = false,
): Promise<MatchHistoryBatchResult> => {
	const step = 20; // 接口单次最多请求 20 条
	let allGames: MatchHistoryGame[] = [];
	const sources: MatchHistorySource[] = [];
	const endpoints: MatchHistoryEndpoint[] = [];
	let totalCount: number | null = null;

	// 1. 计算总共需要获取的数量
	const totalToFetch = endIndex - begIndex;

	// 2. 使用 offset (偏移量) 进行循环
	for (let i = 0; i < totalToFetch; i += step) {
		// 计算本次应该请求的数量 (最后一次可能不足 step 条)
		const currentCount = Math.min(step, totalToFetch - i);

		// 计算本次请求的起始索引
		const currentStartIndex = begIndex + i;

		// 3. 发起请求
		const result = await fetchMatchHistory(
			puuid,
			currentStartIndex,
			currentCount,
			fullParticipants,
		);
		sources.push(result.source);
		endpoints.push(...result.endpoints);
		if (result.totalCount !== null) {
			totalCount = Math.max(totalCount ?? 0, result.totalCount);
		}

		if (result.games.length > 0) {
			allGames = allGames.concat(result.games);
			// 短页（不足 step）说明服务器历史已经到末尾，再去请求下一页
			// 也只会拿到更旧的、可能无关的数据，反而拉满 200ms 间隔。
			if (result.games.length < step) {
				break;
			}
		} else {
			// 已经到达历史末尾，避免为不存在的分页继续请求。
			break;
		}

		// 4. 频率限制：如果还有下一页，则延迟
		if (i + step < totalToFetch) {
			await delay(200);
		}
	}

	return {
		games: allGames,
		source: combineSources(sources),
		endpoints: combineEndpoints(endpoints),
		totalCount,
	};
};

const splitRequests = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants = false,
): Promise<MatchHistoryBatchResult> => {
	if (!fullParticipants) {
		return splitRequestsSequential(puuid, begIndex, endIndex, false);
	}

	const step = 20;
	const pageConcurrency = 2;
	let allGames: MatchHistoryGame[] = [];
	const sources: MatchHistorySource[] = [];
	const endpoints: MatchHistoryEndpoint[] = [];
	let totalCount: number | null = null;
	const totalToFetch = endIndex - begIndex;

	// 完整参与者请求最多并行两页，批次之间保留间隔，兼顾速度和限流。
	for (
		let batchOffset = 0;
		batchOffset < totalToFetch;
		batchOffset += step * pageConcurrency
	) {
		const batch = Array.from(
			{
				length: Math.min(
					pageConcurrency,
					Math.ceil((totalToFetch - batchOffset) / step),
				),
			},
			(_, batchIndex) => {
				const offset = batchOffset + batchIndex * step;
				return fetchMatchHistory(
					puuid,
					begIndex + offset,
					Math.min(step, totalToFetch - offset),
					true,
				);
			},
		);
		const results = await Promise.all(batch);
		let reachedHistoryEnd = false;
		for (const result of results) {
			sources.push(result.source);
			endpoints.push(...result.endpoints);
			if (result.totalCount !== null) {
				totalCount = Math.max(totalCount ?? 0, result.totalCount);
			}
			if (result.games.length > 0) {
				allGames = allGames.concat(result.games);
			} else {
				reachedHistoryEnd = true;
			}
		}
		if (reachedHistoryEnd) break;
		if (batchOffset + step * pageConcurrency < totalToFetch) {
			await delay(200);
		}
	}

	return {
		games: allGames,
		source: combineSources(sources),
		endpoints: combineEndpoints(endpoints),
		totalCount,
	};
};

// 主函数：查询历史比赛数据，并返回本次实际使用的数据源。
export const queryMatchHistoryWithSource = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
): Promise<MatchHistoryQueryResult | null> => {
	return queryMatchHistoryWithSourceInternal(puuid, begIndex, endIndex, false);
};

const queryMatchHistoryWithSourceInternalUncached = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants: boolean,
): Promise<MatchHistoryQueryResult | null> => {
	try {
		let result: MatchHistoryBatchResult;
		const MAX_REQUEST_SIZE = 20;

		// 如果请求范围超过最大限制，拆分请求
		if (endIndex - begIndex > MAX_REQUEST_SIZE) {
			result = await splitRequests(
				puuid,
				begIndex,
				endIndex,
				fullParticipants,
			);
		} else {
			result = await fetchMatchHistory(
				puuid,
				begIndex,
				endIndex - begIndex,
				fullParticipants,
			);
		}

		// 如果没有获取到游戏数据，返回空数组
		if (result.games.length === 0) {
			return result;
		}

		// 分页接口偶尔会在边界重复返回同一局；重复数据会同时污染
		// 胜率样本、趋势和开黑共同场次，因此在统一出口去重。
		const uniqueGames = Array.from(
			new Map(result.games.map((game) => [game.gameId, game])).values(),
		);

		// 按游戏创建时间降序排序
		return {
			games: uniqueGames.sort((a, b) => b.gameCreation - a.gameCreation),
			source: result.source,
			endpoints: result.endpoints,
			totalCount: result.totalCount,
		};
	} catch (error) {
		logger.error({
			tag: "lcu.history",
			message: "历史查询内部异常",
			context: {
				puuid,
				beg_index: begIndex,
				count: endIndex,
				full_participants: fullParticipants,
				error: String(error).slice(0, 200),
			},
		});
		return null;
	}
};

const queryMatchHistoryWithSourceInternal = (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants: boolean,
): Promise<MatchHistoryQueryResult | null> => {
	const key = `${puuid}:${begIndex}:${endIndex}:${fullParticipants ? "full" : "summary"}`;
	const pending = inFlightHistoryRequests.get(key);
	if (pending) {
		logger.debug({
			tag: "lcu.history",
			message: "inFlight 合并，跳过重复请求",
			context: { key },
		});
		return pending;
	}

	const request = queryMatchHistoryWithSourceInternalUncached(
		puuid,
		begIndex,
		endIndex,
		fullParticipants,
	);
	inFlightHistoryRequests.set(key, request);
	void request.then(
		() => {
			if (inFlightHistoryRequests.get(key) === request) {
				inFlightHistoryRequests.delete(key);
			}
		},
		() => {
			if (inFlightHistoryRequests.get(key) === request) {
				inFlightHistoryRequests.delete(key);
			}
		},
	);
	return request;
};

/** 查询完整 participant 列表，供对局内近期胜率和开黑分析使用。 */
export const queryMatchHistoryFullWithSource = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
): Promise<MatchHistoryQueryResult | null> =>
	queryMatchHistoryWithSourceInternal(puuid, begIndex, endIndex, true);
