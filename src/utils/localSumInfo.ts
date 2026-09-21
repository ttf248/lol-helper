import { sumInfoTypes } from "@/lcu/types/SummonerTypes";

const SUM_INFO_KEY = "sumInfo";

// localStorage 里的 sumInfo 是当前登录玩家的快照：跨窗口（main /
// queryMatch / recentMatch）共享。任何读取方都必须容忍 JSON.parse 抛错
// 和 null 值，否则 corrupt 缓存会让整个面板白屏。
export const readLocalSumInfo = (): Partial<sumInfoTypes> => {
    try {
        const raw = localStorage.getItem(SUM_INFO_KEY);
        if (raw === null) return {};
        return JSON.parse(raw) as Partial<sumInfoTypes>;
    } catch {
        return {};
    }
};

export const readLocalSumInfoOrNull = (): Partial<sumInfoTypes> | null => {
    try {
        const raw = localStorage.getItem(SUM_INFO_KEY);
        if (raw === null) return null;
        return JSON.parse(raw) as Partial<sumInfoTypes>;
    } catch {
        return null;
    }
};

export const isCurrentSummoner = (puuid: string): boolean => {
    const local = readLocalSumInfo();
    return typeof local.puuid === "string" && local.puuid === puuid;
};