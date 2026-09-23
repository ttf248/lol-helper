import {
  queryMatchHistoryWithSource,
  queryMatchHistoryFullWithSource,
  MatchHistoryGame,
} from "@/lcu/aboutMatch";
import { Games } from "@/lcu/types/queryMatchLcuTypes";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import BlackList from "@/main/views/record/blackList";
import { Hater } from "@/main/views/record/blackListTypes";
import { cacheHistory, getCachedHistory, getCachedPlayerSummary, getCachedTeamHistory } from "@/recentMatch/utils/databaseCache";
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
  HISTORY_PLAYER_MAX_GAMES,
} from "@/recentMatch/utils/historyConfig";
import { logger } from "@/utils/logger";
import { buildHistoryEvidence, clearHistoryEvidenceCache } from "@/recentMatch/utils/historyEvidence";
import { scorePartyEvidence, hasHighWinRateEvidence } from "@/recentMatch/utils/partyScoring";
import { comparePartyGroups } from "@/recentMatch/utils/partyPresentation";
import { buildPartyMembership, clearPartyMembershipCache } from "@/recentMatch/utils/partyMembership";
import {
    findPlayerParticipant,
    participantMatchesPlayer,
    clearParticipantLookupCache,
} from "@/recentMatch/utils/participantLookup";

export const RECENT_DEFAULT_GAME_COUNT = HISTORY_PANEL_PREVIEW_COUNT;

const HISTORY_CONCURRENCY = 5;
const RECENT_ACTIVITY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MODERATION_TIMEOUT_MS = 2500;

/**
 * 对局内开黑初筛窗口：当前对局 + 最近 4 场已结束对局。
 * 同队次数至少 3 次才进入历史分析；历史分析通道仍会独立保留。
 */
export const PARTY_RECENT_MATCH_COUNT = 5;
export const PARTY_RECENT_MIN_TEAM_GAMES = 3;
const CURRENT_MATCH_SOURCE = "current-match";

export interface NormalizedHistoryParticipant {
  puuid: string;
  summonerId?: number;
  summonerName?: string;
  /** Riot ID 的游戏昵称，不使用 PUUID 作为展示名。 */
  gameName?: string;
  tagLine?: string;
  teamId: number;
  championId: number;
  position: string;
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
}

// LCU / SGP / 内联 participantIdentities 三种来源的并集形状。
// 只列出归一化链路会读取的字段，其余一概忽略。
interface RawParticipantStats {
  kills?: unknown;
  deaths?: unknown;
  assists?: unknown;
  win?: unknown;
}

interface RawIdentityPlayer {
  puuid?: unknown;
  summonerId?: unknown;
  summonerName?: unknown;
  gameName?: unknown;
  tagLine?: unknown;
}

interface RawParticipant {
  puuid?: unknown;
  summonerId?: unknown;
  summonerName?: unknown;
  gameName?: unknown;
  tagLine?: unknown;
  riotIdGameName?: unknown;
  riotIdTagline?: unknown;
  teamId?: unknown;
  championId?: unknown;
  participantId?: unknown;
  individualPosition?: unknown;
  teamPosition?: unknown;
  role?: unknown;
  lane?: unknown;
  timeline?: {
    role?: unknown;
    lane?: unknown;
  };
  stats?: RawParticipantStats;
}

interface RawParticipantIdentity {
  participantId: number;
  player: RawIdentityPlayer;
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
  /** 本次面板生命周期已成功刷新历史摘要；缓存本身不证明窗口最新。 */
  recentHistoryVerified?: boolean;
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

const getPosition = (participant: RawParticipant): string => {
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

const normalizedText = (value: unknown): string | undefined => {
  const text = String(value ?? "").trim();
  return text || undefined;
};

/**
 * LCU 使用 gameName/tagLine，SGP 使用 riotIdGameName/riotIdTagline，
 * 老接口才可能只提供 summonerName。统一成可读的 Riot 游戏昵称，
 * 绝不把 PUUID 当成用户名称写入分析结果。
 */
const getParticipantDisplayName = (
  participant: RawParticipant,
  identityPlayer?: RawIdentityPlayer,
): { gameName?: string; tagLine?: string; summonerName?: string } => {
  const gameName = normalizedText(
    participant?.gameName ??
      participant?.riotIdGameName ??
      identityPlayer?.gameName,
  );
  const tagLine = normalizedText(
    participant?.tagLine ??
      participant?.riotIdTagline ??
      identityPlayer?.tagLine,
  );
  const legacyName = normalizedText(
    participant?.summonerName ?? identityPlayer?.summonerName,
  );
  if (gameName) {
    const hasTagLine = tagLine &&
      gameName.toLocaleLowerCase().endsWith(`#${tagLine.toLocaleLowerCase()}`);
    return {
      gameName,
      tagLine,
      summonerName: hasTagLine ? gameName : `${gameName}${tagLine ? `#${tagLine}` : ""}`,
    };
  }
  return { summonerName: legacyName };
};

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
  participant: RawParticipant,
  stats: RawParticipantStats | RawParticipant | undefined,
  identity?: RawParticipantIdentity,
): NormalizedHistoryParticipant | null => {
  const identityPlayer = identity?.player;
  const summonerId = asOptionalNumber(
    participant?.summonerId ?? identityPlayer?.summonerId,
  );
  const display = getParticipantDisplayName(participant, identityPlayer);
  const summonerName = display.summonerName;
  const puuid = getIdentityKey(
    participant?.puuid || identityPlayer?.puuid,
    summonerId,
    summonerName,
  );
  if (!puuid) {
    return null;
  }

  // LCU 的 stats 嵌在 participant.stats，SGP / 纯 participants 模式下
  // 直接挂在 participant 上。两种情况分别取后再走统一归一化。
  const source = (stats && typeof stats === "object" && "kills" in stats
    ? stats
    : participant) as RawParticipantStats;
  return {
    puuid,
    summonerId,
    summonerName,
    gameName: display.gameName,
    tagLine: display.tagLine,
    teamId: asNumber(participant?.teamId),
    championId: asNumber(participant?.championId),
    position: getPosition(participant),
    kills: asNumber(source?.kills),
    deaths: asNumber(source?.deaths),
    assists: asNumber(source?.assists),
    win: Boolean(source?.win),
  };
};

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
    .map((participant: RawParticipant) => {
      if ("participantIdentities" in game) {
        const identity = (game as Games).participantIdentities?.find(
          (item: RawParticipantIdentity) =>
            item.participantId === participant.participantId,
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
  recentHistoryVerified: boolean;
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
  recentHistoryVerified: boolean;
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

  // 只检查本次请求可覆盖的窗口；旧缓存数量不能掩盖新摘要缺少参与者。
  const latestWindow = summaryMerged.games.slice(0, boundedServerLimit);
  const needsFullParticipants = latestWindow.some((game) => historyGameQuality(game) !== "complete");

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
    recentHistoryVerified: summaryResult !== null && summaryResult !== undefined,
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
      recentHistoryVerified: synced.recentHistoryVerified,
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
      recentHistoryVerified: false,
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
      // 本地样本与最新窗口分开处理，服务器仅同步最近一页；
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

interface RawModerationRecord {
    gameId?: unknown;
    punisherId?: unknown;
    punisherName?: unknown;
    offenderId?: unknown;
    offenderName?: unknown;
    offense?: unknown;
    createdAt?: unknown;
    source?: unknown;
    tag?: unknown;
    content?: unknown;
    isShow?: unknown;
    UpdatedAt?: unknown;
    updatedAt?: unknown;
    playerSumName?: unknown;
}

const toModerationRecord = (record: RawModerationRecord): ModerationRecord => ({
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
  summonerId: player.summonerId,
  summonerName: normalizedText(player.summonerName) || "未知玩家",
  moderation: moderationMap.get(player.puuid) || emptyModeration(),
});

const participantDisplayName = (
  participant: NormalizedHistoryParticipant,
): string =>
  normalizedText(
    participant.summonerName ||
      participant.gameName ||
      "",
  ) || "未知玩家";

const participantToRecentPlayer = (
  participant: NormalizedHistoryParticipant,
): RecentSumInfo => ({
  summonerId: participant.summonerId || 0,
  summonerName: participantDisplayName(participant),
  puuid: participant.puuid,
  championUrl: "",
  champId: participant.championId,
  teamParticipantId: 0,
  matchList: [],
});

const buildOpponentStats = (
  player: RecentSumInfo,
  opponents: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
  moderationMap: Map<string, PlayerModerationInfo>,
): OpponentMatchupStats[] => {
  const evidence = buildHistoryEvidence(snapshots);

  return opponents
    .map((opponent) => {
      let games = 0;
      let wins = 0;
      let opponentWins = 0;
      for (const game of evidence.values()) {
        const ownParticipant = game
          ? findPlayerParticipant(game, player)
          : undefined;
        const opponentParticipant = game
          ? findPlayerParticipant(game, opponent)
          : undefined;
        if (!ownParticipant || !opponentParticipant) continue;
        if (ownParticipant === opponentParticipant || ownParticipant.teamId <= 0 || opponentParticipant.teamId <= 0) continue;
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
 * 先用于最近窗口初筛，再用于候选组合的完整历史统计；举报结果只在
 * overlay 阶段叠加。
 */
export type StructuralPartyGroup = {
  confidenceScore: number;
  completeCoverage: number;
  identityCoverage: number;
  members: RecentSumInfo[];
  requiredGames: number;
  /** 结构层总同队次数；对局内结果包含当前对局。 */
  games: number;
  /** 排除当前对局后的已结束对局次数。 */
  historicalGames: number;
  /** 当前对局次数，当前对局结果未知时不参与胜率。 */
  currentMatchGames: number;
  /** 初筛窗口内的同队次数，仅在初筛结构上填充。 */
  recentWindowGames?: number;
  wins: number;
  winRate: number;
  latestGameAt: number;
  recentGames: number;
  /** 关系强度：时间衰减、近期共同占比与连续同队，排除胜负。 */
  stabilityScore: number;
  /** 仅依赖结构层数据，可提前计算避免在 overlay 阶段再判一次。 */
  highWinRateAlert: boolean;
  evidence: PartyEvidence[];
  /**
   * 组合内每位成员作为同队成员出现的最少场次。`buildPlayerPartyGroups`
   * 调用时天然等于 group.games（每位成员都参与了所有同场）；
   * `buildPartyGroupsStructure` 调用时同样等于 historicalGames +
   * currentMatchGames。UI 用此判断"4 黑 + 路人"模式下路人是否拉低了
   * 整个组合的可信度。
   */
  minMemberFrequency?: number;
};

interface PartyGroupStructureOptions {
  /** 近期窗口必须逐成员确认比赛归属，历史证据则允许单来源。 */
  requireWindowMembership?: boolean;
  evidence?: Map<number, NormalizedHistoryGame>;
  /** 只计算已经通过最近窗口初筛的成员集合。 */
  allowedGroupKeys?: ReadonlySet<string>;
  /** 结构至少需要多少场；默认沿用人数门槛。 */
  minimumGames?: number;
  /** 写入结果的门槛，当前对局初筛固定为 3。 */
  requiredGames?: number;
}

/**
 * 对一组玩家 × 各自历史的快照，枚举所有 size≥2 同队组合并返回
 * 结构层结果（不含 moderation/置信度字段；调用方需通过
 * `applyPartyGroupOverlay` 叠加）。已在前端对局内面板和首页历史分析
 * 使用；首页战绩查询面板也通过 `useMatchPartyAnalysis` 复用本函数。
 */
const partyGroupKey = (members: RecentSumInfo[]): string =>
  members
    .map((member) => member.puuid)
    .sort()
    .join("|");

export const buildPartyGroupsStructure = (
  players: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
  options: PartyGroupStructureOptions = {},
): StructuralPartyGroup[] => {
  const structures: StructuralPartyGroup[] = [];
  const now = Date.now();
  const evidenceIndex = options.evidence || buildHistoryEvidence(snapshots);
  // 当前局仅供显式近期窗口使用，不进入共享历史证据。
  const current = Array.from(snapshots.values()).flatMap((s) => Array.from(s.games.values()))
    .find((game) => game.source === CURRENT_MATCH_SOURCE);
  const allGames = new Map(evidenceIndex);
  if (current) allGames.set(current.gameId, current);
  const memberships = buildPartyMembership(players, allGames);
  for (let size = 2; size <= players.length; size++) {
    for (const group of combinations(players, size)) {
      if (
        options.allowedGroupKeys &&
        !options.allowedGroupKeys.has(partyGroupKey(group))
      ) {
        continue;
      }
      const commonGameIds = (memberships.get(partyGroupKey(group)) || []).filter((gameId) =>
        !options.requireWindowMembership || group.every((player) =>
          snapshots.get(player.puuid)?.games.has(gameId),
        ),
      );

      let games = 0;
      let historicalGames = 0;
      let currentMatchGames = 0;
      let wins = 0;
      const evidence: PartyEvidence[] = [];
      for (const gameId of commonGameIds) {
        const game = allGames.get(gameId);
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
        if (new Set(participants).size !== group.length) continue;
        const teamId = participants[0]!.teamId;
        if (
          participants.some(
            (participant) => participant!.teamId !== teamId,
          )
        ) {
          continue;
        }
        games += 1;
        const isCurrentMatch = game.source === CURRENT_MATCH_SOURCE;
        if (isCurrentMatch) {
          currentMatchGames += 1;
        } else {
          historicalGames += 1;
          wins += participants[0]!.win ? 1 : 0;
        }
        evidence.push({
          gameId: game.gameId,
          gameCreation: game.gameCreation,
          isCurrentMatch,
        });
      }

      // 对局内的候选门槛由调用方明确传入：当前对局 + 最近 4 场中，
      // 同队次数至少 3 次。历史阶段只负责丰富近期候选；旧的完整历史
      // 通道由调用方另外执行并在最后合并。
      const requiredGames =
        options.requiredGames ?? Math.max(2, Math.min(group.length, 5));
      const minimumGames = options.minimumGames ?? requiredGames;
      if (games < minimumGames) continue;
      const winRate = roundRate(wins, historicalGames) ?? 0;
      // 每位成员作为同队成员在该组合 evidence 中出现的最少场次。
      // 当 size=5 队伍中混入"4 黑 + 路人"模式的低频路人时，路人的
      // 频次会拉低该值；size=4 子组合天然拥有更高的最小成员频次，
      // UI 自然倾向于展示稳定的子组合。
      const minMemberFrequency = historicalGames + currentMatchGames;
      const scores = scorePartyEvidence(
        group,
        evidence,
        Array.from(allGames.values()),
        now,
        minMemberFrequency,
      );
      structures.push({
        members: group,
        requiredGames,
        games,
        historicalGames,
        currentMatchGames,
        wins,
        winRate,
        ...scores,
        highWinRateAlert: hasHighWinRateEvidence(wins, historicalGames),
        evidence: evidence.sort(
          (left, right) => right.gameCreation - left.gameCreation,
        ),
        minMemberFrequency,
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

/**
 * 把结构层结果叠加 moderation/黑名单/置信度等 UI 字段。
 * 纯函数：给定相同输入（structure + moderationMap + now）总返回相同结果。
 */
/**
 * 把结构层结果叠加 moderation/黑名单/置信度等 UI 字段。
 * 纯函数：给定相同输入（structure + moderationMap + now）总返回相同结果。
 * 已在前端对局内面板和首页历史分析使用；首页战绩查询面板也通过
 * `useMatchPartyAnalysis` 复用本函数。
 */
export const applyPartyGroupOverlay = (
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
  const historicalGames = structure.historicalGames;
  const recentWindowGames = structure.recentWindowGames;
  const lastActiveDays = structure.latestGameAt
    ? Math.max(0, Math.floor((now - structure.latestGameAt) / DAY_MS))
    : null;
  return {
    members,
    relationKind: recentWindowGames === undefined ? "historical" : "recent",
    evidenceCoverage: { complete: structure.completeCoverage, identity: structure.identityCoverage },
    requiredGames: structure.requiredGames,
    recentWindowGames,
    historicalGames,
    currentMatchGames: structure.currentMatchGames,
    games: structure.games,
    wins: structure.wins,
    winRate: structure.winRate,
    latestGameAt: structure.latestGameAt,
    recentGames: structure.recentGames,
    lastActiveDays,
    stabilityScore: structure.stabilityScore,
    stabilityLevel: confidenceLevel(structure.stabilityScore),
    highWinRateAlert: structure.highWinRateAlert,
    confidence: confidenceInfo(structure.confidenceScore, [
      ...(recentWindowGames === undefined
        ? [`共同对局 ${structure.games} 场`]
        : [
            `当前模式最近${PARTY_RECENT_MATCH_COUNT}局共同同队 ${recentWindowGames} 次（含当前对局）`,
            `初筛门槛：同队次数至少 3 次`,
          ]),
      `历史共同同队 ${historicalGames} 场`,
      `近${RECENT_ACTIVITY_DAYS}天共同对局 ${structure.recentGames} 场`,
      recentWindowGames === undefined ? "历史同队关系，不代表本局正在组队" : "近期疑似组队，历史记录用于补充证据",
      `阵容完整覆盖 ${structure.completeCoverage}% · 强身份覆盖 ${structure.identityCoverage}%`,
      "证据强度不是组队概率；关系强度不使用胜负或举报信息",
    ]),
    moderationAvailable,
    blacklistedMembers,
    reportedMembers,
    evidence: structure.evidence,
    minMemberFrequency: structure.minMemberFrequency,
  };
};

const toCurrentMatchParticipant = (
  player: RecentSumInfo,
  teamId: number,
): NormalizedHistoryParticipant => ({
  puuid: player.puuid,
  summonerId: player.summonerId,
  summonerName: player.summonerName,
  teamId,
  championId: player.champId,
  position: "UNKNOWN",
  kills: 0,
  deaths: 0,
  assists: 0,
  // 当前对局尚未结算；结构分析会通过 source 排除它的胜负数据。
  win: false,
});

/** 把当前阵容变成只用于关系分析的临时完整对局。 */
const buildCurrentMatchGame = (
  friendList: RecentSumInfo[],
  enemyList: RecentSumInfo[],
  queueId: number,
  currentGameId = 0,
): NormalizedHistoryGame | null => {
  const participants = [
    ...friendList.map((player) => toCurrentMatchParticipant(player, 100)),
    ...enemyList.map((player) => toCurrentMatchParticipant(player, 200)),
  ].filter((participant) => participant.puuid);
  if (participants.length === 0) return null;

  return {
    // session gameId 缺失时使用 0；source 仍能保证它与历史数据区分。
    gameId:
      Number.isFinite(currentGameId) && currentGameId > 0 ? currentGameId : 0,
    gameCreation: Date.now(),
    queueId,
    participants,
    source: CURRENT_MATCH_SOURCE,
  };
};

const isCurrentMatchGame = (
  game: NormalizedHistoryGame,
  currentGame: NormalizedHistoryGame,
): boolean =>
  game.source === CURRENT_MATCH_SOURCE ||
  (currentGame.gameId > 0 && game.gameId === currentGame.gameId);

/** 给完整历史快照补入当前对局，但不改变缓存中的原始快照。 */
const appendCurrentMatchToSnapshots = (
  snapshots: Map<string, PlayerHistorySnapshot>,
  players: RecentSumInfo[],
  currentGame: NormalizedHistoryGame,
): Map<string, PlayerHistorySnapshot> => {
  const result = new Map<string, PlayerHistorySnapshot>();
  for (const player of players) {
    const snapshot = snapshots.get(player.puuid);
    if (!snapshot) continue;
    const games = new Map(
      Array.from(snapshot.games.entries()).filter(
        ([, game]) => !isCurrentMatchGame(game, currentGame),
      ),
    );
    games.set(currentGame.gameId, currentGame);
    result.set(player.puuid, { ...snapshot, games });
  }
  return result;
};

/**
 * 当前对局初筛只取每名玩家最近 4 场已结束对局，再把当前对局放到窗口中。
 * 这样历史缓存即使有 100/500 场，也不会让远期同队记录越过本局初筛。
 */
const buildRecentPartySnapshots = (
  players: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
  currentGame: NormalizedHistoryGame,
): Map<string, PlayerHistorySnapshot> => {
  const result = new Map<string, PlayerHistorySnapshot>();
  const historicalLimit = PARTY_RECENT_MATCH_COUNT - 1;
  for (const player of players) {
    const snapshot = snapshots.get(player.puuid);
    if (!snapshot) continue;
    const recentHistory = Array.from(snapshot.games.values())
      .filter((game) => !isCurrentMatchGame(game, currentGame))
      .sort(
        (left, right) =>
          right.gameCreation - left.gameCreation || right.gameId - left.gameId,
      )
      .slice(0, historicalLimit);
    // 接口校验失败时，只要本地缓存已经有足够的完整近期对局，仍可
    // 用于“最近三局同队”的结构判断；胜率和覆盖率仍按接口校验状态展示。
    const completeCachedWindow =
      recentHistory.length >= PARTY_RECENT_MIN_TEAM_GAMES - 1 &&
      recentHistory.every((game) => historyGameQuality(game) === "complete");
    if (!snapshot.recentHistoryVerified && !completeCachedWindow) continue;
    const games = new Map<number, NormalizedHistoryGame>([
      [currentGame.gameId, currentGame],
      ...recentHistory.map((game) => [game.gameId, game] as const),
    ]);
    result.set(player.puuid, { ...snapshot, games });
  }
  return result;
};

/**
 * 对局内开黑分析的双通道入口：
 * 1. 当前对局 + 最近 4 场，按同队次数至少 3 次生成近期候选；
 * 2. 历史门槛独立保留；两条通道复用一次历史统计，不重复扫描所有比赛。
 */
const buildCurrentTeamPartyGroups = (
  team: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
  currentGame: NormalizedHistoryGame,
  moderationMap: Map<string, PlayerModerationInfo>,
  localTeamEvidence?: Map<number, NormalizedHistoryGame>,
): PartyGroupAnalysis[] => {
  // 团队级缓存是完整历史的加速来源，但不能替代逐玩家快照：数据库
  // 暂不可用、缓存为空或参与者版本不一致时，仍要保留旧算法能看到的证据。
  const historicalEvidence = new Map(buildHistoryEvidence(snapshots));
  for (const [gameId, game] of localTeamEvidence || []) {
    if (!isCurrentMatchGame(game, currentGame)) {
      historicalEvidence.set(gameId, game);
    }
  }

  // 旧算法独立保留完整历史关系，避免近期窗口过滤掉远期但稳定的组合。
  const legacyStructures = buildPartyGroupsStructure(team, snapshots, {
    evidence: historicalEvidence,
  });
  const mergedStructures = new Map<string, StructuralPartyGroup>(
    legacyStructures.map((group) => [partyGroupKey(group.members), group]),
  );

  // 新算法只看当前对局 + 每名玩家最近 4 场，并要求窗口内至少 3 次
  // 同队；requireWindowMembership 防止某一个人的历史替另一个人补证据。
  const recentSnapshots = buildRecentPartySnapshots(team, snapshots, currentGame);
  const recentStructures = buildPartyGroupsStructure(team, recentSnapshots, {
    requireWindowMembership: true,
    evidence: historicalEvidence,
    minimumGames: PARTY_RECENT_MIN_TEAM_GAMES,
    requiredGames: PARTY_RECENT_MIN_TEAM_GAMES,
  });
  if (recentStructures.length > 0) {
    const candidateKeys = new Set(
      recentStructures.map((group) => partyGroupKey(group.members)),
    );
    const historicalSnapshots = appendCurrentMatchToSnapshots(
      snapshots,
      team,
      currentGame,
    );
    const historicalStructures = buildPartyGroupsStructure(
      team,
      historicalSnapshots,
      {
        allowedGroupKeys: candidateKeys,
        evidence: historicalEvidence,
        // 近期候选已经完成判定，这里只负责补全完整历史统计。
        minimumGames: 1,
        requiredGames: PARTY_RECENT_MIN_TEAM_GAMES,
      },
    );
    const historicalByKey = new Map(
      historicalStructures.map((group) => [partyGroupKey(group.members), group]),
    );

    // 相同成员集合只保留一条结果：历史统计作为主体，近期窗口次数
    // 作为近期证据叠加，避免两个通道重复计数。
    for (const recentStructure of recentStructures) {
      const key = partyGroupKey(recentStructure.members);
      const historicalStructure = historicalByKey.get(key);
      mergedStructures.set(key, {
        ...(historicalStructure || recentStructure),
        requiredGames: PARTY_RECENT_MIN_TEAM_GAMES,
        recentWindowGames: recentStructure.games,
      });
    }
  }

  const now = Date.now();
  return Array.from(mergedStructures.values())
    .map((structure) => applyPartyGroupOverlay(structure, moderationMap, now))
    .sort(comparePartyGroups);
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
    if (game.source === CURRENT_MATCH_SOURCE) continue;

    const teammates = Array.from(
      new Map(
        game.participants
          .filter(
            (participant) =>
              participant.teamId === ownParticipant.teamId &&
              participant.teamId > 0 &&
              participant !== ownParticipant && !participantMatchesPlayer(participant, player),
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
      const members = [
        player,
        ...group.teammates.map(participantToRecentPlayer),
      ];
      return applyPartyGroupOverlay({
        members,
        requiredGames,
        games: group.games,
        historicalGames: group.games,
        currentMatchGames: 0,
        wins: group.wins,
        winRate,
        ...scorePartyEvidence(
          members,
          group.evidence,
          Array.from(snapshot.games.values()),
          now,
          group.games,
        ),
        highWinRateAlert: hasHighWinRateEvidence(group.wins, group.games),
        evidence: group.evidence.sort(
          (left, right) => right.gameCreation - left.gameCreation,
        ),
        minMemberFrequency: group.games,
      }, moderationMap, now);
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
        participant === ownParticipant ||
        participantMatchesPlayer(participant, player)
      ) {
        continue;
      }

      const existing = teammateGames.get(participant.puuid) || {
        player: participantToRecentPlayer(participant),
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
    partyCoverage: {
      status: games.length > 0 && hasParticipantRoster(games) ? "ready" : "insufficient",
      message: games.length > 0 && hasParticipantRoster(games)
        ? "已检查当前已加载的历史记录"
        : "参与者数据不足，未发现组合不代表没有组队关系",
    },
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
      if (participant === ownParticipant || participantMatchesPlayer(participant, player)) continue;
      if (participant.teamId <= 0) continue;
      const existing = related.get(participant.puuid) || {
        player: participantToRecentPlayer(participant),
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
 * 首页"历史分析"专用入口：优先按 gameCreation DESC 读取 PostgreSQL
 * 本地缓存；发现参与者不完整时，补拉完整队伍并回写同一批对局。
 */
export const loadPlayerCacheAnalysis = async (
  player: RecentSumInfo,
  modeKey: MatchModeKey,
  onProgress?: PlayerAnalysisProgressHandler,
): Promise<PlayerRecentAnalysis> => {
  const startedAt = Date.now();
  logger.info({
    tag: "recent.analysis.cache_first",
    message: "首页历史分析发起（本地优先）",
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
  let snapshot: PlayerHistorySnapshot = {
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

  // 历史分析不能把“只含当前玩家的摘要缓存”当作完整数据。旧版本的
  // 冷启动同步已经把 498 场摘要写入 PG，所以这里在发现参与者不完整时
  // 主动补拉完整 participant；成功后立即回写同一批 gameId，后续分析和
  // 下一次打开页面都只需读取 PG。
  let relationBaseAnalysis = personalAnalysis;
  if (snapshot.games.size > 0 && !snapshot.complete) {
    const hydrateStartedAt = Date.now();
    onProgress?.({
      stage: "full",
      completed: 0,
      total: 1,
      percentage: 74,
      message: `发现部分对局只有单人摘要，正在补齐最近 ${HISTORY_PLAYER_MAX_GAMES} 场参与者`,
    });
    logger.info({
      tag: "recent.analysis.cache_first",
      message: "本地历史参与者不完整，开始补齐",
      context: {
        purpose: "历史分析前补拉完整 participants 并回写 PostgreSQL",
        puuid: player.puuid,
        mode_key: modeKey,
        cached_games: snapshot.games.size,
        server_limit: HISTORY_PLAYER_MAX_GAMES,
      },
    });

    const fullResult = await queryMatchHistoryFullWithSource(
      player.puuid,
      0,
      HISTORY_PLAYER_MAX_GAMES,
    );
    const fullGames = uniqueGames(
      fullResult?.games ?? [],
      modeKey,
      player,
      fullResult?.source || "interface-full",
    );
    const merged = mergeHistoryGames(
      Array.from(snapshot.games.values()),
      Array.from(fullGames.values()),
      HISTORY_CACHE_PAGE_SIZE,
      { puuid: player.puuid, modeKey },
    );
    const mergedMap = new Map(merged.games.map((game) => [game.gameId, game]));
    const hydratedComplete =
      mergedMap.size > 0 && hasParticipantRoster(Array.from(mergedMap.values()));

    if (fullGames.size > 0) {
      const source = fullResult?.source || "历史接口完整参与者";
      await cacheHistory({
        puuid: player.puuid,
        summonerId: player.summonerId,
        summonerName: player.summonerName,
        modeKey,
        source,
        games: merged.games,
      });
      snapshot = {
        ...snapshot,
        games: mergedMap,
        source,
        sourceEndpoints: fullResult?.endpoints || snapshot.sourceEndpoints,
        complete: hydratedComplete,
        dataCoverage: merged.coverage,
      };
      relationBaseAnalysis = buildPlayerAnalysis(
        player,
        snapshot,
        [],
        [],
        emptyModeration(),
      );
      onProgress?.({
        stage: "full",
        completed: 1,
        total: 1,
        percentage: 82,
        message: hydratedComplete
          ? `参与者补齐完成：${merged.games.length} 场可用于开黑分析`
          : `已补回 ${fullGames.size} 场，仍有部分历史缺少参与者`,
        analysis: relationBaseAnalysis,
      });
    } else {
      onProgress?.({
        stage: "full",
        completed: 1,
        total: 1,
        percentage: 82,
        message: "完整参与者接口暂不可用，继续使用本地摘要分析",
        analysis: personalAnalysis,
      });
    }

    logger.info({
      tag: "recent.analysis.cache_first",
      message: "本地历史参与者补齐完成",
      context: {
        purpose: "历史分析前补拉完整 participants 并回写 PostgreSQL",
        puuid: player.puuid,
        mode_key: modeKey,
        cached_games: snapshot.games.size,
        full_games: fullGames.size,
        complete: snapshot.complete,
        duration_ms: Date.now() - hydrateStartedAt,
      },
      durationMs: Date.now() - hydrateStartedAt,
    });
  }

  const finalAnalysis = await computePlayerRelations(
    player,
    snapshot,
    relationBaseAnalysis,
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
    tag: "recent.analysis.cache_first",
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
      summonerId: player.summonerId,
      summonerName: player.summonerName,
      team,
      teamIndex,
    })),
  );
  const players = [...friendList, ...enemyList];
  const edges: RecentNetworkEdge[] = [];
  const evidence = buildHistoryEvidence(snapshots);

  for (let leftIndex = 0; leftIndex < players.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < players.length; rightIndex++) {
      const left = players[leftIndex];
      const right = players[rightIndex];
      let sameTeamGames = 0;
      let opposedGames = 0;
      let sourceWins = 0;
      let targetWins = 0;
      for (const game of evidence.values()) {
        const source = game ? findPlayerParticipant(game, left) : undefined;
        const target = game ? findPlayerParticipant(game, right) : undefined;
        if (!source || !target) continue;
        if (source === target || source.teamId <= 0 || target.teamId <= 0) continue;
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

  const availableGames = evidence.size;
  return { nodes, edges, availableGames };
};

const getTeamPartyCoverage = (
  team: RecentSumInfo[],
  snapshots: Map<string, PlayerHistorySnapshot>,
  currentGame: NormalizedHistoryGame | null,
  localTeamEvidence?: Map<number, NormalizedHistoryGame>,
): NonNullable<PlayerRecentAnalysis["partyCoverage"]> => {
  const evidence = localTeamEvidence || buildHistoryEvidence(snapshots);
  const ready = team.length > 0 && team.every((player) => {
    const snapshot = snapshots.get(player.puuid);
    if (!snapshot?.recentHistoryVerified) return false;
    const window = Array.from(snapshot.games.values())
      .filter((game) => !currentGame || !isCurrentMatchGame(game, currentGame))
      .sort((a, b) => b.gameCreation - a.gameCreation || b.gameId - a.gameId)
      .slice(0, PARTY_RECENT_MATCH_COUNT - 1);
    return window.length === PARTY_RECENT_MATCH_COUNT - 1 && window.every((game) =>
      historyGameQuality(evidence.get(game.gameId) || game) === "complete",
    );
  });
  return {
    status: ready ? "ready" : "insufficient",
    message: ready
      ? "已核验当前模式各成员最近4场；历史统计限于已加载记录"
      : "近期窗口未刷新、场数不足或参与者缺失；暂无法排除组队关系",
  };
};

// 同一不可变快照的举报刷新只叠加附加信息；时间分桶避免跨分钟复用衰减分数。
let teamAnalysisCache = new WeakMap<Map<string, PlayerHistorySnapshot>, {
  key: string; analyses: Map<string, PlayerRecentAnalysis>;
}>();

const overlayModeration = (
  analysis: PlayerRecentAnalysis, puuid: string, moderation: Map<string, PlayerModerationInfo>,
): PlayerRecentAnalysis => {
  const member = (value: PartyMember): PartyMember => ({ ...value, moderation: moderation.get(value.puuid) || emptyModeration() });
  return { ...analysis, moderation: moderation.get(puuid) || emptyModeration(),
    partyGroups: analysis.partyGroups.map(group => {
      const members = group.members.map(member);
      return { ...group, members,
        moderationAvailable: members.every(m => m.moderation?.available),
        blacklistedMembers: members.filter(m => m.moderation?.marked),
        reportedMembers: members.filter(m => (m.moderation?.reportCount || 0) > 0),
      };
    }),
    opponents: analysis.opponents.map(opponent => ({ ...opponent, opponent: member(opponent.opponent) })),
  };
};

const applyTeamAnalysis = (
  friendList: RecentSumInfo[],
  enemyList: RecentSumInfo[],
  snapshotMap: Map<string, PlayerHistorySnapshot>,
  moderationMap: Map<string, PlayerModerationInfo>,
  queueId: number,
  currentGameId = 0,
  teamEvidence?: readonly [Map<number, NormalizedHistoryGame>, Map<number, NormalizedHistoryGame>],
) => {
  const now = Date.now();
  const key = JSON.stringify([queueId, currentGameId, Math.floor(now / 60_000),
    [friendList, enemyList].map(team => team.map(p => [p.puuid, p.summonerId, p.summonerName, p.champId]))]);
  const cached = teamAnalysisCache.get(snapshotMap);
  if (cached?.key === key) {
    for (const player of [...friendList, ...enemyList]) {
      const analysis = cached.analyses.get(player.puuid);
      if (analysis) player.recentAnalysis = overlayModeration(analysis, player.puuid, moderationMap);
    }
    return;
  }
  const analyses = new Map<string, PlayerRecentAnalysis>();
  const currentGame = buildCurrentMatchGame(
    friendList,
    enemyList,
    queueId,
    currentGameId,
  );
  for (const [team, opposingTeam, localEvidence] of [
    [friendList, enemyList, teamEvidence?.[0]],
    [enemyList, friendList, teamEvidence?.[1]],
  ] as const) {
    const partyCoverage = getTeamPartyCoverage(team, snapshotMap, currentGame, localEvidence);
    // 近期候选和历史关系独立保留，覆盖不足时明确标注，不能据此否定组队。
    const groups = currentGame
      ? buildCurrentTeamPartyGroups(
          team,
          snapshotMap,
          currentGame,
          moderationMap,
          localEvidence,
        )
      : buildPartyGroupsStructure(team, snapshotMap).map((structure) =>
          applyPartyGroupOverlay(structure, moderationMap, now),
        );
    for (const player of team) {
      const snapshot = snapshotMap.get(player.puuid);
      if (!snapshot) continue;
      player.recentAnalysis = buildPlayerAnalysis(
        player,
        snapshot,
        groups.filter((group) =>
          group.members.some((member) => member.puuid === player.puuid),
        ),
        buildOpponentStats(player, opposingTeam, snapshotMap, moderationMap),
        moderationMap.get(player.puuid) || emptyModeration(),
      );
      player.recentAnalysis.partyCoverage = partyCoverage;
      analyses.set(player.puuid, player.recentAnalysis);
    }
  }
  teamAnalysisCache.set(snapshotMap, { key, analyses });
};

/** 当前一边队伍统一从本地 PostgreSQL 取证；个人历史仍负责最近窗口和战绩。 */
const loadTeamPartyEvidence = async (
  team: RecentSumInfo[],
  queueId: number,
): Promise<Map<number, NormalizedHistoryGame>> => {
  const games = await getCachedTeamHistory({
    puuids: team.map((player) => player.puuid),
    modeKey: modeForQueue(queueId),
    limit: HISTORY_CACHE_PAGE_SIZE,
  });
  return new Map(games.map((game) => [game.gameId, game]));
};

export const loadRecentTeamAnalysis = async (
  friendList: RecentSumInfo[],
  enemyList: RecentSumInfo[],
  queueId: number,
  currentGameId = 0,
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
  const teamEvidencePromise = Promise.all([
    loadTeamPartyEvidence(friendList, queueId),
    loadTeamPartyEvidence(enemyList, queueId),
  ] as const);
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
  const initialTeamEvidence = await teamEvidencePromise;

  // 第一阶段先基于当前对局 + 最近 4 场完成开黑初筛，个人统计仍沿用
  // 缓存中的近期样本；先使用空的举报结果，避免外部举报服务拖慢首屏。
  applyTeamAnalysis(
    friendList,
    enemyList,
    snapshotMap,
    new Map(players.map((player) => [player.puuid, emptyModeration()])),
    queueId,
    currentGameId,
    initialTeamEvidence,
  );
  logger.info({
    tag: "recent.analysis",
    message: "近期分析阶段：缓存历史关系分析完成，待核验最新窗口",
    context: { stage: "recent", queue_id: queueId, players: players.length },
  });
  onProgress?.({
    stage: "recent",
    completed: players.length,
    total: players.length,
    message: "缓存历史关系已分析，正在核验当前模式最近5局",
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
  // 举报记录完成后刷新最近 5 局初筛和已有的个人结果，不影响历史补全任务。
  applyTeamAnalysis(
    friendList,
    enemyList,
    snapshotMap,
    moderationMap,
    queueId,
    currentGameId,
    initialTeamEvidence,
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
        dataCoverage: hydratedResult?.coverage,
        recentHistoryVerified: hydratedResult?.recentHistoryVerified ?? false,
      };
    });
  const hydratedSnapshotMap = new Map(
    players.map((player, index) => [player.puuid, hydratedSnapshots[index]]),
  );
  buildHistoryEvidence(hydratedSnapshotMap, snapshotMap);
  const hydratedTeamEvidence = await Promise.all([
    loadTeamPartyEvidence(friendList, queueId),
    loadTeamPartyEvidence(enemyList, queueId),
  ] as const);
  applyTeamAnalysis(
    friendList,
    enemyList,
    hydratedSnapshotMap,
    moderationMap,
    queueId,
    currentGameId,
    hydratedTeamEvidence,
  );
  const network = buildNetworkAnalysis(friendList, enemyList, hydratedSnapshotMap);
  logger.info({
    tag: "recent.analysis",
    message: "近期分析阶段：已加载历史分析完成",
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
    message: "当前模式已加载历史分析完成",
  });
  return network;
};

export const clearRecentAnalysisCache = () => {
  historyCache.clear();
  queueHydration.clear();
  teamAnalysisCache = new WeakMap();
  clearHistoryEvidenceCache();
  clearPartyMembershipCache();
  clearParticipantLookupCache();
};
