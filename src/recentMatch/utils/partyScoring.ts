import type { NormalizedHistoryGame } from "@/recentMatch/utils/recentAnalytics";
import type { PartyEvidence, RecentSumInfo } from "@/recentMatch/utils/queryTypes";
import { findPlayerParticipant, isStrongPuuid } from "@/recentMatch/utils/participantLookup";
import { historyGameQuality } from "@/recentMatch/utils/historyData";

const DAY_MS = 86_400_000;

/** 可解释的证据强度，不代表经过校准的组队概率；胜负和举报均不参与。 */
export const scorePartyEvidence = (
  members: RecentSumInfo[],
  evidence: PartyEvidence[],
  observedGames: NormalizedHistoryGame[],
  now: number,
) => {
  const historical = evidence.filter((item) => !item.isCurrentMatch);
  const ids = new Set(historical.map((item) => item.gameId));
  const observed = observedGames.filter((game) => game.source !== "current-match" &&
    members.some((member) => findPlayerParticipant(game, member)))
    .sort((a, b) => b.gameCreation - a.gameCreation || b.gameId - a.gameId);
  const latestGameAt = Math.max(0, ...historical.map((item) => item.gameCreation));
  const age = latestGameAt ? Math.max(0, (now - latestGameAt) / DAY_MS) : Infinity;
  const decay = 2 ** (-age / 30);
  const weightedGames = historical.reduce((sum, item) =>
    sum + 2 ** (-Math.max(0, (now - item.gameCreation) / DAY_MS) / 30), 0);
  const recentGames = historical.filter((item) => item.gameCreation >= now - 30 * DAY_MS).length;
  const recentObserved = observed.filter((game) => game.gameCreation >= now - 30 * DAY_MS);
  const ratio = recentObserved.length ? Math.min(1, recentGames / recentObserved.length) : 0;
  let consecutive = 0;
  for (const game of observed) {
    if (!ids.has(game.gameId)) break;
    consecutive++;
  }
  const completeCoverage = observed.length
    ? observed.filter((game) => historyGameQuality(game) === "complete").length / observed.length : 0;
  const shared = observed.filter((game) => ids.has(game.gameId));
  const identityCoverage = shared.length ? shared.reduce((sum, game) => sum +
    members.filter((member) => isStrongPuuid(findPlayerParticipant(game, member)?.puuid)).length,
  0) / (shared.length * members.length) : 0;
  return {
    latestGameAt,
    recentGames,
    stabilityScore: Math.round(50 * Math.min(weightedGames / 10, 1) +
      30 * ratio * decay + 20 * Math.min(consecutive / 5, 1) * decay),
    confidenceScore: Math.round(60 * Math.min(historical.length / 10, 1) +
      20 * completeCoverage + 20 * identityCoverage),
    completeCoverage: Math.round(completeCoverage * 100),
    identityCoverage: Math.round(identityCoverage * 100),
  };
};

/** Wilson 95% 下界避免少数连胜被渲染成高胜率警报。 */
export const hasHighWinRateEvidence = (wins: number, games: number): boolean => {
  if (games < 10 || wins / games < 0.65) return false;
  const z = 1.96, p = wins / games;
  const lower = (p + z * z / (2 * games) -
    z * Math.sqrt(p * (1 - p) / games + z * z / (4 * games * games))) / (1 + z * z / games);
  return lower > 0.5;
};
