import { MatchItemTypes } from "@/recentMatch/utils/queryTypes";
import { champDict } from "@/resources/champList";
import { queryMatchHistoryWithSource } from "@/lcu/aboutMatch";
import { Games } from "@/lcu/types/queryMatchLcuTypes";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import {
    cacheHistory,
    getCachedHistory,
} from "@/recentMatch/utils/databaseCache";
import { modeForQueue, MatchModeKey } from "@/recentMatch/utils/matchMode";
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
        // 只缓存当前请求返回的 participant；写库在首屏请求内完成，
        // 后续完整分析即可直接读取这批最近数据，不会立即重复拉取 100 场。
        await this.cacheRawGames(puuid, result.games, result.source);
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

        return participants[0];
    };

    public queryMatchHistory = async (
        puuid: string,
        queueId: number,
        targetSummonerId?: number,
    ): Promise<[MatchItemTypes[], number]> => {
        try {
            const cachedMatches = await getCachedHistory({
                puuid,
                queueId,
                modeKey: modeForQueue(queueId),
                limit: 10,
            });
            if (cachedMatches.length >= 10) {
                const matches = cachedMatches.map((game) => {
                    const participant = game.participants.find(
                        (item) =>
                            item.puuid === puuid ||
                            item.summonerId === targetSummonerId,
                    ) || game.participants[0];
                    const championId = participant?.championId || 0;
                    const alias = champDict[String(championId)]?.alias;
                    return {
                        champImg: alias
                            ? `https://game.gtimg.cn/images/lol/act/img/champion/${alias}.png`
                            : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`,
                        championId,
                        kills: participant?.kills || 0,
                        deaths: participant?.deaths || 0,
                        assists: participant?.assists || 0,
                        isWin: Boolean(participant?.win),
                        gameId: game.gameId,
                        queueId: game.queueId,
                    } satisfies MatchItemTypes;
                });
                return [matches, matches.filter((match) => match.isWin).length];
            }

            let matchList: MatchItemTypes[] = [];

            // Get match list based on queue type
            if (queueId === 420 || queueId === 440) {
                matchList = await this.findSpecialMatch(
                    puuid,
                    queueId,
                    targetSummonerId,
                );
            } else {
                matchList = await this.findMatch(puuid, targetSummonerId);
            }

            // Remove duplicate matches by gameId
            const uniqueMatches = matchList.reduce(
                (acc: MatchItemTypes[], current) => {
                    if (!acc.some((match) => match.gameId === current.gameId)) {
                        acc.push(current);
                    }
                    return acc;
                },
                [],
            );

            const winCount = matchList.filter((match) => match.isWin).length;

            return [uniqueMatches, winCount];
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
    ): MatchItemTypes => {
        const p0 = this.findParticipant(games, targetPuuid, targetSummonerId);
        if (p0 === undefined) {
            throw new Error(`Match ${games.gameId} has no participants`);
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
        };
    };

    public findMatch = async (
        puuid: string,
        targetSummonerId?: number,
    ): Promise<MatchItemTypes[]> => {
        const matchList = await this.queryRawHistory(puuid, 0, 10);
        if (matchList.length > 0) {
            return matchList.map((games) =>
                this.parseMatch(games, puuid, targetSummonerId),
            );
        } else {
            return [];
        }
    };

    public findSpecialMatch = async (
        puuid: string,
        queueId: number,
        targetSummonerId?: number,
    ): Promise<MatchItemTypes[]> => {
        const latestMatch = await this.queryRawHistory(puuid, 0, 10);
        const specialList: MatchItemTypes[] = [];

        for (const game of latestMatch.filter(
            (item) => queueId === item.queueId,
        )) {
            specialList.push(this.parseMatch(game, puuid, targetSummonerId));
        }
        // 首屏只读取最近一页；完整模式历史由后台分析任务按需补齐。
        // 这样排位/大乱斗混合历史不会阻塞整个对局面板几十秒。
        if (specialList.length === 0) {
            return latestMatch.map((games) =>
                this.parseMatch(games, puuid, targetSummonerId),
            );
        }
        return specialList;
    };
}

export default QueryMatch;
