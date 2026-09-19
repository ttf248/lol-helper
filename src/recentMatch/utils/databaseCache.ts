import { invoke } from "@tauri-apps/api/core";
import type { NormalizedHistoryGame } from "./recentAnalytics";
import { MatchModeKey } from "./matchMode";

export interface CachedHistoryQuery {
  puuid: string;
  queueId?: number;
  modeKey?: MatchModeKey;
  limit: number;
  offset?: number;
}

interface CachedParticipant {
  puuid: string;
  summonerId?: number;
  summonerName?: string;
  teamId: number;
  championId: number;
  position: string;
  kills: number;
  deaths: number;
  assists: number;
  win: boolean;
}

interface CachedGame {
  gameId: number;
  gameCreation: number;
  queueId: number;
  modeKey: MatchModeKey;
  source: string;
  participants: CachedParticipant[];
}

export const getCachedHistory = async (
  query: CachedHistoryQuery,
): Promise<NormalizedHistoryGame[]> => {
  try {
    const games = await invoke<CachedGame[]>("get_cached_match_history", {
      request: query,
    });
    return (games || []).map((game) => ({
      gameId: game.gameId,
      gameCreation: game.gameCreation,
      queueId: game.queueId,
      source: game.source || "postgres",
      participants: (game.participants || []).map((participant) => ({
        puuid: participant.puuid,
        summonerId: participant.summonerId,
        summonerName: participant.summonerName,
        teamId: participant.teamId,
        championId: participant.championId,
        position: participant.position,
        kills: participant.kills,
        deaths: participant.deaths,
        assists: participant.assists,
        win: participant.win,
      })),
    }));
  } catch (error) {
    console.warn("Failed to read PostgreSQL match cache", error);
    return [];
  }
};

export const cacheHistory = async (request: {
  puuid: string;
  summonerId?: number;
  summonerName?: string;
  modeKey: MatchModeKey;
  source: string;
  games: NormalizedHistoryGame[];
}): Promise<boolean> => {
  try {
    await invoke("cache_match_history", {
      request: {
        puuid: request.puuid,
        summonerId: request.summonerId,
        summonerName: request.summonerName,
        modeKey: request.modeKey,
        games: request.games.map((game) => ({
          gameId: game.gameId,
          gameCreation: game.gameCreation,
          queueId: game.queueId,
          modeKey: request.modeKey,
          source: request.source,
          participants: game.participants,
        })),
      },
    });
    return true;
  } catch (error) {
    console.warn("Failed to write PostgreSQL match cache", error);
    return false;
  }
};

export const getDatabaseStatus = async () => {
  try {
    return await invoke<{
      available: boolean;
      message: string;
      checkedAt: number;
    }>("database_status");
  } catch (error) {
    return {
      available: false,
      message: String(error),
      checkedAt: 0,
    };
  }
};

export interface DatabaseModeSummary {
  modeKey: string;
  matches: number;
  participants: number;
  latestGameCreation?: number | null;
}

export interface DatabaseSummary {
  totalMatches: number;
  totalParticipants: number;
  totalPlayers: number;
  modes: DatabaseModeSummary[];
}

export interface DatabaseSourceSummary {
  source: string;
  matches: number;
}

export interface CachedPlayerSummary {
  puuid: string;
  modeKey?: MatchModeKey | null;
  matches: number;
  completeMatches: number;
  wins: number;
  latestGameCreation?: number | null;
  sources: DatabaseSourceSummary[];
}

export const getDatabaseSummary = async (): Promise<DatabaseSummary> => {
  try {
    return await invoke<DatabaseSummary>("database_summary");
  } catch (error) {
    console.warn("Failed to read PostgreSQL cache summary", error);
    return {
      totalMatches: 0,
      totalParticipants: 0,
      totalPlayers: 0,
      modes: [],
    };
  }
};

export const getCachedPlayerSummary = async (
  puuid: string,
  modeKey?: MatchModeKey,
): Promise<CachedPlayerSummary> => {
  const empty: CachedPlayerSummary = {
    puuid,
    modeKey: modeKey || null,
    matches: 0,
    completeMatches: 0,
    wins: 0,
    latestGameCreation: null,
    sources: [],
  };
  try {
    return await invoke<CachedPlayerSummary>("get_cached_player_summary", {
      request: { puuid, modeKey: modeKey || null },
    });
  } catch (error) {
    console.warn("Failed to read cached player summary", error);
    return empty;
  }
};
