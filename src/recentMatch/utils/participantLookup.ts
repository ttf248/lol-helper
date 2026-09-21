import { Games } from "@/lcu/types/queryMatchLcuTypes";
import { GamesBySgp } from "@/lcu/types/queryMatchSgpGameTypes";
import { NormalizedHistoryParticipant } from "@/recentMatch/utils/recentAnalytics";
import { RecentSumInfo } from "@/recentMatch/utils/queryTypes";

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
    const direct = participants.find(
        (participant) =>
            (targetPuuid !== undefined && participant.puuid === targetPuuid) ||
            (targetSummonerId !== undefined &&
                participant.summonerId === targetSummonerId),
    );
    if (direct !== undefined) return direct;

    if ("participantIdentities" in match) {
        const identity = match.participantIdentities?.find((item: any) => {
            const player = item.player;
            return (
                (targetPuuid !== undefined && player.puuid === targetPuuid) ||
                (targetSummonerId !== undefined &&
                    player.summonerId === targetSummonerId)
            );
        });
        if (identity !== undefined) {
            const byParticipantId = participants.find(
                (participant) =>
                    participant.participantId === identity.participantId,
            );
            if (byParticipantId !== undefined) return byParticipantId;
        }
    }
    return undefined;
};

const normalizeIdentityName = (name?: string | null) =>
    (name || "").trim().toLowerCase();

/**
 * 分析层的"这个 participant 是不是某个 SumInfo 对应的人"判定。
 * 比 findParticipant 更宽松，会对 summonerName 做归一化（#tag 前缀也接受），
 * 用于 PG 缓存里只有 summonerName 没有 summonerId/puuid 的兜底场景。
 */
export const participantMatchesPlayer = (
    participant: NormalizedHistoryParticipant,
    player: RecentSumInfo,
): boolean => {
    if (participant.puuid === player.puuid) return true;
    if (
        participant.summonerId !== undefined &&
        participant.summonerId === player.summonerId
    ) {
        return true;
    }
    const targetName = normalizeIdentityName(player.summonerName);
    if (targetName === "") return false;
    const participantName = normalizeIdentityName(participant.summonerName);
    if (participantName === "") return false;
    return (
        participantName === targetName ||
        participantName.split("#", 1)[0] === targetName.split("#", 1)[0]
    );
};

export const findPlayerParticipant = (
    game: { participants: NormalizedHistoryParticipant[] },
    player: RecentSumInfo,
): NormalizedHistoryParticipant | undefined =>
    game.participants.find((participant) =>
        participantMatchesPlayer(participant, player),
    );

export type { FindParams };