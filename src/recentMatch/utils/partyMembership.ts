import type { NormalizedHistoryGame } from "@/recentMatch/utils/recentAnalytics";
import type { RecentSumInfo } from "@/recentMatch/utils/queryTypes";
import { findPlayerParticipant } from "@/recentMatch/utils/participantLookup";

let cache = new WeakMap<NormalizedHistoryGame, Map<string, string[]>>();
let evaluatedGames = 0;
export const partyMembershipStats = () => ({ evaluatedGames });
export const clearPartyMembershipCache = () => { cache = new WeakMap(); evaluatedGames = 0; };

/** 每个不可变比赛版本只匹配一次阵容，补齐时仅重新计算变化的比赛。 */
export const buildPartyMembership = (
  players: RecentSumInfo[], games: ReadonlyMap<number, NormalizedHistoryGame>,
): Map<string, number[]> => {
  const ordered = players.slice().sort((a, b) => a.puuid.localeCompare(b.puuid));
  const rosterKey = JSON.stringify(ordered.map(p => [p.puuid, p.summonerId, p.summonerName]));
  const result = new Map<string, number[]>();
  for (const game of games.values()) {
    let rosters = cache.get(game);
    if (!rosters) { rosters = new Map(); cache.set(game, rosters); }
    let groups = rosters.get(rosterKey);
    if (!groups) {
      evaluatedGames++;
      groups = [];
      const found = ordered.map(player => ({ player, participant: findPlayerParticipant(game, player) }))
        .filter(item => item.participant && item.participant.teamId > 0);
      // 当前阵容通常5人；递归只扩展同队且身份不同的组合。
      const visit = (start: number, selected: typeof found) => {
        if (selected.length >= 2) groups!.push(selected.map(item => item.player.puuid).sort().join("|"));
        for (let i = start; i < found.length; i++) {
          const candidate = found[i];
          if (selected.some(item => item.participant === candidate.participant ||
            item.participant!.teamId !== candidate.participant!.teamId)) continue;
          visit(i + 1, [...selected, candidate]);
        }
      };
      visit(0, []);
      rosters.set(rosterKey, groups);
    }
    for (const key of groups) {
      const ids = result.get(key) || [];
      ids.push(game.gameId);
      result.set(key, ids);
    }
  }
  return result;
};
