/**
 * 首页战绩查询页面的开黑分析 composable。
 *
 * 给定 `matchContent` 已加载的 10 人阵容（teamOne + teamTwo），从
 * PostgreSQL 本地缓存读取每名玩家的历史，复用对局内面板的
 * `buildPartyGroupsStructure` + `applyPartyGroupOverlay` 算法，
 * 返回 `PartyGroupAnalysis[]`，供 `matchDetails` 在玩家行内打 chip。
 *
 * 数据流与对局内面板对齐：仅依赖本地缓存，不触发 LCU/SGP 服务器接口；
 * 未命中的玩家自动从 chip 集合中排除。
 */
import type { PartyGroupAnalysis, RecentSumInfo } from "@/recentMatch/utils/queryTypes";
import { modeForQueue } from "@/recentMatch/utils/matchMode";
import { getCachedHistory, getCachedPlayerSummary } from "@/recentMatch/utils/databaseCache";
import {
  buildPartyGroupsStructure,
  applyPartyGroupOverlay,
} from "@/recentMatch/utils/recentAnalytics";
import { selectPrimaryPartyGroups } from "@/recentMatch/utils/partyPresentation";
import { logger } from "@/utils/logger";
import type { SummonerDetailInfo } from "@/queryMatch/utils/MatchDetail";

/** 每个 player_history_snapshot 上 PG 缓存最多读取的对局数。 */
const CACHED_HISTORY_LIMIT = 500;
/** selectPrimaryPartyGroups 的最终 chip 上限（与 recentMatchList 一致）。 */
const PRIMARY_GROUP_LIMIT = 2;
/** 一组玩家可过滤掉的"无任何缓存"成员后再做枚举的下限。 */
const MIN_PLAYERS_FOR_PARTY = 2;

const toRecentSumInfo = (summoner: SummonerDetailInfo): RecentSumInfo | null => {
  if (!summoner.puuid || !summoner.name) return null;
  return {
    puuid: summoner.puuid,
    summonerId: summoner.accountId || 0,
    summonerName: summoner.name,
    championUrl: summoner.champImgUrl,
    champId: 0,
    teamParticipantId: summoner.teamType || 0,
    matchList: [],
  };
};

interface MatchPlayerHistorySnapshot {
  puuid: string;
  games: Map<number, Awaited<ReturnType<typeof getCachedHistory>>[number]>;
  complete: boolean;
  recentHistoryVerified: boolean;
  source: string;
  sourceEndpoints: string[];
}

const buildSnapshot = (
  games: Awaited<ReturnType<typeof getCachedHistory>>,
): MatchPlayerHistorySnapshot => ({
  puuid: "",
  games: new Map(games.map((game) => [game.gameId, game])),
  complete: games.length >= CACHED_HISTORY_LIMIT,
  recentHistoryVerified: false,
  source: games.length > 0 ? "PostgreSQL 本地缓存" : "unavailable",
  sourceEndpoints: [],
});

/**
 * 模块级缓存：同 gameId 复用上次结果，切换最近 N 场列表时无需重复读 PG。
 * 实际对局信息变了（按 gameId 切对局）就重新计算。
 */
const matchPartyCache = new Map<number, PartyGroupAnalysis[]>();

/**
 * 清空缓存（用户强制同步 PG、账号切换、UI 显式刷新场景）。
 */
export const clearMatchPartyCache = (reason?: string): void => {
  matchPartyCache.clear();
  logger.info({
    tag: "query.match.party",
    message: "首页开黑分析缓存清空",
    context: { reason: reason ?? "unspecified" },
  });
};

/**
 * 读取对局内 10 人阵容所涉及的开黑组合。
 *
 * 注意：本函数**不**触发服务器端 LCU/SGP 历史查询；PG 缓存为空时返回空数组，
 * UI 应保持现状（无 chip）而不是阻塞首屏。
 */
export const loadMatchPartyAnalysis = async (
  teamOne: SummonerDetailInfo[],
  teamTwo: SummonerDetailInfo[],
  queueId: number,
  gameId: number,
): Promise<PartyGroupAnalysis[]> => {
  if (!Number.isFinite(gameId) || gameId <= 0) return [];
  const cached = matchPartyCache.get(gameId);
  if (cached) return cached;

  const modeKey = modeForQueue(queueId);
  const summoners = [...teamOne, ...teamTwo]
    .map(toRecentSumInfo)
    .filter((player): player is RecentSumInfo => player !== null);
  if (summoners.length < MIN_PLAYERS_FOR_PARTY) {
    matchPartyCache.set(gameId, []);
    return [];
  }

  const startedAt = Date.now();
  const snapshots = new Map<string, MatchPlayerHistorySnapshot>();
  // 并行拉取每名玩家的本地缓存，避免串行等待；缓存未命中（matches=0）
  // 的玩家直接不参与 party 枚举，不报错。
  await Promise.all(
    summoners.map(async (player) => {
      try {
        const summary = await getCachedPlayerSummary(player.puuid, modeKey);
        if (summary.matches === 0) return;
        const games = await getCachedHistory({
          puuid: player.puuid,
          modeKey,
          limit: CACHED_HISTORY_LIMIT,
        });
        if (games.length === 0) return;
        const snapshot = buildSnapshot(games);
        snapshots.set(player.puuid, snapshot);
      } catch (error) {
        logger.warn({
          tag: "query.match.party",
          message: "读取玩家本地缓存失败",
          context: { puuid: player.puuid, error: String(error).slice(0, 200) },
        });
      }
    }),
  );

  if (snapshots.size < MIN_PLAYERS_FOR_PARTY) {
    matchPartyCache.set(gameId, []);
    logger.info({
      tag: "query.match.party",
      message: "本地缓存不足，跳过开黑分析",
      context: { game_id: gameId, players_with_cache: snapshots.size },
    });
    return [];
  }

  try {
    const structures = buildPartyGroupsStructure(summoners, snapshots);
    const now = Date.now();
    const groups = structures
      .map((structure) => applyPartyGroupOverlay(structure, new Map(), now))
      .sort((a, b) => b.stabilityScore - a.stabilityScore);
    const primary = selectPrimaryPartyGroups(groups, PRIMARY_GROUP_LIMIT);
    matchPartyCache.set(gameId, primary);
    logger.info({
      tag: "query.match.party",
      message: "首页开黑分析完成",
      context: {
        game_id: gameId,
        players_with_cache: snapshots.size,
        total_groups: groups.length,
        primary_groups: primary.length,
        duration_ms: Date.now() - startedAt,
      },
    });
    return primary;
  } catch (error) {
    logger.warn({
      tag: "query.match.party",
      message: "首页开黑分析失败",
      context: { game_id: gameId, error: String(error).slice(0, 200) },
    });
    matchPartyCache.set(gameId, []);
    return [];
  }
};