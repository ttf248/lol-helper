import {englishToChinese} from "@/lcu/utils";
import {aliasToId, champDict} from "@/resources/champList";
import {invokeLcu} from "@/lcu";
import {querySummonerInfo} from "@/lcu/aboutSummoner";
import {invoke} from "@tauri-apps/api/core";
import {
  LiveGamePlayer,
  PlayerChampionSelection,
  RecentSumInfo,
  SessionTypes,
  TeamData,
  SuperChampTypes,
} from "@/recentMatch/utils/queryTypes";

class QuerySummoner {
  public matchSession: null|SessionTypes = null
  public currentId: number = 0
  public queueId: number = 0

  private wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

    const teamOne: TeamData[] = [];
    const teamTwo: TeamData[] = [];
    for (const player of livePlayers) {
      const team = player.team.toLocaleUpperCase();
      const targetTeam = team === "ORDER"
        ? teamOne
        : team === "CHAOS"
          ? teamTwo
          : null;
      if (targetTeam === null) {
        continue;
      }

      const knownPlayer = knownPlayers.get(this.normalizeName(player.summonerName));
      const info = knownPlayer?.puuid
        ? {
            currentId: knownPlayer.summonerId,
            name: knownPlayer.summonerName,
            puuid: knownPlayer.puuid,
          }
        : await querySummonerInfo(undefined, player.summonerName);
      if (info === null) {
        continue;
      }

      const championId = this.findChampionId(player, selections);
      targetTeam.push({
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
  private hydrateMissingTeam = async (session: SessionTypes): Promise<SessionTypes> => {
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

    const knownPlayers = new Set(
      [...teamOne, ...teamTwo].flatMap((player) => [
        this.getPlayerKey(player),
        player.summonerInternalName ? `name:${player.summonerInternalName}` : "",
        player.summonerName ? `name:${player.summonerName}` : "",
      ]),
    );
    const missingSelections = gameData.playerChampionSelections.filter(
      (selection: PlayerChampionSelection) =>
        selection.summonerInternalName &&
        !knownPlayers.has(`name:${selection.summonerInternalName}`),
    );

    const hydratedPlayers = await Promise.all(
      missingSelections.map(async (selection, index): Promise<TeamData | null> => {
        const info = await querySummonerInfo(
          undefined,
          selection.summonerInternalName,
        );
        if (info === null) {
          return null;
        }

        return {
          championId: selection.championId,
          lastSelectedSkinIndex: selection.selectedSkinIndex,
          profileIconId: 0,
          puuid: info.puuid,
          selectedPosition: "NONE",
          selectedRole: "NONE",
          summonerId: info.currentId,
          summonerInternalName: selection.summonerInternalName,
          summonerName: info.name || selection.summonerInternalName,
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

  // 初始化数据
  public init = async () => {
    let latestSession: SessionTypes | null = null;

    // 加载画面期间分阶段补全队伍信息，最多等待 15 秒。
    for (let attempt = 0; attempt < 30; attempt++) {
      const session = await invokeLcu<SessionTypes>('get','/lol-gameflow/v1/session');
      if (session?.gameData) {
        latestSession = await this.hydrateMissingTeam(session);

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
          }
        }

        if (this.hasCompleteTeams(latestSession)) {
          break;
        }
      }
      if (attempt < 29) {
        await this.wait(500);
      }
    }

    if (latestSession === null) {
      this.matchSession = null
      this.queueId = 0
      return
    }

    this.matchSession = latestSession;
    this.queueId = latestSession.gameData.queue.id;
    const localSumInfo = JSON.parse(localStorage.getItem('sumInfo') || 'null');
    this.currentId = Number(localSumInfo?.summonerId || 0);
  }
  // 通过Lcu接口查询数据
  public fromLcuQuery = async () => {
    await this.init()
    if (this.matchSession === null){
      return null
    }
    const localPuuid = JSON.parse(localStorage.getItem('sumInfo') || 'null')?.puuid;
    const isTeamOne = this.matchSession.gameData.teamOne.some((i: TeamData) =>
      i.summonerId === this.currentId || (localPuuid && i.puuid === localPuuid),
    );
    const [friendList,enemyList] = await Promise.all([
      this.simplifySummonerInfo(isTeamOne ? this.matchSession.gameData.teamOne : this.matchSession.gameData.teamTwo),
      this.simplifySummonerInfo(isTeamOne ? this.matchSession.gameData.teamTwo : this.matchSession.gameData.teamOne)
    ])
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
        const iconAlias = this.getIconAlias(summoner)
        const summonerState = await this.querySummonerSuperChampData(summoner.puuid, iconAlias)
        const rankPoint = await this.queryRankPoint(summoner.puuid)
        return <RecentSumInfo> {
          matchList:[],
          rankPoint:rankPoint,
          summonerState: summonerState,
          summonerId: summoner.summonerId,
          puuid:summoner.puuid,
          summonerName: summoner.summonerName,
          teamParticipantId:summoner.teamParticipantId,
          champId:summoner.championId,
          championUrl: `https://game.gtimg.cn/images/lol/act/img/champion/${iconAlias}.png`
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
  // 获取段位数据
  public queryRankPoint = async (puuid: string): Promise<string[]> => {
    const fetchRankDataWithRetry = async (retries = 2): Promise<any> => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await invokeLcu('get', `/lol-ranked/v1/ranked-stats/${puuid}`);
          if (res !== null) return res; // 如果获取成功，立即返回
          await new Promise((resolve) => setTimeout(resolve, 300));
        } catch (error) {
          console.warn(`Attempt ${attempt + 1} failed:`, error);
        }
      }
      return null; // 如果所有尝试均失败，返回 null
    };

    const res = await fetchRankDataWithRetry();

    if (res === null) {
      return ['error', 'error'];
    }

    // 解析 rank 数据
    const rankData = res.queueMap ?? (Array.isArray(res.queues)
      ? res.queues.reduce((result: Record<string, any>, item: any) => {
          result[item.queueType] = item;
          return result;
        }, {})
      : {});
    return ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'].reduce((acc: string[], queueType: string) => {
      const tier = rankData[queueType]?.tier === "" ? '未定级' : englishToChinese(rankData[queueType].tier);
      const division = rankData[queueType]?.division === 'NA' ? '' : rankData[queueType]?.division || '';
      acc.push(tier !== '未定级' ? `${tier}${division}` : '未定级');
      return acc;
    }, []);
  };

  // 获取召唤师英雄绝活数据 Z:正常 A:绝活 B:熟练 S:小代 Y:未知 (需要进行下一步判断)
  public querySummonerSuperChampData = async (puuid: string, champAlias: string) => {
    // 获取英雄 ID
    const champId = aliasToId[champAlias];
    const curChampMark = { lv: -1, score: -1 };

    // 获取召唤师英雄绝活数据
    const superList: SuperChampTypes[] | null = await invokeLcu('get', `/lol-champion-mastery/v1/${puuid}/champion-mastery`);

    if (!superList) {
      return { label: 'Z', lv: curChampMark.lv, score: curChampMark.score };
    }

    // 查找当前英雄的等级和分数
    const curChamp = superList.find((val: SuperChampTypes) => val.championId === champId);
    if (curChamp) {
      curChampMark.lv = curChamp.championLevel;
      curChampMark.score = curChamp.championPoints;
    }

    // 检查前 6 名中的位置
    const top6List = superList.slice(0, 6);
    const champIndex = top6List.findIndex((val: SuperChampTypes) => val.championId === champId);

    if (champIndex !== -1) {
      return {
        label: champIndex < 3 ? 'A' : 'B',
        lv: curChampMark.lv,
        score: curChampMark.score,
      };
    }

    // 英雄未上榜
    return { label: 'Y', lv: curChampMark.lv, score: curChampMark.score };
  };
}

export default QuerySummoner
