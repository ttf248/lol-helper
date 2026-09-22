import type {
  HistoryCoverageInfo,
} from "@/recentMatch/utils/queryTypes";
import type { NormalizedHistoryGame } from "@/recentMatch/utils/recentAnalytics";
import { logger } from "@/utils/logger";
import { isStrongPuuid } from "@/recentMatch/utils/participantLookup";
import { modeForQueue } from "@/recentMatch/utils/matchMode";

export type HistoryGameQuality = "complete" | "partial";

const participantRosterIsComplete = (game: NormalizedHistoryGame): boolean => {
  // 本项目明确支持的模式均为 5v5；未知队列不猜测阵容规模。
  if (modeForQueue(game.queueId) === "other" || game.participants.length !== 10) return false;
  if (new Set(game.participants.map((p) => p.puuid)).size !== 10) return false;
  if (game.participants.some((p) => !p.puuid || ![100, 200].includes(p.teamId))) return false;
  return game.participants.filter((p) => p.teamId === 100).length === 5;
};

export const historyGameQuality = (
  game: NormalizedHistoryGame,
): HistoryGameQuality =>
  participantRosterIsComplete(game) ? "complete" : "partial";

const qualityScore = (game: NormalizedHistoryGame): number[] => {
  const valid = game.participants.filter((p) => p.puuid && p.teamId > 0);
  return [
    Number(participantRosterIsComplete(game)),
    new Set(valid.map((p) => p.puuid)).size,
    valid.filter((p) => isStrongPuuid(p.puuid)).length,
    valid.filter((p) => p.championId > 0 && p.summonerName).length,
  ];
};

/** 按完整性、身份覆盖、字段质量逐层比较，人数不能越过完整性等级。 */
export const compareHistoryGameQuality = (left: NormalizedHistoryGame, right: NormalizedHistoryGame): number => {
  const a = qualityScore(left), b = qualityScore(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

const sortHistoryGames = (games: NormalizedHistoryGame[]) =>
  games.sort(
    (left, right) =>
      Number(right.gameCreation || 0) - Number(left.gameCreation || 0) ||
      Number(right.gameId || 0) - Number(left.gameId || 0),
  );

/**
 * 合并本地缓存与接口历史。
 *
 * 同一个 gameId 的记录如果完整度不同，永远保留完整参与者版本；完整度相同
 * 时接口版本优先，以便修正缓存中的旧 KDA/队伍字段。最终排序固定使用
 * gameCreation、gameId，避免不同请求返回顺序影响胜率窗口。
 */
export const mergeHistoryGames = (
  cachedGames: NormalizedHistoryGame[],
  interfaceGames: NormalizedHistoryGame[],
  limit = 100,
  loggerContext?: { puuid?: string; modeKey?: string },
): { games: NormalizedHistoryGame[]; coverage: HistoryCoverageInfo } => {
  const merged = new Map<number, NormalizedHistoryGame>();
  let conflicts = 0;

  for (const game of cachedGames) {
    if (!Number.isFinite(game.gameId)) continue;
    const previous = merged.get(game.gameId);
    if (!previous || compareHistoryGameQuality(game, previous) >= 0) merged.set(game.gameId, game);
  }

  for (const game of interfaceGames) {
    if (!Number.isFinite(game.gameId)) continue;
    const previous = merged.get(game.gameId);
    if (!previous) {
      merged.set(game.gameId, game);
      continue;
    }

    conflicts += 1;
    const interfaceIsBetter = compareHistoryGameQuality(game, previous) >= 0;
    if (interfaceIsBetter) {
      merged.set(game.gameId, game);
    }
  }

  if (conflicts > 0) {
    logger.debug({
      tag: "recent.merge",
      message: "mergeHistoryGames 出现 gameId 冲突",
      context: {
        conflicts,
        cached_games: cachedGames.length,
        interface_games: interfaceGames.length,
        ...(loggerContext?.puuid !== undefined
          ? { puuid: `…${loggerContext.puuid.slice(-8)}` }
          : {}),
        ...(loggerContext?.modeKey !== undefined
          ? { mode_key: loggerContext.modeKey }
          : {}),
      },
    });
  }

  const sorted = sortHistoryGames(Array.from(merged.values()));
  const games = sorted.slice(0, Math.max(1, limit));
  const completeGames = games.filter(
    (game) => historyGameQuality(game) === "complete",
  ).length;
  const sourceSet = new Set(
    games.map((game) => game.source).filter((source): source is string => Boolean(source)),
  );

  return {
    games,
    coverage: {
      cachedGames: cachedGames.length,
      interfaceGames: interfaceGames.length,
      mergedGames: games.length,
      completeGames,
      partialGames: games.length - completeGames,
      conflicts,
      sources: Array.from(sourceSet),
      latestGameCreation: games[0]?.gameCreation || null,
    },
  };
};

export const mergeHistoryGameLists = (
  cachedGames: NormalizedHistoryGame[],
  interfaceGames: NormalizedHistoryGame[],
  limit = 100,
) => mergeHistoryGames(cachedGames, interfaceGames, limit).games;
