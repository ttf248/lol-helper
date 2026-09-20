import {
    GameDetailedInfo,
    SummonerDetailInfo,
    ParticipantsInfo,
    Participant,
    MaxMatchData,
    Stat,
    ShowDataTypes,
    ParticipantIdentity,
    PropertiesToCompareTypes,
    SumPlatInfo,
} from "./MatchDetail";
import type { Games } from "@/lcu/types/queryMatchLcuTypes";
import { queryGameType } from "@/lcu/utils";
import { champDict } from "@/resources/champList";
import { invokeLcu } from "@/lcu";
import type { MatchHistoryEndpoint } from "@/lcu/aboutMatch";
import { getCachedGameDetail, cacheGameDetail } from "@/recentMatch/utils/databaseCache";
import {
    GamesBySgp,
    Participant as SgpParticipant,
} from "@/lcu/types/queryMatchSgpGameTypes";
import { logger } from "@/utils/logger";

export default class MatchDetails {
    // 同 gameId 详情请求的实例级缓存。MatchDetails 是 mainWindow
    // 长期持有的单例，UI 翻页 / 切换分析面板会让同一局被反复请求，
    // 命中后直接返回即可避免重复打 `/games/{gameId}`。
    // Phase 5 后 value 同时携带来源，方便 instance-cache 命中也能报告
    // 准确的数据来源（postgres / sgp-summary / lcu-game-detail）。
    private detailCache = new Map<
        number,
        { info: ParticipantsInfo; source: MatchHistoryEndpoint }
    >();
    private team100Kills = 0;
    private team200Kills = 0;
    private team100GoldEarned = 0;
    private team200GoldEarned = 0;
    private markeUsed = {
        kills: true,
        assists: true,
        turretKills: true,
        totalDamageDealtToChampions: true,
        totalMinionsKilled: true,
        goldEarned: true,
        totalDamageTaken: true,
        visionScore: true,
    };

    private withDataSource = (
        result: ParticipantsInfo | null,
        dataSource: MatchHistoryEndpoint,
    ): ParticipantsInfo | null =>
        result === null ? null : { ...result, dataSource };

    public queryGameDetail = async (
        gameId: number,
        sumId: number,
        sumPuuid?: string,
    ) => {
        const startedAt = Date.now();
        logger.info({
            tag: "match.detail",
            message: "对局详情查询发起",
            context: {
                purpose: "查询单局对局详情（包含双方十人数据）",
                game_id: gameId,
                sum_id: sumId,
                sum_puuid: sumPuuid ?? null,
            },
        });
        // PG 缓存优先：已经持久化过的对局不再触发 LCU /games/{gameId} 或 SGP。
        // raw_payload_sgp 存在时优先走 SGP 解析（包含完整的 10 人数据，对外部
        // 召唤师也可用）；否则用 raw_payload 走 LCU 解析路径。
        const pgCached = await getCachedGameDetail(gameId);
        if (pgCached) {
            const payload = pgCached.rawPayloadSgp ?? pgCached.rawPayload;
            const resolved = pgCached.rawPayloadSgp ? "sgp-summary" : "lcu-game-detail";
            const sgpPayload = pgCached.rawPayloadSgp as
                | Parameters<MatchDetails["getSgpParticipantsDetails"]>[0]
                | undefined;
            const sgpResult =
                sgpPayload !== undefined
                    ? this.getSgpParticipantsDetails(sgpPayload, sumId, sumPuuid)
                    : null;
            if (sgpResult) {
                this.detailCache.set(gameId, { info: sgpResult, source: "postgres" });
                logger.info({
                    tag: "match.detail",
                    message: "对局详情解析完成",
                    context: {
                        purpose: "查询单局对局详情（包含双方十人数据）",
                        game_id: gameId,
                        sum_puuid: sumPuuid,
                        resolved: "postgres",
                        sgp_source: true,
                        duration_ms: Date.now() - startedAt,
                    },
                    durationMs: Date.now() - startedAt,
                }, JSON.stringify(sgpResult));
                return this.withDataSource(sgpResult, "postgres");
            }
            const lcuPayload = payload as unknown as GameDetailedInfo;
            if (lcuPayload && Array.isArray(lcuPayload.participants)) {
                const lcuResult =
                    lcuPayload.queueId === 1700
                        ? this.getFighterParticipantsDetails(
                              lcuPayload,
                              lcuPayload.participants,
                              lcuPayload.participantIdentities,
                              gameId,
                              sumId,
                              lcuPayload.queueId,
                          )
                        : this.getParticipantsDetails(
                              lcuPayload,
                              lcuPayload.participants,
                              lcuPayload.participantIdentities,
                              sumId,
                              lcuPayload.queueId,
                              gameId,
                              sumPuuid,
                          );
                if (lcuResult) {
                    this.detailCache.set(gameId, { info: lcuResult, source: "postgres" });
                    logger.info({
                        tag: "match.detail",
                        message: "对局详情解析完成",
                        context: {
                            purpose: "查询单局对局详情（包含双方十人数据）",
                            game_id: gameId,
                            sum_puuid: sumPuuid,
                            resolved: "postgres",
                            sgp_source: false,
                            duration_ms: Date.now() - startedAt,
                        },
                        durationMs: Date.now() - startedAt,
                    }, JSON.stringify(lcuResult));
                    return this.withDataSource(lcuResult, "postgres");
                }
            }
            // PG 有 payload 但解析失败 —— 落到 LCU 单局接口重试。
            logger.warn({
                tag: "match.detail",
                message: "PG 缓存 payload 无法解析，回落到服务器",
                context: {
                    game_id: gameId,
                    resolved,
                    has_sgp: pgCached.rawPayloadSgp !== undefined && pgCached.rawPayloadSgp !== null,
                },
            });
        }
        // 实例级缓存：同一 gameId 在 mainWindow 会话内已经拼装过一次
        // ParticipantsInfo，直接复用，省掉 PG 重读 + 单局详情两条路径
        // 的所有调用。Phase 5 后 source 由写入点一并记录，避免再次
        // 依赖已删除的 getCachedLcuMatchSource。
        const cached = this.detailCache.get(gameId);
        if (cached) {
            logger.info({
                tag: "match.detail",
                message: "对局详情解析完成",
                context: {
                    purpose: "查询单局对局详情（包含双方十人数据）",
                    game_id: gameId,
                    sum_puuid: sumPuuid,
                    resolved: "instance-cache",
                    source: cached.source,
                    duration_ms: Date.now() - startedAt,
                },
                durationMs: Date.now() - startedAt,
            }, JSON.stringify(cached.info));
            return this.withDataSource(cached.info, cached.source);
        }

        this.init();

        const lcuUrl = `/lol-match-history/v1/games/${gameId}`;
        logger.info({
            tag: "match.detail",
            message: "对局详情 LCU /games/{gameId} 发起",
            context: {
                purpose: "查询单局对局详情（包含双方十人数据）",
                game_id: gameId,
                sum_puuid: sumPuuid ?? null,
                url: lcuUrl,
                method: "GET",
            },
        });
        const response: GameDetailedInfo | null = await invokeLcu(
            "get",
            lcuUrl,
        );
        if (response === null || response?.queueId === undefined) {
            logger.warn({
                tag: "match.detail",
                message: "对局详情无响应",
                context: {
                    purpose: "查询单局对局详情（包含双方十人数据）",
                    game_id: gameId,
                    sum_puuid: sumPuuid ?? null,
                    url: lcuUrl,
                    duration_ms: Date.now() - startedAt,
                },
            });
            return null;
        }

        // 拿到单局响应后把原始 payload 持久化到 PG。重启客户端后下次再开
        // 这局详情直接命中 PG，不再触发 /games/{gameId}。
        // Phase 5 前还会额外写一份无界 Map（已删除），现在只剩 PG。
        void cacheGameDetail(
            response as unknown as Games,
            undefined,
            "lcu-game-detail",
        );

        let assembled: ParticipantsInfo | null = null;
        if (response.queueId === 1700) {
            assembled = this.getFighterParticipantsDetails(
                response,
                response.participants,
                response.participantIdentities,
                gameId,
                sumId,
                response.queueId,
            );
        } else {
            assembled = this.getParticipantsDetails(
                response,
                response.participants,
                response.participantIdentities,
                sumId,
                response.queueId,
                gameId,
                sumPuuid,
            );
        }

        logger.info({
            tag: "match.detail",
            message: "对局详情解析完成",
            context: {
                purpose: "查询单局对局详情（包含双方十人数据）",
                game_id: gameId,
                sum_puuid: sumPuuid,
                resolved: "lcu-game-detail",
                queue_id: response.queueId,
                duration_ms: Date.now() - startedAt,
            },
            durationMs: Date.now() - startedAt,
        }, JSON.stringify(assembled));

        if (assembled) {
            this.detailCache.set(gameId, {
                info: assembled,
                source: "lcu-game-detail",
            });
        }
        return this.withDataSource(assembled, "lcu-game-detail");
    };

    /** 将 SGP SUMMARY 的扁平 participant 转成现有详情组件使用的 LCU 结构。 */
    private getSgpParticipantsDetails = (
        game: GamesBySgp,
        sumId: number,
        sumPuuid?: string,
    ): null | ParticipantsInfo => {
        const sourceParticipants = game.participants
            .filter(
                (participant) =>
                    participant &&
                    typeof participant.participantId === "number" &&
                    typeof participant.teamId === "number",
            )
            .slice()
            .sort(
                (left, right) =>
                    left.teamId - right.teamId ||
                    left.participantId - right.participantId,
            );

        if (sourceParticipants.length === 0) {
            return null;
        }

        const participants = sourceParticipants.map((participant) =>
            this.toLcuParticipant(participant),
        );
        const participantIdentities = sourceParticipants.map((participant) => ({
            participantId: participant.participantId,
            player: {
                accountId: participant.summonerId,
                currentAccountId: participant.summonerId,
                currentPlatformId: game.platformId,
                matchHistoryUri: "",
                platformId: game.platformId,
                profileIcon: participant.profileIcon,
                summonerId: participant.summonerId,
                summonerName: participant.summonerName,
                gameName: participant.riotIdGameName || participant.summonerName,
                puuid: participant.puuid,
            },
        }));
        const response = {
            gameCreation: game.gameCreation,
            gameCreationDate: new Date(game.gameCreation).toISOString(),
            gameDuration: game.gameDuration,
            gameId: game.gameId,
            gameMode: game.gameMode,
            gameType: game.gameType,
            gameVersion: game.gameVersion,
            mapId: game.mapId,
            participantIdentities,
            participants,
            platformId: game.platformId,
            queueId: game.queueId,
            seasonId: game.seasonId,
            teams: [],
        } as unknown as GameDetailedInfo;

        if (game.queueId === 1700) {
            return this.getFighterParticipantsDetails(
                response,
                participants,
                participantIdentities,
                game.gameId,
                sumId,
                game.queueId,
            );
        }

        return this.getParticipantsDetails(
            response,
            participants,
            participantIdentities,
            sumId,
            game.queueId,
            game.gameId,
            sumPuuid,
        );
    };

    private toLcuParticipant = (participant: SgpParticipant): Participant => {
        const runeIds =
            participant.perks?.styles?.flatMap((style) =>
                style.selections?.map((selection) => selection.perk) ?? [],
            ) ?? [];
        const stats = {
            ...participant,
            perk0: runeIds[0] ?? 0,
            perk1: runeIds[1] ?? 0,
            perk2: runeIds[2] ?? 0,
            perk3: runeIds[3] ?? 0,
            perk4: runeIds[4] ?? 0,
            perk5: runeIds[5] ?? 0,
        } as unknown as Stat;

        return {
            championId: participant.championId,
            highestAchievedSeasonTier: "",
            participantId: participant.participantId,
            spell1Id: participant.spell1Id,
            spell2Id: participant.spell2Id,
            stats,
            teamId: participant.teamId,
            timeline: {} as Participant["timeline"],
        };
    };

    private init() {
        this.detailCache.clear();
        [
            this.team100Kills,
            this.team200Kills,
            this.team100GoldEarned,
            this.team200GoldEarned,
        ] = [0, 0, 0, 0];
        this.markeUsed = {
            kills: true,
            assists: true,
            turretKills: true,
            totalDamageDealtToChampions: true,
            totalMinionsKilled: true,
            goldEarned: true,
            totalDamageTaken: true,
            visionScore: true,
        };
    }

    // 获取召唤师participants下面的详细数据
    private getParticipantsDetails = (
        res: GameDetailedInfo,
        participants: Participant[],
        participantIdentities: ParticipantIdentity[],
        sumId: number,
        queId: number,
        gameId: number,
        sumPuuid?: string,
    ): null | ParticipantsInfo => {
        if (participants?.length !== 10) {
            logger.warn({
                tag: "match.detail",
                message: "参与者数量异常，跳过详情组装",
                context: {
                    game_id: gameId,
                    sum_puuid: sumPuuid,
                    actual: participants?.length ?? 0,
                    expected: 10,
                },
            });
            return null;
        }

        const isTeamOne = res.participantIdentities
            .slice(0, 5)
            .some(
                (value) =>
                    value.player.summonerId === sumId ||
                    (sumPuuid !== undefined && value.player.puuid === sumPuuid),
            );

        const titleList = this.getDetailsTitle(
            res.gameCreation,
            res.gameDuration,
            queId,
        );
        const maxMatchData = this.getMaxField(participants);
        const participantsInfo: ParticipantsInfo = {
            teamOne: [],
            teamTwo: [],
            headerInfo: [],
            queueId: queId,
            gameId: gameId,
        };
        const nameList = this.getparticipantIdAndName(participantIdentities);

        for (let i = 0; i < 5; i++) {
            this.team100Kills += isTeamOne
                ? participants[i].stats.kills
                : participants[i + 5].stats.kills;
            this.team200Kills += isTeamOne
                ? participants[i + 5].stats.kills
                : participants[i].stats.kills;
            this.team100GoldEarned += isTeamOne
                ? participants[i].stats.goldEarned
                : participants[i + 5].stats.goldEarned;
            this.team200GoldEarned += isTeamOne
                ? participants[i + 5].stats.goldEarned
                : participants[i].stats.goldEarned;

            participantsInfo.teamOne.push(
                this.analyticalData(
                    participants[i],
                    nameList[i],
                    maxMatchData,
                    sumId,
                ),
            );
            participantsInfo.teamTwo.push(
                this.analyticalData(
                    participants[i + 5],
                    nameList[i + 5],
                    maxMatchData,
                    sumId,
                ),
            );
        }
        participantsInfo.teamOne[
            this.queryMvpIndex(participantsInfo.teamOne).index
        ].isMvp = true;
        participantsInfo.teamTwo[
            this.queryMvpIndex(participantsInfo.teamTwo).index
        ].isMvp = true;

        titleList.push(
            String(this.team100Kills),
            String(this.team200Kills),
            String(this.goldToStr(this.team100GoldEarned)),
            String(this.goldToStr(this.team200GoldEarned)),
        );
        participantsInfo.headerInfo = titleList;

        if (!isTeamOne) {
            const temp = participantsInfo.teamOne;
            participantsInfo.teamOne = participantsInfo.teamTwo;
            participantsInfo.teamTwo = temp;
        }
        return participantsInfo;
    };
    // 解析对局数据
    private analyticalData = (
        participant: Participant,
        nameList: SumPlatInfo,
        maxMatchData: MaxMatchData,
        sumId: number,
    ): SummonerDetailInfo => {
        const iconList = this.getIconList(participant.stats, maxMatchData);
        const checkAndPushIcon = (
            stats: Stat,
            condition: (stats: Stat) => boolean,
            iconName: string,
        ) => {
            if (condition(stats)) {
                iconList.push(iconName);
            }
        };
        checkAndPushIcon(
            participant.stats,
            (stats: Stat) => stats.firstBloodKill,
            "firstBlood",
        );
        checkAndPushIcon(
            participant.stats,
            (stats: Stat) => stats.tripleKills > 0,
            "threeKills",
        );
        checkAndPushIcon(
            participant.stats,
            (stats: Stat) => stats.quadraKills > 0,
            "fourKills",
        );
        checkAndPushIcon(
            participant.stats,
            (stats: Stat) => stats.pentaKills > 0,
            "fiveKills",
        );
        checkAndPushIcon(
            participant.stats,
            (stats: Stat) => stats.largestKillingSpree >= 8,
            "god",
        );

        const showDataDict: ShowDataTypes = this.getShowDataPercent(
            maxMatchData,
            {
                totalDamageDealtToChampions:
                    participant.stats.totalDamageDealtToChampions,
                totalDamageTaken: participant.stats.totalDamageTaken,
                goldEarned: participant.stats.goldEarned,
                visionScore: participant.stats.visionScore,
                totalMinionsKilled:
                    participant.stats.totalMinionsKilled +
                    participant.stats.neutralMinionsKilled,
            },
        );

        const champAlias = champDict[String(participant.championId)]?.alias;
        // 字典缺英雄时回退到 CommunityDragon 图标
        const champImgUrl = champAlias
            ? `https://game.gtimg.cn/images/lol/act/img/champion/${champAlias}.png`
            : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${participant.championId}.png`;

        return {
            name: nameList.name,
            accountId: nameList.summonerId,
            puuid: nameList.puuid,
            isCurSum: nameList.summonerId === sumId,
            teamType: participant.teamId,
            champLevel: participant.stats.champLevel,
            champImgUrl: champImgUrl,
            spell1Id: participant.spell1Id,
            spell2Id: participant.spell2Id,
            items: [
                participant.stats.item0,
                participant.stats.item1,
                participant.stats.item2,
                participant.stats.item3,
                participant.stats.item4,
                participant.stats.item5,
                participant.stats.item6,
            ],
            kills: participant.stats.kills,
            deaths: participant.stats.deaths,
            assists: participant.stats.assists,
            //物理伤害
            physicalDamageDealtToChampions:
                participant.stats.physicalDamageDealtToChampions,
            // 魔法伤害
            magicDamageDealtToChampions:
                participant.stats.magicDamageDealtToChampions,
            // 真实伤害
            trueDamageDealtToChampions:
                participant.stats.trueDamageDealtToChampions,
            // 伤害总和
            totalDamageDealtToChampions:
                participant.stats.totalDamageDealtToChampions,
            // 承受伤害
            totalDamageTaken: participant.stats.totalDamageTaken,
            // 击杀野怪
            neutralMinionsKilled: participant.stats.neutralMinionsKilled,
            // 击杀小兵
            totalMinionsKill: participant.stats.totalMinionsKilled,
            // 获得金钱
            goldEarned: participant.stats.goldEarned,
            // 花费金钱
            goldSpent: participant.stats.goldSpent,
            // 视野得分
            visionScore: participant.stats.visionScore,
            // 放置视野
            wardsPlaced: participant.stats.wardsPlaced,
            // 符文数据
            runesList: [
                participant.stats.perk0,
                participant.stats.perk1,
                participant.stats.perk2,
                participant.stats.perk3,
                participant.stats.perk4,
                participant.stats.perk5,
            ],
            totalMinionsKilled:
                participant.stats.totalMinionsKilled +
                participant.stats.neutralMinionsKilled,
            iconList: iconList,
            score: this.analyseSingleMatch(participant.stats),
            isWin: participant.stats.win,
            isMvp: false,
            showDataDict: showDataDict,
        };
    };
    // 获取召唤师participantId 和 name
    private getparticipantIdAndName = (
        participantIdentities: ParticipantIdentity[],
    ) => {
        const dataList: SumPlatInfo[] = [];
        for (const participantIdentity of participantIdentities) {
            dataList.push({
                puuid: participantIdentity.player.puuid,
                name:
                    participantIdentity.player.gameName ||
                    participantIdentity.player.summonerName,
                summonerId: participantIdentity.player.summonerId,
            });
        }
        return dataList;
    };

    private timestampToDate = (timestamp: number): [string, string] => {
        const date = new Date(timestamp);
        // 获取时间
        const hours = date.getHours().toString().padStart(2, "0");
        const minutes = date.getMinutes().toString().padStart(2, "0");
        return [
            `${hours} : ${minutes}`,
            (date.getMonth() + 1 < 10
                ? "0" + (date.getMonth() + 1)
                : date.getMonth() + 1) +
                "-" +
                (date.getDate() < 10 ? "0" + date.getDate() : date.getDate()),
        ];
    };

    // 获取当前页面顶部详细数据
    private getDetailsTitle = (
        creation: number,
        duration: number,
        queueId: number,
    ) => {
        const createTime = this.timestampToDate(creation);
        const dateStr = createTime[1];
        const timeStr = createTime[0];
        const lane = queryGameType(queueId);
        const gameDuration = (duration / 60).toFixed(0);
        return [dateStr, timeStr, lane, gameDuration];
    };
    private goldToStr = (gold: number) => {
        return Number((gold / 1000).toFixed(1));
    };
    // 获取十名召唤师中的某些数据的最大数据
    private getMaxField = (participants: Participant[]) => {
        const propertiesToCompare: (keyof PropertiesToCompareTypes)[] = [
            "kills",
            "assists",
            "turretKills",
            "totalDamageDealtToChampions",
            "totalMinionsKilled",
            "goldEarned",
            "totalDamageTaken",
            "visionScore",
        ];

        return participants.reduce(
            (res: MaxMatchData, obj: Participant) => {
                propertiesToCompare.forEach((property) => {
                    if (obj.stats[property] >= res[property]) {
                        res[property] = obj.stats[property];
                    }
                });
                return res;
            },
            <MaxMatchData>{
                kills: 0,
                assists: 0,
                turretKills: 0,
                totalDamageDealtToChampions: 0,
                totalMinionsKilled: 0,
                goldEarned: 0,
                totalDamageTaken: 0,
                visionScore: 0,
            },
        );
    };
    // 获取对于的最大数据图标
    private getIconList = (stats: Stat, maxMatchData: MaxMatchData) => {
        if (maxMatchData === null) {
            return [];
        }
        const iconList: string[] = [];
        for (const key of Object.keys(maxMatchData)) {
            if (key === "totalMinionsKilled") {
                if (
                    stats.totalMinionsKilled + stats.neutralMinionsKilled ===
                    maxMatchData.totalMinionsKilled
                ) {
                    iconList.push(key);
                }
                continue;
            }
            // @ts-ignore
            if (stats[key] === maxMatchData[key] && this.markeUsed[key]) {
                iconList.push(key);
                // @ts-ignore
                this.markeUsed[key] = false;
            }
        }
        return iconList;
    };
    // 通过分析数据得出单场得分情况
    private analyseSingleMatch = (match: Stat): string => {
        const kda =
            match.deaths === 0
                ? (match.kills + match.assists) * 2
                : ((match.kills + match.assists) / match.deaths) * 3;
        let score = 0;
        if (match["firstBloodKill"]) {
            score += 2;
        } // 一血 加5分
        if (match["firstBloodAssist"]) {
            score += 1;
        } // 一血助攻 加2分
        score += match["doubleKills"] * 1; // 一次双杀加1分
        score += match["tripleKills"] * 2; // 一次三杀加2分
        score += match["quadraKills"] * 3; // 一次四杀加3分
        score += match["pentaKills"] * 4; // 一次五杀加4分
        score += kda;
        return score.toFixed(1);
    };
    // 获取需要显示数据的百分比
    private getShowDataPercent = (
        maxDict: MaxMatchData,
        curDict: ShowDataTypes,
    ) => {
        const resDict: any = {};
        for (const key of Object.keys(curDict)) {
            // @ts-ignore
            resDict[key] = this.computePercent(maxDict[key], curDict[key]);
        }
        return resDict;
    };
    // 根据最高数据算出百分比
    private computePercent = (max: number, cur: number) => {
        if (max === 0 || cur === 0) {
            return "0%";
        }
        return Math.round((cur / max) * 10000) / 100 + "%";
    };
    // 找出评分最大的对象的数组下表
    private queryMvpIndex = (array: SummonerDetailInfo[]) => {
        return array.reduce(
            (max, obj, index) => {
                if (Number(obj.score) > max.value) {
                    return { value: Number(obj.score), index };
                } else {
                    return max;
                }
            },
            { value: 0, index: 0 },
        );
    };
    // 获取斗魂竞技场战绩数据
    private getFighterParticipantsDetails = (
        res: GameDetailedInfo,
        participants: Participant[],
        participantIdentities: ParticipantIdentity[],
        gameId: number,
        sumId: number,
        queId: number,
    ): ParticipantsInfo => {
        try {
            const titleList = this.getDetailsTitle(
                res.gameCreation,
                res.gameDuration,
                res.queueId,
            );
            const nameList = this.getparticipantIdAndName(
                participantIdentities,
            );
            const result = [];
            const maxMatchData = this.getMaxField(participants);
            for (let i = 0; i < nameList.length; i++) {
                result.push(
                    this.analyticalData(
                        participants[i],
                        nameList[i],
                        maxMatchData,
                        sumId,
                    ),
                );
            }
            result.sort(
                (a, b) =>
                    b.totalDamageDealtToChampions -
                    a.totalDamageDealtToChampions,
            );

            return {
                headerInfo: titleList,
                teamOne: result,
                teamTwo: [],
                queueId: queId,
                gameId: gameId,
            };
        } catch (e) {
            return {
                headerInfo: <string[]>[],
                teamOne: [],
                teamTwo: [],
                queueId: queId,
                gameId: gameId,
            };
        }
    };
}
