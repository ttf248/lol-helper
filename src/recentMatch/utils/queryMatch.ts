import { MatchItemTypes } from "@/recentMatch/utils/queryTypes";
import { champDict } from "@/resources/champList";
import { queryMatchHistory } from "@/lcu/aboutMatch";
import { Games } from "@/lcu/types/queryMatchLcuTypes";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";

class QueryMatch {
    public winCount = 0;

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
        summonerState: string,
        targetSummonerId?: number,
    ): Promise<[MatchItemTypes[], number, boolean]> => {
        try {
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

            // Calculate win count (assuming this.winCount is updated in findMatch/findSpecialMatch)
            const winCount = matchList.length > 0 ? this.winCount : 0;

            // Determine if player is excellent based on their state and match performance
            const isExcel = this.isExcelPlayer(summonerState, uniqueMatches);

            // Reset win count for future calls
            this.winCount = 0;

            return [uniqueMatches, winCount, isExcel];
        } catch (error) {
            console.error("Error in queryMatchHistory:", error);
            // Return default values in case of error
            return [[], 0, false];
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

        // 3. 更新胜率统计 (使用简写)
        if (win) {
            this.winCount++;
        }

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

    public isExcelPlayer = (
        summonerState: string,
        matchList: MatchItemTypes[],
    ) => {
        // 判断是否为小代
        if (summonerState !== "Y") {
            return false;
        }
        let excellentCount = 0;
        for (let match of matchList.slice(0, 5)) {
            const kda =
                match.deaths === 0
                    ? (match.kills + match.assists) * 2
                    : ((match.kills + match.assists) / match.deaths) * 3;
            if (kda >= 12) {
                excellentCount += 1;
            }
        }
        return excellentCount >= 3;
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
