import { modeForQueue, type MatchModeKey } from "@/recentMatch/utils/matchMode";
import type { RecentSumInfo } from "@/recentMatch/utils/queryTypes";

/** Pick the history mode matching the player's newest supported match. */
export const inferHistoryMode = (
  player: Pick<RecentSumInfo, "matchList">,
): MatchModeKey => {
  for (const match of player.matchList || []) {
    const queueId = Number(match.queueId);
    if (!Number.isFinite(queueId)) continue;

    const mode = modeForQueue(queueId);
    if (mode !== "other") return mode;
  }

  return "match";
};
