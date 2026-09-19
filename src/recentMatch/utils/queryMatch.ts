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
                limit: 10,
            });
            const cachedMatchItems = cachedMatches
                .map((game) =>
                    this.cachedGameToMatch(game, puuid, targetSummonerId),
                )
                .filter(
                    (match): match is MatchItemTypes => match !== null,
                );

            // 缓存不足时只补同一模式的接口数据，绝不把“最近 10 场
            // 混合模式”直接展示。接口结果和缓存结果最后统一按真实
            // gameCreation 去重、排序，避免某个玩家被旧数据顶到前面。
            const apiMatches = cachedMatchItems.length >= 10
                ? []
                : await this.findMatch(puuid, modeKey, targetSummonerId);
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
    ): Promise<MatchItemTypes[]> => {
        // 多读取一页只用于筛掉其它模式；返回给面板的仍然最多 10 场。
        const matchList = await this.queryRawHistory(puuid, 0, 20);
        if (matchList.length > 0) {
            return matchList
                .filter((game) => isModeQueue(game.queueId, modeKey))
                .map((games) => this.parseMatch(games, puuid, targetSummonerId))
                .filter(
                    (match): match is MatchItemTypes => match !== null,
                )
                .slice(0, 10);
        } else {
            return [];
        }
    };
}

export default QueryMatch;
