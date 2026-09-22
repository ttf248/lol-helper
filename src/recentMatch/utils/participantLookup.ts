import type { Games } from "@/lcu/types/queryMatchLcuTypes";
import type { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import type { NormalizedHistoryParticipant } from "@/recentMatch/utils/recentAnalytics";
import type { RecentSumInfo } from "@/recentMatch/utils/queryTypes";

/** 缓存生成的替代键不是 Riot PUUID，不能用于强身份判定。 */
export const isStrongPuuid = (value?: string): boolean =>
    Boolean(value?.trim()) && !value!.startsWith("summoner-id:") &&
    !value!.startsWith("summoner-name:");

const identityRank = (
    participant: { puuid?: string; summonerId?: number; summonerName?: string },
    target: { puuid?: string; summonerId?: number; summonerName?: string },
): number => {
    if (isStrongPuuid(participant.puuid) && isStrongPuuid(target.puuid)) {
        return participant.puuid === target.puuid ? 3 : 0;
    }
    if ((participant.summonerId || 0) > 0 && (target.summonerId || 0) > 0) {
        return participant.summonerId === target.summonerId ? 2 : 0;
    }
    const name = participant.summonerName?.trim().toLowerCase();
    const targetName = target.summonerName?.trim().toLowerCase();
    // 不删除 Tag；旧式无 Tag 昵称只允许在整局中唯一匹配。
    return name && name === targetName ? 1 : 0;
};

const uniqueIdentityMatch = <T extends { puuid?: string; summonerId?: number; summonerName?: string }>(
    participants: T[],
    target: { puuid?: string; summonerId?: number; summonerName?: string },
): T | undefined => {
    const ranked = participants.map((participant) => ({ participant, rank: identityRank(participant, target) }));
    const best = Math.max(0, ...ranked.map((item) => item.rank));
    const matches = ranked.filter((item) => item.rank === best);
    return best > 0 && matches.length === 1 ? matches[0].participant : undefined;
};

// 旧名（stringify）已经作为 helper 名字使用了很多处，保留作为 deprecation
// alias 以维持 import 路径稳定。
type FindParams = {
    targetPuuid?: string;
    targetSummonerId?: number;
};

/**
 * 在 LCU 或 SGP 的一场对局里找到属于某个玩家的 participant。
 * 优先按 puuid 匹配，再用 summonerId 兜底，最后尝试 participantIdentities
 * 反查。找不到时返回 undefined —— 不允许回退到 participants[0]，那是
 * 历史最常见的"队友战绩伪装成自己"的错位来源。
 */
export const findParticipant = <
    T extends {
        puuid?: string;
        summonerId?: number;
        participantId?: number;
    },
>(
    match: Games | GamesBySgp,
    targetPuuid?: string,
    targetSummonerId?: number,
): T | undefined => {
    const participants = (match.participants ?? []) as unknown as T[];
    const target = { puuid: targetPuuid, summonerId: targetSummonerId };
    const direct = uniqueIdentityMatch(participants, target);
    if (direct !== undefined) return direct;

    if ("participantIdentities" in match) {
        const identities = match.participantIdentities || [];
        const identityPlayer = uniqueIdentityMatch(identities.map((item) => item.player), target);
        const identity = identities.find((item) => item.player === identityPlayer);
        if (identity !== undefined) {
            const byParticipantId = participants.find(
                (participant) =>
                    participant.participantId === identity.participantId,
            );
            if (byParticipantId !== undefined &&
                !(isStrongPuuid(byParticipantId.puuid) && isStrongPuuid(targetPuuid) &&
                  byParticipantId.puuid !== targetPuuid)) return byParticipantId;
        }
    }
    return undefined;
};

/**
 * 强身份优先且冲突即拒绝。关系判断只接受强身份或完整 Riot ID；
 * 无 Tag 的旧昵称由 findPlayerParticipant 在整局唯一性检查后兜底。
 */
export const participantMatchesPlayer = (
    participant: NormalizedHistoryParticipant,
    player: RecentSumInfo,
): boolean => {
    const rank = identityRank(participant, player);
    return rank >= 2 || (rank === 1 && Boolean(participant.summonerName?.includes("#")));
};

export const findPlayerParticipant = (
    game: { participants: NormalizedHistoryParticipant[] },
    player: RecentSumInfo,
): NormalizedHistoryParticipant | undefined =>
    uniqueIdentityMatch(game.participants, player);

export type { FindParams };
