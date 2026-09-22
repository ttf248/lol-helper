import type { NormalizedHistoryGame } from "@/recentMatch/utils/recentAnalytics";
import { mergeHistoryGames } from "@/recentMatch/utils/historyData";

export interface HistoryEvidenceSnapshot {
  games: Map<number, NormalizedHistoryGame>;
}

/** 所有来源共享同一份比赛证据；固定来源次序保证成员顺序不影响结果。 */
export const buildHistoryEvidence = (
  snapshots: ReadonlyMap<string, HistoryEvidenceSnapshot>,
): Map<number, NormalizedHistoryGame> => {
  const records = Array.from(snapshots.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, snapshot]) => Array.from(snapshot.games.values()));
  return new Map(mergeHistoryGames([], records, Math.max(1, records.length)).games
    .filter((game) => game.source !== "current-match")
    .map((game) => [game.gameId, game]));
};
