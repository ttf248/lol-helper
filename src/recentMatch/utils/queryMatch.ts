import { MatchItemTypes } from "@/recentMatch/utils/queryTypes";
import { champDict } from "@/resources/champList";
import { queryMatchHistoryWithSource } from "@/lcu/aboutMatch";
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

const HISTORY_PAGE_SIZE = 20;
const HISTORY_SYNC_SCAN_LIMIT = 300;
const HISTORY_SYNC_GAME_LIMIT = 100;

class QueryMatch {
    private cacheRawGames = async (
        puuid: string,
        games: (Games | GamesBySgp)[],
        source: string,
    ) => {
        const gamesByMode = new Map<MatchModeKey, NormalizedHistoryGame[]>();
        for (const rawGame of games) {
            const normalized = normalizeHistoryGame(rawGame);
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

    private queryRawHistory = async (
        puuid: string,
        begIndex: number,
        endIndex: number,
    ): Promise<(Games | GamesBySgp)[]> => {
        const result = await queryMatchHistoryWithSource(
            puuid,
            begIndex,
            endIndex,
        );
        if (!result || result.games.length === 0) return [];
        // 缓存写入不再阻塞首屏。当前请求的数据已经可以直接渲染，
        // 后续分析会优先使用 player.matchList；数据库在后台完成持久化。
        void this.cacheRawGames(puuid, result.games, result.source).catch((error) => {
            console.warn("Failed to persist recent match cache", error);
        });
        return result.games;
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
    ): Promise<[MatchItemTypes[], number]> => {
        try {
            const modeKey = modeForQueue(queueId);
            const cachedMatches = await getCachedHistory({
                puuid,
                // 对局内历史按模式读取，而不是把 420/440 或 400/430/490
                // 拆成不同数据集；这样缓存和接口的筛选边界完全一致。
                modeKey,
                limit: HISTORY_SYNC_GAME_LIMIT,
            });
            const cachedMatchItems = cachedMatches
                .map((game) =>
                    this.cachedGameToMatch(game, puuid, targetSummonerId),
                )
                .filter(
                    (match): match is MatchItemTypes => match !== null,
                );

            // 缓存永远不是停止条件。每次打开对局面板都从服务器读取
            // 最新分页；服务器返回某局 gameId 已存在于本地缓存后，才
            // 认为已经追到缓存边界并停止继续向后翻页。
            const apiMatches = await this.findMatch(
                puuid,
                modeKey,
                targetSummonerId,
                new Set(cachedMatches.map((game) => game.gameId)),
            );
            const matches = this.uniqueAndSortMatches([
                ...cachedMatchItems,
                ...apiMatches,
            ]).slice(0, 10);
            return [matches, matches.filter((match) => match.isWin).length];
        } catch (error) {
            console.error("Error in queryMatchHistory:", error);
            // Return default values in case of error
            return [[], 0];
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

    public findMatch = async (
        puuid: string,
        modeKey: MatchModeKey,
        targetSummonerId?: number,
        cachedGameIds: Set<number> = new Set(),
    ): Promise<MatchItemTypes[]> => {
        const matchList: MatchItemTypes[] = [];
        const seenGameIds = new Set<number>();
        let reachedCachedBoundary = false;

        for (
            let offset = 0;
            offset < HISTORY_SYNC_SCAN_LIMIT;
            offset += HISTORY_PAGE_SIZE
        ) {
            const games = await this.queryRawHistory(
                puuid,
                offset,
                Math.min(offset + HISTORY_PAGE_SIZE, HISTORY_SYNC_SCAN_LIMIT),
            );
            if (games.length === 0) break;

            for (const game of games) {
                if (!isModeQueue(game.queueId, modeKey)) continue;
                if (cachedGameIds.has(game.gameId)) {
                    reachedCachedBoundary = true;
                }

                const match = this.parseMatch(game, puuid, targetSummonerId);
                if (match && !seenGameIds.has(match.gameId)) {
                    seenGameIds.add(match.gameId);
                    matchList.push(match);
                }
            }

            // 最新 100 场已经足够支撑当前面板和后续分析；如果这一页
            // 已碰到本地已有 gameId，且合并后的样本已经覆盖 100 场，
            // 才算追到缓存边界。缓存不足 100 场时仍继续向后查询。
            const mergedGameCount = new Set([
                ...cachedGameIds,
                ...seenGameIds,
            ]).size;
            if (
                (reachedCachedBoundary &&
                    mergedGameCount >= HISTORY_SYNC_GAME_LIMIT) ||
                (cachedGameIds.size === 0 &&
                    matchList.length >= HISTORY_SYNC_GAME_LIMIT) ||
                games.length < HISTORY_PAGE_SIZE
            ) {
                break;
            }
        }

        return this.uniqueAndSortMatches(matchList).slice(
            0,
            HISTORY_SYNC_GAME_LIMIT,
        );
    };
}

export default QueryMatch;
