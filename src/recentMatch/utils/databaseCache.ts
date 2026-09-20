import { invoke } from "@tauri-apps/api/core";
import type { NormalizedHistoryGame } from "./recentAnalytics";
import { MatchModeKey } from "./matchMode";
import { logger } from "@/utils/logger";

// 客户端 TTL 缓存：避免切模式 tab / 翻页 / 切换玩家时反复打 LCU → Rust → PG
// 这条链路。日志里 db.summary / db.player_summary / db.cached_history 在单次
// 会话中常出现 8+ 次重复调用，返回完全相同的数据。把同一查询合并到 TTL 内
// 即可消除冗余，同时不破坏 cacheHistory 的写入语义。
const SUMMARY_TTL_MS = 30_000;
const PLAYER_SUMMARY_TTL_MS = 15_000;
const HISTORY_TTL_MS = 10_000;

interface CachedEntry<T> {
  value: T;
  fetchedAt: number;
}

const summaryCache: { current: CachedEntry<DatabaseSummary> | null } = {
  current: null,
};
const playerSummaryCache = new Map<string, CachedEntry<CachedPlayerSummary>>();
const historyCache = new Map<string, CachedEntry<NormalizedHistoryGame[]>>();

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
export const resetDatabaseCache = () => {
  summaryCache.current = null;
  playerSummaryCache.clear();
  historyCache.clear();
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
    return cached!.value;
  }
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
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache_read",
      message: "Failed to read PostgreSQL match cache",
      context: {
        op: "get_cached_match_history",
        error: String(error).slice(0, 200),
      },
    });
    return [];
  }
};

export const cacheHistory = async (request: {
  puuid: string;
  summonerId?: number;
  summonerName?: string;
  modeKey: MatchModeKey;
  source: string;
  games: NormalizedHistoryGame[];
}): Promise<boolean> => {
  try {
    await invoke("cache_match_history", {
      request: {
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
      },
    });
    // 写入成功后清掉同 puuid 的 history / playerSummary 缓存，下次读取会
    // 重新走 invoke。summaryCache 是全局统计，不受影响。
    for (const key of Array.from(historyCache.keys())) {
      if (key.startsWith(`${request.puuid}|`)) {
        historyCache.delete(key);
      }
    }
    playerSummaryCache.delete(`${request.puuid}|${request.modeKey}`);
    return true;
  } catch (error) {
    logger.warn({
      tag: "db.cache_write",
      message: "Failed to write PostgreSQL match cache",
      context: {
        op: "cache_match_history",
        error: String(error).slice(0, 200),
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

export const getDatabaseSummary = async (): Promise<DatabaseSummary> => {
  if (isFresh(summaryCache.current ?? undefined, SUMMARY_TTL_MS)) {
    return summaryCache.current!.value;
  }
  try {
    const value = await invoke<DatabaseSummary>("database_summary");
    summaryCache.current = { value, fetchedAt: Date.now() };
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache_summary",
      message: "Failed to read PostgreSQL cache summary",
      context: {
        op: "database_summary",
        error: String(error).slice(0, 200),
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
  try {
    const value = await invoke<CachedPlayerSummary>("get_cached_player_summary", {
      request: { puuid, modeKey: modeKey || null },
    });
    playerSummaryCache.set(cacheKey, { value, fetchedAt: Date.now() });
    return value;
  } catch (error) {
    logger.warn({
      tag: "db.cache_summary",
      message: "Failed to read cached player summary",
      context: {
        op: "get_cached_player_summary",
        puuid: puuid?.slice(-8) ?? "",
        error: String(error).slice(0, 200),
      },
    });
    return empty;
  }
};
