import { MatchItemTypes } from "@/recentMatch/utils/queryTypes";
import { champDict } from "@/resources/champList";
import { queryMatchHistory } from "@/lcu/aboutMatch";
import { Games } from "@/lcu/types/queryMatchLcuTypes";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import { getCachedHistory } from "@/recentMatch/utils/databaseCache";
import { modeForQueue } from "@/recentMatch/utils/matchMode";

class QueryMatch {
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
            if (cachedMatches.length > 0) {
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
        const matchList = await queryMatchHistory(puuid, 0, 10);
        if (matchList !== null) {
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
        const latestMatch = await queryMatchHistory(puuid, 0, 10);
        const specialList: MatchItemTypes[] = [];

        let offset = 0;
        while (offset < 30) {
            const matchHistory =
                offset === 0
                    ? latestMatch
                    : await queryMatchHistory(puuid, offset, offset + 10);
            if (!matchHistory || matchHistory.length === 0) {
                break;
            }
            const filterMatch = matchHistory.filter(
                (games) => queueId === games.queueId,
            );

            for (const game of filterMatch) {
                specialList.push(
                    this.parseMatch(game, puuid, targetSummonerId),
                );
                if (specialList.length === 10) {
                    return specialList;
                }
            }

            offset += 10;
        }
        if (specialList.length === 0 && latestMatch !== null) {
            return latestMatch.map((games) =>
                this.parseMatch(games, puuid, targetSummonerId),
            );
        } else return specialList;
    };
}

export default QueryMatch;
