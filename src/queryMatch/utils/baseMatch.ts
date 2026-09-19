import { querySummonerInfo } from "@/lcu/aboutSummoner";
import { Games, SimpleMatchDetailsTypes } from "@/lcu/types/queryMatchLcuTypes";
import {
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
import { modeForQueue, MatchModeKey } from "@/recentMatch/utils/matchMode";

const HISTORY_PAGE_SIZE = 20;
const HISTORY_SYNC_SCAN_LIMIT = 300;
const HISTORY_SYNC_GAME_LIMIT = 100;

export interface ProcessedMatchHistory {
    matches: SimpleMatchDetailsTypes[];
    source: MatchHistorySource | null;
}

export default class BaseMatch {
    public summonerId = 0;

    private combineSources = (sources: MatchHistorySource[]) => {
        const uniqueSources = Array.from(new Set(sources));
        if (uniqueSources.length === 0) return null;
        return uniqueSources.length === 1 ? uniqueSources[0] : "mixed";
    };

    private syncHistoryUntilCacheBoundary = async (
        puuid: string,
        cachedGameIds: Set<number>,
        targetCount: number,
    ): Promise<{
        games: (Games | GamesBySgp)[];
        source: MatchHistorySource | null;
    }> => {
        const serverGames = new Map<number, Games | GamesBySgp>();
        const sources: MatchHistorySource[] = [];
        let reachedCachedBoundary = false;

        for (
            let offset = 0;
            offset < HISTORY_SYNC_SCAN_LIMIT;
            offset += HISTORY_PAGE_SIZE
        ) {
            const result = await queryMatchHistoryWithSource(
                puuid,
                offset,
                Math.min(offset + HISTORY_PAGE_SIZE, HISTORY_SYNC_SCAN_LIMIT),
            );
            if (result?.source) sources.push(result.source);
            const games = result?.games ?? [];
            if (games.length === 0) break;

            for (const game of games) {
                if (cachedGameIds.has(game.gameId)) {
                    reachedCachedBoundary = true;
                }
                serverGames.set(game.gameId, game);
            }

            const mergedCount = new Set([
                ...cachedGameIds,
                ...serverGames.keys(),
            ]).size;
            if (
                (reachedCachedBoundary && mergedCount >= targetCount) ||
                (cachedGameIds.size === 0 &&
                    serverGames.size >= targetCount) ||
                games.length < HISTORY_PAGE_SIZE
            ) {
                break;
            }
        }

        return {
            games: Array.from(serverGames.values()),
            source: this.combineSources(sources),
        };
    };

    private mergeHistoryGames = (
        cachedGames: NormalizedHistoryGame[],
        serverGames: (Games | GamesBySgp)[],
        limit: number,
    ): NormalizedHistoryGame[] => {
        const unique = new Map<number, NormalizedHistoryGame>();
        cachedGames.forEach((game) => unique.set(game.gameId, game));
        serverGames.forEach((rawGame) => {
            const game = normalizeHistoryGame(rawGame);
            if (game) unique.set(game.gameId, game);
        });
        return Array.from(unique.values())
            .sort((left, right) => right.gameCreation - left.gameCreation)
            .slice(0, limit);
    };

    private cacheNormalizedGames = (
        puuid: string,
        games: (Games | GamesBySgp)[],
        source: MatchHistorySource,
        summonerName: string,
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
        for (const [modeKey, modeGames] of gamesByMode) {
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
        if (requestedCount > 0) {
            const syncLimit = Math.min(
                HISTORY_SYNC_SCAN_LIMIT,
                Math.max(HISTORY_SYNC_GAME_LIMIT, endIndex),
            );
            const cachedGames = await getCachedHistory({
                puuid,
                limit: syncLimit,
                offset: 0,
            });
            const synced = await this.syncHistoryUntilCacheBoundary(
                puuid,
                new Set(cachedGames.map((game) => game.gameId)),
                syncLimit,
            );
            const mergedGames = this.mergeHistoryGames(
                cachedGames,
                synced.games,
                syncLimit,
            );
            const cachedMatches = mergedGames
                .map((game) => this.getSimpleCachedMatch(game, puuid))
                .filter(
                    (match): match is SimpleMatchDetailsTypes => match !== null,
                );
            const pageMatches = cachedMatches.slice(begIndex, endIndex);
            if (pageMatches.length >= requestedCount || mergedGames.length > 0) {
                if (synced.games.length > 0 && synced.source) {
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
                            : synced.source || "postgres",
                };
            }
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

        // 历史查询面板也负责回填统一分析缓存，后续首页、分页和模式分析
        // 都可以直接复用这些 participant 数据，避免重复请求同一段历史。
        this.cacheNormalizedGames(
            puuid,
            result.games,
            result.source,
            localSumInfo.name || "",
        );

        return { matches, source: result.source };
    };

    public getSimpleCachedMatch = (
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
                        ((identity.player as any).puuid === targetPuuid ||
                            (this.summonerId > 0 &&
                                (identity.player as any).summonerId ===
                                    this.summonerId)),
                );
            }
            return false;
        });
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
        const result = await this.dealMatchHistoryWithSource(puuid, 0, 60);
        if (result === null) {
            return { matches: [], source: null };
        }
        const specialList = result.matches.filter(
            (matchList) => matchList.queueId === queueId,
        );

        return { matches: specialList, source: result.source };
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
