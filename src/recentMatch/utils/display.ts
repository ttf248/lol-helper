import { champDict } from "@/resources/champList";
import {
    MATCH_HISTORY_ENDPOINT_LABELS,
    MATCH_HISTORY_ENDPOINT_PATHS,
    MATCH_HISTORY_SOURCE_LABELS,
} from "@/lcu/aboutMatch";

// 注意：胜率格式化统一沿用 partyDisplay.ts 的 formatRate（含 toFixed(1)），
// 这里不重复实现，避免不同面板出现 "75%" vs "75.0%" 的细微差异。

export const championName = (championId: number): string =>
    champDict[String(championId)]?.label || `英雄 ${championId}`;

export const sourceEndpointLabel = (endpoint: string): string =>
    MATCH_HISTORY_ENDPOINT_LABELS[
        endpoint as keyof typeof MATCH_HISTORY_ENDPOINT_LABELS
    ] || endpoint;

export const historySourceLabel = (source: string): string =>
    MATCH_HISTORY_SOURCE_LABELS[
        source as keyof typeof MATCH_HISTORY_SOURCE_LABELS
    ] || source;

export const sourceEndpointSummary = (endpoints?: string[]): string =>
    (endpoints || []).map(sourceEndpointLabel).join("、");

export const sourceEndpointTitle = (endpoints?: string[]): string =>
    (endpoints || [])
        .map(
            (endpoint) =>
                MATCH_HISTORY_ENDPOINT_PATHS[
                    endpoint as keyof typeof MATCH_HISTORY_ENDPOINT_PATHS
                ] || endpoint,
        )
        .join("\n");

const HISTORY_STATUS_LABELS: Record<string, string> = {
    loading: "历史读取中",
    "cache-fallback": "本地缓存",
    "no-data": "暂无历史",
    "mode-empty": "本模式暂无历史",
    "identity-mismatch": "身份待确认",
    error: "历史读取失败",
};

export const historyStatusLabel = (kind: string, fallback: string): string =>
    HISTORY_STATUS_LABELS[kind] || fallback;