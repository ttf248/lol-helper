import {
  queryMatchHistoryWithSource,
  queryMatchHistoryFullWithSource,
  MatchHistoryGame,
} from "@/lcu/aboutMatch";
import { Games } from "@/lcu/types/queryMatchLcuTypes";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import BlackList from "@/main/views/record/blackList";
import { Hater } from "@/main/views/record/blackListTypes";
import { cacheHistory, getCachedHistory, getCachedPlayerSummary } from "@/recentMatch/utils/databaseCache";
import { isModeQueue, MatchModeKey, modeForQueue } from "@/recentMatch/utils/matchMode";
import {
  ChampionRecentStats,
  ConfidenceInfo,
  ConfidenceLevel,
  MatchItemTypes,
  ModerationRecord,
  OpponentMatchupStats,
  PartyEvidence,
  PartyGroupAnalysis,
  PartyMember,
  PlayerAnalysisProgress,
  PlayerModerationInfo,
  PlayerRecentAnalysis,
  HistoryCoverageInfo,
  PositionRecentStats,
  RecentNetworkAnalysis,
  RecentNetworkEdge,
  RecentNetworkNode,
  RecentSumInfo,
  TeammateSynergyStats,
} from "@/recentMatch/utils/queryTypes";
import {
  historyGameQuality,
  mergeHistoryGames,
} from "@/recentMatch/utils/historyData";
import {
  HISTORY_CACHE_PAGE_SIZE,
  HISTORY_FRIEND_FALLBACK_LIMIT,
  HISTORY_PANEL_PREVIEW_COUNT,
  HISTORY_SERVER_PAGE_SIZE,
} from "@/recentMatch/utils/historyConfig";
import { logger } from "@/utils/logger";

export const RECENT_DEFAULT_GAME_COUNT = HISTORY_PANEL_PREVIEW_COUNT;

const HISTORY_CONCURRENCY = 5;
const RECENT_ACTIVITY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MODERATION_TIMEOUT_MS = 2500;

export interface NormalizedHistoryParticipant {
  puuid: string;
  summonerId?: number;
  summonerName?: string;
  teamId: number;
  championId: number;
  position: string;
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
}

export interface NormalizedHistoryGame {
  gameId: number;
  gameCreation: number;
  queueId: number;
  participants: NormalizedHistoryParticipant[];
  source?: string;
}

interface PlayerHistorySnapshot {
  puuid: string;
  games: Map<number, NormalizedHistoryGame>;
  source: string;
  sourceEndpoints: string[];
  complete: boolean;
  dataCoverage?: HistoryCoverageInfo;
}

export interface RecentAnalysisProgress {
  stage: "cache" | "recent" | "full" | "done";
  completed: number;
  total: number;
  message: string;
}

const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const roundRate = (wins: number, games: number): number | null =>
  games > 0 ? Math.round((wins / games) * 1000) / 10 : null;

const normalizePosition = (rawPosition: unknown): string => {
  const value = String(rawPosition || "").trim().toUpperCase();
  switch (value) {
    case "TOP":
      return "TOP";
    case "JUNGLE":
    case "JG":
      return "JUNGLE";
    case "MIDDLE":
    case "MID":
      return "MIDDLE";
    case "BOTTOM":
    case "BOT":
    case "ADC":
    case "DUO_CARRY":
      return "BOTTOM";
    case "SUPPORT":
    case "UTILITY":
    case "DUO_SUPPORT":
      return "SUPPORT";
    default:
      return "UNKNOWN";
  }
};

const getPosition = (participant: any): string => {
  const lcuTimeline = participant?.timeline;
  const candidates = [
    participant?.individualPosition,
    participant?.teamPosition,
    participant?.role,
    participant?.lane,
    lcuTimeline?.role,
    lcuTimeline?.lane,
  ].filter((value) => {
    const normalized = String(value || "").trim().toUpperCase();
    return normalized && normalized !== "INVALID" && normalized !== "NONE";
  });
  for (const candidate of candidates) {
    const normalized = normalizePosition(candidate);
    if (normalized !== "UNKNOWN") {
      return normalized;
    }
  }
  return "UNKNOWN";
};

const normalizeIdentityName = (name: unknown): string =>
  String(name || "").trim().toLocaleLowerCase();

const getIdentityKey = (
  puuid: unknown,
  summonerId: number | undefined,
  summonerName: unknown,
): string => {
  const normalizedPuuid = String(puuid || "").trim();
  if (normalizedPuuid) return normalizedPuuid;
  if (summonerId !== undefined && summonerId > 0) {
    return `summoner-id:${summonerId}`;
  }
  const normalizedName = normalizeIdentityName(summonerName);
  return normalizedName ? `summoner-name:${normalizedName}` : "";
};

const participantStats = (
  participant: any,
  stats: any,
  identity?: any,
): NormalizedHistoryParticipant | null => {
  const summonerId = asOptionalNumber(
    participant?.summonerId ?? identity?.player?.summonerId,
  );
  const summonerName =
    participant?.summonerName || identity?.player?.summonerName || undefined;
  const puuid = getIdentityKey(
    participant?.puuid || identity?.player?.puuid,
    summonerId,
    summonerName,
  );
  if (!puuid) {
    return null;
  }

  const source = stats || participant;
  return {
    puuid,
    summonerId,
    summonerName,
    teamId: asNumber(participant?.teamId),
    championId: asNumber(participant?.championId),
    position: getPosition(participant),
    kills: asNumber(source?.kills),
    deaths: asNumber(source?.deaths),
    assists: asNumber(source?.assists),
    win: Boolean(source?.win),
  };
};

const participantMatchesPlayer = (
  participant: NormalizedHistoryParticipant,
  player: RecentSumInfo,
): boolean => {
  if (participant.puuid === player.puuid) return true;
  if (
    participant.summonerId !== undefined &&
    participant.summonerId === player.summonerId
  ) {
    return true;
  }
  return (
    normalizeIdentityName(participant.summonerName) !== "" &&
    normalizeIdentityName(participant.summonerName) ===
      normalizeIdentityName(player.summonerName)
  );
};

const findPlayerParticipant = (
  game: NormalizedHistoryGame,
  player: RecentSumInfo,
): NormalizedHistoryParticipant | undefined =>
  game.participants.find((participant) =>
    participantMatchesPlayer(participant, player),
  );

const combinations = <T>(items: T[], size: number): T[][] => {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  if (size === 1) return items.map((item) => [item]);
  const result: T[][] = [];
  for (let index = 0; index <= items.length - size; index++) {
    for (const tail of combinations(items.slice(index + 1), size - 1)) {
      result.push([items[index], ...tail]);
    }
  }
  return result;
};

/** 将 LCU/SGP 的不同 participant 结构转换成分析层使用的统一结构。 */
export const normalizeHistoryGame = (
  game: MatchHistoryGame,
  source = "interface",
): NormalizedHistoryGame | null => {
  if (
    !game ||
    typeof game.gameId !== "number" ||
    typeof game.gameCreation !== "number" ||
    !Array.isArray(game.participants)
  ) {
    return null;
  }

  const participants = (game as GamesBySgp).participants
    .map((participant: any) => {
      if ("participantIdentities" in game) {
        const identity = (game as Games).participantIdentities?.find(
          (item: any) => item.participantId === participant.participantId,
        );
        return participantStats(participant, participant.stats, identity);
      }
      return participantStats(participant, participant);
    })
    .filter(
      (participant): participant is NormalizedHistoryParticipant =>
        participant !== null,
    );

  if (participants.length === 0) {
    return null;
  }

  return {
    gameId: game.gameId,
    gameCreation: game.gameCreation,
    queueId: game.queueId,
    participants,
    source,
  };
};

const uniqueGames = (
  games: MatchHistoryGame[],
  modeKey: MatchModeKey,
  player: RecentSumInfo,
  source = "interface",
): Map<number, NormalizedHistoryGame> => {
  const result = new Map<number, NormalizedHistoryGame>();
  for (const rawGame of games) {
    if (!isModeQueue(rawGame.queueId, modeKey)) {
      continue;
    }
    const game = normalizeHistoryGame(rawGame, source);
    if (!game || !findPlayerParticipant(game, player)) {
      continue;
    }
    result.set(game.gameId, game);
  }
  return new Map(
    Array.from(result.entries()).sort(
      ([, left], [, right]) => right.gameCreation - left.gameCreation,
    ),
  );
};

const historyCache = new Map<string, Promise<PlayerHistorySnapshot>>();

const sortGames = (games: NormalizedHistoryGame[]) =>
  mergeHistoryGames([], games, Math.max(games.length, 1)).games;

// 只有同一局至少包含一支完整队伍时，才能用于同队/对手关系分析。
// 普通战绩接口可能只缓存目标玩家一个 participant，这种数据仍可计算
// 个人胜率，但不能误判为“没有共同对局”。
const hasParticipantRoster = (games: NormalizedHistoryGame[]): boolean =>
  games.length > 0 &&
  games.every((game) => historyGameQuality(game) === "complete");

interface QueueHydrationResult {
  games: NormalizedHistoryGame[];
  source: string;
  sourceEndpoints: string[];
  coverage: HistoryCoverageInfo;
}

interface QueueHydrationEntry {
  serverLimit: number;
  request: Promise<QueueHydrationResult>;
}

const queueHydration = new Map<string, QueueHydrationEntry>();

const historyKey = (puuid: string, modeKey: MatchModeKey) =>
  `${puuid}:${modeKey}`;

const syncPlayerModeGames = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  existingGames: NormalizedHistoryGame[],
  serverLimit = HISTORY_FRIEND_FALLBACK_LIMIT,
): Promise<{
  games: NormalizedHistoryGame[];
  source: string;
  sourceEndpoints: string[];
  coverage: HistoryCoverageInfo;
}> => {
  const startedAt = Date.now();
  const boundedServerLimit = Math.min(
    HISTORY_FRIEND_FALLBACK_LIMIT,
    Math.max(1, serverLimit),
  );
  logger.info({
    tag: "recent.analysis",
    message: "玩家历史同步发起",
    context: {
      purpose: "单玩家单模式历史同步：摘要接口 + 完整参与者接口 + 缓存合并",
      puuid: player.puuid,
      summoner_id: player.summonerId ?? null,
      summoner_name: player.summonerName ?? null,
      mode_key: modeKey,
      server_limit: boundedServerLimit,
      cached_games: existingGames.length,
    },
  });

  // 先走和战绩分页相同的轻量摘要接口。当前模式没有记录时，
  // 不再继续进入完整参与者/SGP 链路。
  const summaryResult = await queryMatchHistoryWithSource(
    player.puuid,
    0,
    boundedServerLimit,
  );
  const summaryGames = uniqueGames(
    summaryResult?.games ?? [],
    modeKey,
    player,
    summaryResult?.source || "interface",
  );
  const summaryMerged = mergeHistoryGames(
    existingGames,
    Array.from(summaryGames.values()),
    HISTORY_CACHE_PAGE_SIZE,
    { puuid: player.puuid, modeKey },
  );

  // 本地已有完整窗口时，摘要只负责刷新最近数据，不必再请求完整参与者。
  const needsFullParticipants =
    existingGames.length < HISTORY_CACHE_PAGE_SIZE ||
    !hasParticipantRoster(existingGames);

  let finalGames = summaryMerged.games;
  let finalSource =
    summaryResult?.source ||
    (existingGames.length > 0 ? "PostgreSQL 本地缓存" : "unavailable");
  let finalEndpoints = summaryResult?.endpoints || [];
  let finalCoverage = summaryMerged.coverage;
  const fullRequested =
    needsFullParticipants &&
    (summaryGames.size > 0 || existingGames.length > 0);

  if (fullRequested) {
    // 只有确认当前模式有数据（或已有本地样本）后，才进入较慢的完整参与者链路。
    const fullResult = await queryMatchHistoryFullWithSource(
      player.puuid,
      0,
      boundedServerLimit,
    );
    const fullGames = uniqueGames(
      fullResult?.games ?? [],
      modeKey,
      player,
      fullResult?.source || "interface-full",
    );
    const merged = mergeHistoryGames(
      existingGames,
      [...summaryGames.values(), ...fullGames.values()],
      HISTORY_CACHE_PAGE_SIZE,
      { puuid: player.puuid, modeKey },
    );
    finalGames = merged.games;
    finalCoverage = merged.coverage;
    finalSource = fullResult?.source || summaryResult?.source || finalSource;
    finalEndpoints = Array.from(
      new Set([
        ...(summaryResult?.endpoints || []),
        ...(fullResult?.endpoints || []),
      ]),
    );
  }

  logger.info({
    tag: "recent.analysis",
    message: "玩家历史同步完成",
    context: {
      purpose: "单玩家单模式历史同步：摘要接口 + 完整参与者接口 + 缓存合并",
      puuid: player.puuid,
      summoner_id: player.summonerId ?? null,
      summoner_name: player.summonerName ?? null,
      mode_key: modeKey,
      server_limit: boundedServerLimit,
      cached_games: existingGames.length,
      summary_games: summaryGames.size,
      merged_games: finalGames.length,
      full_requested: fullRequested,
      final_source: finalSource,
      final_endpoints: finalEndpoints,
      duration_ms: Date.now() - startedAt,
    },
    durationMs: Date.now() - startedAt,
  });

  return {
    games: finalGames,
    source: finalSource,
    sourceEndpoints: finalEndpoints,
    coverage: finalCoverage,
  };
};

const hydratePlayerQueueHistory = (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  existingGames: NormalizedHistoryGame[],
  serverLimit = HISTORY_FRIEND_FALLBACK_LIMIT,
): Promise<QueueHydrationResult> => {
  const key = historyKey(player.puuid, modeKey);
  const boundedServerLimit = Math.min(
    HISTORY_FRIEND_FALLBACK_LIMIT,
    Math.max(1, serverLimit),
  );
  const existing = queueHydration.get(key);
  if (existing && existing.serverLimit >= boundedServerLimit) {
    return existing.request;
  }

  const request = (async (): Promise<QueueHydrationResult> => {
    const synced = await syncPlayerModeGames(
      player,
      modeKey,
      existingGames,
      boundedServerLimit,
    );
    const games = synced.games;
    if (games.length > 0) {
      await cacheHistory({
        puuid: player.puuid,
        summonerId: player.summonerId,
        summonerName: player.summonerName,
        modeKey,
        source: synced.source,
        games,
      });
    }
    return {
      games,
      source: synced.source,
      sourceEndpoints: synced.sourceEndpoints,
      coverage: synced.coverage,
    };
  })().catch((error) => {
    logger.warn({
      tag: "recent.analysis",
      message: "服务器历史补全失败",
      context: { error: String(error).slice(0, 200) },
    });
    return {
      games: existingGames,
      source: "PostgreSQL 本地缓存",
      sourceEndpoints: [],
      coverage: mergeHistoryGames(
        existingGames,
        [],
        HISTORY_CACHE_PAGE_SIZE,
      ).coverage,
    };
  });
  queueHydration.set(key, {
    serverLimit: boundedServerLimit,
    request,
  });
  // 任务结果保留在当前面板生命周期内，保证极快返回的完整历史也能被
  // loadRecentTeamAnalysis 捕获并刷新 UI。新一局开始时由
  // clearRecentAnalysisCache 一并清理，避免跨对局复用。
  return request;
};

const loadPlayerHistory = async (
  player: RecentSumInfo,
  queueId: number,
): Promise<PlayerHistorySnapshot> => {
  const modeKey = modeForQueue(queueId);
  const key = historyKey(player.puuid, modeKey);
  const cached = historyCache.get(key);
  if (cached) {
    return cached;
  }

  const request = (async (): Promise<PlayerHistorySnapshot> => {
    const cachedGames = await getCachedHistory({
      puuid: player.puuid,
      modeKey,
      limit: HISTORY_CACHE_PAGE_SIZE,
    });
    if (cachedGames.length > 0) {
      // 即使本地已经有 100 场，也只向服务器同步最近三页；
      // 合并时通过 gameId 去重并让接口的完整 participant 覆盖旧缓存。
      void hydratePlayerQueueHistory(player, modeKey, cachedGames);
      const limitedGames = new Map(
        cachedGames.slice(0, HISTORY_CACHE_PAGE_SIZE).map((game) => [
          game.gameId,
          game,
        ]),
      );
      return {
        puuid: player.puuid,
        games: limitedGames,
        source: "PostgreSQL 本地缓存",
        sourceEndpoints: player.historyStatus?.sourceEndpoints || [],
        complete:
          limitedGames.size >= HISTORY_CACHE_PAGE_SIZE &&
          hasParticipantRoster(Array.from(limitedGames.values())),
        dataCoverage: mergeHistoryGames(
          cachedGames,
          [],
          HISTORY_CACHE_PAGE_SIZE,
        ).coverage,
      };
    }

    // PostgreSQL 不可用或首次缓存尚未写入时，直接复用首屏已取得的
    // 最近 10 场。本地无缓存时服务器兜底拉取最近 1 页（20 场），不能阻塞对局面板首屏。
    const quickGames = sortGames(
      (Array.isArray(player.matchList) ? player.matchList : [])
        .filter((match) => isModeQueue(match.queueId, modeKey))
        .slice(0, RECENT_DEFAULT_GAME_COUNT)
        .map((match, index) => quickMatchToGame(match, player, index)),
    );
    if (quickGames.length > 0) {
      void hydratePlayerQueueHistory(player, modeKey, quickGames);
      return {
        puuid: player.puuid,
        games: new Map(quickGames.map((game) => [game.gameId, game])),
        source: "当前面板已加载的最近战绩",
        sourceEndpoints: player.historyStatus?.sourceEndpoints || [],
        complete: false,
        dataCoverage: mergeHistoryGames([], quickGames, RECENT_DEFAULT_GAME_COUNT)
          .coverage,
      };
    }

    // 没有首屏摘要时也不要让一个玩家阻塞其它玩家的最近 10 场分析。
    // 由统一的后台任务异步基于本地缓存刷新整队分析。
    void hydratePlayerQueueHistory(player, modeKey, []);
    return {
      puuid: player.puuid,
      games: new Map(),
      source: "后台查询中",
      sourceEndpoints: player.historyStatus?.sourceEndpoints || [],
      complete: false,
    };
  })();

  historyCache.set(key, request);
  return request;
};

type PlayerAnalysisProgressHandler = (
  progress: PlayerAnalysisProgress,
) => void;

const toHistorySnapshot = (
  player: RecentSumInfo,
  games: NormalizedHistoryGame[],
  source: string,
  sourceEndpoints: string[] = [],
  dataCoverage?: HistoryCoverageInfo,
): PlayerHistorySnapshot => ({
  puuid: player.puuid,
  games: new Map(games.map((game) => [game.gameId, game])),
  source,
  sourceEndpoints,
  complete:
    games.length >= HISTORY_CACHE_PAGE_SIZE && hasParticipantRoster(games),
  dataCoverage,
});

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onItem?: (index: number, result: R) => void,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const run = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex]);
      onItem?.(currentIndex, results[currentIndex]);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(limit, Math.max(items.length, 1)) },
      () => run(),
    ),
  );
  return results;
};

const emptyModeration = (): PlayerModerationInfo => ({
  available: false,
  marked: false,
  reportCount: 0,
  blacklistCount: 0,
  positiveCount: 0,
  records: [],
});

const toModerationRecord = (record: any): ModerationRecord => ({
  tag: String(record?.tag || "未分类"),
  content: String(record?.content || ""),
  isShow: Boolean(record?.isShow),
  updatedAt: String(record?.UpdatedAt || record?.updatedAt || ""),
  playerSumName: String(record?.playerSumName || ""),
});

const loadModerationMap = async (
  players: RecentSumInfo[],
): Promise<Map<string, PlayerModerationInfo>> => {
  const result = new Map<string, PlayerModerationInfo>();
  players.forEach((player) => result.set(player.puuid, emptyModeration()));

  const sumIds = players
    .map((player) => player.summonerId)
    .filter((summonerId) => Number.isFinite(summonerId) && summonerId > 0)
    .map(String);
  if (sumIds.length === 0) {
    return result;
  }

  try {
    const haterList: Hater[] | null = await Promise.race([
      new BlackList().querySumDetails(sumIds, false),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), MODERATION_TIMEOUT_MS),
      ),
    ]);
    if (haterList === null) {
      logger.warn({
        tag: "recent.analysis.moderation",
        message: "举报记录查询超时或不可用",
        context: { players: players.length, timeout_ms: MODERATION_TIMEOUT_MS },
      });
      return result;
    }

    for (const player of players) {
      const hater = haterList.find(
        (item) => String(item.sumId) === String(player.summonerId),
      );
      const records = (hater?.blacklist || []).map(toModerationRecord);
      result.set(player.puuid, {
        available: true,
        marked: records.some((record) => record.isShow),
        reportCount: records.length,
        blacklistCount: records.filter((record) => record.isShow).length,
        positiveCount: records.filter((record) => !record.isShow).length,
        records,
      });
    }
  } catch (error) {
    logger.warn({
      tag: "recent.analysis.moderation",
      message: "举报记录加载失败",
      context: { error: String(error).slice(0, 200) },
    });
  }

  return result;
};

const buildChampionStats = (
  games: NormalizedHistoryGame[],
  player: RecentSumInfo,
): ChampionRecentStats[] => {
  const byChampion = new Map<number, ChampionRecentStats>();
  for (const game of games) {
    const participant = findPlayerParticipant(game, player);
    if (!participant) continue;

    const current = byChampion.get(participant.championId) || {
      championId: participant.championId,
      games: 0,
      wins: 0,
      winRate: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
    };
    current.games += 1;
    current.wins += participant.win ? 1 : 0;
    current.kills += participant.kills;
    current.deaths += participant.deaths;
    current.assists += participant.assists;
    current.winRate = roundRate(current.wins, current.games) ?? 0;
    byChampion.set(participant.championId, current);
  }

  return Array.from(byChampion.values()).sort(
    (left, right) =>
      right.games - left.games ||
      right.winRate - left.winRate ||
      left.championId - right.championId,
  );
};

const buildPositionStats = (
  games: NormalizedHistoryGame[],
  player: RecentSumInfo,
): PositionRecentStats[] => {
  const byPosition = new Map<string, NormalizedHistoryGame[]>();
  for (const game of games) {
    const participant = findPlayerParticipant(game, player);
    if (!participant) continue;
    const current = byPosition.get(participant.position) || [];
    current.push(game);
    byPosition.set(participant.position, current);
  }

  return Array.from(byPosition.entries())
    .map(([position, positionGames]) => {
      const playerParticipants = positionGames
        .map((game) => findPlayerParticipant(game, player))
        .filter(Boolean) as NormalizedHistoryParticipant[];
      const wins = playerParticipants.filter((participant) => participant.win).length;
      return {
        position,
        games: playerParticipants.length,
        wins,
        winRate: roundRate(wins, playerParticipants.length) ?? 0,
        champions: buildChampionStats(positionGames, player),
      };
    })
    .sort(
      (left, right) =>
        right.games - left.games || right.winRate - left.winRate,
    );
};

const quickMatchToGame = (
  match: MatchItemTypes,
  player: RecentSumInfo,
  index: number,
): NormalizedHistoryGame => ({
  gameId: match.gameId,
  // 首屏摘要现在携带接口/数据库的真实时间。只有兼容旧数据时才
  // 使用递减时间，避免把不同玩家的摘要按“请求完成时间”重新排序。
  gameCreation:
    Number.isFinite(match.gameCreation) && Number(match.gameCreation) > 0
      ? Number(match.gameCreation)
      : Date.now() - index,
  queueId: match.queueId,
  source: "current-panel",
  participants: [
    {
      puuid: player.puuid,
      summonerId: player.summonerId,
      summonerName: player.summonerName,
      teamId: 100,
      championId: asNumber(match.championId),
      position: "UNKNOWN",
      kills: asNumber(match.kills),
      deaths: asNumber(match.deaths),
      assists: asNumber(match.assists),
      win: Boolean(match.isWin),
    },
  ],
});

const buildQuickPlayerAnalysis = (
  player: RecentSumInfo,
  modeKey?: MatchModeKey,
  requestedGames = RECENT_DEFAULT_GAME_COUNT,
): PlayerRecentAnalysis => {
  const quickMatches = (Array.isArray(player.matchList) ? player.matchList : [])
    .filter((match) =>
      modeKey === undefined || isModeQueue(Number(match.queueId), modeKey),
    )
    .slice(0, requestedGames);
  const games = quickMatches.map((match, index) =>
    quickMatchToGame(match, player, index),
  );
  const playerGames = games
    .map((game) => findPlayerParticipant(game, player))
    .filter(
      (participant): participant is NormalizedHistoryParticipant =>
        participant !== undefined,
    );
  const wins = playerGames.filter((participant) => participant.win).length;
  const champions = buildChampionStats(games, player);
  const actualGames = playerGames.length;
  const confidenceScore = Math.min(actualGames / requestedGames, 1) * 70;

  return {
    actualGames,
    wins,
    winRate: roundRate(wins, actualGames),
    currentChampion:
      champions.find((item) => item.championId === player.champId) || null,
    champions,
    positions: [],
    opponents: [],
    partyGroups: [],
    confidence: confidenceInfo(confidenceScore, [
      `面板已加载当前模式最近 ${actualGames}/${requestedGames} 场`,
      "位置、交手和组合关系将在后台继续补齐",
    ]),
    moderation: emptyModeration(),
    source: "当前面板已加载的最近战绩",
    sourceEndpoints: player.historyStatus?.sourceEndpoints || [],
    historyComplete: false,
  };
};

/** 先使用面板已有的最近 10 场，避免完整历史接口阻塞首屏。 */
export const applyFastRecentAnalysis = (players: RecentSumInfo[]) => {
  players.forEach((player) => {
    player.recentAnalysis = buildQuickPlayerAnalysis(player);
  });
};

const confidenceLevel = (score: number): ConfidenceLevel =>
  score >= 80 ? "high" : score >= 50 ? "medium" : "low";

const confidenceInfo = (score: number, reasons: string[]): ConfidenceInfo => ({
  level: confidenceLevel(score),
  score: Math.max(0, Math.min(100, Math.round(score))),
  reasons,
});

const toPartyMember = (
  player: RecentSumInfo,
  moderationMap: Map<string, PlayerModerationInfo>,
): PartyMember => ({
  puuid: player.puuid,
  summonerName: player.summonerName,
  moderation: moderationMap.get(player.puuid) || emptyModeration(),
});

const buildOpponentStats = (
  player: RecentSumInfo,
  opponents: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
  moderationMap: Map<string, PlayerModerationInfo>,
): OpponentMatchupStats[] => {
  const ownSnapshot = snapshots.get(player.puuid);
  if (!ownSnapshot) return [];

  return opponents
    .map((opponent) => {
      const opponentSnapshot = snapshots.get(opponent.puuid);
      if (!opponentSnapshot) return null;
      const opponentGames = new Set(opponentSnapshot.games.keys());
      const sharedGameIds = Array.from(ownSnapshot.games.keys()).filter((gameId) =>
        opponentGames.has(gameId),
      );
      let games = 0;
      let wins = 0;
      let opponentWins = 0;
      for (const gameId of sharedGameIds) {
        const game = ownSnapshot.games.get(gameId);
        const ownParticipant = game
          ? findPlayerParticipant(game, player)
          : undefined;
        const opponentParticipant = game
          ? findPlayerParticipant(game, opponent)
          : undefined;
        if (!ownParticipant || !opponentParticipant) continue;
        if (ownParticipant.teamId === opponentParticipant.teamId) continue;
        games += 1;
        wins += ownParticipant.win ? 1 : 0;
        opponentWins += opponentParticipant.win ? 1 : 0;
      }
      if (games === 0) return null;
      return {
        opponent: toPartyMember(opponent, moderationMap),
        games,
        wins,
        opponentWins,
        winRate: roundRate(wins, games) ?? 0,
      };
    })
    .filter((item): item is OpponentMatchupStats => item !== null)
    .sort((left, right) => right.games - left.games || right.winRate - left.winRate);
};

/**
 * 「疑似开黑」检测结构层中间结果。
 *
 * 与 `PartyGroupAnalysis` 相比，不依赖举报/黑名单信息（moderationMap），
 * 可被多次复用：例如 `applyTeamAnalysis` 在「先空 moderation 快出结果、
 * 后用真实 moderation 再算一次」的两段式调用中，复用结构层即可。
 */
type StructuralPartyGroup = {
  members: RecentSumInfo[];
  requiredGames: number;
  games: number;
  wins: number;
  winRate: number;
  latestGameAt: number;
  recentGames: number;
  /** 已经包含 games/recentGames/winRate 的预计算分。 */
  stabilityScore: number;
  /** 仅依赖结构层数据，可提前计算避免在 overlay 阶段再判一次。 */
  highWinRateAlert: boolean;
  evidence: PartyEvidence[];
};

/**
 * 结构层 WeakMap 缓存：外层 key 是 snapshotMap 引用，内层 key 是
 * players 数组引用。当 `loadRecentTeamAnalysis` 内的 friendList /
 * enemyList 在 Pass 1 与 Pass 2 共享同一引用时，Pass 2 直接命中；
 * Pass 3（hydratedSnapshotMap）引用不同，会触发一次 miss 后再次命中。
 *
 * WeakMap 的引用特性保证 snapshotMap 与 players 被 GC 后条目自动回收。
 */
const partyGroupsStructureCache = new WeakMap<
  Map<string, PlayerHistorySnapshot>,
  WeakMap<RecentSumInfo[], StructuralPartyGroup[]>
>();

const buildPartyGroupsStructure = (
  players: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
): StructuralPartyGroup[] => {
  const structures: StructuralPartyGroup[] = [];
  const now = Date.now();
  for (let size = 2; size <= players.length; size++) {
    for (const group of combinations(players, size)) {
      const groupSnapshots = group
        .map((player) => snapshots.get(player.puuid))
        .filter(
          (snapshot): snapshot is PlayerHistorySnapshot =>
            snapshot !== undefined,
        );
      if (groupSnapshots.length !== group.length) continue;

      let commonGameIds = Array.from(groupSnapshots[0].games.keys());
      for (const snapshot of groupSnapshots.slice(1)) {
        const gameIds = new Set(snapshot.games.keys());
        commonGameIds = commonGameIds.filter((gameId) => gameIds.has(gameId));
      }

      let games = 0;
      let wins = 0;
      let latestGameAt = 0;
      let recentGames = 0;
      const evidence: PartyEvidence[] = [];
      for (const gameId of commonGameIds) {
        const game = groupSnapshots[0].games.get(gameId);
        if (!game) continue;
        const participants = group.map((player) =>
          findPlayerParticipant(game, player),
        );
        if (
          participants.some(
            (participant) =>
              participant === undefined || participant.teamId <= 0,
          )
        ) {
          continue;
        }
        const teamId = participants[0]!.teamId;
        if (
          participants.some(
            (participant) => participant!.teamId !== teamId,
          )
        ) {
          continue;
        }
        games += 1;
        wins += participants[0]!.win ? 1 : 0;
        evidence.push({
          gameId: game.gameId,
          gameCreation: game.gameCreation,
        });
        latestGameAt = Math.max(latestGameAt, game.gameCreation);
        if (game.gameCreation >= now - RECENT_ACTIVITY_DAYS * DAY_MS) {
          recentGames += 1;
        }
      }

      // 人数越多，偶然同队的概率越高。两人两场可以作为候选，
      // 三/四/五人组合分别至少需要三/四/五场完全相同的共同同队对局。
      // 这样不会因为一两场交集就把整队误报成一个开黑小队。
      const requiredGames = Math.max(2, Math.min(group.length, 5));
      if (games < requiredGames) continue;
      const winRate = roundRate(wins, games) ?? 0;
      const stabilityScore = Math.round(
        Math.min(games / 10, 1) * 40 +
          Math.min(recentGames / 5, 1) * 30 +
          (winRate / 100) * 30,
      );
      structures.push({
        members: group,
        requiredGames,
        games,
        wins,
        winRate,
        latestGameAt,
        recentGames,
        stabilityScore,
        highWinRateAlert:
          games >= 5 && winRate >= 65 && stabilityScore >= 55,
        evidence: evidence.sort(
          (left, right) => right.gameCreation - left.gameCreation,
        ),
      });
    }
  }

  return structures.sort(
    (left, right) =>
      Number(right.highWinRateAlert) - Number(left.highWinRateAlert) ||
      right.members.length - left.members.length ||
      right.stabilityScore - left.stabilityScore ||
      right.games - left.games,
  );
};

const getCachedPartyGroupsStructure = (
  players: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
): StructuralPartyGroup[] => {
  let perSnapshot = partyGroupsStructureCache.get(snapshots);
  if (!perSnapshot) {
    perSnapshot = new WeakMap();
    partyGroupsStructureCache.set(snapshots, perSnapshot);
  }
  const cached = perSnapshot.get(players);
  if (cached) return cached;
  const fresh = buildPartyGroupsStructure(players, snapshots);
  perSnapshot.set(players, fresh);
  return fresh;
};

/**
 * 把结构层结果叠加 moderation/黑名单/置信度等 UI 字段。
 * 纯函数：给定相同输入（structure + moderationMap + now）总返回相同结果。
 */
const applyPartyGroupOverlay = (
  structure: StructuralPartyGroup,
  moderationMap: Map<string, PlayerModerationInfo>,
  now: number,
): PartyGroupAnalysis => {
  const members = structure.members.map((player) =>
    toPartyMember(player, moderationMap),
  );
  const blacklistedMembers = members.filter(
    (member) => member.moderation?.marked === true,
  );
  const reportedMembers = members.filter(
    (member) => (member.moderation?.reportCount || 0) > 0,
  );
  const moderationAvailable = members.every(
    (member) => member.moderation?.available === true,
  );
  const confidenceScore = Math.round(
    Math.min(structure.games / 10, 1) * 70 +
      Math.min(structure.recentGames / 5, 1) * 20 +
      (moderationAvailable ? 10 : 0),
  );
  const lastActiveDays = structure.latestGameAt
    ? Math.max(0, Math.floor((now - structure.latestGameAt) / DAY_MS))
    : null;
  return {
    members,
    requiredGames: structure.requiredGames,
    games: structure.games,
    wins: structure.wins,
    winRate: structure.winRate,
    latestGameAt: structure.latestGameAt,
    recentGames: structure.recentGames,
    lastActiveDays,
    stabilityScore: structure.stabilityScore,
    stabilityLevel: confidenceLevel(structure.stabilityScore),
    highWinRateAlert: structure.highWinRateAlert,
    confidence: confidenceInfo(confidenceScore, [
      `共同对局 ${structure.games} 场`,
      `${structure.members.length}人组合门槛 ${structure.requiredGames} 场共同同队`,
      `近${RECENT_ACTIVITY_DAYS}天共同对局 ${structure.recentGames} 场`,
      "组队关系由历史同队记录推断",
    ]),
    moderationAvailable,
    blacklistedMembers,
    reportedMembers,
    evidence: structure.evidence,
  };
};

/**
 * 从当前玩家自己的完整历史逐局枚举组合。
 *
 * 旧实现先截取高频队友再做全排列，可能漏掉“单独看不高频、但一起出现很
 * 稳定”的三/四人组合。这里直接取每局目标玩家所在队伍的队友，枚举该局
 * 出现过的 2/3/4/5 人组合，再按成员集合合并，数据来源就是 PostgreSQL
 * 缓存的完整 participants。
 */
const buildPlayerPartyGroups = (
  player: RecentSumInfo,
  snapshot: PlayerHistorySnapshot,
  moderationMap: Map<string, PlayerModerationInfo>,
): PartyGroupAnalysis[] => {
  interface GroupAccumulator {
    teammates: NormalizedHistoryParticipant[];
    games: number;
    wins: number;
    latestGameAt: number;
    recentGames: number;
    evidence: PartyEvidence[];
  }

  const groups = new Map<string, GroupAccumulator>();
  const now = Date.now();

  for (const game of snapshot.games.values()) {
    const ownParticipant = findPlayerParticipant(game, player);
    if (!ownParticipant || ownParticipant.teamId <= 0) continue;

    const teammates = Array.from(
      new Map(
        game.participants
          .filter(
            (participant) =>
              participant.teamId === ownParticipant.teamId &&
              participant.teamId > 0 &&
              !participantMatchesPlayer(participant, player),
          )
          .map((participant) => [participant.puuid, participant]),
      ).values(),
    );

    // 一局 5 人队伍最多生成 15 个组合，100 场也只有 1500 次合并，
    // 比基于所有历史队友做全排列稳定得多。
    for (let teammateCount = 1; teammateCount <= teammates.length; teammateCount++) {
      for (const selectedTeammates of combinations(teammates, teammateCount)) {
        const memberKeys = [player.puuid, ...selectedTeammates.map((item) => item.puuid)]
          .sort();
        const key = memberKeys.join("|");
        const existing = groups.get(key) || {
          teammates: selectedTeammates,
          games: 0,
          wins: 0,
          latestGameAt: 0,
          recentGames: 0,
          evidence: [],
        };
        existing.games += 1;
        existing.wins += ownParticipant.win ? 1 : 0;
        existing.latestGameAt = Math.max(existing.latestGameAt, game.gameCreation);
        if (game.gameCreation >= now - RECENT_ACTIVITY_DAYS * DAY_MS) {
          existing.recentGames += 1;
        }
        existing.evidence.push({
          gameId: game.gameId,
          gameCreation: game.gameCreation,
        });
        groups.set(key, existing);
      }
    }
  }

  return Array.from(groups.values())
    .map((group) => {
      const memberCount = group.teammates.length + 1;
      const requiredGames = Math.max(2, Math.min(memberCount, 5));
      if (group.games < requiredGames) return null;

      const winRate = roundRate(group.wins, group.games) ?? 0;
      const lastActiveDays = group.latestGameAt
        ? Math.max(0, Math.floor((now - group.latestGameAt) / DAY_MS))
        : null;
      const stabilityScore = Math.round(
        Math.min(group.games / 10, 1) * 40 +
          Math.min(group.recentGames / 5, 1) * 30 +
          (winRate / 100) * 30,
      );
      const members = [
        toPartyMember(player, moderationMap),
        ...group.teammates.map((participant) => ({
          puuid: participant.puuid,
          summonerName: participant.summonerName || participant.puuid,
          moderation: moderationMap.get(participant.puuid) || emptyModeration(),
        })),
      ];
      const blacklistedMembers = members.filter(
        (member) => member.moderation?.marked === true,
      );
      const reportedMembers = members.filter(
        (member) => (member.moderation?.reportCount || 0) > 0,
      );
      const confidenceScore = Math.round(
        Math.min(group.games / 10, 1) * 70 +
          Math.min(group.recentGames / 5, 1) * 20 +
          (members.every((member) => member.moderation?.available) ? 10 : 0),
      );

      return {
        members,
        requiredGames,
        games: group.games,
        wins: group.wins,
        winRate,
        latestGameAt: group.latestGameAt,
        recentGames: group.recentGames,
        lastActiveDays,
        stabilityScore,
        stabilityLevel: confidenceLevel(stabilityScore),
        highWinRateAlert:
          group.games >= 5 && winRate >= 65 && stabilityScore >= 55,
        confidence: confidenceInfo(confidenceScore, [
          `共同对局 ${group.games} 场`,
          `${memberCount}人组合门槛 ${requiredGames} 场共同同队`,
          `近${RECENT_ACTIVITY_DAYS}天共同对局 ${group.recentGames} 场`,
          "组合由 PostgreSQL 缓存中的逐局同队记录推断",
        ]),
        moderationAvailable: members.every(
          (member) => member.moderation?.available === true,
        ),
        blacklistedMembers,
        reportedMembers,
        evidence: group.evidence.sort(
          (left, right) => right.gameCreation - left.gameCreation,
        ),
      } satisfies PartyGroupAnalysis;
    })
    .filter((group): group is PartyGroupAnalysis => group !== null)
    .sort(
      (left, right) =>
        right.games - left.games ||
        right.stabilityScore - left.stabilityScore ||
        right.winRate - left.winRate,
    );
};

const buildTeammateSynergy = (
  player: RecentSumInfo,
  snapshot: PlayerHistorySnapshot,
  moderationMap: Map<string, PlayerModerationInfo>,
): TeammateSynergyStats[] => {
  const teammateGames = new Map<
    string,
    { player: RecentSumInfo; games: NormalizedHistoryGame[] }
  >();

  for (const game of snapshot.games.values()) {
    const ownParticipant = findPlayerParticipant(game, player);
    if (!ownParticipant || ownParticipant.teamId <= 0) continue;

    for (const participant of game.participants) {
      if (
        participant.teamId !== ownParticipant.teamId ||
        participant.teamId <= 0 ||
        participantMatchesPlayer(participant, player)
      ) {
        continue;
      }

      const existing = teammateGames.get(participant.puuid) || {
        player: {
          summonerId: participant.summonerId || 0,
          summonerName: participant.summonerName || participant.puuid,
          puuid: participant.puuid,
          championUrl: "",
          champId: participant.championId,
          teamParticipantId: 0,
          matchList: [],
        },
        games: [],
      };
      existing.games.push(game);
      teammateGames.set(participant.puuid, existing);
    }
  }

  return Array.from(teammateGames.values())
    .map(({ player: teammate, games }) => {
      const ownParticipants = games
        .map((game) => findPlayerParticipant(game, player))
        .filter(
          (participant): participant is NormalizedHistoryParticipant =>
            participant !== undefined,
        );
      const wins = ownParticipants.filter((participant) => participant.win).length;
      return {
        teammate: toPartyMember(teammate, moderationMap),
        games: ownParticipants.length,
        wins,
        winRate: roundRate(wins, ownParticipants.length) ?? 0,
        champions: buildChampionStats(games, player),
        positions: buildPositionStats(games, player),
        latestGameAt: Math.max(...games.map((game) => game.gameCreation)),
      } satisfies TeammateSynergyStats;
    })
    .sort(
      (left, right) =>
        right.games - left.games ||
        right.winRate - left.winRate ||
        right.latestGameAt - left.latestGameAt,
    );
};

const buildPlayerAnalysis = (
  player: RecentSumInfo,
  snapshot: PlayerHistorySnapshot,
  partyGroups: PartyGroupAnalysis[],
  opponents: OpponentMatchupStats[],
  moderation: PlayerModerationInfo,
): PlayerRecentAnalysis => {
  const games = Array.from(snapshot.games.values());
  const playerGames = games
    .map((game) => findPlayerParticipant(game, player))
    .filter(
      (participant): participant is NormalizedHistoryParticipant =>
        participant !== undefined,
    );
  const wins = playerGames.filter((participant) => participant.win).length;
  const actualGames = playerGames.length;
  const champions = buildChampionStats(games, player);
  // 缓存驱动；不再按窗口裁剪，confidence 反映「样本量与完整度」。
  const sampleScore = Math.min(actualGames / HISTORY_CACHE_PAGE_SIZE, 1) * 80;
  const confidenceScore =
    sampleScore + (snapshot.complete ? 20 : 0);
  const confidenceReasons = [
    `已使用本地缓存全部 ${actualGames} 场`,
    snapshot.complete
      ? "本地缓存包含完整参与者"
      : "部分对局仅含单人摘要，关系分析不完整",
    "统计基于完整 participant 身份关联",
  ];

  return {
    actualGames,
    wins,
    winRate: roundRate(wins, actualGames),
    currentChampion:
      champions.find((item) => item.championId === player.champId) || null,
    champions,
    positions: buildPositionStats(games, player),
    opponents,
    partyGroups,
    confidence: confidenceInfo(confidenceScore, confidenceReasons),
    moderation,
    source: snapshot.source,
    sourceEndpoints: snapshot.sourceEndpoints,
    historyComplete: snapshot.complete,
    dataCoverage: snapshot.dataCoverage,
  };
};

const computePlayerRelations = async (
  player: RecentSumInfo,
  snapshot: PlayerHistorySnapshot,
  baseAnalysis: PlayerRecentAnalysis,
  onProgress?: PlayerAnalysisProgressHandler,
): Promise<PlayerRecentAnalysis> => {
  // 单个用户的默认面板也需要展示关系分析。历史详情已经包含每局的
  // participant，因此可以从同一份缓存构造共同对局快照，不必为每个队友
  // 再发起一次历史接口请求。
  const related = new Map<
    string,
    {
      player: RecentSumInfo;
      sameTeamGames: number;
      opposedGames: number;
      games: Map<number, NormalizedHistoryGame>;
      sourceEndpoints: string[];
    }
  >();
  for (const game of snapshot.games.values()) {
    const ownParticipant = findPlayerParticipant(game, player);
    if (!ownParticipant || ownParticipant.teamId <= 0) continue;
    for (const participant of game.participants) {
      if (participantMatchesPlayer(participant, player)) continue;
      if (participant.teamId <= 0) continue;
      const existing = related.get(participant.puuid) || {
        player: {
          summonerId: participant.summonerId || 0,
          summonerName: participant.summonerName || participant.puuid,
          puuid: participant.puuid,
          championUrl: "",
          champId: participant.championId,
          teamParticipantId: 0,
          matchList: [],
        },
        sameTeamGames: 0,
        opposedGames: 0,
        games: new Map<number, NormalizedHistoryGame>(),
        sourceEndpoints: snapshot.sourceEndpoints,
      };
      existing.games.set(game.gameId, game);
      if (participant.teamId === ownParticipant.teamId) {
        existing.sameTeamGames += 1;
      } else {
        existing.opposedGames += 1;
      }
      related.set(participant.puuid, existing);
    }
  }

  onProgress?.({
    stage: "relations",
    completed: 1,
    total: 2,
    percentage: 82,
    message: `已扫描 ${snapshot.games.size} 场，正在统计同队与历史交手`,
  });

  const relatedEntries = Array.from(related.values());
  const partyPlayers = relatedEntries
    .filter((item) => item.sameTeamGames > 0)
    .sort((left, right) => right.sameTeamGames - left.sameTeamGames)
    .slice(0, 10)
    .map((item) => item.player);
  const opponentPlayers = relatedEntries
    .filter((item) => item.opposedGames > 0)
    .sort((left, right) => right.opposedGames - left.opposedGames)
    .slice(0, 10)
    .map((item) => item.player);
  const selectedPlayers = [
    player,
    ...partyPlayers,
    ...opponentPlayers.filter(
      (opponent) => !partyPlayers.some((item) => item.puuid === opponent.puuid),
    ),
  ];
  const snapshots = new Map<string, PlayerHistorySnapshot>([
    [player.puuid, snapshot],
  ]);
  selectedPlayers.slice(1).forEach((item) => {
    const itemSnapshot = related.get(item.puuid);
    if (itemSnapshot) {
      snapshots.set(item.puuid, {
        puuid: item.puuid,
        games: itemSnapshot.games,
        source: snapshot.source,
        sourceEndpoints: itemSnapshot.sourceEndpoints,
        complete: snapshot.complete,
      });
    }
  });
  const moderationMap = await loadModerationMap(selectedPlayers);

  onProgress?.({
    stage: "relations",
    completed: 2,
    total: 2,
    percentage: 94,
    message: `关系分析完成，正在合并 ${selectedPlayers.length} 名玩家的举报/黑名单记录`,
  });

  const playerAnalysis = buildPlayerAnalysis(
    player,
    snapshot,
    buildPlayerPartyGroups(player, snapshot, moderationMap),
    buildOpponentStats(player, opponentPlayers, snapshots, moderationMap),
    moderationMap.get(player.puuid) || emptyModeration(),
  );
  // 保留 baseAnalysis 中已经填好的指标字段（胜率、英雄、位置等），
  // 只覆盖由 computePlayerRelations 计算的关系字段。
  return {
    ...baseAnalysis,
    partyGroups: playerAnalysis.partyGroups,
    opponents: playerAnalysis.opponents,
    teammateSynergy: buildTeammateSynergy(player, snapshot, moderationMap),
    network: buildNetworkAnalysis(
      [player, ...partyPlayers.slice(0, 5)],
      opponentPlayers.slice(0, 5),
      snapshots,
    ),
    moderation: moderationMap.get(player.puuid) || emptyModeration(),
  };
};

/**
 * 首页"历史分析"专用入口：完全运行在 PostgreSQL 本地缓存上，
 * 按 gameCreation DESC 读取该玩家在该模式下的全部缓存对局。
 * 不再向服务器发起任何请求。
 */
export const loadPlayerCacheAnalysis = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  onProgress?: PlayerAnalysisProgressHandler,
): Promise<PlayerRecentAnalysis> => {
  const startedAt = Date.now();
  logger.info({
    tag: "recent.analysis.cache_only",
    message: "首页历史分析发起（仅本地缓存）",
    context: {
      purpose: "按 puuid + mode_key 全量读取本地缓存并做预定分析",
      puuid: player.puuid,
      summoner_id: player.summonerId ?? null,
      summoner_name: player.summonerName ?? null,
      mode_key: modeKey,
    },
  });

  const summary = await getCachedPlayerSummary(player.puuid, modeKey);
  const totalCached = summary.matches;

  onProgress?.({
    stage: "cache",
    completed: 0,
    total: Math.max(totalCached, 1),
    percentage: 10,
    message:
      totalCached > 0
        ? `本地缓存命中 ${totalCached} 场，正在分页读取`
        : "本地暂无缓存，等待首次同步",
  });

  // 按 PAGE=500 分页读取，避免单次 invoke 拉超过 PG 索引阈值的数据。
  const PAGE = HISTORY_CACHE_PAGE_SIZE;
  const collected: NormalizedHistoryGame[] = [];
  for (let offset = 0; offset < totalCached; offset += PAGE) {
    const limit = Math.min(PAGE, totalCached - offset);
    if (limit <= 0) break;
    const games = await getCachedHistory({
      puuid: player.puuid,
      modeKey,
      limit,
      offset,
    });
    collected.push(...games);
    onProgress?.({
      stage: "cache",
      completed: Math.min(collected.length, totalCached),
      total: Math.max(totalCached, 1),
      percentage:
        10 +
        Math.round((40 * Math.min(collected.length, totalCached)) / Math.max(totalCached, 1)),
      message: `已读取 ${collected.length}/${totalCached} 场`,
    });
  }

  // 把列表转成 PlayerHistorySnapshot。snapshot.source 固定为本地缓存。
  const gamesMap = new Map<number, NormalizedHistoryGame>();
  collected.forEach((game) => gamesMap.set(game.gameId, game));
  const snapshot: PlayerHistorySnapshot = {
    puuid: player.puuid,
    games: gamesMap,
    source: "PostgreSQL 本地缓存",
    sourceEndpoints: [],
    complete:
      gamesMap.size > 0 && hasParticipantRoster(Array.from(gamesMap.values())),
  };

  onProgress?.({
    stage: "personal",
    completed: snapshot.games.size,
    total: Math.max(totalCached, 1),
    percentage: 55,
    message: `已合并 ${gamesMap.size} 场本地缓存，准备个人统计`,
  });

  const personalAnalysis = buildPlayerAnalysis(
    player,
    snapshot,
    [],
    [],
    emptyModeration(),
  );
  onProgress?.({
    stage: "personal",
    completed: personalAnalysis.actualGames,
    total: Math.max(totalCached, 1),
    percentage: 70,
    message: `个人统计完成：${personalAnalysis.actualGames} 场`,
    analysis: personalAnalysis,
  });

  const finalAnalysis = await computePlayerRelations(
    player,
    snapshot,
    personalAnalysis,
    onProgress,
  );

  onProgress?.({
    stage: "done",
    completed: 1,
    total: 1,
    percentage: 100,
    message: `历史分析完成：${finalAnalysis.actualGames} 场个人样本，${finalAnalysis.partyGroups.length} 组开黑关系`,
    analysis: finalAnalysis,
  });

  logger.info({
    tag: "recent.analysis.cache_only",
    message: "首页历史分析完成",
    context: {
      puuid: player.puuid,
      mode_key: modeKey,
      total_cached: totalCached,
      loaded: snapshot.games.size,
      party_groups: finalAnalysis.partyGroups.length,
      duration_ms: Date.now() - startedAt,
    },
    durationMs: Date.now() - startedAt,
  });

  return finalAnalysis;
};

const buildNetworkAnalysis = (
  friendList: RecentSumInfo[],
  enemyList: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
): RecentNetworkAnalysis => {
  const teams = [
    { list: friendList, team: "friend" as const },
    { list: enemyList, team: "enemy" as const },
  ];
  const nodes: RecentNetworkNode[] = teams.flatMap(({ list, team }) =>
    list.map((player, teamIndex) => ({
      puuid: player.puuid,
      summonerName: player.summonerName,
      team,
      teamIndex,
    })),
  );
  const players = [...friendList, ...enemyList];
  const edges: RecentNetworkEdge[] = [];

  for (let leftIndex = 0; leftIndex < players.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < players.length; rightIndex++) {
      const left = players[leftIndex];
      const right = players[rightIndex];
      const leftSnapshot = snapshots.get(left.puuid);
      const rightSnapshot = snapshots.get(right.puuid);
      if (!leftSnapshot || !rightSnapshot) continue;
      const rightGameIds = new Set(rightSnapshot.games.keys());
      const sharedGameIds = Array.from(leftSnapshot.games.keys()).filter((gameId) =>
        rightGameIds.has(gameId),
      );
      let sameTeamGames = 0;
      let opposedGames = 0;
      let sourceWins = 0;
      let targetWins = 0;
      for (const gameId of sharedGameIds) {
        const game = leftSnapshot.games.get(gameId);
        const source = game ? findPlayerParticipant(game, left) : undefined;
        const target = game ? findPlayerParticipant(game, right) : undefined;
        if (!source || !target) continue;
        if (source.teamId === target.teamId) {
          sameTeamGames += 1;
        } else {
          opposedGames += 1;
        }
        sourceWins += source.win ? 1 : 0;
        targetWins += target.win ? 1 : 0;
      }
      const sharedGames = sameTeamGames + opposedGames;
      if (sharedGames === 0) continue;
      edges.push({
        source: left.puuid,
        target: right.puuid,
        sharedGames,
        sameTeamGames,
        opposedGames,
        sourceWins,
        targetWins,
      });
    }
  }

  const availableGames = new Set(
    Array.from(snapshots.values()).flatMap((snapshot) => snapshot.games.keys()),
  ).size;
  return { nodes, edges, availableGames };
};

const applyTeamAnalysis = (
  friendList: RecentSumInfo[],
  enemyList: RecentSumInfo[],
  snapshotMap: Map<string, PlayerHistorySnapshot>,
  moderationMap: Map<string, PlayerModerationInfo>,
) => {
  const now = Date.now();
  for (const [team, opposingTeam] of [
    [friendList, enemyList],
    [enemyList, friendList],
  ] as const) {
    // 结构层使用 WeakMap 缓存：Pass 1 / Pass 2 共享同一 snapshotMap
    // 引用时第二次命中，跳过组合枚举；Pass 3 (hydrated snapshotMap)
    // 引用不同会重新计算一次。overlay 是 O(groups × members)，
    // 远小于结构层 O(2^N × games)。
    const structures = getCachedPartyGroupsStructure(team, snapshotMap);
    const groups = structures.map((structure) =>
      applyPartyGroupOverlay(structure, moderationMap, now),
    );
    for (const player of team) {
      const snapshot = snapshotMap.get(player.puuid);
      if (!snapshot || snapshot.games.size === 0) continue;
      player.recentAnalysis = buildPlayerAnalysis(
        player,
        snapshot,
        groups.filter((group) =>
          group.members.some((member) => member.puuid === player.puuid),
        ),
        buildOpponentStats(player, opposingTeam, snapshotMap, moderationMap),
        moderationMap.get(player.puuid) || emptyModeration(),
      );
    }
  }
};

export const loadRecentTeamAnalysis = async (
  friendList: RecentSumInfo[],
  enemyList: RecentSumInfo[],
  queueId: number,
  onProgress?: (progress: RecentAnalysisProgress) => void,
): Promise<RecentNetworkAnalysis> => {
  const players = Array.from(
    new Map(
      [...friendList, ...enemyList].map((player) => [player.puuid, player]),
    ).values(),
  );
  const startedAt = Date.now();
  logger.info({
    tag: "recent.analysis",
    message: "近期团队分析发起",
    context: {
      purpose: "对局内面板：双方全员近期分析（团队/开黑关系 + 个人统计）",
      queue_id: queueId,
      mode_key: modeForQueue(queueId),
      friends: friendList.length,
      enemies: enemyList.length,
      players: players.length,
      player_puuids: players.map((p) => p.puuid),
    },
  });

  if (players.length === 0) {
    onProgress?.({
      stage: "done",
      completed: 0,
      total: 0,
      message: "暂无可分析的本局玩家",
    });
    logger.info({
      tag: "recent.analysis",
      message: "近期团队分析完成（无玩家）",
      context: {
        purpose: "对局内面板：双方全员近期分析（团队/开黑关系 + 个人统计）",
        queue_id: queueId,
        players: 0,
        duration_ms: Date.now() - startedAt,
      },
      durationMs: Date.now() - startedAt,
    });
    return buildNetworkAnalysis(friendList, enemyList, new Map());
  }

  logger.info({
    tag: "recent.analysis",
    message: "近期分析阶段：读取本地缓存",
    context: {
      purpose: "对局内面板：双方全员近期分析（团队/开黑关系 + 个人统计）",
      stage: "cache",
      queue_id: queueId,
      players: players.length,
    },
  });
  onProgress?.({
    stage: "cache",
    completed: 0,
    total: players.length,
    message: "正在读取本地历史缓存",
  });

  // 举报记录不是首屏最近 10 场分析的前置条件，与缓存读取并行执行。
  const moderationPromise = loadModerationMap(players);
  const snapshots = await mapWithConcurrency(
    players,
    HISTORY_CONCURRENCY,
    (player) => loadPlayerHistory(player, queueId),
    (index) => {
      onProgress?.({
        stage: "cache",
        completed: index + 1,
        total: players.length,
        message: "正在读取本地历史缓存",
      });
    },
  );
  const snapshotMap = new Map(
    players.map((player, index) => [player.puuid, snapshots[index]]),
  );

  // 第一阶段只使用缓存/首屏的最近 10 场，立刻把个人分析交付给 UI。
  // 先使用空的举报结果，避免外部举报服务拖慢首屏。
  applyTeamAnalysis(
    friendList,
    enemyList,
    snapshotMap,
    new Map(players.map((player) => [player.puuid, emptyModeration()])),
  );
  logger.info({
    tag: "recent.analysis",
    message: "近期分析阶段：最近 10 场完成",
    context: { stage: "recent", queue_id: queueId, players: players.length },
  });
  onProgress?.({
    stage: "recent",
    completed: players.length,
    total: players.length,
    message: "最近 10 场分析已完成",
  });

  const hydrationEntries = players
    .map((player) => {
      const modeKey = modeForQueue(queueId);
      const entry = queueHydration.get(historyKey(player.puuid, modeKey));
      if (!entry) {
        return {
          player,
          request: hydratePlayerQueueHistory(
            player,
            modeKey,
            [],
            HISTORY_FRIEND_FALLBACK_LIMIT,
          ),
        };
      }
      if (entry.serverLimit >= HISTORY_FRIEND_FALLBACK_LIMIT) {
        return { player, request: entry.request };
      }
      return {
        player,
        request: entry.request.then((result) =>
          hydratePlayerQueueHistory(
            player,
            modeKey,
            result.games,
            HISTORY_FRIEND_FALLBACK_LIMIT,
          ),
        ),
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        player: RecentSumInfo;
        request: Promise<QueueHydrationResult>;
      } => entry !== null,
    );

  if (hydrationEntries.length > 0) {
      onProgress?.({
        stage: "full",
        completed: 0,
        total: hydrationEntries.length,
        message: `正在查询服务器最近 1 页（最多 ${HISTORY_FRIEND_FALLBACK_LIMIT} 场）并合并本地缓存`,
      });
  }

  const hydratedResultsByPlayer = new Map<string, QueueHydrationResult>();
  let hydratedCount = 0;
  const hydratedGamesPromise = Promise.all(
    hydrationEntries.map(async ({ player, request }) => {
      const hydratedResult = await request;
      hydratedResultsByPlayer.set(player.puuid, hydratedResult);
      hydratedCount += 1;
      onProgress?.({
        stage: "full",
        completed: hydratedCount,
        total: hydrationEntries.length,
        message: `正在查询服务器最近 1 页（最多 ${HISTORY_FRIEND_FALLBACK_LIMIT} 场）并合并本地缓存`,
      });
    }),
  );

  const moderationMap = await moderationPromise;
  // 举报记录完成后只刷新已有的最近 10 场结果，不影响历史补全任务。
  applyTeamAnalysis(
    friendList,
    enemyList,
    snapshotMap,
    moderationMap,
  );

  if (hydrationEntries.length === 0) {
    const network = buildNetworkAnalysis(friendList, enemyList, snapshotMap);
    logger.info({
      tag: "recent.analysis",
      message: "近期分析阶段：完成（无补全）",
      context: { stage: "done", queue_id: queueId, players: players.length, hydrated: 0 },
    });
    onProgress?.({
      stage: "done",
      completed: players.length,
      total: players.length,
      message: "近期分析已完成",
    });
    return network;
  }

  await hydratedGamesPromise;
  const hydratedSnapshots = players.map((player, index) => {
      const initialSnapshot = snapshots[index];
      const hydratedResult = hydratedResultsByPlayer.get(player.puuid);
      const hydratedGames = hydratedResult?.games;
      // hydratePlayerQueueHistory 已经返回了合并后的完整结果，并负责写入
      // PostgreSQL。这里直接复用结果，避免补全结束后再为每个玩家重复读
      // 一次数据库（十名玩家会额外产生十次串行 SQL）。
      if (!hydratedGames) {
        return initialSnapshot;
      }
      const mergedGames = sortGames([
        ...initialSnapshot.games.values(),
        ...hydratedGames,
      ]).slice(0, HISTORY_CACHE_PAGE_SIZE);
      if (
        mergedGames.length <= initialSnapshot.games.size &&
        !hasParticipantRoster(mergedGames)
      ) {
        return initialSnapshot;
      }
      return {
        puuid: player.puuid,
        games: new Map(mergedGames.map((game) => [game.gameId, game])),
        source:
          hasParticipantRoster(mergedGames) && hydratedGames.length > 0
            ? hydratedResult?.source || "历史接口完整参与者"
            : "PostgreSQL 本地缓存",
        sourceEndpoints:
          hydratedResult && hydratedResult.sourceEndpoints.length > 0
            ? hydratedResult.sourceEndpoints
            : initialSnapshot.sourceEndpoints,
        complete:
          mergedGames.length >= HISTORY_CACHE_PAGE_SIZE &&
          hasParticipantRoster(mergedGames),
      };
    });
  const hydratedSnapshotMap = new Map(
    players.map((player, index) => [player.puuid, hydratedSnapshots[index]]),
  );
  applyTeamAnalysis(
    friendList,
    enemyList,
    hydratedSnapshotMap,
    moderationMap,
  );
  const network = buildNetworkAnalysis(friendList, enemyList, hydratedSnapshotMap);
  logger.info({
    tag: "recent.analysis",
    message: "近期分析阶段：100 场完成",
    context: {
      purpose: "对局内面板：双方全员近期分析（团队/开黑关系 + 个人统计）",
      stage: "done",
      queue_id: queueId,
      mode_key: modeForQueue(queueId),
      players: players.length,
      hydrated: hydrationEntries.length,
      nodes: network.nodes.length,
      edges: network.edges.length,
      available_games: network.availableGames,
      duration_ms: Date.now() - startedAt,
    },
    durationMs: Date.now() - startedAt,
  });
  onProgress?.({
    stage: "done",
    completed: hydrationEntries.length,
    total: hydrationEntries.length,
    message: "近期 100 场分析已完成",
  });
  return network;
};

export const clearRecentAnalysisCache = () => {
  historyCache.clear();
  queueHydration.clear();
  // partyGroupsStructureCache 是 WeakMap，键（snapshotMap / players 数组）
  // 被 GC 后条目自动回收，不需要也无接口手动 clear。
};
