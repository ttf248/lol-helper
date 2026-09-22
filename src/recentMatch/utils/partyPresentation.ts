import type { PartyGroupAnalysis } from "@/recentMatch/utils/queryTypes";

export type PartySortMode = "evidence" | "frequency" | "winRate";
const key = (group: PartyGroupAnalysis) => group.members.map((m) => m.puuid).sort().join("|");

/** 对局入口共用证据排序；历史排行保留用户主动选择的频率/胜率。 */
export const comparePartyGroups = (
  left: PartyGroupAnalysis, right: PartyGroupAnalysis, mode: PartySortMode = "evidence",
): number => {
  const recent = Number(right.relationKind === "recent") - Number(left.relationKind === "recent");
  if (recent) return recent;
  if (mode === "winRate" && left.winRate !== right.winRate) return right.winRate - left.winRate;
  if (mode === "frequency" && left.historicalGames !== right.historicalGames) {
    return (right.historicalGames ?? right.games) - (left.historicalGames ?? left.games);
  }
  return (right.recentWindowGames || 0) - (left.recentWindowGames || 0) ||
    right.stabilityScore - left.stabilityScore || right.confidence.score - left.confidence.score ||
    right.members.length - left.members.length || right.games - left.games || key(left).localeCompare(key(right));
};

/** 只折叠成员为真子集且证据完全相同的组合；有独立对局证据的子组保留。 */
export const selectPartyGroups = (
  groups: PartyGroupAnalysis[],
  options: { limit?: number; showSubgroups?: boolean; mode?: PartySortMode } = {},
): PartyGroupAnalysis[] => {
  const unique = new Map<string, PartyGroupAnalysis>();
  for (const group of groups) {
    const previous = unique.get(key(group));
    if (!previous || comparePartyGroups(group, previous) < 0) unique.set(key(group), group);
  }
  const all = Array.from(unique.values());
  const evidenceKeys = new Map(all.map(g => [g, new Set(g.evidence.map(e => `${e.gameId}:${Boolean(e.isCurrentMatch)}`))]));
  const visible = options.showSubgroups ? all : all.filter(group => !all.some(parent => {
    if (parent.relationKind !== group.relationKind || parent.members.length <= group.members.length) return false;
    if (!group.members.every(m => parent.members.some(p => p.puuid === m.puuid))) return false;
    const own = evidenceKeys.get(group)!, other = evidenceKeys.get(parent)!;
    return own.size > 0 && own.size === other.size && Array.from(own).every(id => other.has(id));
  }));
  return visible.sort((a, b) => comparePartyGroups(a, b, options.mode)).slice(0, options.limit ?? Infinity);
};
