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
  'buildNetworkAnalysis', 'buildOpponentStats', 'buildPlayerPartyGroups', 'applyPartyGroupOverlay', 'syncPlayerModeGames'] })(analyticsPath);
const analytics = makeAnalytics();
const player = (i) => ({ ...fullGame().participants[i], champId: i + 1, matchList: [] });
const snapshot = (games) => ({ games: new Map(games.map(g => [g.gameId, g])), complete: true, source: 'test', sourceEndpoints: [] });

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
  const both = new Map([['p0', snapshot(games)], ['p1', snapshot(games)]]);
  const recent = analytics.buildCurrentTeamPartyGroups(team, both, current, new Map())[0];
  assert.equal(recent.recentWindowGames, 3);
  assert.equal(recent.historicalGames, 2);
  assert.equal(recent.winRate, 100);
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
