import { invokeLcu } from "./index";
import { SgpMatchHistoryService } from "./sgpMatch";
import {
	Games,
	LcuMatchList,
	EntitlementsTokenTypes,
} from "./types/queryMatchLcuTypes";

import { GamesBySgp } from "./types/queryMatchSgpGameTypes";

export type MatchHistorySource =
	| "lcu-current"
	| "lcu-puuid"
	| "sgp"
	| "postgres"
	| "mixed";

export const MATCH_HISTORY_SOURCE_LABELS: Record<MatchHistorySource, string> = {
	"lcu-current": "LCU（当前召唤师）",
	"lcu-puuid": "LCU（PUUID）",
	sgp: "SGP（区域服务）",
	postgres: "PostgreSQL 本地缓存",
	mixed: "LCU + SGP（混合）",
};

export type MatchHistoryGame = Games | GamesBySgp;

export interface MatchHistoryQueryResult {
	games: MatchHistoryGame[];
	source: MatchHistorySource;
}

interface MatchHistoryBatchResult extends MatchHistoryQueryResult {}

const combineSources = (sources: MatchHistorySource[]): MatchHistorySource => {
	const uniqueSources = Array.from(new Set(sources));
	return uniqueSources.length === 1 ? uniqueSources[0] : "mixed";
};

const tokenFetcher = async (): Promise<string | null> => {
	const entitlements: EntitlementsTokenTypes | null = await invokeLcu(
		"get",
		"/entitlements/v1/token",
	);
	if (entitlements === null) {
		console.error("Failed to fetch token");
		return null;
	}
	return entitlements.accessToken;
};

const sgpService = new SgpMatchHistoryService(tokenFetcher);
const lcuMatchCache = new Map<number, Games>();

const cacheLcuGames = (games: Games[]) => {
	for (const game of games) {
		if (typeof game?.gameId === "number") {
			lcuMatchCache.set(game.gameId, game);
		}
	}
};

export const getCachedLcuMatch = (gameId: number): Games | null =>
	lcuMatchCache.get(gameId) ?? null;

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
): Promise<Games[] | null> => {
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
		cacheLcuGames(games);
		const responseStart = Number(history?.gameIndexBegin);
		const responseEnd = Number(history?.gameIndexEnd);
		// 新版 LCU 会按 query 参数返回分页结果，旧版可能忽略参数并
		// 返回完整列表。利用响应中的索引避免对新版结果二次 slice。
		const alreadyPaged =
			responseStart === begIndex &&
			Number.isFinite(responseEnd) &&
			responseEnd <= begIndex + count;
		return alreadyPaged ? games : games.slice(begIndex, begIndex + count);
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
): Promise<Games[] | null> => {
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
		cacheLcuGames(games);
		return games;
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
		const currentGames = await fetchCurrentSummonerMatchHistory(
			begIndex,
			endIndex,
		);
		if (currentGames !== null) {
			return { games: currentGames, source: "lcu-current" };
		}
	}

	// 先走 LCU 的 PUUID endpoint。对于腾讯服，它通常能直接返回他人的
	// 简要战绩；只有客户端拒绝或返回空结果时才需要 SGP。
	const lcuGames = await fetchSummonerMatchHistoryFromLcu(
		puuid,
		begIndex,
		endIndex,
	);
	if (
		lcuGames !== null &&
		lcuGames.length > 0 &&
		(!fullParticipants || hasParticipantRoster(lcuGames))
	) {
		return { games: lcuGames, source: "lcu-puuid" };
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
			return { games: sgpGames, source: "sgp" };
		}
	} catch (sgpError) {
		console.warn("SGP match history request failed, trying LCU fallback", sgpError);
	}

	// SGP 不可用时，仍允许页面显示目标玩家的历史胜率；但这里明确是
	// 降级数据，调用方会通过 participants 数量判断关系分析是否可信。
	if (isCurrentSummoner(puuid)) {
		const currentGames = await fetchCurrentSummonerMatchHistory(
			begIndex,
			endIndex,
		);
		if (currentGames !== null && currentGames.length > 0) {
			return { games: currentGames, source: "lcu-current" };
		}
	}
	if (lcuGames !== null) {
		return { games: lcuGames, source: "lcu-puuid" };
	}
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

		if (result.games.length > 0) {
			allGames = allGames.concat(result.games);
		} else {
			// 已经到达历史末尾，避免为不存在的分页继续请求。
			break;
		}

		// 4. 频率限制：如果还有下一页，则延迟
		if (i + step < totalToFetch) {
			await delay(200);
		}
	}

	return { games: allGames, source: combineSources(sources) };
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

	return { games: allGames, source: combineSources(sources) };
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
		};
	} catch (error) {
		console.error("Error fetching match history:", error);
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

// 兼容其它页面原有的数组返回格式。
export const queryMatchHistory = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
): Promise<MatchHistoryGame[] | null> => {
	const result = await queryMatchHistoryWithSource(puuid, begIndex, endIndex);
	return result?.games ?? null;
};
