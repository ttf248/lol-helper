export type MatchModeKey = "match" | "ranked" | "aram" | "hex-aram" | "other";

export interface MatchModeDefinition {
  key: MatchModeKey;
  label: string;
  queueIds: number[];
}

export const MATCH_MODES: MatchModeDefinition[] = [
  { key: "match", label: "匹配模式", queueIds: [400, 430, 490] },
  { key: "ranked", label: "排位模式", queueIds: [420, 440] },
  { key: "aram", label: "大乱斗", queueIds: [450] },
  { key: "hex-aram", label: "海克斯大乱斗", queueIds: [2400, 2401] },
];

const OTHER_MODE: MatchModeDefinition = {
  key: "other",
  label: "其他模式",
  queueIds: [],
};

export const modeForQueue = (queueId: number): MatchModeKey => {
  const normalizedQueueId = Number(queueId);
  const mode = MATCH_MODES.find((item) =>
    item.queueIds.includes(normalizedQueueId),
  );
  return mode?.key || OTHER_MODE.key;
};

export const modeLabel = (modeKey: MatchModeKey): string =>
  [...MATCH_MODES, OTHER_MODE].find((item) => item.key === modeKey)?.label || "其他模式";

export const isModeQueue = (queueId: number, modeKey: MatchModeKey): boolean => {
  const normalizedQueueId = Number(queueId);
  if (modeKey === OTHER_MODE.key) {
    return !MATCH_MODES.some((item) =>
      item.queueIds.includes(normalizedQueueId),
    );
  }
  return (
    MATCH_MODES.find((item) => item.key === modeKey)?.queueIds.includes(
      normalizedQueueId,
    ) || false
  );
};
