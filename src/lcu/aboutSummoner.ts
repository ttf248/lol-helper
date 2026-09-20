import { invokeLcu } from "./index";
import {
	lcuSummonerInfo,
	summonerInfo,
} from "./types/SummonerTypes";
import {
	cacheSummoner,
	getCachedSummonerById,
	getCachedSummonerByPuuid,
	summonerRowToLcuInfo,
} from "@/recentMatch/utils/databaseCache";

const buildSummonerInfo = (info: lcuSummonerInfo): summonerInfo => {
	const xpRatio =
		info.xpUntilNextLevel > 0
			? (info.xpSinceLastLevel / info.xpUntilNextLevel) * 100
			: 0;
	const xp = Number.isFinite(xpRatio)
		? Math.min(100, Math.max(0, Math.trunc(xpRatio)))
		: 0;

	return {
		privacy: info.privacy,
		puuid: info.puuid,
		tagLine: info.tagLine,
		name:
			info.gameName ||
			info.displayName ||
			info.internalName,
		currentId: info.summonerId,
		lv: "Lv " + info.summonerLevel,
		xp,
		imgUrl: `https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/${info.profileIconId}.png`,
	};
};

// 查询本地召唤师信息
export const querySummonerInfo = async (
	summonerId?: number | string,
	summonerName?: string,
): Promise<summonerInfo | null> => {
	// 1) PG 优先：有 summonerId 直接按 id 查 PG，没有就跳过。
	if (
		summonerId !== undefined &&
		summonerId !== null &&
		String(summonerId).trim() !== ""
	) {
		const numericId =
			typeof summonerId === "number"
				? summonerId
				: Number.parseInt(String(summonerId), 10);
		if (Number.isFinite(numericId) && numericId > 0) {
			const cached = await getCachedSummonerById(numericId);
			if (cached) {
				return buildSummonerInfo(summonerRowToLcuInfo(cached));
			}
		}
	} else if (summonerName !== undefined && summonerName.trim() !== "") {
		// 按名字查时，PG 没有 name 索引。先试 localStorage 里上次缓存的 sumInfo.puuid。
		try {
			const cachedPuuid = JSON.parse(
				localStorage.getItem("sumInfo") || "null",
			)?.puuid;
			if (typeof cachedPuuid === "string" && cachedPuuid.length > 0) {
				const cached = await getCachedSummonerByPuuid(cachedPuuid);
				if (cached) {
					return buildSummonerInfo(summonerRowToLcuInfo(cached));
				}
			}
		} catch {
			// localStorage 不可用时静默回退到 LCU
		}
	}

	// 2) PG 未命中或不可用，走 LCU。
	let endpoint: string;
	if (
		summonerId !== undefined &&
		summonerId !== null &&
		String(summonerId).trim() !== ""
	) {
		endpoint = `/lol-summoner/v1/summoners/${summonerId}`;
	} else if (summonerName !== undefined && summonerName.trim() !== "") {
		// LCU keeps this endpoint's query key as `name`; its value may be a
		// Riot ID (GameName#TagLine) or a legacy summoner name.
		const query = new URLSearchParams({ name: summonerName.trim() });
		endpoint = `/lol-summoner/v1/summoners?${query.toString()}`;
	} else {
		endpoint = "/lol-summoner/v1/current-summoner";
	}

	const lcuInfo: lcuSummonerInfo | null = await invokeLcu("get", endpoint);

	if (
		lcuInfo === null ||
		typeof lcuInfo.summonerId !== "number" ||
		!lcuInfo.puuid
	) {
		return null;
	}

	// 3) 写回 PG（fire-and-forget），后续同玩家命中本地缓存。
	void cacheSummoner(lcuInfo);

	return buildSummonerInfo(lcuInfo);
};
