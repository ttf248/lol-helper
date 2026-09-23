// 真实玩家数据 fixture
// 来自 PostgreSQL summoners + matches 表，puuid 8d7b0b53-410e-51df-86b7-905eee83b581
// （鼠标加键盘#86495，level 1293，最近 20 场全部是 queue 2400 / hex-aram）。
// 数据库观察到的核心规律：
//   - size=5 组合「玩家+中意+Uzi+solo+1is」9 场同队（5 黑）
//   - size=4 组合「玩家+Uzi+solo+1is」19 场同队（覆盖所有 5 黑 + 4 黑+路人场）
//   - size=5 组合「玩家+Uzi+solo+1is+可劲得瑟吧提莫」只有 1 场同队（路人场）

const TARGET_PUUID = '8d7b0b53-410e-51df-86b7-905eee83b581';
const STRAY_PUUID = '3408ed00-3df8-5b3e-b15c-0f0885d64488';
const CORE_PUUIDS = {
  player: TARGET_PUUID,
  zhongyi: 'puuid-zhongyi',
  uzi: 'puuid-uzi',
  solo: 'puuid-solo',
  yisi: 'puuid-yisi',
  stray: STRAY_PUUID,
};

const FULL_HISTORY_FIXTURE_VERSION = 1;

function makeHexAramTeam({ gameId, gameCreation, ownPuuids, source = 'interface-full' }) {
  // hex-aram 5v5；调用方负责传入 5 人 ownPuuids。
  const otherPuuids = ['opponent-a', 'opponent-b', 'opponent-c', 'opponent-d', 'opponent-e'];
  const participants = [
    ...ownPuuids.map((puuid, i) => ({
      puuid,
      summonerId: 100 + i,
      summonerName: `member-${i}`,
      teamId: 100,
      championId: i + 1,
      position: 'UNKNOWN',
      kills: 10,
      deaths: 5,
      assists: 8,
      win: i === 0,
    })),
    ...otherPuuids.map((puuid, i) => ({
      puuid,
      summonerId: 200 + i,
      summonerName: `enemy-${i}`,
      teamId: 200,
      championId: 11 + i,
      position: 'UNKNOWN',
      kills: 6,
      deaths: 10,
      assists: 4,
      win: false,
    })),
  ];
  return {
    gameId,
    gameCreation,
    queueId: 2400,
    source,
    participants,
  };
}

function playerFromPuuid(puuid, summonerName) {
  return {
    puuid,
    summonerId: parseInt(puuid.replace(/\D/g, '').slice(-8) || '1', 10) || 1,
    summonerName,
    championUrl: '',
    champId: 1,
    teamParticipantId: 0,
    matchList: [],
  };
}

function snapshot(games) {
  return {
    games: new Map(games.map((g) => [g.gameId, g])),
    complete: true,
    recentHistoryVerified: true,
    source: 'test',
    sourceEndpoints: [],
  };
}

// 复刻玩家最近 5 场阵容：
//   game 5: 玩家+Uzi+solo+1is+可劲得瑟吧提莫 (4 黑 + 1 路人)
//   game 4..1: 玩家+中意+Uzi+solo+1is (5 黑)
function buildPlayerRecent5Window(nowMs) {
  const ownForStrangerGame = [
    CORE_PUUIDS.player,
    CORE_PUUIDS.uzi,
    CORE_PUUIDS.solo,
    CORE_PUUIDS.yisi,
    CORE_PUUIDS.stray,
  ];
  const ownForFullGroup = [
    CORE_PUUIDS.player,
    CORE_PUUIDS.zhongyi,
    CORE_PUUIDS.uzi,
    CORE_PUUIDS.solo,
    CORE_PUUIDS.yisi,
  ];
  return [
    makeHexAramTeam({
      gameId: 5,
      gameCreation: nowMs - 0,
      ownPuuids: ownForStrangerGame,
    }),
    makeHexAramTeam({
      gameId: 4,
      gameCreation: nowMs - 30 * 60 * 1000,
      ownPuuids: ownForFullGroup,
    }),
    makeHexAramTeam({
      gameId: 3,
      gameCreation: nowMs - 60 * 60 * 1000,
      ownPuuids: ownForFullGroup,
    }),
    makeHexAramTeam({
      gameId: 2,
      gameCreation: nowMs - 90 * 60 * 1000,
      ownPuuids: ownForFullGroup,
    }),
    makeHexAramTeam({
      gameId: 1,
      gameCreation: nowMs - 120 * 60 * 1000,
      ownPuuids: ownForFullGroup,
    }),
  ];
}

// 构造一组更长的历史：9 场 5 黑 + 1 场 4 黑+路人
function buildPlayerHistoricalTenGames(nowMs) {
  const ownForFullGroup = [
    CORE_PUUIDS.player,
    CORE_PUUIDS.zhongyi,
    CORE_PUUIDS.uzi,
    CORE_PUUIDS.solo,
    CORE_PUUIDS.yisi,
  ];
  const ownForStrangerGame = [
    CORE_PUUIDS.player,
    CORE_PUUIDS.uzi,
    CORE_PUUIDS.solo,
    CORE_PUUIDS.yisi,
    CORE_PUUIDS.stray,
  ];
  const games = [];
  // game 1: 4 黑 + 路人（最新），gameId 用 2000 段避免与 5 黑对局冲突
  games.push(makeHexAramTeam({
    gameId: 2001,
    gameCreation: nowMs - 0,
    ownPuuids: ownForStrangerGame,
  }));
  // game 2..10: 5 黑（递减 30 分钟）
  for (let i = 1; i < 10; i++) {
    games.push(makeHexAramTeam({
      gameId: 1000 + i,
      gameCreation: nowMs - i * 30 * 60 * 1000,
      ownPuuids: ownForFullGroup,
    }));
  }
  return games;
}

module.exports = {
  TARGET_PUUID,
  STRAY_PUUID,
  CORE_PUUIDS,
  FULL_HISTORY_FIXTURE_VERSION,
  makeHexAramTeam,
  playerFromPuuid,
  snapshot,
  buildPlayerRecent5Window,
  buildPlayerHistoricalTenGames,
};