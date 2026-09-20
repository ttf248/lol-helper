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
    HISTORY_CACHE_PAGE_SIZE,
    HISTORY_CACHE_SYNC_LIMIT,
    HISTORY_COLD_START_PAGES,
    HISTORY_PLAYER_MAX_GAMES,
    HISTORY_SERVER_PAGE_SIZE,
} from "@/recentMatch/utils/historyConfig";
import type {
    HistoryCacheSyncStatus,
    HistoryCacheSyncKind,
} from "@/recentMatch/utils/queryTypes";
import { logger } from "@/utils/logger";

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
// 请求相同的服务器窗口，也不应重复把同一批数据写入 PostgreSQL。
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
        const startedAt = Date.now();
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
        logger.info({
            tag: "home.history",
            message: "首页列表读取发起",
            context: {
                purpose: "首页战绩列表读取（缓存优先 + 服务器最近一页合并）",
                puuid,
                beg_index: begIndex,
                end_index: endIndex,
                requested_count: requestedCount,
                server_limit: serverLimit,
                summoner_id: this.summonerId,
            },
        });
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
            limit: HISTORY_CACHE_PAGE_SIZE,
            offset: 0,
        });
        // 列表路径只同步最近 20 场，分析面板路径按调用方的窗口同步；不同
        // serverLimit 各自维护一份 TTL 窗口，避免主窗口首屏重复请求。
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
            HISTORY_CACHE_PAGE_SIZE,
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
            // 模式分析都可以复用已经拉取的 participant 数据。
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
            availableCount: Math.min(
                HISTORY_PLAYER_MAX_GAMES,
                Math.max(cachedMatches.length, synced.totalCount ?? 0),
            ),
            totalCount: synced.totalCount,
        };
    };

    private logHomeHistoryDone(
        op: string,
        puuid: string,
        startedAt: number,
        extra: Record<string, unknown>,
    ) {
        logger.info({
            tag: "home.history",
            message: `首页列表${op}完成`,
            context: {
                purpose: "首页战绩列表读取",
                op,
                puuid,
                duration_ms: Date.now() - startedAt,
                ...extra,
            },
            durationMs: Date.now() - startedAt,
        });
    }

    /**
     * 在主页后台补齐当前用户的主动同步窗口。
     *
     * 每次只请求一页并在成功后等待 PostgreSQL 写入。整页已经存在时跳过
     * 写入但仍继续检查冷启动范围内的后续页；没有可靠总数时则用短页/空页
     * 判断历史末尾，最多扫描 HISTORY_COLD_START_PAGES 页（当前为 25 页 = 500 场）。
     *
     * 翻页遇本地未覆盖时由 fetchAndCacheSinglePage 单页增量补齐，不会
     * 继续向更早历史走 scan 循环。
     */
    public syncCurrentUserHistory = async (
        puuid: string,
        onProgress?: (progress: HistoryCacheSyncProgress) => void,
        shouldContinue: () => boolean = () => true,
    ): Promise<HistoryCacheSyncResult> => {
        const startedAt = Date.now();
        // 服务启动 / 登录后后台最多缓存最近 500 场，首屏不会等待这项任务；
        // 翻页仍可复用已写入 PG 的结果。
        const maxPages = HISTORY_COLD_START_PAGES;
        logger.info({
            tag: "home.history",
            message: "冷启动同步发起",
            context: {
                purpose: "主页当前用户后台逐页回填历史战绩到 PG",
                op: "syncCurrentUserHistory",
                puuid,
                max_pages: maxPages,
                page_size: HISTORY_SERVER_PAGE_SIZE,
                sync_limit: HISTORY_CACHE_SYNC_LIMIT,
            },
        });
        const pageSize = HISTORY_SERVER_PAGE_SIZE;
        let totalPages: number | null = null;
        let totalCount: number | null = null;
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
                totalCount,
                maxPages,
                cachedGames: cachedGameIds.size,
                downloadedGames,
                message,
                detail,
            };
            logger.info({
                tag: "home.history",
                message: `冷启动同步阶段事件：${kind}`,
                context: {
                    purpose: "主页当前用户后台逐页回填历史战绩到 PG",
                    op: "syncCurrentUserHistory",
                    puuid,
                    kind,
                    current_page: currentPage,
                    max_pages: maxPages,
                    total_pages: totalPages,
                    total_count: totalCount,
                    cached_games: cachedGameIds.size,
                    downloaded_games: downloadedGames,
                    progress_message: message,
                    progress_detail: detail,
                    elapsed_ms: Date.now() - startedAt,
                },
            });
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
            logger.info({
                tag: "home.history",
                message: `冷启动同步第 ${currentPage}/${maxPages} 页发起`,
                context: {
                    purpose: "主页当前用户后台逐页回填历史战绩到 PG",
                    op: "syncCurrentUserHistory",
                    puuid,
                    current_page: currentPage,
                    max_pages: maxPages,
                    page_size: HISTORY_SERVER_PAGE_SIZE,
                    beg_index: pageIndex * HISTORY_SERVER_PAGE_SIZE,
                    end_index: (pageIndex + 1) * HISTORY_SERVER_PAGE_SIZE,
                    cached_before_page: cachedGameIds.size,
                },
            });
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

            // null 表示接口没有可靠的全局总数。不能使用 Number(null)，
            // 否则会把“未知总数”转换成 0，令 totalPages=1，后台同步
            // 在第一页就提前结束（并把首页分页收缩成一页）。
            const reportedTotalCount =
                pageResult.totalCount !== null &&
                Number.isFinite(pageResult.totalCount) &&
                pageResult.totalCount >= 0
                    ? pageResult.totalCount
                    : null;
            if (reportedTotalCount !== null) {
                totalCount = Math.max(totalCount ?? 0, reportedTotalCount);
                totalPages = Math.max(
                    currentPage,
                    Math.ceil(totalCount / pageSize),
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
                // 缓存目标是配置的最大窗口，而不是“遇到第一页已缓存
                // 就停止”。只有接口明确到末尾或已达到报告的总页数才结束。
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
            `已达到主动同步上限，当前已缓存 ${cachedGameIds.size} 场；更早历史不在本次窗口内。`,
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
        const startedAt = Date.now();
        const pageSize = HISTORY_SERVER_PAGE_SIZE;
        logger.info({
            tag: "home.history",
            message: "首页翻页单页增量拉取发起",
            context: {
                purpose: "首页翻页遇本地未覆盖时单页增量拉取并写入缓存",
                op: "fetchAndCacheSinglePage",
                puuid,
                page_index: pageIndex,
                page_size: pageSize,
                beg_index: pageIndex * pageSize,
                end_index: (pageIndex + 1) * pageSize,
            },
        });
        const safePageIndex = Math.max(0, Math.floor(pageIndex));
        if (safePageIndex * pageSize >= HISTORY_PLAYER_MAX_GAMES) {
            logger.info({
                tag: "home.history",
                message: "首页翻页达到单玩家主动同步上限",
                context: {
                    purpose: "首页翻页遇本地未覆盖时单页增量拉取并写入缓存",
                    op: "fetchAndCacheSinglePage",
                    puuid,
                    page_index: safePageIndex,
                    max_games: HISTORY_PLAYER_MAX_GAMES,
                },
            });
            return { cachedGames: 0, reachedEnd: true };
        }
        const begIndex = safePageIndex * pageSize;
        const endIndex = Math.min(
            begIndex + pageSize,
            HISTORY_PLAYER_MAX_GAMES,
        );

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

        logger.info({
            tag: "home.history",
            message: "首页翻页单页增量拉取完成",
            context: {
                purpose: "首页翻页遇本地未覆盖时单页增量拉取并写入缓存",
                op: "fetchAndCacheSinglePage",
                puuid,
                page_index: pageIndex,
                write_succeeded: writeSucceeded,
                cached_games: writeSucceeded ? pageGames.length : 0,
                reached_end: pageResult.games.length < pageSize,
                duration_ms: Date.now() - startedAt,
            },
            durationMs: Date.now() - startedAt,
        });

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
            HISTORY_CACHE_PAGE_SIZE,
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
