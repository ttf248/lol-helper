import {champDict} from "@/resources/champList";
import {invokeLcu} from "@/lcu";
import {querySummonerInfo} from "@/lcu/aboutSummoner";
import {invoke} from "@tauri-apps/api/core";
import {
  LiveGamePlayer,
  PlayerChampionSelection,
  RecentHistoryStatus,
  RecentSumInfo,
  SessionTypes,
  TeamData,
} from "@/recentMatch/utils/queryTypes";
import { logger } from "@/utils/logger";
import {
  getCachedSessionByLcuGameId,
  getCachedSummonerByPuuid,
} from "@/recentMatch/utils/databaseCache";
import { getChampionImageUrl } from "@/utils/championImage";
import { readLocalSumInfo } from "@/utils/localSumInfo";

export interface CurrentMatchProgress {
  loaded: number;
  total: number;
  message: string;
}

type CurrentMatchProgressCallback = (progress: CurrentMatchProgress) => void;

class QuerySummoner {
  public matchSession: null|SessionTypes = null
  public currentId: number = 0
  public queueId: number = 0

  private wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  private summonerInfoCache = new Map<string, ReturnType<typeof querySummonerInfo>>();

  private querySummonerByName = (name: string) => {
    const key = name.trim().toLocaleLowerCase();
    const cached = this.summonerInfoCache.get(key);
    if (cached) return cached;

    const request = querySummonerInfo(undefined, name).then((info) => {
      if (info === null) {
        this.summonerInfoCache.delete(key);
      }
      return info;
    });
    this.summonerInfoCache.set(key, request);
    return request;
  };

  private getExpectedTeamSize = (session: SessionTypes) => {
    const teamSize = Number(session.gameData.queue.numPlayersPerTeam);
    return Number.isFinite(teamSize) && teamSize > 0 ? teamSize : 5;
  };

  private hasCompleteTeams = (session: SessionTypes) => {
    const expectedTeamSize = this.getExpectedTeamSize(session);
    return session.gameData.teamOne.length >= expectedTeamSize &&
      session.gameData.teamTwo.length >= expectedTeamSize;
  };

  private getPlayerKey = (player: Partial<TeamData>) => {
    if (player.puuid) return `puuid:${player.puuid}`;
    if (player.summonerId !== undefined) return `id:${player.summonerId}`;
    return `name:${player.summonerInternalName || player.summonerName || ""}`;
  };

  private normalizeName = (name?: string) =>
    (name || "").trim().toLocaleLowerCase();

  private findChampionId = (
    player: LiveGamePlayer,
    selections: Map<string, PlayerChampionSelection>,
  ) => {
    const selection = selections.get(this.normalizeName(player.summonerName));
    if (selection?.championId) {
      return selection.championId;
    }

    const liveChampionNames = [player.rawChampionName, player.championName]
      .map((name) => this.normalizeName(name))
      .filter(Boolean);
    const champion = Object.entries(champDict).find(([, info]) =>
      [info.alias, info.label, info.title].some((name) =>
        liveChampionNames.includes(this.normalizeName(name)),
      ),
    );
    return champion === undefined ? 0 : Number(champion[0]);
  };

  /**
   * 从 PG `game_sessions` + `session_player_picks` 还原一局对局内阵容。
   * 只在 `phase ∈ {PreEndOfGame, EndOfGame}` 命中时返回非空；
   * 进行中的对局不会触发该缓存，因此 init() 仍走原 LCU poll。
   */
  private tryLoadCachedSession = async (): Promise<SessionTypes | null> => {
    let gameId = 0;
    try {
      const rawGameInfo = localStorage.getItem("gameInfo");
      if (rawGameInfo) {
        const parsed = JSON.parse(rawGameInfo) as { gameId?: number };
        if (typeof parsed?.gameId === "number" && parsed.gameId > 0) {
          gameId = parsed.gameId;
        }
      }
    } catch {
      return null;
    }
    if (gameId <= 0) return null;

    const cached = await getCachedSessionByLcuGameId(gameId);
    if (cached === null) return null;
    if (cached.picks.length === 0) return null;

    // team_id 100 → ORDER (teamOne)，200 → CHAOS (teamTwo)。
    const teamOne: TeamData[] = [];
    const teamTwo: TeamData[] = [];
    let order = 1;
    for (const pick of cached.picks) {
      const participantId = order++;
      const entry: TeamData = {
        championId: pick.championId ?? 0,
        lastSelectedSkinIndex: 0,
        profileIconId: pick.profileIconId ?? 0,
        puuid: pick.puuid,
        selectedPosition: "NONE",
        selectedRole: "NONE",
        summonerId: pick.summonerId ?? 0,
        summonerInternalName:
          pick.summonerName ?? pick.gameName ?? pick.puuid,
        summonerName: pick.summonerName ?? pick.gameName ?? pick.puuid,
        teamOwner: false,
        teamParticipantId: participantId,
      };
      if (pick.teamId === 200) {
        teamTwo.push(entry);
      } else {
        teamOne.push(entry);
      }
    }

    // 构造与 LCU `/lol-gameflow/v1/session` 同形的 SessionTypes。
    // 其他字段（gameClient / gameDodge / map）保持 any，不影响本面板消费。
    const session: SessionTypes = {
      gameClient: null,
      gameDodge: null,
      map: null,
      phase: cached.phase,
      gameData: {
        gameId: cached.gameId,
        gameName: "",
        isCustomGame: false,
        password: "",
        playerChampionSelections: cached.picks
        .filter((pick) => pick.summonerName || pick.puuid)
        .map((pick) => ({
          championId: pick.championId ?? 0,
          selectedSkinIndex: 0,
          spell1Id: pick.spell1Id ?? 0,
          spell2Id: pick.spell2Id ?? 0,
          summonerInternalName:
            pick.summonerName ?? pick.puuid,
        })),
        queue: {
          allowablePremadeSizes: [],
          areFreeChampionsAllowed: false,
          assetMutator: "",
          category: "",
          championsRequiredToPlay: 0,
          description: "",
          detailedDescription: "",
          gameMode: "",
          gameTypeConfig: {
            advancedLearningQuests: false,
            allowTrades: false,
            banMode: "",
            banTimerDuration: 0,
            battleBoost: false,
            crossTeamChampionPool: false,
            deathMatch: false,
            doNotRemove: false,
            duplicatePick: false,
            exclusivePick: false,
            id: cached.queueId,
            learningQuests: false,
            mainPickTimerDuration: 0,
            maxAllowableBans: 0,
            name: "",
            onboardCoopBeginner: false,
            pickMode: "",
            postPickTimerDuration: 0,
            reroll: false,
            teamChampionPool: false,
          },
          id: cached.queueId,
          isRanked: false,
          isTeamBuilderManaged: false,
          lastToggledOffTime: 0,
          lastToggledOnTime: 0,
          mapId: cached.mapId ?? 0,
          maximumParticipantListSize: 10,
          minLevel: 0,
          minimumParticipantListSize: 0,
          name: "",
          numPlayersPerTeam:
            teamOne.length > 0 ? teamOne.length : teamTwo.length > 0 ? teamTwo.length : 5,
          queueAvailability: "",
          queueRewards: {
            isChampionPointsEnabled: false,
            isIpEnabled: false,
            isXpEnabled: false,
            partySizeIpRewards: [],
          },
          removalFromGameAllowed: false,
          removalFromGameDelayMinutes: 0,
          shortName: "",
          showPositionSelector: false,
          spectatorEnabled: false,
          type: "",
        },
        spectatorsAllowed: false,
        teamOne,
        teamTwo,
      },
    };
    return session;
  };

  /**
   * gameflow 在加载阶段仍可能缺人，Live Client Data 的 playerlist 是当前
   * 对局实际加载的完整玩家列表。用它确定阵营，再用 LCU 补回 PUUID/召唤师 ID。
   */
  private queryLiveTeams = async (session: SessionTypes) => {
    let livePlayers: LiveGamePlayer[];
    try {
      livePlayers = await invoke<LiveGamePlayer[]>("get_ingame_players");
    } catch {
      return null;
    }

    const expectedTeamSize = this.getExpectedTeamSize(session);
    if (!Array.isArray(livePlayers) || livePlayers.length < expectedTeamSize * 2) {
      return null;
    }

    const knownPlayers = new Map<string, TeamData>();
    for (const player of [
      ...session.gameData.teamOne,
      ...session.gameData.teamTwo,
    ]) {
      for (const name of [player.summonerName, player.summonerInternalName]) {
        const key = this.normalizeName(name);
        if (key) {
          knownPlayers.set(key, player);
        }
      }
    }

    const selections = new Map<string, PlayerChampionSelection>();
    for (const selection of session.gameData.playerChampionSelections) {
      const key = this.normalizeName(selection.summonerInternalName);
      if (key) {
        selections.set(key, selection);
      }
    }

    const resolvedPlayers = await Promise.all(livePlayers.map(async (player) => {
      const team = player.team.toLocaleUpperCase();
      if (team !== "ORDER" && team !== "CHAOS") {
        return null;
      }

      const knownPlayer = knownPlayers.get(this.normalizeName(player.summonerName));
      const info = knownPlayer?.puuid
        ? {
            currentId: knownPlayer.summonerId,
            name: knownPlayer.summonerName,
            puuid: knownPlayer.puuid,
          }
        : await this.querySummonerByName(player.summonerName);
      if (info === null) {
        return null;
      }

      const championId = this.findChampionId(player, selections);
      return {
        team,
        player: {
        championId: championId || knownPlayer?.championId || 0,
        lastSelectedSkinIndex: knownPlayer?.lastSelectedSkinIndex || 0,
        profileIconId: knownPlayer?.profileIconId || 0,
        puuid: info.puuid,
        selectedPosition: knownPlayer?.selectedPosition || "NONE",
        selectedRole: knownPlayer?.selectedRole || "NONE",
        summonerId: info.currentId,
        summonerInternalName: knownPlayer?.summonerInternalName || player.summonerName,
        summonerName: info.name || player.summonerName,
        teamOwner: knownPlayer?.teamOwner || false,
        teamParticipantId: 0,
        },
      };
    }));

    const teamOne: TeamData[] = [];
    const teamTwo: TeamData[] = [];
    for (const resolved of resolvedPlayers) {
      if (resolved === null) continue;
      const targetTeam = resolved.team === "ORDER" ? teamOne : teamTwo;
      targetTeam.push({
        ...resolved.player,
        teamParticipantId: targetTeam.length + 1,
      });
    }

    if (teamOne.length < expectedTeamSize || teamTwo.length < expectedTeamSize) {
      return null;
    }
    return {teamOne, teamTwo};
  };

  /**
   * 游戏加载阶段 gameflow 的 teamTwo 可能暂时只有部分玩家。
   * playerChampionSelections 通常已经包含十名玩家，利用它补齐缺失的那一队。
   */
  private hydrateMissingTeam = async (
    session: SessionTypes,
    onStage?: (stage: "champion-selection" | "live-data", detected: number) => void,
  ): Promise<SessionTypes> => {
    if (this.hasCompleteTeams(session)) {
      return session;
    }

    const {gameData} = session;
    const expectedTeamSize = this.getExpectedTeamSize(session);
    const teamOne = [...gameData.teamOne];
    const teamTwo = [...gameData.teamTwo];

    // 只有一边已经完整时，才能无歧义地把剩余选择结果归入另一边。
    const targetTeam = teamOne.length >= expectedTeamSize
      ? teamTwo
      : teamTwo.length >= expectedTeamSize
        ? teamOne
        : null;
    if (targetTeam === null || gameData.playerChampionSelections.length === 0) {
      return session;
    }

    onStage?.("champion-selection", teamOne.length + teamTwo.length);

    const knownPlayers = new Set(
      [...teamOne, ...teamTwo].flatMap((player) => [
        this.getPlayerKey(player),
        player.puuid ? `puuid:${player.puuid}` : "",
        player.summonerInternalName ? `name:${player.summonerInternalName}` : "",
        player.summonerName ? `name:${player.summonerName}` : "",
      ]),
    );
    const missingSelections = gameData.playerChampionSelections.filter(
      (selection: PlayerChampionSelection) => {
        const selectionKey = selection.puuid
          ? `puuid:${selection.puuid}`
          : selection.summonerInternalName
            ? `name:${selection.summonerInternalName}`
            : "";
        return Boolean(selectionKey) && !knownPlayers.has(selectionKey);
      },
    );

    const hydratedPlayers = await Promise.all(
      missingSelections.map(async (selection, index): Promise<TeamData | null> => {
        const cachedInfo = selection.puuid
          ? await getCachedSummonerByPuuid(selection.puuid)
          : null;
        const info = cachedInfo
          ? {
              currentId: cachedInfo.summonerId,
              name:
                cachedInfo.gameName ||
                cachedInfo.displayName ||
                cachedInfo.internalName ||
                cachedInfo.summonerName ||
                selection.puuid ||
                selection.summonerInternalName,
              puuid: cachedInfo.puuid,
            }
          : selection.puuid
            ? {
                currentId: 0,
                name: selection.puuid,
                puuid: selection.puuid,
              }
            : await this.querySummonerByName(selection.summonerInternalName);
        if (info === null) return null;

        if (!cachedInfo && selection.puuid) {
          logger.warn({
            tag: "query_summoner",
            message: "本局玩家补齐：仅使用英雄选择中的 PUUID",
            context: {
              stage: "champion-selection",
              puuid_suffix: selection.puuid.slice(-8),
              reason: "召唤师缓存未命中，保留玩家以避免阵容缺人",
            },
          });
        }

        return {
          championId: selection.championId,
          lastSelectedSkinIndex: selection.selectedSkinIndex,
          profileIconId: cachedInfo?.profileIconId || 0,
          puuid: info.puuid,
          selectedPosition: "NONE",
          selectedRole: "NONE",
          summonerId: info.currentId,
          summonerInternalName:
            selection.summonerInternalName || info.name || selection.puuid || "未知玩家",
          summonerName: info.name || selection.summonerInternalName || selection.puuid || "未知玩家",
          teamOwner: false,
          teamParticipantId: targetTeam.length + index + 1,
        };
      }),
    );

    targetTeam.push(...hydratedPlayers.filter((player): player is TeamData => player !== null));

    return {
      ...session,
      gameData: {
        ...gameData,
        teamOne,
        teamTwo,
      },
    };
  };

  // 初始化数据。游戏加载阶段最多等待 6 秒，避免一个缺失玩家让整个面板
  // 阻塞 15 秒；每次尝试都会把当前已识别人数反馈给界面。
  public init = async (onProgress?: CurrentMatchProgressCallback) => {
    let latestSession: SessionTypes | null = null;
    const maxAttempts = 12;
    let firstStageLogged = false;
    let liveStageLogged = false;
    let championSelectionStageLogged = false;

    // PG 优先：PreEndOfGame / EndOfGame 时 gameFlow 已经把 10 人阵容落库，
    // 直接命中 PG 就跳过整段 gameflow poll。游戏进行中的实时对局不命中
    // 这条路径（gameData.gameId 在切换阶段不稳定），依旧走原 LCU 轮询。
    const cachedSession = await this.tryLoadCachedSession();
    if (cachedSession !== null) {
      latestSession = cachedSession;
      if (!firstStageLogged) {
        firstStageLogged = true;
        logger.info({
          tag: "query_summoner",
          message: "本局玩家阶段：PG 缓存命中",
          context: {
            stage: "postgres-session",
            phase: cachedSession.phase,
            queue_id: cachedSession.gameData.queue?.id,
            detected:
              cachedSession.gameData.teamOne.length +
              cachedSession.gameData.teamTwo.length,
          },
        });
      }
    } else {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const session = await invokeLcu<SessionTypes>('get','/lol-gameflow/v1/session');
        if (session?.gameData) {
          if (!firstStageLogged) {
          firstStageLogged = true;
          logger.info({
            tag: "query_summoner",
            message: "本局玩家阶段：读取 gameflow session",
            context: {
              stage: "gameflow-session",
              phase: session.phase,
              queue_id: session.gameData.queue?.id,
              detected: session.gameData.teamOne.length + session.gameData.teamTwo.length,
            },
          });
        }

        latestSession = await this.hydrateMissingTeam(session, (resolved, detected) => {
          if (!championSelectionStageLogged && resolved === "champion-selection") {
            championSelectionStageLogged = true;
            logger.info({
              tag: "query_summoner",
              message: "本局玩家阶段：按英雄选择补齐",
              context: { stage: "champion-selection", detected },
            });
          }
        });

        const detectedPlayers =
          latestSession.gameData.teamOne.length + latestSession.gameData.teamTwo.length;
        onProgress?.({
          loaded: detectedPlayers,
          total: this.getExpectedTeamSize(latestSession) * 2,
          message: detectedPlayers >= this.getExpectedTeamSize(latestSession) * 2
            ? "本局玩家已读取"
            : `正在读取本局玩家（已识别 ${detectedPlayers} 人）`,
        });

        // gameflow 数据仍不完整时，定期切换到游戏内玩家列表再次获取。
        if (!this.hasCompleteTeams(latestSession) && attempt >= 2 && attempt % 3 === 2) {
          const liveTeams = await this.queryLiveTeams(latestSession);
          if (liveTeams !== null) {
            latestSession = {
              ...latestSession,
              gameData: {
                ...latestSession.gameData,
                teamOne: liveTeams.teamOne,
                teamTwo: liveTeams.teamTwo,
              },
            };
            if (!liveStageLogged) {
              liveStageLogged = true;
              logger.info({
                tag: "query_summoner",
                message: "本局玩家阶段：游戏内玩家列表接管",
                context: {
                  stage: "live-data",
                  detected: liveTeams.teamOne.length + liveTeams.teamTwo.length,
                },
              });
            }
          }

          const refreshedPlayers =
            latestSession.gameData.teamOne.length + latestSession.gameData.teamTwo.length;
          onProgress?.({
            loaded: refreshedPlayers,
            total: this.getExpectedTeamSize(latestSession) * 2,
            message: `正在读取本局玩家（已识别 ${refreshedPlayers} 人）`,
          });
        }

        if (this.hasCompleteTeams(latestSession)) {
          break;
        }
      }
      if (attempt < maxAttempts - 1) {
        await this.wait(500);
      }
    }
    }

    if (latestSession === null) {
      this.matchSession = null
      this.queueId = 0
      return
    }

    this.matchSession = latestSession;
    this.queueId = latestSession.gameData.queue.id;
    this.currentId = Number(readLocalSumInfo().summonerId || 0);
  }
  // 通过Lcu接口查询数据
  public fromLcuQuery = async (onProgress?: CurrentMatchProgressCallback) => {
    await this.init(onProgress)
    if (this.matchSession === null){
      return null
    }
    const localPuuid = readLocalSumInfo().puuid;
    const isTeamOne = this.matchSession.gameData.teamOne.some((i: TeamData) =>
      i.summonerId === this.currentId || (localPuuid && i.puuid === localPuuid),
    );
    const [friendList,enemyList] = await Promise.all([
      this.simplifySummonerInfo(isTeamOne ? this.matchSession.gameData.teamOne : this.matchSession.gameData.teamTwo),
      this.simplifySummonerInfo(isTeamOne ? this.matchSession.gameData.teamTwo : this.matchSession.gameData.teamOne)
    ])
    onProgress?.({
      loaded: friendList.length + enemyList.length,
      total: this.getExpectedTeamSize(this.matchSession) * 2,
      message: `本局玩家读取完成（${friendList.length + enemyList.length} 人）`,
    });
    return {friendList, enemyList,queueId:this.queueId}
  }
  // 获取召唤师Icon
  public getIconAlias = (summoner:TeamData) => {
    if (summoner.championId !== undefined){
      return  champDict[summoner.championId]?.alias || ""
    }
    return ""
    // return  champDict[this.playerChampionSelections[(summoner.summonerName.toLowerCase())]].alias
  }
  // 通过lcu接口获取数据再次进行解析
  public simplifySummonerInfo = async (summonerList: TeamData[]) => {
    try {
      const promisesList:Promise<RecentSumInfo>[] =  summonerList.map(async (summoner:TeamData) => {
        return <RecentSumInfo> {
          matchList:[],
          historyStatus: <RecentHistoryStatus> {
            kind: "loading",
            title: "正在查询历史战绩",
            detail: "正在按当前模式读取本地缓存并校验服务器数据",
            cachedGames: 0,
            serverGames: 0,
            modeGames: 0,
            matchedGames: 0,
          },
          summonerId: summoner.summonerId,
          puuid:summoner.puuid,
          summonerName: summoner.summonerName,
          teamParticipantId:summoner.teamParticipantId,
          champId:summoner.championId,
          championUrl: getChampionImageUrl(summoner.championId || 0),
        }
      })

      const reSumInfoList = await Promise.all(promisesList)
      return reSumInfoList.sort((x: RecentSumInfo, y: RecentSumInfo) => {
        return x.teamParticipantId - y.teamParticipantId
      })
    }catch (e) {
      return [] as RecentSumInfo[]
    }
  }
}

export default QuerySummoner
