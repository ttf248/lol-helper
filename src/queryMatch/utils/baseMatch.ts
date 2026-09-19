import { querySummonerInfo } from "@/lcu/aboutSummoner";
import { Games, SimpleMatchDetailsTypes } from "@/lcu/types/queryMatchLcuTypes";
import {
    MatchHistorySource,
    queryMatchHistoryWithSource,
} from "@/lcu/aboutMatch";
import { queryGameType } from "@/lcu/utils";
import { champDict } from "@/resources/champList";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import { sumInfoTypes } from "@/lcu/types/SummonerTypes";
import {
    cacheHistory,
    getCachedHistory,
} from "@/recentMatch/utils/databaseCache";
import {
    normalizeHistoryGame,
    NormalizedHistoryGame,
} from "@/recentMatch/utils/recentAnalytics";
import { modeForQueue, MatchModeKey } from "@/recentMatch/utils/matchMode";

export interface ProcessedMatchHistory {
    matches: SimpleMatchDetailsTypes[];
    source: MatchHistorySource | null;
}

export default class BaseMatch {
    public summonerId = 0;

    public gerSummonerInfo = async (summonerId?: number) => {
        const summonerInfo = await querySummonerInfo(summonerId);
        if (summonerInfo !== null) {
            return { summonerInfo };
        }
        return null;
    };

    public dealMatchHistory = async (
        puuid: string,
        begIndex: number,
        endIndex: number,
    ): Promise<SimpleMatchDetailsTypes[] | null> => {
        const result = await this.dealMatchHistoryWithSource(
            puuid,
            begIndex,
            endIndex,
        );
        return result?.matches ?? null;
    };

    public dealMatchHistoryWithSource = async (
        puuid: string,
        begIndex: number,
        endIndex: number,
    ): Promise<ProcessedMatchHistory | null> => {
        // 写入玩家id
        const localSumInfo: sumInfoTypes = JSON.parse(
            localStorage.getItem("sumInfo") as string,
        );
        if (this.summonerId === 0) {
            this.summonerId = localSumInfo.summonerId;
        }

        const requestedCount = Math.max(0, endIndex - begIndex);
        if (requestedCount > 0) {
            const cachedGames = await getCachedHistory({
                puuid,
                limit: requestedCount,
                offset: begIndex,
            });
            const cachedMatches = cachedGames
                .map((game) => this.getSimpleCachedMatch(game, puuid))
                .filter(
                    (match): match is SimpleMatchDetailsTypes => match !== null,
                );
            if (cachedMatches.length >= requestedCount) {
                return { matches: cachedMatches, source: "postgres" };
            }
        }

        const result = await queryMatchHistoryWithSource(
            puuid,
            begIndex,
            endIndex,
        );

        if (result === null) {
            return null;
        }

        const matches = result.games
            .map((matchListElement) =>
                this.getSimpleMatch(matchListElement, puuid),
            )
            .filter(
                (match): match is SimpleMatchDetailsTypes => match !== null,
            );

        // 历史查询面板也负责回填统一分析缓存，后续首页、分页和模式分析
        // 都可以直接复用这些 participant 数据，避免重复请求同一段历史。
        const gamesByMode = new Map<MatchModeKey, NormalizedHistoryGame[]>();
        for (const rawGame of result.games) {
            const normalized = normalizeHistoryGame(rawGame);
            if (!normalized) continue;
            const modeKey = modeForQueue(normalized.queueId);
            const modeGames = gamesByMode.get(modeKey) || [];
            modeGames.push(normalized);
            gamesByMode.set(modeKey, modeGames);
        }
        for (const [modeKey, games] of gamesByMode) {
            void cacheHistory({
                puuid,
                summonerId: this.summonerId,
                summonerName: localSumInfo.name,
                modeKey,
                source: result.source,
                games,
            });
        }

        return { matches, source: result.source };
    };

    public getSimpleCachedMatch = (
        match: NormalizedHistoryGame,
        targetPuuid?: string,
    ): SimpleMatchDetailsTypes | null => {
        const participant =
            match.participants.find((item) => item.puuid === targetPuuid) ||
            match.participants[0];
        if (!participant) return null;

        const { kills, deaths, assists } = participant;
        const kda =
            deaths === 0
                ? kills + assists
                : Math.round(((kills + assists) / deaths) * 3);
        const [startTime, matchTime] = this.timestampToDate(match.gameCreation);
        const champAlias = champDict[String(participant.championId)]?.alias;
        const champImgUrl = champAlias
            ? `https://game.gtimg.cn/images/lol/act/img/champion/${champAlias}.png`
            : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${participant.championId}.png`;

        return {
            gameId: match.gameId,
            champId: participant.championId,
            champImgUrl,
            isWin: participant.win,
            kills,
            deaths,
            assists,
            kda,
            matchTime,
            startTime,
            gameModel: queryGameType(match.queueId),
            queueId: match.queueId,
        };
    };

    public getSimpleMatch = (
        match: Games | GamesBySgp,
        targetPuuid?: string,
    ): SimpleMatchDetailsTypes | null => {
        // 1. 确定参与者数据源
        const participant = match.participants?.find((item: any) => {
            if (item?.puuid === targetPuuid) {
                return true;
            }
            if (targetPuuid && "participantIdentities" in match) {
                return match.participantIdentities?.some(
                    (identity) =>
                        identity.participantId === item?.participantId &&
                        (identity.player as any).puuid === targetPuuid,
                );
            }
            return false;
        }) ?? match.participants?.[0];
        if (!participant || typeof match.gameId !== "number") {
            return null;
        }
        const stats =
            "stats" in participant ? (participant as any).stats : participant;

        // 2. 提取核心数值
        const { kills, deaths, assists, win } = stats;
        const { championId } = participant; // championId 始终在参与者根节点
        // 3. 计算 KDA
        const kda =
            deaths === 0
                ? kills + assists
                : Math.round(((kills + assists) / deaths) * 3);

        // 4. 处理时间和字典查询
        const [startTime, matchTime] = this.timestampToDate(match.gameCreation);
        const champAlias = champDict[String(championId)]?.alias;
        // 字典缺英雄时回退到 CommunityDragon 图标
        const champImgUrl = champAlias
            ? `https://game.gtimg.cn/images/lol/act/img/champion/${champAlias}.png`
            : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;

        // 5. 统一返回
        return {
            gameId: match.gameId,
            champId: championId,
            champImgUrl,
            isWin: Boolean(win),
            kills,
            deaths,
            assists,
            kda,
            matchTime,
            startTime,
            gameModel: queryGameType(match.queueId),
            queueId: match.queueId,
        };
    };

    public querySpecialMatch = async (puuid: string, queueId: number) => {
        const result = await this.querySpecialMatchWithSource(puuid, queueId);
        return result.matches;
    };

    public querySpecialMatchWithSource = async (
        puuid: string,
        queueId: number,
    ): Promise<ProcessedMatchHistory> => {
        const result = await this.dealMatchHistoryWithSource(puuid, 0, 60);
        if (result === null) {
            return { matches: [], source: null };
        }
        const specialList = result.matches.filter(
            (matchList) => matchList.queueId === queueId,
        );

        return { matches: specialList, source: result.source };
    };

    public timestampToDate = (timestamp: number): [string, string] => {
        const date = new Date(timestamp);
        // 获取时间
        const hours = date.getHours().toString().padStart(2, "0");
        const minutes = date.getMinutes().toString().padStart(2, "0");
        return [
            `${hours} : ${minutes}`,
            date.getMonth() + 1 + "-" + date.getDate(),
        ];
    };
}
