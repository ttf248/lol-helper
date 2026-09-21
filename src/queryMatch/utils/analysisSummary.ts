import { champDict } from "@/resources/champList";
import {
  RecentDataAnalysisTypes,
  RoleCountMapTypes,
} from "./analysisTypes";
import { SimpleMatchTypes } from "@/lcu/types/queryMatchLcuTypes";

export const findTopChamp = (
  matches: SimpleMatchTypes[] | undefined | null,
): RecentDataAnalysisTypes | null => {
  if (!matches || matches.length === 0) return null;

  const roleCountMap: RoleCountMapTypes = {
    assassin: 0,
    fighter: 0,
    mage: 0,
    marksman: 0,
    support: 0,
    tank: 0,
  };
  const championCounts = new Map<number, number>();

  for (const match of matches) {
    championCounts.set(
      match.champId,
      (championCounts.get(match.champId) || 0) + 1,
    );
    const role = champDict[match.champId]?.roles?.[0] as
      | keyof RoleCountMapTypes
      | undefined;
    if (role && role in roleCountMap) roleCountMap[role] += 1;
  }

  const top3Champions = Array.from(championCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([champId, count]) => ({ champId, count }));

  return {
    top3Champions,
    totalChampions: matches.length,
    roleCountMap,
    oneGameId: matches[0].gameId,
  };
};
