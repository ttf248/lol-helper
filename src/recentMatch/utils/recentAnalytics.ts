import {
  queryMatchHistoryFullWithSource,
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
  PartyGroupAnalysis,
  PartyMember,
  PlayerModerationInfo,
  PlayerRecentAnalysis,
  PositionRecentStats,
  RecentNetworkAnalysis,
  RecentNetworkEdge,
  RecentNetworkNode,
  RecentSumInfo,
  WinRateTrendPoint,
} from "@/recentMatch/utils/queryTypes";

export const RECENT_ANALYSIS_GAME_COUNT = 100;
export const RECENT_DEFAULT_GAME_COUNT = 10;
export const RECENT_ANALYSIS_WINDOWS = [10, 20, 50, 100] as const;

// 默认只读取小窗口，避免首页第一次打开就等待分页扫描；完整窗口在后台补齐。
const HISTORY_FAST_SCAN_LIMIT = 40;
// 非当前模式的历史记录会占用窗口，因此完整分析需要多扫描一些记录。
const HISTORY_SCAN_LIMIT = 300;
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
}

interface PlayerHistorySnapshot {
  puuid: string;
  games: Map<number, NormalizedHistoryGame>;
  source: string;
  complete: boolean;
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

/** 将 LCU/SGP 的不同 participant 结构转换成分析层使用的统一结构。 */
export const normalizeHistoryGame = (
  game: MatchHistoryGame,
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
  };
};

const uniqueGames = (
  games: MatchHistoryGame[],
  queueId: number,
  player: RecentSumInfo,
): Map<number, NormalizedHistoryGame> => {
  const result = new Map<number, NormalizedHistoryGame>();
  for (const rawGame of games) {
    if (rawGame.queueId !== queueId) {
      continue;
    }
    const game = normalizeHistoryGame(rawGame);
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
  Array.from(new Map(games.map((game) => [game.gameId, game])).values()).sort(
    (left, right) => right.gameCreation - left.gameCreation,
  );

const queueHydration = new Map<string, Promise<void>>();

const hydratePlayerQueueHistory = (
  player: RecentSumInfo,
  queueId: number,
  existingGames: NormalizedHistoryGame[],
) => {
  const key = `${player.puuid}:${queueId}`;
  const existing = queueHydration.get(key);
  if (existing) return existing;

  const request = (async () => {
    const result = await queryMatchHistoryFullWithSource(
      player.puuid,
      0,
      HISTORY_SCAN_LIMIT,
    );
    const fetchedGames = uniqueGames(result?.games ?? [], queueId, player);
    const games = sortGames([
      ...existingGames,
      ...Array.from(fetchedGames.values()),
    ]).slice(0, RECENT_ANALYSIS_GAME_COUNT);
    if (games.length > 0) {
      await cacheHistory({
        puuid: player.puuid,
        summonerId: player.summonerId,
        summonerName: player.summonerName,
        modeKey: modeForQueue(queueId),
        source: result?.source || "unavailable",
        games,
      });
    }
  })().catch((error) => {
    console.warn("Failed to hydrate full queue history", error);
  });
  queueHydration.set(key, request);
  return request;
};

const loadPlayerHistory = async (
  player: RecentSumInfo,
  queueId: number,
): Promise<PlayerHistorySnapshot> => {
  const key = `${player.puuid}:${queueId}`;
  const cached = historyCache.get(key);
  if (cached) {
    return cached;
  }

  const request = (async (): Promise<PlayerHistorySnapshot> => {
    const modeKey = modeForQueue(queueId);
    const cachedGames = await getCachedHistory({
      puuid: player.puuid,
      queueId,
      modeKey,
      limit: RECENT_ANALYSIS_GAME_COUNT,
    });
    if (cachedGames.length > 0) {
      if (cachedGames.length < RECENT_ANALYSIS_GAME_COUNT) {
        void hydratePlayerQueueHistory(player, queueId, cachedGames);
      }
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
        complete: limitedGames.size >= RECENT_ANALYSIS_GAME_COUNT,
      };
    }

    // PostgreSQL 不可用或首次缓存尚未写入时，直接复用首屏已取得的
    // 最近 10 场。完整历史只在后台补齐，不能阻塞对局面板的首屏分析。
    const quickGames = (Array.isArray(player.matchList) ? player.matchList : [])
      .slice(0, RECENT_DEFAULT_GAME_COUNT)
      .map((match, index) => quickMatchToGame(match, player, index));
    if (quickGames.length > 0) {
      void hydratePlayerQueueHistory(player, queueId, quickGames);
      return {
        puuid: player.puuid,
        games: new Map(quickGames.map((game) => [game.gameId, game])),
        source: "当前面板已加载的最近战绩",
        complete: false,
      };
    }

    const result = await queryMatchHistoryFullWithSource(
      player.puuid,
      0,
      HISTORY_SCAN_LIMIT,
    );
    const games = uniqueGames(result?.games ?? [], queueId, player);
    if (games.size > 0) {
      void cacheHistory({
        puuid: player.puuid,
        summonerId: player.summonerId,
        summonerName: player.summonerName,
        modeKey,
        source: result?.source || "unavailable",
        games: Array.from(games.values()),
      });
    }
    const limitedGames = new Map(
      Array.from(games.entries()).slice(0, RECENT_ANALYSIS_GAME_COUNT),
    );
    return {
      puuid: player.puuid,
      games: limitedGames,
      source: result?.source || "unavailable",
      complete: limitedGames.size >= RECENT_ANALYSIS_GAME_COUNT,
    };
  })();

  historyCache.set(key, request);
  return request;
};

const modeHydration = new Map<string, Promise<void>>();

const normalizeModeGames = (
  games: MatchHistoryGame[],
  modeKey: MatchModeKey,
) =>
  sortGames(
    games
      .map(normalizeHistoryGame)
      .filter(
        (game): game is NormalizedHistoryGame =>
          game !== null && isModeQueue(game.queueId, modeKey),
      ),
  );

const hydratePlayerModeHistory = (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  existingGames: NormalizedHistoryGame[],
) => {
  const key = `${player.puuid}:${modeKey}`;
  const existing = modeHydration.get(key);
  if (existing) return existing;

  const request = (async () => {
    const result = await queryMatchHistoryFullWithSource(
      player.puuid,
      0,
      HISTORY_SCAN_LIMIT,
    );
    const games = sortGames([
      ...existingGames,
      ...normalizeModeGames(result?.games || [], modeKey),
    ]).slice(0, RECENT_ANALYSIS_GAME_COUNT);
    if (games.length > 0) {
      await cacheHistory({
        puuid: player.puuid,
        summonerId: player.summonerId,
        summonerName: player.summonerName,
        modeKey,
        source: result?.source || "unavailable",
        games,
      });
    }
  })().catch((error) => {
    console.warn("Failed to hydrate full mode history", error);
  });
  modeHydration.set(key, request);
  return request;
};

const loadPlayerModeHistory = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  requestedGames = RECENT_DEFAULT_GAME_COUNT,
): Promise<PlayerHistorySnapshot> => {
  const cachedGames = await getCachedHistory({
    puuid: player.puuid,
    modeKey,
    limit: RECENT_ANALYSIS_GAME_COUNT,
  });
  if (cachedGames.length >= Math.min(requestedGames, RECENT_ANALYSIS_GAME_COUNT)) {
    if (cachedGames.length < RECENT_ANALYSIS_GAME_COUNT) {
      void hydratePlayerModeHistory(player, modeKey, cachedGames);
    }
    return {
      puuid: player.puuid,
      games: new Map(cachedGames.map((game) => [game.gameId, game])),
      source: "PostgreSQL 本地缓存",
      complete: cachedGames.length >= RECENT_ANALYSIS_GAME_COUNT,
    };
  }

  const fastResult = await queryMatchHistoryFullWithSource(
    player.puuid,
    0,
    HISTORY_FAST_SCAN_LIMIT,
  );
  const fastGames = sortGames([
    ...cachedGames,
    ...normalizeModeGames(fastResult?.games || [], modeKey),
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
    void hydratePlayerModeHistory(player, modeKey, fastGames);
  }
  return {
    puuid: player.puuid,
    games: new Map(fastGames.map((game) => [game.gameId, game])),
    source: fastResult?.source || "unavailable",
    complete: fastGames.length >= RECENT_ANALYSIS_GAME_COUNT,
  };
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const run = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex]);
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
  gameCreation: Date.now() - index,
  queueId: match.queueId,
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
): PlayerRecentAnalysis => {
  const quickMatches = (Array.isArray(player.matchList) ? player.matchList : [])
    .slice(0, RECENT_DEFAULT_GAME_COUNT);
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
  const confidenceScore = Math.min(actualGames / RECENT_DEFAULT_GAME_COUNT, 1) * 70;

  return {
    requestedGames: RECENT_DEFAULT_GAME_COUNT,
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
      `面板已加载最近 ${actualGames} 场`,
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
      for (const gameId of commonGameIds) {
        const game = groupSnapshots[0].games.get(gameId);
        if (!game) continue;
        const participants = group.map((player) =>
          findPlayerParticipant(game, player),
        );
        if (participants.some((participant) => participant === undefined)) continue;
        const teamId = participants[0]!.teamId;
        if (participants.some((participant) => participant!.teamId !== teamId)) {
          continue;
        }
        games += 1;
        wins += participants[0]!.win ? 1 : 0;
        latestGameAt = Math.max(latestGameAt, game.gameCreation);
        if (game.gameCreation >= now - RECENT_ACTIVITY_DAYS * DAY_MS) {
          recentGames += 1;
        }
      }

      if (games < 2) continue;
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
          `近${RECENT_ACTIVITY_DAYS}天共同对局 ${recentGames} 场`,
          "组队关系由历史同队记录推断",
        ]),
        moderationAvailable: members.every(
          (member) => member.moderation?.available === true,
        ),
        blacklistedMembers,
        reportedMembers,
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
  };
};

/** 默认面板使用最近 10 场；用户展开更多分析时仍可复用同一份缓存。 */
export const loadPlayerModeAnalysis = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  requestedGames = 10,
): Promise<PlayerRecentAnalysis> => {
  let snapshot = await loadPlayerModeHistory(player, modeKey, requestedGames);
  if (requestedGames > RECENT_DEFAULT_GAME_COUNT && snapshot.games.size < requestedGames) {
    const hydration = modeHydration.get(`${player.puuid}:${modeKey}`);
    if (hydration) {
      await hydration;
      const hydratedGames = await getCachedHistory({
        puuid: player.puuid,
        modeKey,
        limit: RECENT_ANALYSIS_GAME_COUNT,
      });
      if (hydratedGames.length > snapshot.games.size) {
        snapshot = {
          ...snapshot,
          games: new Map(hydratedGames.map((game) => [game.gameId, game])),
          source: "PostgreSQL 本地缓存",
          complete: hydratedGames.length >= RECENT_ANALYSIS_GAME_COUNT,
        };
      }
    }
  }
  if (snapshot.games.size === 0) {
    return buildQuickPlayerAnalysis(player);
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
    if (!ownParticipant) continue;
    for (const participant of game.participants) {
      if (participantMatchesPlayer(participant, player)) continue;
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

  const playerAnalysis = buildPlayerAnalysis(
    player,
    snapshot,
    buildPartyGroups([player, ...partyPlayers], snapshots, moderationMap),
    buildOpponentStats(player, opponentPlayers, snapshots, moderationMap),
    moderationMap.get(player.puuid) || emptyModeration(),
    requestedGames,
  );
  playerAnalysis.network = buildNetworkAnalysis(
    [player, ...partyPlayers.slice(0, 5)],
    opponentPlayers.slice(0, 5),
    snapshots,
  );
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
): Promise<RecentNetworkAnalysis> => {
  const players = Array.from(
    new Map(
      [...friendList, ...enemyList].map((player) => [player.puuid, player]),
    ).values(),
  );
  const [snapshots, moderationMap] = await Promise.all([
    mapWithConcurrency(
      players,
      HISTORY_CONCURRENCY,
      (player) => loadPlayerHistory(player, queueId),
    ),
    loadModerationMap(players),
  ]);
  const snapshotMap = new Map(
    players.map((player, index) => [player.puuid, snapshots[index]]),
  );
  // 第一阶段只使用缓存/首屏的最近 10 场，立刻把个人分析和已有关系交付给 UI。
  applyTeamAnalysis(
    friendList,
    enemyList,
    snapshotMap,
    moderationMap,
    RECENT_DEFAULT_GAME_COUNT,
  );

  const hydrationRequests = players
    .map((player) => queueHydration.get(`${player.puuid}:${queueId}`))
    .filter((request): request is Promise<void> => request !== undefined);
  if (hydrationRequests.length === 0) {
    return buildNetworkAnalysis(friendList, enemyList, snapshotMap);
  }

  // 第二阶段等待后台补齐；此函数由调用方 fire-and-forget，因而不会阻塞
  // 首屏，但能让顶部“100 场分析中”状态准确持续到真正完成。
  await Promise.allSettled(hydrationRequests);
  const hydratedSnapshots = await Promise.all(
    players.map(async (player, index) => {
      const cachedGames = await getCachedHistory({
        puuid: player.puuid,
        queueId,
        modeKey: modeForQueue(queueId),
        limit: RECENT_ANALYSIS_GAME_COUNT,
      });
      const initialSnapshot = snapshots[index];
      if (cachedGames.length <= initialSnapshot.games.size) {
        return initialSnapshot;
      }
      return {
        puuid: player.puuid,
        games: new Map(cachedGames.map((game) => [game.gameId, game])),
        source: "PostgreSQL 本地缓存",
        complete: cachedGames.length >= RECENT_ANALYSIS_GAME_COUNT,
      };
    }),
  );
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
  return buildNetworkAnalysis(friendList, enemyList, hydratedSnapshotMap);
};

export const clearRecentAnalysisCache = () => historyCache.clear();
