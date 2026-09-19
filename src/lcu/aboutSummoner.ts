import { invokeLcu } from "./index";
import {
	lcuSummonerInfo,
	summonerInfo,
} from "./types/SummonerTypes";

// 查询本地召唤师信息
export const querySummonerInfo = async (
	summonerId?: number | string,
	summonerName?: string,
): Promise<summonerInfo | null> => {
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

	const summonerInfo: lcuSummonerInfo | null = await invokeLcu("get", endpoint);

	if (
		summonerInfo === null ||
		typeof summonerInfo.summonerId !== "number" ||
		!summonerInfo.puuid
	) {
		return null;
	}

	const xpRatio =
		summonerInfo.xpUntilNextLevel > 0
			? (summonerInfo.xpSinceLastLevel / summonerInfo.xpUntilNextLevel) * 100
			: 0;
	const xp = Number.isFinite(xpRatio)
		? Math.min(100, Math.max(0, Math.trunc(xpRatio)))
		: 0;

	return {
		privacy: summonerInfo.privacy,
		puuid: summonerInfo.puuid,
		tagLine: summonerInfo.tagLine,
		name:
			summonerInfo.gameName ||
			summonerInfo.displayName ||
			summonerInfo.internalName,
		currentId: summonerInfo.summonerId,
		lv: "Lv " + summonerInfo.summonerLevel,
		xp,
		imgUrl: `https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/${summonerInfo.profileIconId}.png`,
	};
};
