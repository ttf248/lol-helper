import { invoke } from "@tauri-apps/api/core";
import type { NormalizedHistoryGame } from "./recentAnalytics";
import { MatchModeKey } from "./matchMode";
import { logger } from "@/utils/logger";
import type { lcuSummonerInfo } from "@/lcu/types/SummonerTypes";

// 客户端 TTL 缓存：避免切模式 tab / 翻页 / 切换玩家时反复打 LCU → Rust → PG
// 这条链路。日志里 db.summary / db.player_summary / db.cached_history 在单次
// 会话中常出现 8+ 次重复调用，返回完全相同的数据。把同一查询合并到 TTL 内
// 即可消除冗余，同时不破坏 cacheHistory 的写入语义。
const SUMMARY_TTL_MS = 30_000;
const PLAYER_SUMMARY_TTL_MS = 15_000;
const HISTORY_TTL_MS = 10_000;
const SUMMONER_TTL_MS = 30_000;
const GAME_DETAIL_TTL_MS = 60_000;

interface CachedEntry<T> {
  value: T;
  fetchedAt: number;
}

const summaryCache: { current: CachedEntry<DatabaseSummary> | null } = {
  current: null,
};
const playerSummaryCache = new Map<string, CachedEntry<CachedPlayerSummary>>();
const historyCache = new Map<string, CachedEntry<NormalizedHistoryGame[]>>();
const summonerByIdCache = new Map<number, CachedEntry<CachedSummonerRow>>();
const summonerByPuuidCache = new Map<string, CachedEntry<CachedSummonerRow>>();
const gameDetailCache = new Map<number, CachedEntry<CachedGameDetail>>();

const dropSummonerCacheEntry = (row: CachedSummonerRow) => {
  summonerByIdCache.delete(row.summonerId);
  summonerByPuuidCache.delete(row.puuid);
};

const isFresh = <T>(entry: CachedEntry<T> | undefined, ttl: number) =>
  entry !== undefined && Date.now() - entry.fetchedAt < ttl;

const historyCacheKey = (query: CachedHistoryQuery) =>
  `${query.puuid}|${query.modeKey ?? ""}|${query.queueId ?? ""}|${query.offset ?? 0}|${query.limit}`;

const playerSummaryCacheKey = (puuid: string, modeKey?: MatchModeKey | null) =>
  `${puuid}|${modeKey ?? ""}`;

/**
 * 清空客户端 TTL 缓存。手动刷新（数据库写入、切换账号、用户点击
 * refresh 按钮）时应调用，避免读到旧数据。
 */
export const resetDatabaseCache = (reason?: string) => {
  const before = {
    summary: summaryCache.current !== null ? 1 : 0,
    player_summary: playerSummaryCache.size,
    history: historyCache.size,
    summoner_by_id: summonerByIdCache.size,
    summoner_by_puuid: summonerByPuuidCache.size,
    game_detail: gameDetailCache.size,
  };
  summaryCache.current = null;
  playerSummaryCache.clear();
  historyCache.clear();
  summonerByIdCache.clear();
  summonerByPuuidCache.clear();
  gameDetailCache.clear();
  logger.info({
    tag: "db.cache",
    message: "TTL 缓存已重置",
    context: {
      reason: reason ?? "unspecified",
      cleared_entries: before,
    },
  });
};

export interface CachedHistoryQuery {
  puuid: string;
  queueId?: number;
  modeKey?: MatchModeKey;
  limit: number;
  offset?: number;
}

interface CachedParticipant {
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

interface CachedGame {
  gameId: number;
  gameCreation: number;
  queueId: number;
  modeKey: MatchModeKey;
  source: string;
  participants: CachedParticipant[];
}

export const getCachedHistory = async (
  query: CachedHistoryQuery,
): Promise<NormalizedHistoryGame[]> => {
  const cacheKey = historyCacheKey(query);
  const cached = historyCache.get(cacheKey);
  if (isFresh(cached, HISTORY_TTL_MS)) {
    logger.debug({
      tag: "db.cache",
      message: "TTL 命中，跳过 invoke",
      context: {
        op: "get_cached_match_history",
        puuid: query.puuid?.slice(-8) ?? "",
        mode_key: query.modeKey,
        age_ms: Date.now() - (cached?.fetchedAt ?? 0),
      },
    });
    return cached!.value;
  }
  const startedAt = Date.now();
  logger.info({
    tag: "db.cache",
    message: "读取缓存历史发起",
    context: {
      purpose: "读取 PostgreSQL 缓存历史",
      op: "get_cached_match_history",
      puuid: query.puuid,
      queue_id: query.queueId ?? null,
      mode_key: query.modeKey ?? null,
      limit: query.limit,
      offset: query.offset ?? 0,
      request: query,
    },
  });
  try {
    const games = await invoke<CachedGame[]>("get_cached_match_history", {
      request: query,
    });
    const value = (games || []).map((game) => ({
      gameId: game.gameId,
      gameCreation: game.gameCreation,
      queueId: game.queueId,
      source: game.source || "postgres",
      participants: (game.participants || []).map((participant) => ({
        puuid: participant.puuid,
        summonerId: participant.summonerId,
        summonerName: participant.summonerName,
        teamId: participant.teamId,
        championId: participant.championId,
        position: participant.position,
        kills: participant.kills,
        deaths: participant.deaths,
        assists: participant.assists,
        win: participant.win,
      })),
    }));
    historyCache.set(cacheKey, { value, fetchedAt: Date.now() });
    logger.info({
      tag: "db.cache",
      message: "读取缓存历史完成",
      context: {
        purpose: "读取 PostgreSQL 缓存历史",
        op: "get_cached_match_history",
        puuid: query.puuid,
        mode_key: query.modeKey ?? null,
        queue_id: query.queueId ?? null,
        limit: query.limit,
        offset: query.offset ?? 0,
        count: value.length,
        duration_ms: Date.now() - startedAt,
      },
      durationMs: Date.now() - startedAt,
    }, JSON.stringify(games ?? []));
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "读取 PostgreSQL 历史缓存失败",
      context: {
        op: "get_cached_match_history",
        puuid: query.puuid,
        mode_key: query.modeKey ?? null,
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return [];
  }
};

/** 按"时间倒序 + 偏移"读取缓存中的某一页历史。 */
export const getCachedHistoryPage = async (
  puuid: string,
  offset: number,
  limit: number,
): Promise<NormalizedHistoryGame[]> => {
  if (limit <= 0) return [];
  const safeOffset = Math.max(0, offset);
  const games = await getCachedHistory({
    puuid,
    offset: safeOffset,
    limit,
  });
  return games;
};

export const cacheHistory = async (request: {
  puuid: string;
  summonerId?: number;
  summonerName?: string;
  modeKey: MatchModeKey;
  source: string;
  games: NormalizedHistoryGame[];
}): Promise<boolean> => {
  const startedAt = Date.now();
  const payload = {
    puuid: request.puuid,
    summonerId: request.summonerId,
    summonerName: request.summonerName,
    modeKey: request.modeKey,
    games: request.games.map((game) => ({
      gameId: game.gameId,
      gameCreation: game.gameCreation,
      queueId: game.queueId,
      modeKey: request.modeKey,
      source: request.source,
      participants: game.participants,
    })),
  };
  logger.info({
    tag: "db.cache",
    message: "写入缓存历史发起",
    context: {
      purpose: "将归一化后的历史写入 PostgreSQL 缓存",
      op: "cache_match_history",
      puuid: request.puuid,
      mode_key: request.modeKey,
      source: request.source,
      games_count: request.games.length,
    },
  }, JSON.stringify(payload));
  try {
    await invoke("cache_match_history", { request: payload });
    // 写入成功后清掉同 puuid 的 history / playerSummary 缓存，下次读取会
    // 重新走 invoke。summaryCache 是全局统计，不受影响。
    for (const key of Array.from(historyCache.keys())) {
      if (key.startsWith(`${request.puuid}|`)) {
        historyCache.delete(key);
      }
    }
    playerSummaryCache.delete(`${request.puuid}|${request.modeKey}`);
    logger.info({
      tag: "db.cache",
      message: "写入缓存历史完成",
      context: {
        purpose: "将归一化后的历史写入 PostgreSQL 缓存",
        op: "cache_match_history",
        puuid: request.puuid,
        mode_key: request.modeKey,
        source: request.source,
        games_count: request.games.length,
        duration_ms: Date.now() - startedAt,
      },
      durationMs: Date.now() - startedAt,
    });
    return true;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "写入 PostgreSQL 历史缓存失败",
      context: {
        op: "cache_match_history",
        puuid: request.puuid,
        mode_key: request.modeKey,
        games_count: request.games.length,
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return false;
  }
};

export const getDatabaseStatus = async () => {
  try {
    return await invoke<{
      available: boolean;
      message: string;
      checkedAt: number;
    }>("database_status");
  } catch (error) {
    return {
      available: false,
      message: String(error),
      checkedAt: 0,
    };
  }
};

export interface DatabaseModeSummary {
  modeKey: string;
  matches: number;
  participants: number;
  latestGameCreation?: number | null;
}

export interface DatabaseSummary {
  totalMatches: number;
  totalParticipants: number;
  totalPlayers: number;
  modes: DatabaseModeSummary[];
}

export interface DatabaseSourceSummary {
  source: string;
  matches: number;
}

export interface CachedPlayerSummary {
  puuid: string;
  modeKey?: MatchModeKey | null;
  matches: number;
  completeMatches: number;
  wins: number;
  latestGameCreation?: number | null;
  sources: DatabaseSourceSummary[];
}

/**
 * 单个召唤师在 PostgreSQL `summoners` 表中的完整行。
 * 所有字段都为可空，因为旧版本 LCU 可能不回填部分字段；
 * 写回 PG 后服务端会保持原值（LCU "Win"/"Fail" 字符串不归一化）。
 */
export interface CachedSummonerRow {
  puuid: string;
  summonerId: number;
  accountId?: number | null;
  displayName?: string | null;
  internalName?: string | null;
  gameName?: string | null;
  tagLine?: string | null;
  summonerName?: string | null;
  profileIconId?: number | null;
  summonerLevel?: number | null;
  xpSinceLastLevel?: number | null;
  xpUntilNextLevel?: number | null;
  percentCompleteForNextLevel?: number | null;
  privacy?: string | null;
  nameChangeFlag?: boolean | null;
  rerollPoints?: unknown;
  updatedAt: number;
}

export const getDatabaseSummary = async (): Promise<DatabaseSummary> => {
  if (isFresh(summaryCache.current ?? undefined, SUMMARY_TTL_MS)) {
    logger.debug({
      tag: "db.cache",
      message: "TTL 命中，跳过 invoke",
      context: { op: "database_summary" },
    });
    return summaryCache.current!.value;
  }
  const startedAt = Date.now();
  logger.info({
    tag: "db.cache",
    message: "读取全局汇总发起",
    context: {
      purpose: "读取 PostgreSQL 全局汇总",
      op: "database_summary",
    },
  });
  try {
    const value = await invoke<DatabaseSummary>("database_summary");
    summaryCache.current = { value, fetchedAt: Date.now() };
    logger.info({
      tag: "db.cache",
      message: "读取全局汇总完成",
      context: {
        purpose: "读取 PostgreSQL 全局汇总",
        op: "database_summary",
        total_matches: value.totalMatches,
        total_participants: value.totalParticipants,
        total_players: value.totalPlayers,
        modes_count: value.modes.length,
        duration_ms: Date.now() - startedAt,
      },
      durationMs: Date.now() - startedAt,
    }, JSON.stringify(value));
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "读取 PostgreSQL 缓存汇总失败",
      context: {
        op: "database_summary",
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return {
      totalMatches: 0,
      totalParticipants: 0,
      totalPlayers: 0,
      modes: [],
    };
  }
};

export const getCachedPlayerSummary = async (
  puuid: string,
  modeKey?: MatchModeKey,
): Promise<CachedPlayerSummary> => {
  const cacheKey = playerSummaryCacheKey(puuid, modeKey);
  const cached = playerSummaryCache.get(cacheKey);
  if (isFresh(cached, PLAYER_SUMMARY_TTL_MS)) {
    logger.debug({
      tag: "db.cache",
      message: "TTL 命中，跳过 invoke",
      context: {
        op: "get_cached_player_summary",
        puuid: puuid?.slice(-8) ?? "",
        mode_key: modeKey,
        age_ms: Date.now() - (cached?.fetchedAt ?? 0),
      },
    });
    return cached!.value;
  }
  const empty: CachedPlayerSummary = {
    puuid,
    modeKey: modeKey || null,
    matches: 0,
    completeMatches: 0,
    wins: 0,
    latestGameCreation: null,
    sources: [],
  };
  const startedAt = Date.now();
  logger.info({
    tag: "db.cache",
    message: "读取玩家汇总发起",
    context: {
      purpose: "读取玩家级 PostgreSQL 缓存汇总",
      op: "get_cached_player_summary",
      puuid,
      mode_key: modeKey ?? null,
    },
  });
  try {
    const value = await invoke<CachedPlayerSummary>("get_cached_player_summary", {
      request: { puuid, modeKey: modeKey || null },
    });
    playerSummaryCache.set(cacheKey, { value, fetchedAt: Date.now() });
    logger.info({
      tag: "db.cache",
      message: "读取玩家汇总完成",
      context: {
        purpose: "读取玩家级 PostgreSQL 缓存汇总",
        op: "get_cached_player_summary",
        puuid,
        mode_key: modeKey ?? null,
        matches: value.matches,
        complete_matches: value.completeMatches,
        wins: value.wins,
        latest_game_creation: value.latestGameCreation ?? null,
        sources_count: value.sources.length,
        duration_ms: Date.now() - startedAt,
      },
      durationMs: Date.now() - startedAt,
    }, JSON.stringify(value));
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "读取玩家汇总缓存失败",
      context: {
        op: "get_cached_player_summary",
        puuid,
        mode_key: modeKey ?? null,
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return empty;
  }
};

/**
 * 将刚通过 LCU 拿到的召唤师信息 fire-and-forget 写入 PostgreSQL。
 * 即使写入失败也不影响调用方 —— 查询路径走 TTL miss → LCU 已保证本次可用。
 */
export const cacheSummoner = async (
  info: lcuSummonerInfo,
): Promise<boolean> => {
  if (!info || typeof info.summonerId !== "number" || !info.puuid) {
    return false;
  }
  const startedAt = Date.now();
  try {
    await invoke<number>("cache_summoners", {
      request: { summoners: [info] },
    });
    // 写入成功后清掉本地 TTL 缓存，避免出现"刚刚写入 → 旧 TTL 命中 → 看不到新值"的延迟。
    dropSummonerCacheEntry({
      puuid: info.puuid,
      summonerId: info.summonerId,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    logger.info({
      tag: "db.cache",
      message: "写入召唤师缓存完成",
      context: {
        purpose: "将 LCU 召唤师信息写入 PostgreSQL 缓存",
        op: "cache_summoners",
        puuid: info.puuid,
        summoner_id: info.summonerId,
        duration_ms: Date.now() - startedAt,
      },
      durationMs: Date.now() - startedAt,
    });
    return true;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "写入召唤师缓存失败",
      context: {
        op: "cache_summoners",
        puuid: info.puuid,
        summoner_id: info.summonerId,
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return false;
  }
};

/**
 * 按 summoner_id 查 PG 中的召唤师行，命中后回填两层 TTL 缓存并返回。
 * 失败或未命中返回 null，调用方应继续走 LCU 路径。
 */
export const getCachedSummonerById = async (
  summonerId: number,
): Promise<CachedSummonerRow | null> => {
  if (!Number.isFinite(summonerId) || summonerId <= 0) {
    return null;
  }
  const cached = summonerByIdCache.get(summonerId);
  if (isFresh(cached, SUMMONER_TTL_MS)) {
    logger.debug({
      tag: "db.cache",
      message: "TTL 命中，跳过 invoke",
      context: { op: "get_cached_summoner_by_id", summoner_id: summonerId },
    });
    return cached!.value;
  }
  const startedAt = Date.now();
  try {
    const value = await invoke<CachedSummonerRow | null>(
      "get_cached_summoner_by_id",
      { summonerId },
    );
    if (value) {
      summonerByIdCache.set(summonerId, { value, fetchedAt: Date.now() });
      summonerByPuuidCache.set(value.puuid, { value, fetchedAt: Date.now() });
      logger.debug({
        tag: "db.cache",
        message: "PG 召唤师缓存命中",
        context: {
          op: "get_cached_summoner_by_id",
          summoner_id: summonerId,
          puuid: value.puuid,
          duration_ms: Date.now() - startedAt,
        },
      });
    }
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "读取召唤师缓存失败",
      context: {
        op: "get_cached_summoner_by_id",
        summoner_id: summonerId,
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return null;
  }
};

export const getCachedSummonerByPuuid = async (
  puuid: string,
): Promise<CachedSummonerRow | null> => {
  if (!puuid || puuid.trim() === "") {
    return null;
  }
  const cached = summonerByPuuidCache.get(puuid);
  if (isFresh(cached, SUMMONER_TTL_MS)) {
    logger.debug({
      tag: "db.cache",
      message: "TTL 命中，跳过 invoke",
      context: { op: "get_cached_summoner_by_puuid", puuid },
    });
    return cached!.value;
  }
  const startedAt = Date.now();
  try {
    const value = await invoke<CachedSummonerRow | null>(
      "get_cached_summoner_by_puuid",
      { puuid },
    );
    if (value) {
      summonerByPuuidCache.set(puuid, { value, fetchedAt: Date.now() });
      summonerByIdCache.set(value.summonerId, { value, fetchedAt: Date.now() });
      logger.debug({
        tag: "db.cache",
        message: "PG 召唤师缓存命中",
        context: {
          op: "get_cached_summoner_by_puuid",
          puuid,
          summoner_id: value.summonerId,
          duration_ms: Date.now() - startedAt,
        },
      });
    }
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "读取召唤师缓存失败",
      context: {
        op: "get_cached_summoner_by_puuid",
        puuid,
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return null;
  }
};

/**
 * 把 PG 行还原回 LCU `lcuSummonerInfo` 形状，便于复用现有 `querySummonerInfo`
 * 调用点或写入 `cacheSummoner()` 触发重新落库。
 */
export const summonerRowToLcuInfo = (
  row: CachedSummonerRow,
): lcuSummonerInfo => ({
  accountId: row.accountId ?? 0,
  displayName: row.displayName ?? "",
  gameName: row.gameName ?? "",
  internalName: row.internalName ?? "",
  nameChangeFlag: row.nameChangeFlag ?? false,
  percentCompleteForNextLevel: row.percentCompleteForNextLevel ?? 0,
  privacy: row.privacy ?? "",
  profileIconId: row.profileIconId ?? 0,
  puuid: row.puuid,
  rerollPoints:
    (row.rerollPoints as lcuSummonerInfo["rerollPoints"]) ?? {
      currentPoints: 0,
      maxRolls: 0,
      numberOfRolls: 0,
      pointsCostToRoll: 0,
      pointsToReroll: 0,
    },
  summonerId: row.summonerId,
  summonerLevel: row.summonerLevel ?? 0,
  unnamed: false,
  xpSinceLastLevel: row.xpSinceLastLevel ?? 0,
  xpUntilNextLevel: row.xpUntilNextLevel ?? 0,
  tagLine: row.tagLine ?? "",
});

/**
 * 单局对局详情在 PG `game_details` 表中的完整行。
 * raw_payload 始终是 LCU /games/{gameId} 的完整响应，
 * raw_payload_sgp 可选，仅当调用方传入 SGP 数据时存在。
 * 计划确认只存原始载荷，字段化提取（participants/teams）暂未启用。
 */
export interface CachedGameDetail {
  gameId: number;
  gameCreation?: number | null;
  gameDuration?: number | null;
  gameMode?: string | null;
  gameType?: string | null;
  gameVersion?: string | null;
  mapId?: number | null;
  platformId?: string | null;
  seasonId?: number | null;
  rawPayload: unknown;
  rawPayloadSgp?: unknown;
  source: string;
  fetchedAt: number;
}

const dropGameDetailCacheEntry = (gameId: number) => {
  gameDetailCache.delete(gameId);
};

/**
 * 将单局 LCU /games/{gameId} 响应 fire-and-forget 写入 PostgreSQL。
 * raw_payload_sgp 仅在传入时写入，独立事务，失败不影响 LCU 部分。
 * 当 source === 'sgp-summary-full' / 'sgp-summary' 时，将同一份载荷
 * 写入 raw_payload + raw_payload_sgp —— 既满足 NOT NULL，又保证读取
 * 路径走 SGP 分支。
 */
export const cacheGameDetail = async (
  detail: unknown,
  sgpDetail?: unknown,
  source?: string,
): Promise<boolean> => {
  if (!detail || typeof detail !== "object") {
    return false;
  }
  const gameId = (detail as { gameId?: unknown }).gameId;
  if (typeof gameId !== "number" || gameId <= 0) {
    return false;
  }
  const isSgpSource = source?.startsWith("sgp") ?? false;
  const sgpPayload = isSgpSource ? detail : sgpDetail;
  const startedAt = Date.now();
  try {
    await invoke<number>("cache_game_detail", {
      request: {
        detail,
        sgpDetail: sgpPayload ?? null,
        source: source ?? "lcu-game-detail",
      },
    });
    // 写完清除 TTL —— 下次读会重新走 invoke 拿到最新 payload。
    dropGameDetailCacheEntry(gameId);
    logger.info({
      tag: "db.cache",
      message: "写入对局详情缓存完成",
      context: {
        purpose: "将对局详情（LCU + 可选 SGP）写入 PostgreSQL 缓存",
        op: "cache_game_detail",
        game_id: gameId,
        has_sgp: sgpPayload !== undefined && sgpPayload !== null,
        source: source ?? "lcu-game-detail",
        duration_ms: Date.now() - startedAt,
      },
      durationMs: Date.now() - startedAt,
    });
    return true;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "写入对局详情缓存失败",
      context: {
        op: "cache_game_detail",
        game_id: gameId,
        has_sgp: sgpPayload !== undefined && sgpPayload !== null,
        source: source ?? "lcu-game-detail",
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return false;
  }
};

/**
 * 按 gameId 查 PG 中的对局详情；命中后回填 TTL 缓存并返回。
 * 失败或未命中返回 null，调用方应继续走 LCU/SGP 路径。
 */
export const getCachedGameDetail = async (
  gameId: number,
): Promise<CachedGameDetail | null> => {
  if (!Number.isFinite(gameId) || gameId <= 0) {
    return null;
  }
  const cached = gameDetailCache.get(gameId);
  if (isFresh(cached, GAME_DETAIL_TTL_MS)) {
    logger.debug({
      tag: "db.cache",
      message: "TTL 命中，跳过 invoke",
      context: { op: "get_cached_game_detail", game_id: gameId },
    });
    return cached!.value;
  }
  const startedAt = Date.now();
  try {
    const value = await invoke<CachedGameDetail | null>(
      "get_cached_game_detail",
      { gameId },
    );
    if (value) {
      gameDetailCache.set(gameId, { value, fetchedAt: Date.now() });
      logger.debug({
        tag: "db.cache",
        message: "PG 对局详情缓存命中",
        context: {
          op: "get_cached_game_detail",
          game_id: gameId,
          source: value.source,
          has_sgp: value.rawPayloadSgp !== undefined && value.rawPayloadSgp !== null,
          duration_ms: Date.now() - startedAt,
        },
      });
    }
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache",
      message: "读取对局详情缓存失败",
      context: {
        op: "get_cached_game_detail",
        game_id: gameId,
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return null;
  }
};
