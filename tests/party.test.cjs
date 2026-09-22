const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./load-ts.cjs');
const load = createLoader();
const { participantMatchesPlayer, findPlayerParticipant, findParticipant } = load('src/recentMatch/utils/participantLookup.ts');
const a = { puuid: 'a', summonerId: 1, summonerName: 'Same#A' };
const b = { puuid: 'b', summonerId: 2, summonerName: 'Same#B' };
const silentLogger = { debug() {}, info() {}, warn() {} };
const history = createLoader({ '@/utils/logger': { logger: silentLogger } })('src/recentMatch/utils/historyData.ts');
const { inferHistoryMode } = createLoader()('src/queryMatch/utils/historyMode.ts');
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
  'buildNetworkAnalysis', 'buildOpponentStats', 'buildPlayerPartyGroups', 'applyPartyGroupOverlay', 'syncPlayerModeGames', 'getTeamPartyCoverage', 'applyTeamAnalysis', 'buildTeammateSynergy'] })(analyticsPath);
const analytics = makeAnalytics();
const scoring = createLoader({ '@/utils/logger': { logger: silentLogger } })('src/recentMatch/utils/partyScoring.ts');
const { selectPartyGroups, selectPrimaryPartyGroups } = createLoader()('src/recentMatch/utils/partyPresentation.ts');

test('recent evidence wins display priority, identical subgroups fold, independent evidence survives', () => {
  const group = (ids, games, kind = 'historical') => ({
    members: ids.map(puuid => ({ puuid })), relationKind: kind,
    evidence: games.map(gameId => ({ gameId })), games: games.length, historicalGames: games.length,
    confidence: { score: 50 }, stabilityScore: 50, winRate: 100,
    recentWindowGames: kind === 'recent' ? 3 : undefined,
  });
  const parent = group(['a', 'b', 'c'], [1, 2, 3]);
  const child = group(['a', 'b'], [1, 2, 3]);
  const independent = group(['a', 'c'], [1, 2, 3, 4]);
  const recent = group(['d', 'e'], [8, 9], 'recent');
  assert.deepEqual(selectPartyGroups([child, parent, independent, recent], { limit: 2 }), [recent, parent]);
  assert.equal(selectPartyGroups([child, parent, independent]).includes(independent), true);
  assert.equal(selectPartyGroups([child, parent], { showSubgroups: true }).length, 2);
  assert.equal(selectPartyGroups([parent, independent], { mode: 'frequency' })[0], independent);
  const secondParty = group(['f', 'g'], [20, 21], 'recent');
  const overlap = group(['d', 'f'], [30, 31], 'recent');
  assert.deepEqual(selectPrimaryPartyGroups([child, parent, independent, recent, secondParty, overlap]), [recent, secondParty]);
  assert.deepEqual(selectPrimaryPartyGroups([recent, secondParty]), [recent, secondParty]);
});
const player = (i) => ({ ...fullGame().participants[i], champId: i + 1, matchList: [] });
const snapshot = (games) => ({ games: new Map(games.map(g => [g.gameId, g])), complete: true, recentHistoryVerified: true, source: 'test', sourceEndpoints: [] });

test('history panel follows the newest supported queue', () => {
  assert.equal(inferHistoryMode({ matchList: [{ queueId: 2400 }] }), 'hex-aram');
  assert.equal(inferHistoryMode({ matchList: [{ queueId: 420 }] }), 'ranked');
  assert.equal(inferHistoryMode({ matchList: [{ queueId: 9999 }] }), 'match');
});

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

test('incremental evidence recomputes only changed matches and removes evicted matches', () => {
  const loader = createLoader({ '@/utils/logger': { logger: silentLogger } });
  const evidence = loader('src/recentMatch/utils/historyEvidence.ts');
  const membership = loader('src/recentMatch/utils/partyMembership.ts');
  const games = [fullGame(1), fullGame(2)];
  const first = new Map([['p0', snapshot(games)]]);
  const initial = evidence.buildHistoryEvidence(first);
  membership.buildPartyMembership([player(0), player(1)], initial);
  const before = membership.partyMembershipStats().evaluatedGames;
  const replacement = { ...games[1], participants: games[1].participants.map(p => ({ ...p, win: false })) };
  const second = new Map([['p0', snapshot([games[0], replacement, fullGame(3)])]]);
  const updated = evidence.buildHistoryEvidence(second, first);
  assert.equal(evidence.historyEvidenceStats(second).updatedGames, 2);
  assert.equal(updated.get(1), initial.get(1));
  membership.buildPartyMembership([player(0), player(1)], updated);
  assert.equal(membership.partyMembershipStats().evaluatedGames - before, 2);
  assert.equal(evidence.buildHistoryEvidence(second), updated);
  const third = new Map([['p0', snapshot([replacement])]]);
  assert.equal(evidence.buildHistoryEvidence(third, second).has(1), false);
  assert.equal(initial.get(2), games[1]);
});

test('moderation-only refresh preserves structural scores and new snapshot invalidates cached analysis', () => {
  const team = [player(0), player(1)];
  const games = [fullGame(1), fullGame(2)];
  const snapshots = new Map(team.map(p => [p.puuid, snapshot(games)]));
  analytics.applyTeamAnalysis(team, [], snapshots, new Map(), 420, 99);
  const before = team[0].recentAnalysis;
  analytics.applyTeamAnalysis(team, [], snapshots, new Map([['p0', { available: true, marked: true, reportCount: 2 }]]), 420, 99);
  const after = team[0].recentAnalysis;
  assert.equal(after.partyGroups[0].confidence.score, before.partyGroups[0].confidence.score);
  assert.equal(after.partyGroups[0].evidence, before.partyGroups[0].evidence);
  assert.equal(after.partyGroups[0].blacklistedMembers.length, 1);
  assert.equal(before.partyGroups[0].blacklistedMembers.length, 0);
  const updated = new Map(team.map(p => [p.puuid, snapshot([...games, fullGame(3)])]));
  analytics.applyTeamAnalysis(team, [], updated, new Map(), 420, 99);
  assert.equal(team[0].recentAnalysis.partyGroups[0].historicalGames, 3);
  assert.equal(team[0].recentAnalysis.partyGroups[0].blacklistedMembers.length, 0);
});

test('membership index agrees with direct enumeration and does not join pairwise-only triples', () => {
  const loader = createLoader();
  const { buildPartyMembership } = loader('src/recentMatch/utils/partyMembership.ts');
  const team = [0, 1, 2, 3, 4].map(player);
  const games = Array.from({ length: 32 }, (_, bits) => {
    const g = fullGame(bits + 1);
    return { ...g, participants: g.participants.map((p, i) => i < 5 ?
      { ...p, teamId: bits & (1 << i) ? 100 : 200 } : p) };
  });
  const actual = buildPartyMembership(team, new Map(games.map(g => [g.gameId, g])));
  for (let mask = 1; mask < 32; mask++) {
    const members = team.filter((_, i) => mask & (1 << i));
    if (members.length < 2) continue;
    const expected = games.filter(g => {
      const found = members.map(p => g.participants.find(v => v.puuid === p.puuid));
      return found.every(p => p.teamId === found[0].teamId);
    }).map(g => g.gameId);
    assert.deepEqual(actual.get(members.map(p => p.puuid).sort().join('|')), expected);
  }
});

test('legacy nickname-only self is never counted as a teammate', () => {
  const self = { ...player(0), summonerName: 'Legacy' };
  const games = [fullGame(1), fullGame(2)].map(g => ({ ...g,
    participants: g.participants.map((p, i) => i === 0 ? {
      ...p, puuid: 'summoner-name:legacy', summonerId: undefined, summonerName: 'Legacy',
    } : p),
  }));
  const result = analytics.buildTeammateSynergy(self, snapshot(games), new Map());
  assert.equal(result.length, 4);
  assert.equal(result.some(g => g.teammate.puuid === 'summoner-name:legacy'), false);
  const groups = analytics.buildPlayerPartyGroups(self, snapshot(games), new Map());
  assert.equal(groups.some(g => g.members.some(p => p.puuid === 'summoner-name:legacy')), false);
});
