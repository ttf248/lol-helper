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

// 分页和模式筛选共享最近服务器窗口。短 TTL 内翻页/切换模式不应重复
// 请求相同的 60 场，也不应重复把同一批数据写入 PostgreSQL。
const SERVER_HISTORY_CACHE_TTL_MS = 30_000;

// 记录上次写入 PG 的内容指纹。同 PUUID + modeKey 在两次同步之间 gameId
// 列表未变化时跳过 cacheHistory 调用，省掉 IPC + UPSERT 往返。写入完成后
// 只在源数据出现新 gameId 时才更新。
const lastWriteFingerprint = new Map<string, string>();

export default class BaseMatch {
    public summonerId = 0;
    private recentServerHistory = new Map<
        string,
        {
            games: (Games | GamesBySgp)[];
            source: MatchHistorySource;
            sourceEndpoints: MatchHistoryEndpoint[];
            fetchedAt: number;
            serverLimit: number;
        }
    >();

    private syncRecentServerHistory = async (
        puuid: string,
        serverLimit: number,
    ): Promise<{
        games: (Games | GamesBySgp)[];
        source: MatchHistorySource | null;
        sourceEndpoints: MatchHistoryEndpoint[];
        failed: boolean;
    }> => {
        const result = await queryMatchHistoryWithSource(
            puuid,
            0,
            serverLimit,
        );
        const cacheKey = `${puuid}|${serverLimit}`;
        if (result) {
            this.recentServerHistory.set(cacheKey, {
                games: result.games,
                source: result.source,
                sourceEndpoints: result.endpoints,
                fetchedAt: Date.now(),
                serverLimit,
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
            // 同 (puuid, modeKey) 上次同步的 gameId 列表未变化就跳过：
            // 服务器三页窗口在 30s TTL 内反复复用，内容没变，写 PG 也
            // 是同一条 ON CONFLICT UPDATE，完全是浪费。出现新 gameId
            // 或 server games 比上次少（被动裁剪）才重新写入。
            const sortedIds = modeGames
                .map((game) => game.gameId)
                .sort((a, b) => a - b);
            const fingerprint = sortedIds.join(",");
            const cacheKey = `${puuid}|${modeKey}`;
            if (lastWriteFingerprint.get(cacheKey) === fingerprint) {
                continue;
            }
            lastWriteFingerprint.set(cacheKey, fingerprint);
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
        serverLimit: number = HISTORY_SERVER_FETCH_LIMIT,
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
        // 列表路径只同步最近 20 场，分析面板路径同步全量 60 场；不同
        // serverLimit 各自维护一份 TTL 窗口，避免主窗口首屏等 200ms
        // 串行三页。
        const serverHistory = this.recentServerHistory.get(
            `${puuid}|${serverLimit}`,
        );
        const shouldSync =
            !serverHistory ||
            Date.now() - serverHistory.fetchedAt >= SERVER_HISTORY_CACHE_TTL_MS;
        const synced =
            shouldSync
                ? await this.syncRecentServerHistory(puuid, serverLimit)
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
        if (shouldSync && synced.games.length > 0 && synced.source) {
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
