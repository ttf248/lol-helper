const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./load-ts.cjs');
const load = createLoader();
const { participantMatchesPlayer, findPlayerParticipant, findParticipant } = load('src/recentMatch/utils/participantLookup.ts');
const a = { puuid: 'a', summonerId: 1, summonerName: 'Same#A' };
const b = { puuid: 'b', summonerId: 2, summonerName: 'Same#B' };
const silentLogger = { debug() {}, info() {}, warn() {} };
const history = createLoader({ '@/utils/logger': { logger: silentLogger } })('src/recentMatch/utils/historyData.ts');
const fullGame = (gameId = 1, gameCreation = Date.now()) => ({
  gameId, gameCreation, queueId: 420,
  participants: Array.from({ length: 10 }, (_, i) => ({
    puuid: `p${i}`, summonerId: i + 1, summonerName: `Player${i}`,
    teamId: i < 5 ? 100 : 200, championId: i + 1, win: i < 5,
    position: 'UNKNOWN', kills: 0, deaths: 0, assists: 0,
  })),
});
const analyticsPath = 'src/recentMatch/utils/recentAnalytics.ts';
const makeAnalytics = (services = {}) => createLoader({
  '@/utils/logger': { logger: silentLogger },
  '@/lcu/aboutMatch': {},
  '@/main/views/record/blackList': { default: class {} },
  '@/recentMatch/utils/databaseCache': {},
  ...services,
}, { [analyticsPath]: ['buildPartyGroupsStructure', 'buildCurrentTeamPartyGroups', 'buildCurrentMatchGame',
  'buildNetworkAnalysis', 'buildOpponentStats', 'buildPlayerPartyGroups', 'applyPartyGroupOverlay', 'syncPlayerModeGames', 'getTeamPartyCoverage'] })(analyticsPath);
const analytics = makeAnalytics();
const scoring = createLoader({ '@/utils/logger': { logger: silentLogger } })('src/recentMatch/utils/partyScoring.ts');
const player = (i) => ({ ...fullGame().participants[i], champId: i + 1, matchList: [] });
const snapshot = (games) => ({ games: new Map(games.map(g => [g.gameId, g])), complete: true, recentHistoryVerified: true, source: 'test', sourceEndpoints: [] });

test('500 complete cached matches do not suppress hydration of a new partial match', async () => {
  const old = Array.from({ length: 500 }, (_, i) => fullGame(i + 1, 1000000000000 + i));
  const full = fullGame(501);
  const partial = { ...full, participants: [full.participants[0]] };
  let calls = 0;
  const api = makeAnalytics({ '@/lcu/aboutMatch': {
    queryMatchHistoryWithSource: async () => ({ games: [partial] }),
    queryMatchHistoryFullWithSource: async (_puuid, start, count) => {
      calls++;
      assert.equal(start, 0);
      assert.equal(count, 20);
      return { games: [full] };
    },
  }});
  const result = await api.syncPlayerModeGames(player(0), 'ranked', old);
  assert.equal(calls, 1);
  assert.equal(result.games[0].participants.length, 10);
  assert.equal(result.recentHistoryVerified, true);
});

test('already complete latest window avoids needless full-roster requests', async () => {
  const full = fullGame();
  const api = makeAnalytics({ '@/lcu/aboutMatch': {
    queryMatchHistoryWithSource: async () => ({ games: [full] }),
    queryMatchHistoryFullWithSource: async () => { throw new Error('unnecessary request'); },
  }});
  assert.equal((await api.syncPlayerModeGames(player(0), 'ranked', [full])).games.length, 1);
});

test('stale or short recent windows remain explicitly insufficient', () => {
  const games = [1, 2, 3, 4].map(i => fullGame(i));
  const snapshots = new Map([['p0', snapshot(games)]]);
  assert.equal(analytics.getTeamPartyCoverage([player(0)], snapshots, null).status, 'ready');
  snapshots.get('p0').recentHistoryVerified = false;
  assert.equal(analytics.getTeamPartyCoverage([player(0)], snapshots, null).status, 'insufficient');
  snapshots.set('p0', snapshot(games.slice(0, 2)));
  assert.equal(analytics.getTeamPartyCoverage([player(0)], snapshots, null).status, 'insufficient');
});

test('one authoritative roster suffices and player order cannot change historical groups', () => {
  const games = [fullGame(1), fullGame(2)];
  const partial = games.map(g => ({ ...g, participants: [g.participants[0]] }));
  const snapshots = new Map([['p0', snapshot(partial)], ['p1', snapshot(games)]]);
  for (const team of [[player(0), player(1)], [player(1), player(0)]]) {
    assert.equal(analytics.buildPartyGroupsStructure(team, snapshots)[0].historicalGames, 2);
  }
  const onlyA = new Map([['p0', snapshot(games)]]);
  assert.equal(analytics.buildPartyGroupsStructure([player(0), player(1)], onlyA).length, 1);
  assert.equal(analytics.buildNetworkAnalysis([player(0), player(1)], [], onlyA).edges[0].sameTeamGames, 2);
  assert.equal(analytics.buildOpponentStats(player(0), [player(5)], onlyA, new Map())[0].games, 2);
});

test('historical evidence does not invent membership in another player recent window', () => {
  const team = [player(0), player(1)];
  const games = [fullGame(1), fullGame(2)];
  const snapshots = new Map([['p0', snapshot(games)], ['p1', snapshot([])]]);
  const current = analytics.buildCurrentMatchGame(team, [], 420, 99);
  const result = analytics.buildCurrentTeamPartyGroups(team, snapshots, current, new Map());
  assert.equal(result[0].recentWindowGames, undefined);
  assert.equal(result[0].relationKind, 'historical');
  const both = new Map([['p0', snapshot(games)], ['p1', snapshot(games)]]);
  const recent = analytics.buildCurrentTeamPartyGroups(team, both, current, new Map())[0];
  assert.equal(recent.recentWindowGames, 3);
  assert.equal(recent.relationKind, 'recent');
  assert.equal(recent.historicalGames, 2);
  assert.equal(recent.winRate, 100);
});

test('party strength is independent of wins and moderation, and agrees across entry points', () => {
  const games = Array.from({ length: 5 }, (_, i) => fullGame(i + 1));
  const team = [player(0), player(1)];
  const snapshots = new Map([['p0', snapshot(games)], ['p1', snapshot(games)]]);
  const structure = analytics.buildPartyGroupsStructure(team, snapshots)[0];
  const absent = analytics.applyPartyGroupOverlay(structure, new Map(), Date.now());
  const available = analytics.applyPartyGroupOverlay(structure, new Map(team.map(p => [p.puuid, { available: true }])), Date.now());
  assert.equal(absent.confidence.score, available.confidence.score);
  const losses = games.map(g => ({ ...g, participants: g.participants.map(p => ({ ...p, win: false })) }));
  const lossStructure = analytics.buildPartyGroupsStructure(team, new Map([['p0', snapshot(losses)]]))[0];
  assert.equal(structure.stabilityScore, lossStructure.stabilityScore);
  const personal = analytics.buildPlayerPartyGroups(player(0), snapshot(games), new Map())
    .find(g => g.members.length === 2 && g.members.some(p => p.puuid === 'p1'));
  assert.equal(personal.confidence.score, absent.confidence.score);
  assert.equal(personal.stabilityScore, absent.stabilityScore);
  assert.equal(personal.highWinRateAlert, false);
});

test('old relationships decay and current match cannot refresh historical activity', () => {
  const now = Date.now();
  const team = [player(0), player(1)];
  const old = [fullGame(1, now - 180 * 86400000), fullGame(2, now - 179 * 86400000)];
  const snapshots = new Map(team.map(p => [p.puuid, snapshot(old)]));
  const result = analytics.buildCurrentTeamPartyGroups(team, snapshots,
    analytics.buildCurrentMatchGame(team, [], 420, 99), new Map())[0];
  assert.equal(result.lastActiveDays, 179);
  assert.equal(result.recentGames, 0);
  assert.equal(result.stabilityScore, 0);
  assert.equal(scoring.hasHighWinRateEvidence(5, 5), false);
  assert.equal(scoring.hasHighWinRateEvidence(8, 10), false);
  assert.equal(scoring.hasHighWinRateEvidence(9, 10), true);
});

test('complete rosters survive partial records in either merge direction, including duplicate cache rows', () => {
  const full = fullGame();
  const partial = { ...full, participants: full.participants.slice(0, 3) };
  assert.equal(history.mergeHistoryGames([full], [partial]).games[0], full);
  assert.equal(history.mergeHistoryGames([partial], [full]).games[0], full);
  assert.equal(history.mergeHistoryGames([full, partial], []).games[0], full);
  const updated = { ...full, source: 'updated' };
  assert.equal(history.mergeHistoryGames([full], [updated]).games[0], updated);
});

test('completeness requires the known queue roster size, unique identities, and balanced teams', () => {
  const full = fullGame();
  assert.equal(history.historyGameQuality(full), 'complete');
  assert.equal(history.historyGameQuality({ ...full, participants: full.participants.slice(3) }), 'partial');
  assert.equal(history.historyGameQuality({ ...full, participants: full.participants.map(p => ({ ...p, puuid: 'same' })) }), 'partial');
  assert.equal(history.historyGameQuality({ ...full, queueId: 99999 }), 'partial');
  assert.equal(history.historyGameQuality({ ...full, participants: full.participants.map(p => ({ ...p, teamId: 100 })) }), 'partial');
});

test('conflicting PUUIDs and different Tags never identify the same player', () => {
  assert.equal(participantMatchesPlayer(a, b), false);
  assert.equal(participantMatchesPlayer(a, { ...b, summonerName: a.summonerName }), false);
  assert.equal(findPlayerParticipant({ participants: [a, b] }, b), b);
  assert.equal(findParticipant({ participants: [a, b] }, 'b', 1), b);
});

test('exact PUUID takes precedence over an earlier weak match; ambiguous names fail closed', () => {
  const weak = { puuid: 'summoner-name:same#a', summonerName: a.summonerName };
  assert.equal(findPlayerParticipant({ participants: [weak, a] }, a), a);
  assert.equal(findPlayerParticipant({ participants: [weak] }, a), weak);
  assert.equal(findPlayerParticipant({ participants: [weak, { ...weak }] }, a), undefined);
  assert.equal(participantMatchesPlayer({ ...weak, summonerName: 'Same#B' }, a), false);
  assert.equal(findPlayerParticipant({ participants: [{ puuid: '', summonerName: '' }] }, { puuid: '', summonerName: '' }), undefined);
});
