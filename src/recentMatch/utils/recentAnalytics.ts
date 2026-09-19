import {
  queryMatchHistoryFullWithSource,
  queryMatchHistoryWithSource,
  MatchHistoryGame,
} from "@/lcu/aboutMatch";
import { Games } from "@/lcu/types/queryMatchLcuTypes";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import BlackList from "@/main/views/record/blackList";
import { Hater } from "@/main/views/record/blackListTypes";
import { cacheHistory, getCachedHistory } from "@/recentMatch/utils/databaseCache";
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
  WinRateTrendPoint,
} from "@/recentMatch/utils/queryTypes";
import {
  historyGameQuality,
  mergeHistoryGames,
} from "@/recentMatch/utils/historyData";

export const RECENT_ANALYSIS_GAME_COUNT = 100;
export const RECENT_DEFAULT_GAME_COUNT = 10;
export const RECENT_ANALYSIS_WINDOWS = [10, 20, 50, 100] as const;

// 默认只读取小窗口，避免首页第一次打开就等待分页扫描；完整窗口在后台补齐。
const HISTORY_FAST_SCAN_LIMIT = 40;
// 非当前模式的历史记录会占用窗口，因此完整分析需要多扫描一些记录。
const HISTORY_SCAN_LIMIT = 300;
const HISTORY_PAGE_SIZE = 20;
const HISTORY_CONCURRENCY = 5;
const RECENT_ACTIVITY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

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

const queueHydration = new Map<string, Promise<NormalizedHistoryGame[]>>();

const historyKey = (puuid: string, modeKey: MatchModeKey) =>
  `${puuid}:${modeKey}`;

const syncPlayerModeGames = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  existingGames: NormalizedHistoryGame[],
): Promise<{
  games: NormalizedHistoryGame[];
  source: string;
  coverage: HistoryCoverageInfo;
}> => {
  const cachedGameIds = new Set(existingGames.map((game) => game.gameId));
  const fetchedGames = new Map<number, NormalizedHistoryGame>();
  let source = "unavailable";
  let reachedCachedBoundary = false;

  for (
    let offset = 0;
    offset < HISTORY_SCAN_LIMIT;
    offset += HISTORY_PAGE_SIZE
  ) {
    const result = await queryMatchHistoryFullWithSource(
      player.puuid,
      offset,
      Math.min(offset + HISTORY_PAGE_SIZE, HISTORY_SCAN_LIMIT),
    );
    const rawGames = result?.games ?? [];
    if (result?.source) source = result.source;
    if (rawGames.length === 0) break;

    const pageGames = uniqueGames(
      rawGames,
      modeKey,
      player,
      result?.source || "interface",
    );
    for (const [gameId, game] of pageGames) {
      if (cachedGameIds.has(gameId)) {
        reachedCachedBoundary = true;
      }
      fetchedGames.set(gameId, game);
    }

    // 只要服务器分页触碰到本地已有 gameId，就已经追到缓存边界；
    // 当合并样本已经覆盖最近 100 场时，后面的历史不再查询。
    const mergedGameCount = new Set([
      ...cachedGameIds,
      ...fetchedGames.keys(),
    ]).size;
    if (
      (reachedCachedBoundary &&
        mergedGameCount >= RECENT_ANALYSIS_GAME_COUNT) ||
      (cachedGameIds.size === 0 &&
        fetchedGames.size >= RECENT_ANALYSIS_GAME_COUNT) ||
      rawGames.length < HISTORY_PAGE_SIZE
    ) {
      break;
    }
  }

  const merged = mergeHistoryGames(
    existingGames,
    Array.from(fetchedGames.values()),
    RECENT_ANALYSIS_GAME_COUNT,
  );
  return {
    games: merged.games,
    source,
    coverage: merged.coverage,
  };
};

const hydratePlayerQueueHistory = (
  player: RecentSumInfo,
  queueId: number,
  existingGames: NormalizedHistoryGame[],
) => {
  const modeKey = modeForQueue(queueId);
  const key = historyKey(player.puuid, modeKey);
  const existing = queueHydration.get(key);
  if (existing) return existing;

  const request = (async (): Promise<NormalizedHistoryGame[]> => {
    const synced = await syncPlayerModeGames(player, modeKey, existingGames);
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
    return games;
  })().catch((error) => {
    console.warn("Failed to hydrate full queue history", error);
    return existingGames;
  });
  queueHydration.set(key, request);
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
      limit: RECENT_ANALYSIS_GAME_COUNT,
    });
    if (cachedGames.length > 0) {
      // 即使本地已经有 100 场，也必须向服务器同步最新分页；
      // gameId 碰到本地记录后才停止继续翻页。
      void hydratePlayerQueueHistory(player, queueId, cachedGames);
      const limitedGames = new Map(
        cachedGames.slice(0, RECENT_ANALYSIS_GAME_COUNT).map((game) => [
          game.gameId,
          game,
        ]),
      );
      return {
        puuid: player.puuid,
        games: limitedGames,
        source: "PostgreSQL 本地缓存",
        complete:
          limitedGames.size >= RECENT_ANALYSIS_GAME_COUNT &&
          hasParticipantRoster(Array.from(limitedGames.values())),
        dataCoverage: mergeHistoryGames(
          cachedGames,
          [],
          RECENT_ANALYSIS_GAME_COUNT,
        ).coverage,
      };
    }

    // PostgreSQL 不可用或首次缓存尚未写入时，直接复用首屏已取得的
    // 最近 10 场。完整历史只在后台补齐，不能阻塞对局面板的首屏分析。
    const quickGames = sortGames(
      (Array.isArray(player.matchList) ? player.matchList : [])
        .filter((match) => isModeQueue(match.queueId, modeKey))
        .slice(0, RECENT_DEFAULT_GAME_COUNT)
        .map((match, index) => quickMatchToGame(match, player, index)),
    );
    if (quickGames.length > 0) {
      void hydratePlayerQueueHistory(player, queueId, quickGames);
      return {
        puuid: player.puuid,
        games: new Map(quickGames.map((game) => [game.gameId, game])),
        source: "当前面板已加载的最近战绩",
        complete: false,
        dataCoverage: mergeHistoryGames([], quickGames, RECENT_DEFAULT_GAME_COUNT)
          .coverage,
      };
    }

    // 没有首屏摘要时也不要让一个玩家阻塞其它玩家的最近 10 场分析。
    // 由统一的后台补全任务异步拉取完整历史，完成后再刷新整队分析。
    void hydratePlayerQueueHistory(player, queueId, []);
    return {
      puuid: player.puuid,
      games: new Map(),
      source: "后台查询中",
      complete: false,
    };
  })();

  historyCache.set(key, request);
  return request;
};

const normalizeModeGames = (
  games: MatchHistoryGame[],
  modeKey: MatchModeKey,
  source = "interface",
) =>
  sortGames(
    games
      .map((game) => normalizeHistoryGame(game, source))
      .filter(
        (game): game is NormalizedHistoryGame =>
          game !== null && isModeQueue(game.queueId, modeKey),
    ),
  );

type PlayerAnalysisProgressHandler = (
  progress: PlayerAnalysisProgress,
) => void;

const toHistorySnapshot = (
  player: RecentSumInfo,
  games: NormalizedHistoryGame[],
  source: string,
  dataCoverage?: HistoryCoverageInfo,
): PlayerHistorySnapshot => ({
  puuid: player.puuid,
  games: new Map(games.map((game) => [game.gameId, game])),
  source,
  complete:
    games.length >= RECENT_ANALYSIS_GAME_COUNT && hasParticipantRoster(games),
  dataCoverage,
});

const loadPlayerModeHistory = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  requestedGames = RECENT_DEFAULT_GAME_COUNT,
  onProgress?: PlayerAnalysisProgressHandler,
): Promise<PlayerHistorySnapshot> => {
  const progressTotal = Math.max(requestedGames, 1);
  onProgress?.({
    stage: "cache",
    completed: 0,
    total: 1,
    percentage: 5,
    message: "正在读取 PostgreSQL 本地缓存",
  });
  const cachedGames = await getCachedHistory({
    puuid: player.puuid,
    modeKey,
    limit: RECENT_ANALYSIS_GAME_COUNT,
  });

  // 个人战绩面板已经加载过一批历史摘要，先把它作为历史数据种子。
  // 这里绝不读取当前对局；当前对局玩家列表只在 recentMatch 面板使用。
  const seededGames = sortGames(
    (Array.isArray(player.matchList) ? player.matchList : [])
      .filter((match) => isModeQueue(match.queueId, modeKey))
      .map((match, index) => quickMatchToGame(match, player, index)),
  );
  const initialGames = sortGames([...seededGames, ...cachedGames]).slice(
    0,
    RECENT_ANALYSIS_GAME_COUNT,
  );
  onProgress?.({
    stage: "cache",
    completed: 1,
    total: 1,
    percentage: 12,
    message:
      cachedGames.length > 0
        ? `本地缓存命中 ${cachedGames.length} 场，正在检查个人样本`
        : `本地暂无缓存，已使用面板中的 ${seededGames.length} 场个人战绩作为种子`,
  });

  const requiredGames = Math.min(requestedGames, RECENT_ANALYSIS_GAME_COUNT);

  // 个人胜率可以只用一名玩家的摘要，但开黑、交手和关系图必须有
  // 完整 participant。只要缓存/面板种子已经覆盖当前窗口，就先直接
  // 展示个人指标；完整 participant 由后续 hydrate 阶段补齐。
  if (initialGames.length >= requiredGames) {
    onProgress?.({
      stage: "personal",
      completed: Math.min(initialGames.length, progressTotal),
      total: progressTotal,
      percentage: 38,
      message:
        cachedGames.length > 0
          ? `个人历史已从本地缓存读取 ${Math.min(initialGames.length, progressTotal)} 场`
          : `已使用页面已有的个人历史 ${Math.min(initialGames.length, progressTotal)} 场`,
    });
    return toHistorySnapshot(
      player,
      initialGames,
      cachedGames.length > 0 ? "PostgreSQL 本地缓存" : "当前个人战绩列表",
    );
  }

  // 这里使用普通个人历史接口先拿到摘要。完整 participant 关系分析
  // 在下一阶段单独补齐，避免把个人战绩首屏绑在慢接口上。
  const scanLimit =
    requestedGames <= RECENT_DEFAULT_GAME_COUNT
      ? HISTORY_FAST_SCAN_LIMIT
      : HISTORY_SCAN_LIMIT;
  onProgress?.({
    stage: "personal",
    completed: Math.min(initialGames.length, progressTotal),
    total: progressTotal,
    percentage: 20,
    message: `正在查询个人历史摘要（目标最近 ${scanLimit} 场）`,
  });
  const fastResult = await queryMatchHistoryWithSource(
    player.puuid,
    0,
    scanLimit,
  );
  const fastGames = sortGames([
    ...initialGames,
    ...normalizeModeGames(
      fastResult?.games || [],
      modeKey,
      fastResult?.source || "interface",
    ),
  ]).slice(0, RECENT_ANALYSIS_GAME_COUNT);
  if (fastGames.length > 0) {
    void cacheHistory({
      puuid: player.puuid,
      summonerId: player.summonerId,
      summonerName: player.summonerName,
      modeKey,
      source: fastResult?.source || "unavailable",
      games: fastGames,
    });
  }

  // 摘要接口可能因客户端分页或临时网络错误返回空结果。窗口大于
  // 10 场时不能直接退回“当前面板的 10 场”，再尝试完整参与者接口，
  // 确保可用的历史数据不会被首屏摘要失败遮住。
  if (fastGames.length === 0 && requestedGames > RECENT_DEFAULT_GAME_COUNT) {
    onProgress?.({
      stage: "full",
      completed: 0,
      total: progressTotal,
      percentage: 45,
      message: "个人摘要接口未返回数据，正在尝试完整历史接口",
    });
    const recovered = await syncPlayerModeGames(player, modeKey, []);
    if (recovered.games.length > 0) {
      void cacheHistory({
        puuid: player.puuid,
        summonerId: player.summonerId,
        summonerName: player.summonerName,
        modeKey,
        source: recovered.source,
        games: recovered.games,
      });
      return toHistorySnapshot(
        player,
        recovered.games,
        recovered.source,
        recovered.coverage,
      );
    }
  }

  onProgress?.({
    stage: "personal",
    completed: Math.min(fastGames.length, progressTotal),
    total: progressTotal,
    percentage: 38,
    message: `个人历史摘要已返回 ${Math.min(fastGames.length, progressTotal)} 场`,
  });
  return toHistorySnapshot(
    player,
    fastGames,
    fastGames.length > initialGames.length
      ? fastResult?.source || "unavailable"
      : cachedGames.length > 0
        ? "PostgreSQL 本地缓存"
      : "当前个人战绩列表",
    mergeHistoryGames(
      [...cachedGames, ...initialGames],
      normalizeModeGames(
        fastResult?.games || [],
        modeKey,
        fastResult?.source || "interface",
      ),
      RECENT_ANALYSIS_GAME_COUNT,
    ).coverage,
  );
};

const hydratePlayerModeHistory = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  existingSnapshot: PlayerHistorySnapshot,
  onProgress?: PlayerAnalysisProgressHandler,
): Promise<PlayerHistorySnapshot> => {
  const existingGames = Array.from(existingSnapshot.games.values());
  onProgress?.({
    stage: "full",
    completed: 0,
    total: 1,
    percentage: 45,
    message: "正在向服务器同步最近 100 场完整参与者，用于同队/交手分析",
  });
  const synced = await syncPlayerModeGames(player, modeKey, existingGames);
  const mergedGames = synced.games;
  if (mergedGames.length > 0) {
    void cacheHistory({
      puuid: player.puuid,
      summonerId: player.summonerId,
      summonerName: player.summonerName,
      modeKey,
      source: synced.source || existingSnapshot.source,
      games: mergedGames,
    });
  }
  const result = toHistorySnapshot(
    player,
    mergedGames,
    mergedGames.length > existingGames.length
      ? synced.source || "历史接口完整参与者"
      : existingSnapshot.source,
    synced.coverage,
  );
  onProgress?.({
    stage: "full",
    completed: 1,
    total: 1,
    percentage: 72,
    message:
      mergedGames.length > existingGames.length
        ? `完整参与者数据已返回，共 ${mergedGames.length} 场，正在计算关系`
        : `服务器数据已与本地缓存核对，共 ${mergedGames.length} 场，正在计算关系`,
  });
  return result;
};

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
    const haterList: Hater[] | null = await new BlackList().querySumDetails(
      sumIds,
      false,
    );
    if (haterList === null) {
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
    console.warn("Failed to load recent-match moderation records", error);
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

const buildTrendStats = (
  games: NormalizedHistoryGame[],
  player: RecentSumInfo,
): WinRateTrendPoint[] =>
  RECENT_ANALYSIS_WINDOWS.map((window) => {
    const selectedGames = games.slice(0, window);
    const participants = selectedGames
      .map((game) => findPlayerParticipant(game, player))
      .filter(Boolean) as NormalizedHistoryParticipant[];
    const wins = participants.filter((participant) => participant.win).length;
    return {
      window,
      games: participants.length,
      wins,
      winRate: roundRate(wins, participants.length),
    };
  });

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
    requestedGames,
    actualGames,
    wins,
    winRate: roundRate(wins, actualGames),
    currentChampion:
      champions.find((item) => item.championId === player.champId) || null,
    champions,
    trends: buildTrendStats(games, player),
    positions: [],
    opponents: [],
    partyGroups: [],
    confidence: confidenceInfo(confidenceScore, [
      `面板已加载当前模式最近 ${actualGames}/${requestedGames} 场`,
      "位置、交手和组合关系将在后台继续补齐",
    ]),
    moderation: emptyModeration(),
    source: "当前面板已加载的最近战绩",
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

const buildPartyGroups = (
  players: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
  moderationMap: Map<string, PlayerModerationInfo>,
): PartyGroupAnalysis[] => {
  const groups: PartyGroupAnalysis[] = [];
  const now = Date.now();
  for (let size = 2; size <= players.length; size++) {
    for (const group of combinations(players, size)) {
      const groupSnapshots = group
        .map((player) => snapshots.get(player.puuid))
        .filter(
          (snapshot): snapshot is PlayerHistorySnapshot => snapshot !== undefined,
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
        if (participants.some((participant) => participant!.teamId !== teamId)) {
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
      const lastActiveDays = latestGameAt
        ? Math.max(0, Math.floor((now - latestGameAt) / DAY_MS))
        : null;
      const stabilityScore = Math.round(
        Math.min(games / 10, 1) * 40 +
          Math.min(recentGames / 5, 1) * 30 +
          (winRate / 100) * 30,
      );
      const members = group.map((player) => toPartyMember(player, moderationMap));
      const blacklistedMembers = members.filter(
        (member) => member.moderation?.marked === true,
      );
      const reportedMembers = members.filter(
        (member) => (member.moderation?.reportCount || 0) > 0,
      );
      const confidenceScore = Math.round(
        Math.min(games / 10, 1) * 70 +
          Math.min(recentGames / 5, 1) * 20 +
          (members.every((member) => member.moderation?.available) ? 10 : 0),
      );
      groups.push({
        members,
        requiredGames,
        games,
        wins,
        winRate,
        latestGameAt,
        recentGames,
        lastActiveDays,
        stabilityScore,
        stabilityLevel: confidenceLevel(stabilityScore),
        highWinRateAlert:
          games >= 5 && winRate >= 65 && stabilityScore >= 55,
        confidence: confidenceInfo(confidenceScore, [
          `共同对局 ${games} 场`,
          `${group.length}人组合门槛 ${requiredGames} 场共同同队`,
          `近${RECENT_ACTIVITY_DAYS}天共同对局 ${recentGames} 场`,
          "组队关系由历史同队记录推断",
        ]),
        moderationAvailable: members.every(
          (member) => member.moderation?.available === true,
        ),
        blacklistedMembers,
        reportedMembers,
        evidence: evidence.sort(
          (left, right) => right.gameCreation - left.gameCreation,
        ),
      });
    }
  }

  return groups.sort(
    (left, right) =>
      Number(right.highWinRateAlert) - Number(left.highWinRateAlert) ||
      right.members.length - left.members.length ||
      right.stabilityScore - left.stabilityScore ||
      right.games - left.games,
  );
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
  requestedGames = RECENT_ANALYSIS_GAME_COUNT,
): PlayerRecentAnalysis => {
  const allGames = Array.from(snapshot.games.values());
  const games = allGames.slice(0, requestedGames);
  const playerGames = games
    .map((game) => findPlayerParticipant(game, player))
    .filter(
      (participant): participant is NormalizedHistoryParticipant =>
        participant !== undefined,
    );
  const wins = playerGames.filter((participant) => participant.win).length;
  const actualGames = playerGames.length;
  const champions = buildChampionStats(games, player);
  const sampleScore = Math.min(actualGames / requestedGames, 1) * 80;
  const confidenceScore = sampleScore +
    (snapshot.complete && requestedGames >= RECENT_ANALYSIS_GAME_COUNT ? 20 : 0);
  const confidenceReasons = [
    `有效样本 ${actualGames}/${requestedGames} 场`,
    snapshot.complete && requestedGames >= RECENT_ANALYSIS_GAME_COUNT
      ? "已覆盖完整 100 场窗口"
      : `当前按最近 ${requestedGames} 场样本统计`,
    "统计基于完整 participant 身份关联",
  ];

  return {
    requestedGames,
    actualGames,
    wins,
    winRate: roundRate(wins, actualGames),
    currentChampion:
      champions.find((item) => item.championId === player.champId) || null,
    champions,
    // 主指标遵循当前窗口；趋势始终使用已加载的完整历史，避免默认 10 场时
    // 20/50/100 场被错误地显示为无数据。
    trends: buildTrendStats(allGames, player),
    positions: buildPositionStats(games, player),
    opponents,
    partyGroups,
    confidence: confidenceInfo(confidenceScore, confidenceReasons),
    moderation,
    source: snapshot.source,
    historyComplete:
      snapshot.complete && requestedGames >= RECENT_ANALYSIS_GAME_COUNT,
    dataCoverage: snapshot.dataCoverage,
  };
};

/** 默认面板使用最近 10 场；用户展开更多分析时仍可复用同一份缓存。 */
export const loadPlayerModeAnalysis = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  requestedGames = 10,
  onProgress?: PlayerAnalysisProgressHandler,
): Promise<PlayerRecentAnalysis> => {
  let snapshot = await loadPlayerModeHistory(
    player,
    modeKey,
    requestedGames,
    onProgress,
  );
  if (snapshot.games.size === 0) {
    const quickAnalysis = buildQuickPlayerAnalysis(
      player,
      modeKey,
      requestedGames,
    );
    onProgress?.({
      stage: "done",
      completed: 0,
      total: Math.max(requestedGames, 1),
      percentage: 100,
      message: "没有取得可用历史数据，已保留个人战绩摘要",
      analysis: quickAnalysis,
    });
    return quickAnalysis;
  }

  // 个人摘要先交付给界面；同队、交手和关系图等完整 participant
  // 数据在后台继续补齐，不再阻塞个人胜率首屏。
  const personalAnalysis = buildPlayerAnalysis(
    player,
    snapshot,
    [],
    [],
    emptyModeration(),
    requestedGames,
  );
  onProgress?.({
    stage: "personal",
    completed: Math.min(personalAnalysis.actualGames, requestedGames),
    total: Math.max(requestedGames, 1),
    percentage: 38,
    message: `个人战绩已展示 ${personalAnalysis.actualGames} 场，正在补充关系数据`,
    analysis: personalAnalysis,
  });

  const snapshotGames = Array.from(snapshot.games.values());
  // 本地样本数量足够也不能跳过服务器同步；只有服务器分页命中
  // 本地 gameId 后，syncPlayerModeGames 才会停止继续查询。
  const needsHydration = snapshotGames.length > 0;
  if (needsHydration) {
    snapshot = await hydratePlayerModeHistory(
      player,
      modeKey,
      snapshot,
      onProgress,
    );
    const hydratedPersonalAnalysis = buildPlayerAnalysis(
      player,
      snapshot,
      [],
      [],
      emptyModeration(),
      requestedGames,
    );
    onProgress?.({
      stage: "full",
      completed: hydratedPersonalAnalysis.actualGames,
      total: Math.max(requestedGames, 1),
      percentage: 74,
      message: `个人历史已补齐 ${hydratedPersonalAnalysis.actualGames} 场，正在计算共同对局`,
      analysis: hydratedPersonalAnalysis,
    });
  }

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
    requestedGames,
  );
  playerAnalysis.teammateSynergy = buildTeammateSynergy(
    player,
    snapshot,
    moderationMap,
  );
  playerAnalysis.network = buildNetworkAnalysis(
    [player, ...partyPlayers.slice(0, 5)],
    opponentPlayers.slice(0, 5),
    snapshots,
  );
  onProgress?.({
    stage: "done",
    completed: 1,
    total: 1,
    percentage: 100,
    message: `历史分析完成：${playerAnalysis.actualGames} 场个人样本，${playerAnalysis.partyGroups.length} 组共同同队关系`,
    analysis: playerAnalysis,
  });
  return playerAnalysis;
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
  requestedGames: number,
) => {
  for (const [team, opposingTeam] of [
    [friendList, enemyList],
    [enemyList, friendList],
  ] as const) {
    const groups = buildPartyGroups(team, snapshotMap, moderationMap);
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
        requestedGames,
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

  if (players.length === 0) {
    onProgress?.({
      stage: "done",
      completed: 0,
      total: 0,
      message: "暂无可分析的本局玩家",
    });
    return buildNetworkAnalysis(friendList, enemyList, new Map());
  }

  onProgress?.({
    stage: "cache",
    completed: 0,
    total: players.length,
    message: "正在读取本地历史缓存",
  });

  // 举报记录不是最近 10 场分析的前置条件，与缓存读取并行执行。
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
    RECENT_DEFAULT_GAME_COUNT,
  );
  onProgress?.({
    stage: "recent",
    completed: players.length,
    total: players.length,
    message: "最近 10 场分析已完成",
  });

  const hydrationEntries = players
    .map((player) => {
      const request = queueHydration.get(
        historyKey(player.puuid, modeForQueue(queueId)),
      );
      return request ? { player, request } : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        player: RecentSumInfo;
        request: Promise<NormalizedHistoryGame[]>;
      } => entry !== null,
    );

  if (hydrationEntries.length > 0) {
      onProgress?.({
        stage: "full",
        completed: 0,
        total: hydrationEntries.length,
        message: "正在从服务器同步最近 100 场（命中本地 gameId 后停止）",
      });
  }

  const hydratedGamesByPlayer = new Map<string, NormalizedHistoryGame[]>();
  let hydratedCount = 0;
  const hydratedGamesPromise = Promise.all(
    hydrationEntries.map(async ({ player, request }) => {
      const games = await request;
      hydratedGamesByPlayer.set(player.puuid, games);
      hydratedCount += 1;
      onProgress?.({
        stage: "full",
        completed: hydratedCount,
        total: hydrationEntries.length,
        message: "正在从服务器同步最近 100 场（命中本地 gameId 后停止）",
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
    RECENT_DEFAULT_GAME_COUNT,
  );

  if (hydrationEntries.length === 0) {
    const network = buildNetworkAnalysis(friendList, enemyList, snapshotMap);
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
      const hydratedGames = hydratedGamesByPlayer.get(player.puuid);
      // hydratePlayerQueueHistory 已经返回了合并后的完整结果，并负责写入
      // PostgreSQL。这里直接复用结果，避免补全结束后再为每个玩家重复读
      // 一次数据库（十名玩家会额外产生十次串行 SQL）。
      if (!hydratedGames) {
        return initialSnapshot;
      }
      const mergedGames = sortGames([
        ...initialSnapshot.games.values(),
        ...hydratedGames,
      ]).slice(0, RECENT_ANALYSIS_GAME_COUNT);
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
            ? "历史接口完整参与者"
            : "PostgreSQL 本地缓存",
        complete:
          mergedGames.length >= RECENT_ANALYSIS_GAME_COUNT &&
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
    RECENT_ANALYSIS_GAME_COUNT,
  );
  const network = buildNetworkAnalysis(friendList, enemyList, hydratedSnapshotMap);
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
};
