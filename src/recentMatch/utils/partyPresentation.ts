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
  // 关键修复 —— 把 members.length 提到 stabilityScore 之前：
  // stabilityScore 的 cap 随 size 缩放（size=2 cap=4，size=4 cap=8），
  // 这会让 size=2 AB 的加权项总是先封顶在 40，从而把 size=4 ABCD 挤掉，
  // 把"4-黑打了 11 场 + 5 局 AB-2黑"误判成两个 2-黑。
  // 用户视角下本局的开黑小组是 ABCD，size 排序必须优先。
  return (right.recentWindowGames || 0) - (left.recentWindowGames || 0) ||
    right.members.length - left.members.length ||
    right.stabilityScore - left.stabilityScore || right.confidence.score - left.confidence.score ||
    right.games - left.games || key(left).localeCompare(key(right));
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

/**
 * 对局总览只显示互不重叠的主小组：先去掉相同证据的子组，再按近期性和
 * 证据强度选择。成员已进入一个主小组后不再被另一张卡重复占用。
 */
export const selectPrimaryPartyGroups = (
  groups: PartyGroupAnalysis[],
  limit = 2,
): PartyGroupAnalysis[] => {
  const selected: PartyGroupAnalysis[] = [];
  const occupied = new Set<string>();
  for (const group of selectPartyGroups(groups)) {
    if (group.members.some((member) => occupied.has(member.puuid))) continue;
    selected.push(group);
    group.members.forEach((member) => occupied.add(member.puuid));
    if (selected.length >= limit) break;
  }
  return selected;
};
