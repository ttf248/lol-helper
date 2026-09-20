/**
 * 「疑似开黑」展示层共享工具。
 *
 * 之前 recentMatchList.vue 与 historyAnalyticsPanel.vue 各有一份重复
 * 实现的 formatRate / confidenceLabel / partyGroupNames。这里把显示用的
 * 纯函数抽出来，组件层只负责排版。
 */

import type {
  ConfidenceInfo,
  ConfidenceLevel,
  PartyGroupAnalysis,
} from "@/recentMatch/utils/queryTypes";

/**
 * 把胜率（0..100，含 1 位小数）格式化为字符串。
 * null / undefined 返回 "--"，避免后续模板分支。
 */
export const formatRate = (rate: number | null | undefined): string =>
  rate === null || rate === undefined ? "--" : `${rate.toFixed(1)}%`;

/**
 * 置信度等级简写。允许传入完整 ConfidenceInfo 或仅 level，二者会
 * 格式化为不同形式以保留现有调用点习惯。
 *
 *  - 传 ConfidenceInfo：`高 · 75`（带分数，团队面板用）
 *  - 传 level：`高`（home 历史分析用）
 */
export function confidenceLabel(confidence: ConfidenceInfo): string;
export function confidenceLabel(level: ConfidenceLevel | string): string;
export function confidenceLabel(
  input: ConfidenceInfo | ConfidenceLevel | string,
): string {
  const levelLabels: Record<string, string> = {
    high: "高",
    medium: "中",
    low: "低",
  };
  if (typeof input === "string") {
    return levelLabels[input] || input;
  }
  const level = (input as ConfidenceInfo).level;
  const score = (input as ConfidenceInfo).score;
  return `${levelLabels[level] || level} · ${score}`;
}

/**
 * 把组合成员名拼成 "A + B + C" 形式。home 页传 selfPuuid 时把自
 * 己替换为「我」，对局内面板不传时保持原样。
 */
export const partyGroupNames = (
  group: PartyGroupAnalysis,
  selfPuuid?: string,
): string =>
  group.members
    .map((member) =>
      selfPuuid !== undefined && member.puuid === selfPuuid
        ? "我"
        : member.summonerName?.trim() || "未知玩家",
    )
    .join(" + ");

/**
 * 距离最近一次共同同队的天数描述。「今天」用于当 lastActiveDays 为 0。
 */
export const lastActiveLabel = (group: PartyGroupAnalysis): string => {
  if (group.lastActiveDays === null) return "未知";
  if (group.lastActiveDays === 0) return "今天";
  return `${group.lastActiveDays}天前`;
};

/**
 * 时间戳（秒或毫秒）格式化为 "MM-DD HH:mm"。
 * Riot SGP 接口有时返回秒级有时返回毫秒级，这里容忍两种。
 */
export const partyEvidenceTime = (timestamp: number): string => {
  const normalized = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * 共同对局 + 人数门槛的简短描述，用于弹窗摘要。
 */
export const partyEvidenceSummary = (group: PartyGroupAnalysis): string =>
  `共同同队 ${group.games} 场 / ${group.members.length} 人组合门槛 ${group.requiredGames} 场`;

/**
 * 组合胜率对应的 Naive UI tag type。
 *   ≥65% → success（绿）
 *   ≥50% → success（绿）
 *   其余 → warning（橙）
 *
 * 与现有 `n-tag type="success|warning"` 的判定保持一致。
 */
export const winRateTagType = (winRate: number): "success" | "warning" =>
  winRate >= 50 ? "success" : "warning";
