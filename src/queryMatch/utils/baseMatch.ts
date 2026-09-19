import { queryRankPoint, querySummonerInfo } from "@/lcu/aboutSummoner";
import { Games, SimpleMatchDetailsTypes } from "@/lcu/types/queryMatchLcuTypes";
import {
    MatchHistorySource,
    queryMatchHistoryWithSource,
} from "@/lcu/aboutMatch";
import { queryGameType } from "@/lcu/utils";
import { champDict } from "@/resources/champList";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import { sumInfoTypes } from "@/lcu/types/SummonerTypes";

export interface ProcessedMatchHistory {
    matches: SimpleMatchDetailsTypes[];
    source: MatchHistorySource | null;
}

export default class BaseMatch {
    public summonerId = 0;

    public gerSummonerInfo = async (summonerId?: number) => {
        const summonerInfo = await querySummonerInfo(summonerId);
        if (summonerInfo !== null) {
            const rankList = await queryRankPoint(summonerInfo.puuid);
            return { summonerInfo, rankList };
        }
        return null;
    };

    public dealMatchHistory = async (
        puuid: string,
        begIndex: number,
        endIndex: number,
    ): Promise<SimpleMatchDetailsTypes[] | null> => {
        const result = await this.dealMatchHistoryWithSource(
            puuid,
            begIndex,
            endIndex,
        );
        return result?.matches ?? null;
    };

    public dealMatchHistoryWithSource = async (
        puuid: string,
        begIndex: number,
        endIndex: number,
    ): Promise<ProcessedMatchHistory | null> => {
        // 写入玩家id
        if (this.summonerId === 0) {
            const localSumInfo: sumInfoTypes = JSON.parse(
                localStorage.getItem("sumInfo") as string,
            );
            this.summonerId = localSumInfo.summonerId;
        }

        const result = await queryMatchHistoryWithSource(
            puuid,
            begIndex,
            endIndex,
        );

        if (result === null) {
            return null;
        }

        const matches = result.games
            .map((matchListElement) =>
                this.getSimpleMatch(matchListElement, puuid),
            )
            .filter(
                (match): match is SimpleMatchDetailsTypes => match !== null,
            );

        return { matches, source: result.source };
    };

    public getSimpleMatch = (
        match: Games | GamesBySgp,
        targetPuuid?: string,
    ): SimpleMatchDetailsTypes | null => {
        // 1. 确定参与者数据源
        const participant = match.participants?.find((item: any) => {
            if (item?.puuid === targetPuuid) {
                return true;
            }
            if (targetPuuid && "participantIdentities" in match) {
                return match.participantIdentities?.some(
                    (identity) =>
                        identity.participantId === item?.participantId &&
                        (identity.player as any).puuid === targetPuuid,
                );
            }
            return false;
        }) ?? match.participants?.[0];
        if (!participant || typeof match.gameId !== "number") {
            return null;
        }
        const stats =
            "stats" in participant ? (participant as any).stats : participant;

        // 2. 提取核心数值
        const { kills, deaths, assists, win } = stats;
        const { championId } = participant; // championId 始终在参与者根节点
        // 3. 计算 KDA
        const kda =
            deaths === 0
                ? kills + assists
                : Math.round(((kills + assists) / deaths) * 3);

        // 4. 处理时间和字典查询
        const [startTime, matchTime] = this.timestampToDate(match.gameCreation);
        const champAlias = champDict[String(championId)]?.alias;
        // 字典缺英雄时回退到 CommunityDragon 图标
        const champImgUrl = champAlias
            ? `https://game.gtimg.cn/images/lol/act/img/champion/${champAlias}.png`
            : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;

        // 5. 统一返回
        return {
            gameId: match.gameId,
            champId: championId,
            champImgUrl,
            isWin: Boolean(win),
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

    public querySpecialMatch = async (puuid: string, queueId: number) => {
        const result = await this.querySpecialMatchWithSource(puuid, queueId);
        return result.matches;
    };

    public querySpecialMatchWithSource = async (
        puuid: string,
        queueId: number,
    ): Promise<ProcessedMatchHistory> => {
        const result = await queryMatchHistoryWithSource(puuid, 0, 60);
        if (result === null) {
            return { matches: [], source: null };
        }
        const specialList = result.games.filter(
            (matchList) => matchList.queueId === queueId,
        );

        const matches = specialList
            .map((matchListElement) =>
                this.getSimpleMatch(matchListElement, puuid),
            )
            .filter(
                (match): match is SimpleMatchDetailsTypes => match !== null,
            );

        return { matches, source: result.source };
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
