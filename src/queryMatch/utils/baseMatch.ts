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
    getCachedHistoryPage,
} from "@/recentMatch/utils/databaseCache";
import {
    normalizeHistoryGame,
    NormalizedHistoryGame,
} from "@/recentMatch/utils/recentAnalytics";
import { mergeHistoryGames as mergeNormalizedHistoryGames } from "@/recentMatch/utils/historyData";
import { modeForQueue, MatchModeKey } from "@/recentMatch/utils/matchMode";
import {
    HISTORY_ANALYSIS_LIMIT,
    HISTORY_CACHE_SYNC_LIMIT,
    HISTORY_COLD_START_PAGES,
    HISTORY_SERVER_PAGE_SIZE,
} from "@/recentMatch/utils/historyConfig";
import type {
    HistoryCacheSyncStatus,
    HistoryCacheSyncKind,
} from "@/recentMatch/utils/queryTypes";

export interface ProcessedMatchHistory {
    matches: SimpleMatchDetailsTypes[];
    source: MatchHistorySource | null;
    sourceEndpoints: MatchHistoryEndpoint[];
    localCacheUsed: boolean;
    /** 本地缓存与最近服务器窗口合并后的可用记录数。 */
    availableCount: number;
    /** 服务器在当前查询中明确提供的历史总场数。 */
    totalCount: number | null;
}

// 分页和模式筛选共享最近服务器窗口。短 TTL 内翻页/切换模式不应重复
// 请求相同的 60 场，也不应重复把同一批数据写入 PostgreSQL。
const SERVER_HISTORY_CACHE_TTL_MS = 30_000;

// 记录上次写入 PG 的内容指纹。同 PUUID + modeKey 在两次同步之间 gameId
// 列表未变化时跳过 cacheHistory 调用，省掉 IPC + UPSERT 往返。写入完成后
// 只在源数据出现新 gameId 时才更新。
const lastWriteFingerprint = new Map<string, string>();
const cacheWriteInFlight = new Map<string, Promise<boolean>>();

export type HistoryCacheSyncProgress = HistoryCacheSyncStatus;

export interface HistoryCacheSyncResult extends HistoryCacheSyncStatus {}

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
            totalCount: number | null;
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
        totalCount: number | null;
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
                totalCount: result.totalCount,
            });
        }
        return {
            games: result?.games ?? [],
            source: result?.source ?? null,
            sourceEndpoints: result?.endpoints ?? [],
            failed: result === null,
            totalCount: result?.totalCount ?? null,
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

    private cacheNormalizedGames = async (
        puuid: string,
        games: (Games | GamesBySgp)[],
        source: MatchHistorySource,
        summonerName: string,
    ): Promise<boolean> => {
        const gamesByMode = new Map<MatchModeKey, NormalizedHistoryGame[]>();
        for (const rawGame of games) {
            const normalized = normalizeHistoryGame(rawGame, source);
            if (!normalized) continue;
            const modeKey = modeForQueue(normalized.queueId);
            const modeGames = gamesByMode.get(modeKey) || [];
            modeGames.push(normalized);
            gamesByMode.set(modeKey, modeGames);
        }
        const writes = Array.from(gamesByMode.entries()).map(
            ([modeKey, modeGames]) => {
                // 同 (puuid, modeKey) 上次同步的 gameId 列表未变化就跳过：
                // 服务器窗口在短 TTL 内反复复用，内容没变，写 PG 也
                // 是同一条 ON CONFLICT UPDATE，完全是浪费。出现新 gameId
                // 或 server games 比上次少（被动裁剪）才重新写入。
                const sortedIds = modeGames
                    .map((game) => game.gameId)
                    .sort((a, b) => a - b);
                const fingerprint = sortedIds.join(",");
                const cacheKey = `${puuid}|${modeKey}`;
                if (lastWriteFingerprint.get(cacheKey) === fingerprint) {
                    return Promise.resolve(true);
                }

                const previousWrite = cacheWriteInFlight.get(cacheKey);
                if (previousWrite) {
                    return previousWrite.then(async (succeeded) => {
                        // 同一 fingerprint 的并发写入可以复用；如果是
                        // 另一页刚好在写，则当前页仍必须继续落库。
                        if (
                            succeeded &&
                            lastWriteFingerprint.get(cacheKey) === fingerprint
                        ) {
                            return true;
                        }
                        const retrySucceeded = await cacheHistory({
                            puuid,
                            summonerId: this.summonerId,
                            summonerName,
                            modeKey,
                            source,
                            games: modeGames,
                        });
                        if (retrySucceeded) {
                            lastWriteFingerprint.set(cacheKey, fingerprint);
                        }
                        return retrySucceeded;
                    });
                }

                let write: Promise<boolean>;
                write = cacheHistory({
                    puuid,
                    summonerId: this.summonerId,
                    summonerName,
                    modeKey,
                    source,
                    games: modeGames,
                }).then((succeeded) => {
                    if (succeeded) {
                        lastWriteFingerprint.set(cacheKey, fingerprint);
                    }
                    return succeeded;
                }).finally(() => {
                    if (cacheWriteInFlight.get(cacheKey) === write) {
                        cacheWriteInFlight.delete(cacheKey);
                    }
                });
                cacheWriteInFlight.set(cacheKey, write);
                return write;
            },
        );

        if (writes.length === 0) return true;
        const results = await Promise.all(writes);
        return results.every(Boolean);
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
        serverLimit: number = HISTORY_SERVER_PAGE_SIZE,
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
                totalCount: null,
            };
        }

        // 读取本地最新 100 场，再只请求服务器最近一页。服务器结果会
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
                      totalCount: serverHistory.totalCount,
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
            availableCount: Math.max(
                cachedMatches.length,
                synced.totalCount ?? 0,
            ),
            totalCount: synced.totalCount,
        };
    };

    /**
     * 在主页后台补齐当前用户的历史战绩（冷启动最小集）。
     *
     * 每次只请求一页并在成功后等待 PostgreSQL 写入。整页已经存在时跳过
     * 写入但仍继续检查冷启动范围内的后续页；没有可靠总数时则用短页/空页
     * 判断历史末尾，最多扫描 HISTORY_COLD_START_PAGES 页（默认 3 页 = 60 场）。
     *
     * 翻页遇本地未覆盖时由 fetchAndCacheSinglePage 单页增量补齐，不会
     * 继续向更早历史走 scan 循环。
     */
    public syncCurrentUserHistory = async (
        puuid: string,
        onProgress?: (progress: HistoryCacheSyncProgress) => void,
        shouldContinue: () => boolean = () => true,
    ): Promise<HistoryCacheSyncResult> => {
        // 冷启动最小集：服务启动 / 登录后只后台缓存最近 3 页（60 场），
        // 翻页未覆盖时由 fetchAndCacheSinglePage 增量补齐。
        const maxPages = HISTORY_COLD_START_PAGES;
        const pageSize = HISTORY_SERVER_PAGE_SIZE;
        let totalPages: number | null = null;
        let currentPage = 0;
        let downloadedGames = 0;

        const cachedGames = await getCachedHistory({
            puuid,
            limit: HISTORY_CACHE_SYNC_LIMIT,
            offset: 0,
        });
        const cachedGameIds = new Set(
            cachedGames
                .map((game) => Number(game.gameId))
                .filter((gameId) => Number.isFinite(gameId)),
        );

        const emit = (
            kind: HistoryCacheSyncKind,
            message: string,
            detail: string,
        ): HistoryCacheSyncResult => {
            const progress: HistoryCacheSyncResult = {
                kind,
                currentPage,
                totalPages,
                maxPages,
                cachedGames: cachedGameIds.size,
                downloadedGames,
                message,
                detail,
            };
            onProgress?.(progress);
            return progress;
        };

        const cancelled = () =>
            emit(
                "cancelled",
                "历史战绩缓存任务已切换",
                "当前召唤师已变化，停止上一轮后台同步。",
            );

        for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
            if (!shouldContinue()) return cancelled();

            currentPage = pageIndex + 1;
            emit(
                "syncing",
                totalPages
                    ? `正在缓存历史战绩（第 ${currentPage}/${totalPages} 页）`
                    : `正在缓存历史战绩（第 ${currentPage} 页）`,
                `已缓存 ${cachedGameIds.size} 场，本次最多扫描 ${maxPages} 页。`,
            );

            // 首页刚刚取过的第一页可以直接复用，避免为了后台缓存再次
            // 请求同一页；后续页始终按 20 场串行请求。
            const recentPage =
                pageIndex === 0
                    ? this.recentServerHistory.get(`${puuid}|${pageSize}`)
                    : undefined;
            const pageResult =
                recentPage &&
                Date.now() - recentPage.fetchedAt < SERVER_HISTORY_CACHE_TTL_MS
                    ? {
                          games: recentPage.games,
                          source: recentPage.source,
                          endpoints: recentPage.sourceEndpoints,
                          totalCount: recentPage.totalCount ?? null,
                      }
                    : await queryMatchHistoryWithSource(
                          puuid,
                          pageIndex * pageSize,
                          (pageIndex + 1) * pageSize,
                      );

            if (pageResult === null) {
                return emit(
                    "error",
                    "历史战绩缓存未完成",
                    `第 ${currentPage} 页请求失败，已缓存 ${cachedGameIds.size} 场；稍后可重试。`,
                );
            }

            const reportedTotalCount = Number(pageResult.totalCount);
            if (Number.isFinite(reportedTotalCount) && reportedTotalCount >= 0) {
                totalPages = Math.max(
                    currentPage,
                    Math.ceil(reportedTotalCount / pageSize),
                );
            }

            const pageGames = Array.from(
                new Map(
                    pageResult.games
                        .filter((game) => Number.isFinite(game.gameId))
                        .map((game) => [game.gameId, game]),
                ).values(),
            );

            if (pageGames.length === 0) {
                return emit(
                    "complete",
                    "当前历史战绩已全部缓存到数据库",
                    `服务器历史已到末尾，共缓存 ${cachedGameIds.size} 场。`,
                );
            }

            const pageAlreadyCached = pageGames.every((game) =>
                cachedGameIds.has(game.gameId),
            );
            if (pageAlreadyCached) {
                // 冷启动缓存的目标是最近三页，而不是“遇到第一页已缓存
                // 就停止”。数据库可能只存在第一页，仍要继续检查第二、
                // 三页；只有接口明确到末尾或已达到报告的总页数才结束。
                if (
                    pageResult.games.length < pageSize ||
                    (totalPages !== null && currentPage >= totalPages)
                ) {
                    return emit(
                        "complete",
                        "当前历史战绩已全部缓存到数据库",
                        `历史接口已到末尾或已覆盖全部记录，共缓存 ${cachedGameIds.size} 场。`,
                    );
                }
                continue;
            }

            const writeSucceeded = await this.cacheNormalizedGames(
                puuid,
                pageGames,
                pageResult.source,
                this.getLocalSummonerName(),
            );
            if (!writeSucceeded) {
                return emit(
                    "error",
                    "历史战绩缓存未完成",
                    `第 ${currentPage} 页写入 PostgreSQL 失败，已缓存 ${cachedGameIds.size} 场；请检查数据库连接。`,
                );
            }

            for (const game of pageGames) {
                if (!cachedGameIds.has(game.gameId)) {
                    downloadedGames += 1;
                    cachedGameIds.add(game.gameId);
                }
            }

            if (
                pageResult.games.length < pageSize ||
                (totalPages !== null && currentPage >= totalPages)
            ) {
                return emit(
                    "complete",
                    "当前历史战绩已全部缓存到数据库",
                    `历史接口已到末尾，共缓存 ${cachedGameIds.size} 场。`,
                );
            }
        }

        return emit(
            "limited",
            `已缓存最近 ${maxPages} 页历史战绩`,
            `已达到冷启动同步上限，当前已缓存 ${cachedGameIds.size} 场；更早历史将在翻页时按需增量拉取。`,
        );
    };

    /**
     * 首页翻页用：单页增量拉取并写入本地缓存。
     *
     * 命中本地缓存时直接返回；否则向服务器请求该页（20 场）并写入 PG。
     * 写入成功后清掉 recentServerHistory 中该 pageIndex 的 TTL 缓存，避免
     * 下次同步任务读到陈旧分页。
     */
    public fetchAndCacheSinglePage = async (
        puuid: string,
        pageIndex: number,
    ): Promise<{ cachedGames: number; reachedEnd: boolean }> => {
        const pageSize = HISTORY_SERVER_PAGE_SIZE;
        const safePageIndex = Math.max(0, Math.floor(pageIndex));
        const begIndex = safePageIndex * pageSize;
        const endIndex = begIndex + pageSize;

        // 先看本地 PG：已经覆盖的页就不打服务器。
        const cached = await getCachedHistoryPage(puuid, begIndex, pageSize);
        if (cached.length >= pageSize) {
            return { cachedGames: cached.length, reachedEnd: false };
        }

        // 本地无覆盖 → 单页拉服务器
        const pageResult = await queryMatchHistoryWithSource(
            puuid,
            begIndex,
            endIndex,
        );
        if (pageResult === null) {
            return { cachedGames: 0, reachedEnd: false };
        }

        // 短页（< 20）即视为历史末尾；不必再继续翻
        if (pageResult.games.length === 0) {
            return { cachedGames: 0, reachedEnd: true };
        }

        const pageGames = Array.from(
            new Map(
                pageResult.games
                    .filter((game) => Number.isFinite(game.gameId))
                    .map((game) => [game.gameId, game]),
            ).values(),
        );

        // 写入本地缓存（fingerprint 跳过仍生效）
        const writeSucceeded = await this.cacheNormalizedGames(
            puuid,
            pageGames,
            pageResult.source,
            this.getLocalSummonerName(),
        );

        // 清理 TTL 缓存里 serverLimit 等于 20 的条目，避免与本次增量重复
        this.recentServerHistory.delete(`${puuid}|${pageSize}`);

        return {
            cachedGames: writeSucceeded ? pageGames.length : 0,
            reachedEnd: pageResult.games.length < pageSize,
        };
    };

    private getLocalSummonerName = (): string => {
        try {
            const localSumInfo = JSON.parse(
                localStorage.getItem("sumInfo") || "{}",
            ) as Partial<sumInfoTypes>;
            return localSumInfo.name || "";
        } catch {
            return "";
        }
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

    /** 将 PostgreSQL 中的统一历史结构转换成首页列表使用的结构。 */
    public getSimpleMatchList = (
        matches: NormalizedHistoryGame[],
        targetPuuid?: string,
    ): SimpleMatchDetailsTypes[] =>
        matches
            .map((match) => this.getSimpleCachedMatch(match, targetPuuid))
            .filter(
                (match): match is SimpleMatchDetailsTypes => match !== null,
            );

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
                totalCount: null,
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
            totalCount: result.totalCount,
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
