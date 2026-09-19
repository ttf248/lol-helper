import { invokeLcu } from "./index";
import { SgpMatchHistoryService } from "./sgpMatch";
import {
	Games,
	LcuMatchList,
	EntitlementsTokenTypes,
} from "./types/queryMatchLcuTypes";

import { GamesBySgp } from "./types/queryMatchSgpGameTypes";

export type MatchHistorySource = "lcu-current" | "lcu-puuid" | "sgp" | "mixed";

export const MATCH_HISTORY_SOURCE_LABELS: Record<MatchHistorySource, string> = {
	"lcu-current": "LCU（当前召唤师）",
	"lcu-puuid": "LCU（PUUID）",
	sgp: "SGP（区域服务）",
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
		const matchList = await invokeLcu<LcuMatchList>(
			"get",
			"/lol-match-history/v1/products/lol/current-summoner/matches",
		);
		const games = matchList?.games?.games;
		if (!Array.isArray(games)) {
			return null;
		}
		cacheLcuGames(games);
		return games.slice(begIndex, begIndex + count);
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

// 辅助函数：处理单次请求
const fetchMatchHistory = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants = false,
): Promise<MatchHistoryBatchResult> => {
	if (isCurrentSummoner(puuid)) {
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
	if (lcuGames !== null && lcuGames.length > 0) {
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
		return { games: sgpGames, source: "sgp" };
	} catch (sgpError) {
		console.warn("SGP match history request failed, trying LCU fallback", sgpError);
		const fallbackGames = await fetchSummonerMatchHistoryFromLcu(
			puuid,
			begIndex,
			endIndex,
		);
		if (fallbackGames === null) {
			throw new Error("Match history interfaces returned no data");
		}
		return { games: fallbackGames, source: "lcu-puuid" };
	}
};

/** 返回最近一次 SGP SUMMARY 中缓存的完整对局，供详情展示复用。 */
export const getCachedSgpMatch = (gameId: number): GamesBySgp | null =>
	sgpService.getCachedMatch(gameId);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 辅助函数：拆分请求区间
const splitRequests = async (
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

// 主函数：查询历史比赛数据，并返回本次实际使用的数据源。
export const queryMatchHistoryWithSource = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
): Promise<MatchHistoryQueryResult | null> => {
	return queryMatchHistoryWithSourceInternal(puuid, begIndex, endIndex, false);
};

const queryMatchHistoryWithSourceInternal = async (
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

		// 去重操作
		// const uniqueGames = Array.from(
		// 	new Map(allGames.map((game) => [game.gameId, game])).values(),
		// );

		// 按游戏创建时间降序排序
		return {
			games: result.games.sort((a, b) => b.gameCreation - a.gameCreation),
			source: result.source,
		};
	} catch (error) {
		console.error("Error fetching match history:", error);
		return null;
	}
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
