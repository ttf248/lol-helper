import type { NormalizedHistoryGame } from "@/recentMatch/utils/recentAnalytics";
import type { PartyEvidence, RecentSumInfo } from "@/recentMatch/utils/queryTypes";
import { findPlayerParticipant, isStrongPuuid } from "@/recentMatch/utils/participantLookup";
import { historyGameQuality } from "@/recentMatch/utils/historyData";

const DAY_MS = 86_400_000;

/** 封顶证据场数随组合规模缩放：size=2 需 ≥4，size=5 需 ≥10。 */
const weightedGamesCap = (groupSize: number): number => Math.max(4, groupSize * 2);
/** 最小成员频次封顶：size=2 需 ≥3，size=5 需 ≥7.5。 */
const memberFrequencyCap = (groupSize: number): number => Math.max(3, groupSize * 1.5);

/**
 * 可解释的证据强度，不代表经过校准的组队概率；胜负和举报均不参与。
 *
 * 三层稳定性设计，避免"4 黑 + 1 路人"或单场路人把整组分数错扣：
 *
 * 1. **consecutive**：保留为"窗口内最长连续前缀"，反映真正的连续活动。
 * 2. **windowRatio**：窗口内 evidence 占总观察数的比例。路人场不再是 0 分。
 * 3. **weightedGames** 与 **consecutive** 都按 groupSize 缩放，size=2 不会无意义地压过 size=5。
 * 4. **minMemberFrequency**：组合内每位成员作为同队成员出现的最少场次；
 *    路人只同队 1-2 场时，size=5 组合该项封顶 ~13%，size=4 子组合会自然胜出。
 */
export const scorePartyEvidence = (
  members: RecentSumInfo[],
  evidence: PartyEvidence[],
  observedGames: NormalizedHistoryGame[],
  now: number,
  /** 该组合每位成员作为同队成员出现的最少场次。调用方传 undefined 时回退到 historical.length。 */
  minMemberFrequency?: number,
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
  // 窗口内 evidence 占比与最长连续前缀并存：单场路人不再把分数归零。
  let longestConsecutivePrefix = 0;
  let evidenceInWindow = 0;
  for (const game of observed) {
    if (ids.has(game.gameId)) {
      longestConsecutivePrefix += 1;
      evidenceInWindow += 1;
    } else if (longestConsecutivePrefix > 0) {
      // 只在已经进入连续段后，遇到第一场路人就停止连续计数；
      // ratioInWindow 继续累加，以反映"4 黑 + 1 路人"仍属于稳定组队。
      break;
    }
  }
  const windowRatio = observed.length ? evidenceInWindow / observed.length : 0;
  const consecutive = longestConsecutivePrefix;
  const completeCoverage = observed.length
    ? observed.filter((game) => historyGameQuality(game) === "complete").length / observed.length : 0;
  const shared = observed.filter((game) => ids.has(game.gameId));
  const identityCoverage = shared.length ? shared.reduce((sum, game) => sum +
    members.filter((member) => isStrongPuuid(findPlayerParticipant(game, member)?.puuid)).length,
  0) / (shared.length * members.length) : 0;
  const groupSize = Math.max(2, members.length);
  const weightedGamesCapValue = weightedGamesCap(groupSize);
  const memberFrequencyCapValue = memberFrequencyCap(groupSize);
  const effectiveMinFrequency = minMemberFrequency ?? historical.length;
  return {
    latestGameAt,
    recentGames,
    stabilityScore: Math.round(
      40 * Math.min(weightedGames / weightedGamesCapValue, 1) +
      20 * ratio * decay +
      20 * Math.min(
        0.5 * Math.min(consecutive / 5, 1) + 0.5 * windowRatio,
        1,
      ) * decay +
      20 * Math.min(effectiveMinFrequency / memberFrequencyCapValue, 1) * decay,
    ),
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