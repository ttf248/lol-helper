const { performance } = require('node:perf_hooks');
const { createLoader } = require('../tests/load-ts.cjs');
const file = 'src/recentMatch/utils/recentAnalytics.ts';
const api = createLoader({
  '@/utils/logger': { logger: { debug() {}, info() {}, warn() {} } },
  '@/lcu/aboutMatch': {}, '@/main/views/record/blackList': {}, '@/recentMatch/utils/databaseCache': {},
}, { [file]: ['applyTeamAnalysis'] })(file);

for (const disjoint of [false, true]) {
  const players = Array.from({ length: 10 }, (_, i) => ({
    puuid: `p${i}`, summonerId: i + 1, summonerName: `Player${i}`, champId: i + 1, matchList: [],
  }));
  const now = Date.now();
  const roster = players.map((p, i) => ({ ...p, championId: i + 1, teamId: i < 5 ? 100 : 200,
    win: i < 5, kills: 1, deaths: 1, assists: 1, position: 'UNKNOWN' }));
  const snapshots = new Map(players.map((p, i) => [p.puuid, {
    games: new Map(Array.from({ length: 500 }, (_, j) => {
      const gameId = (disjoint ? i * 500 : 0) + j + 1;
      return [gameId, { gameId, gameCreation: now - j * 3600000, queueId: 420, participants: roster }];
    })), complete: true, recentHistoryVerified: true, source: 'benchmark', sourceEndpoints: [],
  }]));
  const friend = players.slice(0, 5), enemy = players.slice(5);
  const run = (data, moderation) => {
    const start = performance.now();
    api.applyTeamAnalysis(friend, enemy, data, moderation, 420, 99999);
    return +(performance.now() - start).toFixed(2);
  };
  const initialMs = run(snapshots, new Map());
  const overlayMs = run(snapshots, new Map(players.map(p => [p.puuid, { available: true, records: [] }])));
  const updated = new Map(snapshots);
  const old = snapshots.get('p0');
  const games = new Map(old.games);
  games.set(10000, { gameId: 10000, gameCreation: now + 1, queueId: 420, participants: roster });
  updated.set('p0', { ...old, games });
  const updateMs = run(updated, new Map());
  console.log(JSON.stringify({ players: 10, rowsPerPlayer: 500, uniqueMatches: disjoint ? 5000 : 500,
    initialMs, overlayMs, updateMs }));
}
