import type { NormalizedHistoryGame } from "@/recentMatch/utils/recentAnalytics";
import { compareHistoryGameQuality } from "@/recentMatch/utils/historyData";

export interface HistoryEvidenceSnapshot {
  games: Map<number, NormalizedHistoryGame>;
}

type Snapshots = ReadonlyMap<string, HistoryEvidenceSnapshot>;
type Entry = { versions: NormalizedHistoryGame[]; game: NormalizedHistoryGame };
type EvidenceCache = { entries: Map<number, Entry>; games: Map<number, NormalizedHistoryGame>; updatedGames: number };
let cache = new WeakMap<Snapshots, EvidenceCache>();

export const clearHistoryEvidenceCache = () => { cache = new WeakMap(); };

/**
 * 快照及 game 对象发布后不可变，刷新必须创建新 Map/对象。
 * 可传上一阶段快照，只有来源版本发生变化的 gameId 才重新比较质量。
 */
export const buildHistoryEvidence = (
  snapshots: Snapshots,
  previousSnapshots?: Snapshots,
): Map<number, NormalizedHistoryGame> => {
  const hit = cache.get(snapshots);
  if (hit) return hit.games;
  const previous = previousSnapshots ? cache.get(previousSnapshots) : undefined;
  const versions = new Map<number, NormalizedHistoryGame[]>();
  for (const [, snapshot] of Array.from(snapshots).sort(([a], [b]) => a.localeCompare(b))) {
    for (const game of snapshot.games.values()) {
      if (game.source === "current-match" || !Number.isFinite(game.gameId)) continue;
      const list = versions.get(game.gameId) || [];
      list.push(game);
      versions.set(game.gameId, list);
    }
  }
  const entries = new Map<number, Entry>();
  let updatedGames = 0;
  for (const [id, list] of versions) {
    const old = previous?.entries.get(id);
    if (old && old.versions.length === list.length && old.versions.every((game, i) => game === list[i])) {
      entries.set(id, old);
    } else {
      updatedGames++;
      entries.set(id, { versions: list, game: list.reduce((best, game) =>
        compareHistoryGameQuality(game, best) >= 0 ? game : best) });
    }
  }
  const games = new Map(Array.from(entries, ([id, entry]) => [id, entry.game] as const)
    .sort(([, a], [, b]) => b.gameCreation - a.gameCreation || b.gameId - a.gameId));
  cache.set(snapshots, { entries, games, updatedGames });
  return games;
};

export const historyEvidenceStats = (snapshots: Snapshots) => ({
  games: cache.get(snapshots)?.games.size || 0,
  updatedGames: cache.get(snapshots)?.updatedGames || 0,
});
