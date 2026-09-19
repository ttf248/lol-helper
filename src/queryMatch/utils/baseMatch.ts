import { querySummonerInfo } from "@/lcu/aboutSummoner";
import { Games, SimpleMatchDetailsTypes } from "@/lcu/types/queryMatchLcuTypes";
import {
    MatchHistoryEndpoint,
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
import { mergeHistoryGames as mergeNormalizedHistoryGames } from "@/recentMatch/utils/historyData";
import { modeForQueue, MatchModeKey } from "@/recentMatch/utils/matchMode";
import {
    HISTORY_ANALYSIS_LIMIT,
    HISTORY_SERVER_FETCH_LIMIT,
} from "@/recentMatch/utils/historyConfig";

export interface ProcessedMatchHistory {
    matches: SimpleMatchDetailsTypes[];
    source: MatchHistorySource | null;
    sourceEndpoints: MatchHistoryEndpoint[];
    localCacheUsed: boolean;
    /** 本地缓存与最近服务器窗口合并后的可用记录数。 */
    availableCount: number;
}

export default class BaseMatch {
    public summonerId = 0;
    private recentServerHistory = new Map<
        string,
        {
            games: (Games | GamesBySgp)[];
            source: MatchHistorySource;
            sourceEndpoints: MatchHistoryEndpoint[];
        }
    >();

    private syncRecentServerHistory = async (
        puuid: string,
    ): Promise<{
        games: (Games | GamesBySgp)[];
        source: MatchHistorySource | null;
        sourceEndpoints: MatchHistoryEndpoint[];
        failed: boolean;
    }> => {
        const result = await queryMatchHistoryWithSource(
            puuid,
            0,
            HISTORY_SERVER_FETCH_LIMIT,
        );
        if (result) {
            this.recentServerHistory.set(puuid, {
                games: result.games,
                source: result.source,
                sourceEndpoints: result.endpoints,
            });
        }
        return {
            games: result?.games ?? [],
            source: result?.source ?? null,
            sourceEndpoints: result?.endpoints ?? [],
            failed: result === null,
        };
    };

    private mergeHistoryGames = (
        cachedGames: NormalizedHistoryGame[],
        serverGames: (Games | GamesBySgp)[],
        limit: number,
        source = "interface",
    ): NormalizedHistoryGame[] => {
        const normalizedServerGames = serverGames
            .map((rawGame) => normalizeHistoryGame(rawGame, source))
            .filter(
                (game): game is NormalizedHistoryGame => game !== null,
            );
        return mergeNormalizedHistoryGames(
            cachedGames,
            normalizedServerGames,
            limit,
        ).games;
    };

    private cacheNormalizedGames = (
        puuid: string,
        games: (Games | GamesBySgp)[],
        source: MatchHistorySource,
        summonerName: string,
    ) => {
        const gamesByMode = new Map<MatchModeKey, NormalizedHistoryGame[]>();
        for (const rawGame of games) {
            const normalized = normalizeHistoryGame(rawGame, source);
            if (!normalized) continue;
            const modeKey = modeForQueue(normalized.queueId);
            const modeGames = gamesByMode.get(modeKey) || [];
            modeGames.push(normalized);
            gamesByMode.set(modeKey, modeGames);
        }
        for (const [modeKey, modeGames] of gamesByMode) {
            void cacheHistory({
                puuid,
                summonerId: this.summonerId,
                summonerName,
                modeKey,
                source,
                games: modeGames,
            });
        }
    };

    public gerSummonerInfo = async (summonerId?: number) => {
        const summonerInfo = await querySummonerInfo(summonerId);
        if (summonerInfo !== null) {
            // 查询其它玩家时也同步当前实例的目标 ID，避免把缓存归属写成
            // 上一次打开的本地玩家。
            this.summonerId = summonerInfo.currentId;
            return { summonerInfo };
        }
        return null;
    };

    public dealMatchHistoryWithSource = async (
        puuid: string,
        begIndex: number,
        endIndex: number,
    ): Promise<ProcessedMatchHistory | null> => {
        // 写入玩家id
        let localSumInfo: Partial<sumInfoTypes> = {};
        try {
            localSumInfo = JSON.parse(
                localStorage.getItem("sumInfo") || "{}",
            ) as Partial<sumInfoTypes>;
        } catch {
            localSumInfo = {};
        }
        if (this.summonerId === 0) {
            this.summonerId = localSumInfo.summonerId || 0;
        }

        const requestedCount = Math.max(0, endIndex - begIndex);
        if (requestedCount <= 0) {
            return {
                matches: [],
                source: null,
                sourceEndpoints: [],
                localCacheUsed: false,
                availableCount: 0,
            };
        }

        // 读取本地最新 100 场，再只请求服务器最近三页。服务器结果会
        // 按 gameId 覆盖/补充缓存，最终固定按时间排序后再取页面。
        const cachedGames = await getCachedHistory({
            puuid,
            limit: HISTORY_ANALYSIS_LIMIT,
            offset: 0,
        });
        // 首次查询或重新回到第一页时刷新服务器最近三页；同一玩家
        // 后续翻页复用本次服务器窗口，第四页及更早页面只读本地缓存。
        const serverHistory = this.recentServerHistory.get(puuid);
        const synced =
            begIndex === 0 || !serverHistory
                ? await this.syncRecentServerHistory(puuid)
                : {
                      games: serverHistory.games,
                      source: serverHistory.source,
                      sourceEndpoints: serverHistory.sourceEndpoints,
                      failed: false,
                  };
        const mergedGames = this.mergeHistoryGames(
            cachedGames,
            synced.games,
            HISTORY_ANALYSIS_LIMIT,
            synced.source || "interface",
        );
        const cachedMatches = mergedGames
            .map((game) => this.getSimpleCachedMatch(game, puuid))
            .filter(
                (match): match is SimpleMatchDetailsTypes => match !== null,
            );
        const pageMatches = cachedMatches.slice(begIndex, endIndex);

        if (synced.failed && mergedGames.length === 0) {
            return null;
        }
        if (synced.games.length > 0 && synced.source) {
            // 历史查询面板也负责回填统一分析缓存，后续首页、分页和
            // 模式分析都可以复用这三页 participant 数据。
            this.cacheNormalizedGames(
                puuid,
                synced.games,
                synced.source,
                localSumInfo.name || "",
            );
        }

        return {
            matches: pageMatches,
            source:
                synced.source && cachedGames.length > 0
                    ? "mixed"
                    : synced.source || (cachedGames.length > 0 ? "postgres" : null),
            sourceEndpoints: synced.sourceEndpoints,
            localCacheUsed: cachedGames.length > 0,
            availableCount: cachedMatches.length,
        };
    };

    private getSimpleCachedMatch = (
        match: NormalizedHistoryGame,
        targetPuuid?: string,
    ): SimpleMatchDetailsTypes | null => {
        const participant = match.participants.find(
            (item) =>
                item.puuid === targetPuuid ||
                (this.summonerId > 0 && item.summonerId === this.summonerId),
        );
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

    public querySpecialMatchWithSource = async (
        puuid: string,
        queueId: number,
    ): Promise<ProcessedMatchHistory> => {
        const result = await this.dealMatchHistoryWithSource(
            puuid,
            0,
            HISTORY_ANALYSIS_LIMIT,
        );
        if (result === null) {
            return {
                matches: [],
                source: null,
                sourceEndpoints: [],
                localCacheUsed: false,
                availableCount: 0,
            };
        }
        const specialList = result.matches.filter(
            (matchList) => matchList.queueId === queueId,
        );

        return {
            matches: specialList,
            source: result.source,
            sourceEndpoints: result.sourceEndpoints,
            localCacheUsed: result.localCacheUsed,
            availableCount: specialList.length,
        };
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
