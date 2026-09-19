import {
    MatchItemTypes,
    RecentHistoryStatus,
} from "@/recentMatch/utils/queryTypes";
import { champDict } from "@/resources/champList";
import {
    MatchHistoryEndpoint,
    queryMatchHistoryWithSource,
} from "@/lcu/aboutMatch";
import { Games } from "@/lcu/types/queryMatchLcuTypes";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import {
    cacheHistory,
    getCachedHistory,
} from "@/recentMatch/utils/databaseCache";
import {
    isModeQueue,
    modeForQueue,
    MatchModeKey,
} from "@/recentMatch/utils/matchMode";
import {
    normalizeHistoryGame,
    NormalizedHistoryGame,
} from "@/recentMatch/utils/recentAnalytics";
import { HISTORY_ANALYSIS_LIMIT, HISTORY_SERVER_FETCH_LIMIT } from "@/recentMatch/utils/historyConfig";

interface MatchSearchResult {
    matches: MatchItemTypes[];
    serverGames: number;
    modeGames: number;
    matchedGames: number;
    requestFailed: boolean;
    sourceEndpoints: MatchHistoryEndpoint[];
}

class QueryMatch {
    private cacheRawGames = async (
        puuid: string,
        games: (Games | GamesBySgp)[],
        source: string,
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
        await Promise.all(
            Array.from(gamesByMode.entries()).map(([modeKey, modeGames]) =>
                cacheHistory({
                    puuid,
                    modeKey,
                    source,
                    games: modeGames,
                }),
            ),
        );
    };

    private buildHistoryStatus = (
        cachedGames: number,
        search: MatchSearchResult,
    ): RecentHistoryStatus => {
        const common = {
            cachedGames,
            serverGames: search.serverGames,
            modeGames: search.modeGames,
            matchedGames: search.matchedGames,
            sourceEndpoints: search.sourceEndpoints,
        };

        if (search.matches.length > 0) {
            if (search.requestFailed) {
                return {
                    ...common,
                    kind: "cache-fallback",
                    title: "接口查询未完成，已使用可用数据",
                    detail: `服务器最近三页请求失败或超时，当前显示本地缓存及已返回的 ${search.matches.length} 场。`,
                };
            }
            if (search.serverGames === 0) {
                return {
                    ...common,
                    kind: "cache-fallback",
                    title: "接口暂无新数据，已使用本地缓存",
                    detail: `接口正常返回空列表，当前显示本地缓存 ${cachedGames} 场。`,
                };
            }
            if (search.modeGames === 0) {
                return {
                    ...common,
                    kind: "cache-fallback",
                    title: "当前模式未命中接口记录",
                    detail: `服务器最近三页返回了 ${search.serverGames} 场历史对局，但没有当前模式记录，已显示本地缓存 ${cachedGames} 场。`,
                };
            }
            if (search.matchedGames === 0) {
                return {
                    ...common,
                    kind: "cache-fallback",
                    title: "接口未匹配到该玩家",
                    detail: `接口返回了当前模式对局，但无法用 PUUID/召唤师 ID 匹配该玩家，已显示本地缓存 ${cachedGames} 场。`,
                };
            }
            return {
                ...common,
                kind: "ready",
                title: "历史战绩已加载",
                detail: `已合并本地缓存 ${cachedGames} 场与服务器最近三页中匹配的 ${search.matchedGames} 场。`,
            };
        }

        if (search.requestFailed) {
            return {
                ...common,
                kind: "error",
                title: "历史接口请求失败",
                detail: "服务器最近三页请求失败或超时，且本地没有可用的该模式缓存。",
            };
        }
        if (search.serverGames === 0) {
            return {
                ...common,
                kind: "no-data",
                title: "接口没有返回历史对局",
                detail: "接口已正常返回，但没有可用的公开历史战绩。",
            };
        }
        if (search.modeGames === 0) {
            return {
                ...common,
                kind: "mode-empty",
                title: "当前模式没有历史记录",
                detail: `接口返回了 ${search.serverGames} 场历史对局，但服务器最近三页内没有当前模式记录。`,
            };
        }
        if (search.matchedGames === 0) {
            return {
                ...common,
                kind: "identity-mismatch",
                title: "玩家身份匹配失败",
                detail: `接口返回了 ${search.modeGames} 场当前模式对局，但没有找到该玩家的 PUUID/召唤师 ID。`,
            };
        }
        return {
            ...common,
            kind: "no-data",
            title: "没有可用的有效战绩",
            detail: "接口返回了数据，但无法解析为该玩家的有效历史记录。",
        };
    };

    private findParticipant = (
        match: Games | GamesBySgp,
        targetPuuid?: string,
        targetSummonerId?: number,
    ) => {
        const participants = match.participants ?? [];
        const directParticipant = participants.find((participant: any) =>
            (targetPuuid !== undefined && participant.puuid === targetPuuid) ||
            (targetSummonerId !== undefined &&
                participant.summonerId === targetSummonerId),
        );
        if (directParticipant !== undefined) {
            return directParticipant;
        }

        if ("participantIdentities" in match) {
            const identity = match.participantIdentities?.find((item) => {
                const player = item.player as any;
                return (
                    (targetPuuid !== undefined && player.puuid === targetPuuid) ||
                    (targetSummonerId !== undefined &&
                        player.summonerId === targetSummonerId)
                );
            });
            if (identity !== undefined) {
                const identityParticipant = participants.find(
                    (participant: any) =>
                        participant.participantId === identity.participantId,
                );
                if (identityParticipant !== undefined) {
                    return identityParticipant;
                }
            }
        }

        // 找不到目标身份时不能回退到 participants[0]。不同玩家的
        // participants 顺序并不代表当前查询对象，回退会把队友的 KDA
        // 伪装成目标玩家的历史，正是缓存/API 混用时最难发现的错位来源。
        return undefined;
    };

    private cachedGameToMatch = (
        game: NormalizedHistoryGame,
        targetPuuid: string,
        targetSummonerId?: number,
    ): MatchItemTypes | null => {
        const participant = game.participants.find(
            (item) =>
                item.puuid === targetPuuid ||
                (targetSummonerId !== undefined &&
                    item.summonerId === targetSummonerId),
        );
        if (!participant) return null;

        const championId = participant.championId || 0;
        const alias = champDict[String(championId)]?.alias;
        return {
            champImg: alias
                ? `https://game.gtimg.cn/images/lol/act/img/champion/${alias}.png`
                : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`,
            championId,
            kills: participant.kills || 0,
            deaths: participant.deaths || 0,
            assists: participant.assists || 0,
            isWin: Boolean(participant.win),
            gameId: game.gameId,
            queueId: game.queueId,
            gameCreation: game.gameCreation,
        };
    };

    private uniqueAndSortMatches = (
        matches: MatchItemTypes[],
    ): MatchItemTypes[] => {
        const unique = new Map<number, MatchItemTypes>();
        for (const match of matches) {
            const previous = unique.get(match.gameId);
            const currentCreation = Number(match.gameCreation || 0);
            const previousCreation = Number(previous?.gameCreation || 0);
            if (!previous || currentCreation > previousCreation) {
                unique.set(match.gameId, match);
            }
        }
        return Array.from(unique.values()).sort(
            (left, right) =>
                Number(right.gameCreation || 0) - Number(left.gameCreation || 0),
        );
    };

    public queryMatchHistory = async (
        puuid: string,
        queueId: number,
        targetSummonerId?: number,
    ): Promise<[MatchItemTypes[], number, RecentHistoryStatus]> => {
        try {
            const modeKey = modeForQueue(queueId);
            const cachedMatches = await getCachedHistory({
                puuid,
                // 对局内历史按模式读取，而不是把 420/440 或 400/430/490
                // 拆成不同数据集；这样缓存和接口的筛选边界完全一致。
                modeKey,
                limit: HISTORY_ANALYSIS_LIMIT,
            });
            const cachedMatchItems = cachedMatches
                .map((game) =>
                    this.cachedGameToMatch(game, puuid, targetSummonerId),
                )
                .filter(
                    (match): match is MatchItemTypes => match !== null,
                );

            // 每次打开对局面板只读取服务器最近三页，再与本地缓存按
            // gameId 合并；更早记录不会触发服务器继续翻页。
            const search = await this.findMatchesWithStatus(
                puuid,
                modeKey,
                targetSummonerId,
            );
            const matches = this.uniqueAndSortMatches([
                ...cachedMatchItems,
                ...search.matches,
            ]).slice(0, 10);
            const status = this.buildHistoryStatus(cachedMatchItems.length, {
                ...search,
                matches,
            });
            return [
                matches,
                matches.filter((match) => match.isWin).length,
                status,
            ];
        } catch (error) {
            console.error("Error in queryMatchHistory:", error);
            // Return default values in case of error
            return [
                [],
                0,
                {
                    kind: "error",
                    title: "历史战绩查询异常",
                    detail: "查询过程发生异常，且当前没有可用的历史战绩。",
                    cachedGames: 0,
                    serverGames: 0,
                    modeGames: 0,
                    matchedGames: 0,
                    sourceEndpoints: [],
                },
            ];
        }
    };

    public parseMatch = (
        games: Games | GamesBySgp,
        targetPuuid?: string,
        targetSummonerId?: number,
    ): MatchItemTypes | null => {
        const p0 = this.findParticipant(games, targetPuuid, targetSummonerId);
        if (p0 === undefined) {
            return null;
        }

        // 1. 统一战斗数据源 (LCU 嵌套在 stats，SGP 就在 p0)
        const statsSource = "stats" in p0 ? p0.stats : p0;

        // 2. 提取核心字段
        const { win, kills, deaths, assists } = statsSource;
        const { championId } = p0; // championId 始终在参与者根节点

        // 4. 获取英雄别名

        const champAlias = champDict[String(championId)]?.alias;
        // 字典缺英雄时回退到 CommunityDragon 图标
        const champImgUrl = champAlias
            ? `https://game.gtimg.cn/images/lol/act/img/champion/${champAlias}.png`
            : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;

        return {
            champImg: champImgUrl,
            championId,
            kills,
            deaths,
            assists,
            isWin: !!win,
            gameId: games.gameId,
            queueId: games.queueId,
            gameCreation: games.gameCreation,
        };
    };

    private findMatchesWithStatus = async (
        puuid: string,
        modeKey: MatchModeKey,
        targetSummonerId?: number,
    ): Promise<MatchSearchResult> => {
        const matchList: MatchItemTypes[] = [];
        const seenGameIds = new Set<number>();
        let serverGames = 0;
        let modeGames = 0;
        let matchedGames = 0;
        let requestFailed = false;
        let sourceEndpoints: MatchHistoryEndpoint[] = [];

        const result = await queryMatchHistoryWithSource(
            puuid,
            0,
            HISTORY_SERVER_FETCH_LIMIT,
        );
        if (!result) {
            requestFailed = true;
        } else {
            // 缓存写入不阻塞首屏；三页服务器数据会在后台持久化，
            // 下一次查询直接参与本地合并。
            void this.cacheRawGames(puuid, result.games, result.source).catch(
                (error) => {
                    console.warn("Failed to persist recent match cache", error);
                },
            );
            serverGames = result.games.length;
            sourceEndpoints = result.endpoints;

            for (const game of result.games) {
                if (!isModeQueue(game.queueId, modeKey)) continue;
                modeGames += 1;

                const match = this.parseMatch(game, puuid, targetSummonerId);
                if (match && !seenGameIds.has(match.gameId)) {
                    seenGameIds.add(match.gameId);
                    matchList.push(match);
                    matchedGames += 1;
                }
            }
        }

        return {
            matches: this.uniqueAndSortMatches(matchList).slice(
                0,
                HISTORY_ANALYSIS_LIMIT,
            ),
            serverGames,
            modeGames,
            matchedGames,
            requestFailed,
            sourceEndpoints,
        };
    };

    /** 保留旧的公开方法，供其它调用方继续取得纯战绩列表。 */
    public findMatch = async (
        puuid: string,
        modeKey: MatchModeKey,
        targetSummonerId?: number,
    ): Promise<MatchItemTypes[]> => {
        const result = await this.findMatchesWithStatus(
            puuid,
            modeKey,
            targetSummonerId,
        );
        return result.matches;
    };
}

export default QueryMatch;
