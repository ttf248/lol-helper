import { invoke } from "@tauri-apps/api/core";
import { invokeLcu } from "./index";
import { SgpMatchHistoryService } from "./sgpMatch";
import {
	Games,
	LcuMatchList,
	EntitlementsTokenTypes,
} from "./types/queryMatchLcuTypes";

import { GamesBySgp } from "./types/queryMatchSgpGameTypes";

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
		const matchList = await invoke<LcuMatchList | null>("get_match_list", {
			uri: "/lol-match-history/v1/products/lol/current-summoner/matches",
		});
		const games = matchList?.games?.games;
		if (!Array.isArray(games)) {
			return null;
		}
		return games.slice(begIndex, begIndex + count);
	} catch {
		return null;
	}
};

// 辅助函数：处理单次请求
const fetchMatchHistory = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
): Promise<GamesBySgp[] | Games[]> => {
	if (isCurrentSummoner(puuid)) {
		const currentGames = await fetchCurrentSummonerMatchHistory(
			begIndex,
			endIndex,
		);
		if (currentGames !== null) {
			return currentGames;
		}
	}

	// const uri = `/lol-match-history/v1/products/lol/${puuid}/matches`;
	// const matchList = await invoke<LcuMatchList | null>("get_match_list", {
	// 	uri,
	// });
	// console.log(matchList);

	try {
		return await sgpService.getMatchHistory({
			playerPuuid: puuid,
			start: begIndex,
			count: endIndex,
		});
	} catch (err) {
		const query = new URLSearchParams({
			begIndex: String(begIndex),
			endIndex: String(begIndex + endIndex),
		});
		const uri = `/lol-match-history/v1/products/lol/${puuid}/matches?${query.toString()}`;
		const matchList = await invoke<LcuMatchList | null>("get_match_list", {
			uri,
		});
		if (matchList === null) return [];
		return matchList.games.games || [];
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
): Promise<Games[] | GamesBySgp[]> => {
	const step = 10; // 每次请求 10 条
	let allGames: Games[] | GamesBySgp[] = [];

	// 1. 计算总共需要获取的数量
	const totalToFetch = endIndex - begIndex;

	// 2. 使用 offset (偏移量) 进行循环
	for (let i = 0; i < totalToFetch; i += step) {
		// 计算本次应该请求的数量 (最后一次可能不足 step 条)
		const currentCount = Math.min(step, totalToFetch - i);

		// 计算本次请求的起始索引
		const currentStartIndex = begIndex + i;

		// 3. 发起请求
		const games = await fetchMatchHistory(
			puuid,
			currentStartIndex,
			currentCount,
		);

		if (games && games.length > 0) {
			// @ts-ignore
			allGames = allGames.concat(games);
		}

		// 4. 频率限制：如果还有下一页，则延迟
		if (i + step < totalToFetch) {
			await delay(200);
		}
	}

	return allGames;
};

// 主函数：查询历史比赛数据
export const queryMatchHistory = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
): Promise<Games[] | GamesBySgp[] | null> => {
	try {
		let allGames: Games[] | GamesBySgp[] = [];
		const MAX_REQUEST_SIZE = 20;

		// 如果请求范围超过最大限制，拆分请求
		if (endIndex - begIndex > MAX_REQUEST_SIZE) {
			allGames = await splitRequests(puuid, begIndex, endIndex);
		} else {
			allGames = await fetchMatchHistory(puuid, begIndex, endIndex - begIndex);
		}

		// 如果没有获取到游戏数据，返回空数组
		if (!allGames || allGames.length === 0) {
			return [];
		}

		// 去重操作
		// const uniqueGames = Array.from(
		// 	new Map(allGames.map((game) => [game.gameId, game])).values(),
		// );

		// 按游戏创建时间降序排序
		return allGames.sort((a, b) => b.gameCreation - a.gameCreation);
	} catch (error) {
		console.error("Error fetching match history:", error);
		return null;
	}
};
