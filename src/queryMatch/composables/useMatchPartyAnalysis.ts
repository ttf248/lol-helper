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
import type { NormalizedHistoryGame } from "@/recentMatch/utils/recentAnalytics";
import { modeForQueue } from "@/recentMatch/utils/matchMode";
import { getCachedHistory, getCachedPlayerSummary } from "@/recentMatch/utils/databaseCache";
import {
  buildPartyGroupsStructure,
  applyPartyGroupOverlay,
  computePairCounts,
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
 * 快照身份缓存：把"每名玩家引用了哪些 gameId"作为身份 key，缓存
 * `loadMatchPartyAnalysis` 的中间结果（pairCounts + primary groups）。
 *
 * 关键收益：同一组玩家在 N 局不同 gameId 上的分析共享同一份 pairCounts
 * 计算结果（10 人 × 500 场 × N² 枚举中的 pair 阶段最耗）。如果玩家
 * 阵容不变，新 cacheHistory 写入了新一场对局也只是 pairCounts 增量更新，
 * 整个 party analysis 的 enumeration 阶段几乎不变。
 */
interface AnalysisSnapshot {
  /** 玩家按 puuid 排序后的所有 (puuid, gameId) 集合的有序签名。 */
  identity: string;
  pairCounts: Map<string, number>;
}
const analysisSnapshotCache = new Map<string, AnalysisSnapshot>();
const analysisResultCache = new Map<string, PartyGroupAnalysis[]>();

/**
 * 计算玩家阵容的快照身份：sorted（puuid, gameId）扁平化后 hash。
 * 同一组玩家同一份历史 → 同一身份 → 缓存命中。
 */
const computeSnapshotIdentity = (
  snapshots: Map<string, MatchPlayerHistorySnapshot>,
): string => {
  const parts: string[] = [];
  const sortedPuuids = Array.from(snapshots.keys()).sort();
  for (const puuid of sortedPuuids) {
    const gameIds = Array.from(snapshots.get(puuid)?.games.keys() ?? []).sort();
    parts.push(`${puuid}:${gameIds.join(",")}`);
  }
  return parts.join(";");
};

/**
 * 把 `snapshots` 里所有玩家的所有对局合并成一个 Map（按 gameId 去重）。
 * 用于计算 pairCounts 时把所有玩家共有的对局都纳入。
 */
const buildAllGamesForPairCounts = (
  snapshots: Map<string, MatchPlayerHistorySnapshot>,
): Map<number, NormalizedHistoryGame> => {
  const allGames = new Map<number, NormalizedHistoryGame>();
  for (const snapshot of snapshots.values()) {
    for (const [gameId, game] of snapshot.games.entries()) {
      if (!allGames.has(gameId)) allGames.set(gameId, game);
    }
  }
  return allGames;
};

/**
 * 清空缓存（用户强制同步 PG、账号切换、UI 显式刷新场景）。
 */
export const clearMatchPartyCache = (reason?: string): void => {
  matchPartyCache.clear();
  analysisSnapshotCache.clear();
  analysisResultCache.clear();
  logger.info({
    tag: "query.match.party",
    message: "首页开黑分析缓存清空（含快照身份缓存）",
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
    // 快照身份缓存：同一组玩家同一份历史 → 复用 pairCounts 与结果
    const snapshotIdentity = computeSnapshotIdentity(snapshots);
    let pairCounts = analysisSnapshotCache.get(snapshotIdentity)?.pairCounts;
    if (!pairCounts) {
      // 新对局进入缓存时，整份 pairCounts 第一次算（或重算），
      // 后续同阵容的多次分析直接复用。
      pairCounts = computePairCounts(
        summoners,
        buildAllGamesForPairCounts(snapshots),
      );
      analysisSnapshotCache.set(snapshotIdentity, {
        identity: snapshotIdentity,
        pairCounts,
      });
    }

    const structures = buildPartyGroupsStructure(summoners, snapshots, {
      precomputedPairCounts: pairCounts,
    });
    const now = Date.now();
    const groups = structures
      .map((structure) => applyPartyGroupOverlay(structure, new Map(), now))
      .sort((a, b) => b.stabilityScore - a.stabilityScore);

    // 最终结果按 (gameId, snapshotIdentity) 缓存。
    // 同 gameId 但不同阵容 → 重算（matchPartyCache 已覆盖）。
    // 不同 gameId 但同阵容 → 直接复用 analysisResultCache。
    let primary = analysisResultCache.get(snapshotIdentity);
    if (!primary) {
      primary = selectPrimaryPartyGroups(groups, PRIMARY_GROUP_LIMIT);
      analysisResultCache.set(snapshotIdentity, primary);
    }
    matchPartyCache.set(gameId, primary);

    logger.info({
      tag: "query.match.party",
      message: "首页开黑分析完成",
      context: {
        game_id: gameId,
        snapshot_identity: snapshotIdentity.slice(0, 32),
        players_with_cache: snapshots.size,
        total_groups: groups.length,
        primary_groups: primary.length,
        pair_counts_cached: pairCounts !== analysisSnapshotCache.get(snapshotIdentity)?.pairCounts,
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