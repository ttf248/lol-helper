const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./load-ts.cjs');
const fixtures = require('./party.fixtures.cjs');
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

  // 团队级缓存为空时，仍应回退到逐玩家历史证据，不能丢掉近期三局判定。
  const fallback = analytics.buildCurrentTeamPartyGroups(
    team,
    both,
    current,
    new Map(),
    new Map(),
  )[0];
  assert.equal(fallback.recentWindowGames, 3);

  const cachedOnly = new Map(
    ["p0", "p1"].map((puuid) => [
      puuid,
      { ...snapshot(games), recentHistoryVerified: false },
    ]),
  );
  const cachedFallback = analytics.buildCurrentTeamPartyGroups(
    team,
    cachedOnly,
    current,
    new Map(),
    new Map(),
  )[0];
  assert.equal(cachedFallback.recentWindowGames, 3);
});

test('recent three-game groups and legacy historical groups are both retained', () => {
  const team = [0, 1, 2, 3].map(player);
  const now = Date.now();
  const withTeam = (game, team100) => ({
    ...game,
    participants: game.participants.map((participant, index) => ({
      ...participant,
      teamId: team100.includes(index) ? 100 : 200,
    })),
  });
  const recentGames = [1, 2, 3].map((id, index) =>
    withTeam(fullGame(id, now - index * 1000), [0, 1, 2, 4, 5]),
  );
  const legacyGames = [101, 102].map((id, index) =>
    withTeam(fullGame(id, now - 100000 - index * 1000), [0, 3, 4, 5, 6]),
  );
  const snapshots = new Map(
    team.map((item) => [item.puuid, snapshot([...recentGames, ...legacyGames])]),
  );
  const current = analytics.buildCurrentMatchGame(team, [], 420, 999);
  const groups = analytics.buildCurrentTeamPartyGroups(
    team,
    snapshots,
    current,
    new Map(),
  );
  assert.equal(
    groups.some(
      (group) =>
        group.relationKind === 'recent' &&
        group.members.length === 3 &&
        group.members.every((member) => ['p0', 'p1', 'p2'].includes(member.puuid)),
    ),
    true,
  );
  assert.equal(
    groups.some(
      (group) =>
        group.relationKind === 'historical' &&
        group.members.length === 2 &&
        group.members.every((member) => ['p0', 'p3'].includes(member.puuid)),
    ),
    true,
  );
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
  // 180 天前的旧对局经过 30 天半衰期后衰减到接近 0；新公式允许至多 1 分噪声，
  // 旧公式严格 0。两者语义一致：非常久远的关系不应被渲染为稳定组队。
  assert.ok(result.stabilityScore < 2, `expected < 2, got ${result.stabilityScore}`);
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

// ── 真实数据回归测试 ─────────────────────────────────────────────
// 以下用例基于 PostgreSQL 中 puuid 8d7b0b53-410e-51df-86b7-905eee83b581（鼠标加键盘）
// 的真实阵容：最近 5 场 hex-aram 中 4 场是「玩家+中意+Uzi+solo+1is」5 黑，
// 1 场是「玩家+Uzi+solo+1is+可劲得瑟吧提莫」4 黑 + 1 路人。

test('T1: 单场路人不再把 consecutive 归零（窗口内 evidence 占比生效）', () => {
  // 使用 10 场历史让 size=5 组合同样过 required=5 门槛。
  const nowMs = Date.now();
  const games = fixtures.buildPlayerHistoricalTenGames(nowMs);
  const player = fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.player, '鼠标加键盘');
  const teammates = [
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.zhongyi, '中意不如介意'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.uzi, 'Uzi'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.solo, 'solo'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.yisi, '1is'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.stray, '可劲得瑟吧提莫'),
  ];
  const allPlayers = [player, ...teammates];
  const snapshots = new Map(allPlayers.map(p => [p.puuid, fixtures.snapshot(games)]));
  const structures = analytics.buildPartyGroupsStructure(
    allPlayers,
    snapshots,
    { evidence: new Map(games.map(g => [g.gameId, g])) },
  );
  // size=5「玩家+中意+Uzi+solo+1is」应在历史 evidence 中出现 9 次（不含路人场）
  const fullFive = structures.find(s =>
    s.members.length === 5 &&
    s.members.every(m => m.puuid !== fixtures.CORE_PUUIDS.stray),
  );
  assert.ok(fullFive, 'should have a size=5 group without the stray player');
  assert.equal(fullFive.games, 9);
  assert.equal(fullFive.historicalGames, 9);
  // 新公式：即使夹了一次路人（游戏 0 是路人场），
  // 最近窗口内 evidence 占比 0.8 + 连续 8 场仍让 stabilityScore 保持高位。
  assert.ok(fullFive.stabilityScore >= 70,
    `expected >= 70, got ${fullFive.stabilityScore}`);
  assert.equal(fullFive.minMemberFrequency, 9);
});

test('T2: size=5 队伍夹路人时 size=4 子组合胜出', () => {
  const nowMs = Date.now();
  const games = fixtures.buildPlayerHistoricalTenGames(nowMs);
  const player = fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.player, '鼠标加键盘');
  const teammates = [
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.zhongyi, '中意不如介意'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.uzi, 'Uzi'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.solo, 'solo'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.yisi, '1is'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.stray, '可劲得瑟吧提莫'),
  ];
  const allPlayers = [player, ...teammates];
  const snapshots = new Map(allPlayers.map(p => [p.puuid, fixtures.snapshot(games)]));
  const groups = analytics.buildPlayerPartyGroups(player, snapshots.get(player.puuid), new Map());
  const size4 = groups.find(g => g.members.length === 4);
  const size5 = groups.find(g => g.members.length === 5);
  assert.ok(size4, 'should have a size=4 group (player+Uzi+solo+1is)');
  assert.ok(size5, 'should have a size=5 group (player+中意+Uzi+solo+1is)');
  // size=4 子组合应当胜出：历史 10 场 vs size=5 的 9 场
  assert.ok(size4.stabilityScore > size5.stabilityScore,
    `expected size=4 (${size4.stabilityScore}) > size=5 (${size5.stabilityScore})`);
  assert.equal(size4.historicalGames, 10);
  assert.equal(size5.historicalGames, 9);
  assert.equal(size4.minMemberFrequency, 10);
  assert.equal(size5.minMemberFrequency, 9);
});

test('T3: size=5 历史统计不受单场路人影响', () => {
  const nowMs = Date.now();
  const games = fixtures.buildPlayerHistoricalTenGames(nowMs);
  const player = fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.player, '鼠标加键盘');
  const teammates = [
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.zhongyi, '中意不如介意'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.uzi, 'Uzi'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.solo, 'solo'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.yisi, '1is'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.stray, '可劲得瑟吧提莫'),
  ];
  const allPlayers = [player, ...teammates];
  const snapshots = new Map(allPlayers.map(p => [p.puuid, fixtures.snapshot(games)]));
  const structures = analytics.buildPartyGroupsStructure(
    allPlayers,
    snapshots,
    { evidence: new Map(games.map(g => [g.gameId, g])) },
  );
  const fullFive = structures.find(s =>
    s.members.length === 5 &&
    s.members.every(m => m.puuid !== fixtures.CORE_PUUIDS.stray),
  );
  assert.ok(fullFive, 'should have a size=5 group without stray');
  assert.equal(fullFive.historicalGames, 9,
    'size=5「玩家+中意+Uzi+solo+1is」9 场历史，不应被路人场污染');
  const strayGroup = structures.find(s =>
    s.members.length === 5 &&
    s.members.some(m => m.puuid === fixtures.CORE_PUUIDS.stray),
  );
  assert.equal(strayGroup, undefined,
    '「玩家+Uzi+solo+1is+可劲」路人组 historicalGames=1 < required=5，应被过滤');
});

test('T4: stabilityScore 封顶随 size 缩放', () => {
  // size=2 4 场（cap=4，满分）；size=5 5 场（cap=10，0.5 即满分 50%）
  const nowMs = Date.now();
  const sixGames = Array.from({ length: 6 }, (_, i) => {
    const g = fullGame(i + 1, nowMs - i * 60000);
    return g;
  });
  const p0 = player(0);
  const p1 = player(1);
  const p2 = player(2);
  const p3 = player(3);
  const p4 = player(4);

  // 2 人组合：6 场同队
  const snapshotsSize2 = new Map([
    [p0.puuid, snapshot(sixGames)],
    [p1.puuid, snapshot(sixGames)],
  ]);
  const size2Result = analytics.buildPartyGroupsStructure(
    [p0, p1], snapshotsSize2,
    { evidence: new Map(sixGames.map(g => [g.gameId, g])) },
  )[0];
  // 5 人组合：6 场同队（p0..p4 全在 100 队）
  const snapshotsSize5 = new Map(
    [p0, p1, p2, p3, p4].map(p => [p.puuid, snapshot(sixGames)]),
  );
  const size5Result = analytics.buildPartyGroupsStructure(
    [p0, p1, p2, p3, p4], snapshotsSize5,
    { evidence: new Map(sixGames.map(g => [g.gameId, g])) },
  ).find(s => s.members.length === 5);
  assert.ok(size2Result && size5Result, 'both groups should exist');
  assert.equal(size2Result.games, 6);
  assert.equal(size5Result.games, 6);
  // 同样 6 场 evidence：
  //   size=2 第一项 40 * min(6/4, 1) = 40 (封顶)
  //   size=5 第一项 40 * min(6/10, 1) = 24
  // size=2 在第一项明显高于 size=5。
  // 第二项（ratio*decay）相同；第三项（consecutive/windowRatio）相同；
  // 第四项（minMemberFrequency）：size=2 cap=3, size=5 cap=7.5，都满。
  // 因此 size=2 stabilityScore 应严格高于 size=5。
  assert.ok(size2Result.stabilityScore > size5Result.stabilityScore,
    `size=2 (${size2Result.stabilityScore}) should be > size=5 (${size5Result.stabilityScore})`);
  // 第一项贡献差距约 16 分（40 - 24）
  const scoreDiff = size2Result.stabilityScore - size5Result.stabilityScore;
  assert.ok(scoreDiff >= 10,
    `expected score diff >= 10, got ${scoreDiff}`);
});

test('T5: 现有稳定性不依赖胜负与举报（回归保护）', () => {
  // 与既有 "party strength is independent of wins" 一致；新公式下仍如此。
  const games = Array.from({ length: 5 }, (_, i) => fullGame(i + 1));
  const team = [player(0), player(1)];
  const snapshots = new Map([['p0', snapshot(games)], ['p1', snapshot(games)]]);
  const structure = analytics.buildPartyGroupsStructure(team, snapshots)[0];
  const losses = games.map(g => ({
    ...g,
    participants: g.participants.map(p => ({ ...p, win: false })),
  }));
  const lossStructure = analytics.buildPartyGroupsStructure(
    team, new Map([['p0', snapshot(losses)]]),
  )[0];
  assert.equal(structure.stabilityScore, lossStructure.stabilityScore);
});

// T6 / T7 复用 fixtures 验证首页开黑分析 composable 链路：
// buildPartyGroupsStructure → applyPartyGroupOverlay → selectPrimaryPartyGroups

test('T6: 首页开黑分析复用 buildPartyGroupsStructure 输出正确结构', () => {
  // 5 名玩家 + 9 场 5 黑对局 → 应输出 size=5 全员组合 key 多起，historicalGames=9。
  const nowMs = Date.now();
  const games = fixtures.buildPlayerHistoricalTenGames(nowMs);
  const player = fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.player, '鼠标加键盘');
  const teammates = [
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.zhongyi, '中意不如介意'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.uzi, 'Uzi'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.solo, 'solo'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.yisi, '1is'),
  ];
  const allPlayers = [player, ...teammates];
  const snapshots = new Map(allPlayers.map(p => [p.puuid, fixtures.snapshot(games)]));
  const structures = analytics.buildPartyGroupsStructure(
    allPlayers, snapshots,
    { evidence: new Map(games.map(g => [g.gameId, g])) },
  );
  const fullFive = structures.find(s => s.members.length === 5);
  assert.ok(fullFive, 'should have a size=5 group');
  assert.equal(fullFive.historicalGames, 9);
  // overlay 后 evidence.count == games == 5（size=5 时）
  const overlay = analytics.applyPartyGroupOverlay(fullFive, new Map(), Date.now());
  assert.equal(overlay.members.length, 5);
  assert.equal(overlay.historicalGames, 9);
});

test('T7: 首页开黑 chip 标记：size=4 子组合胜出 size=5 全员组合', () => {
  const nowMs = Date.now();
  const games = fixtures.buildPlayerHistoricalTenGames(nowMs);
  const player = fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.player, '鼠标加键盘');
  const teammates = [
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.zhongyi, '中意不如介意'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.uzi, 'Uzi'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.solo, 'solo'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.yisi, '1is'),
  ];
  const allPlayers = [player, ...teammates];
  const snapshots = new Map(allPlayers.map(p => [p.puuid, fixtures.snapshot(games)]));
  const structures = analytics.buildPartyGroupsStructure(
    allPlayers, snapshots,
    { evidence: new Map(games.map(g => [g.gameId, g])) },
  );
  const groups = structures.map(s => analytics.applyPartyGroupOverlay(s, new Map(), Date.now()));
  // selectPrimaryPartyGroups 输出形如「原始链表里按稳定性筛出的互不重叠小组」。
  const primary = selectPartyGroups(groups, { showSubgroups: false });
  const size4 = primary.find(g => g.members.length === 4);
  const size5 = primary.find(g => g.members.length === 5);
  assert.ok(size4 && size5, 'primary 应同时包含 size=4 子组合和 size=5 全员组合');
  // 用户口述"最近两局四黑、前面五黑"与 size=4 子组合胜出对应。
  assert.ok(size4.stabilityScore > size5.stabilityScore,
    `expected size=4 (${size4.stabilityScore}) > size=5 (${size5.stabilityScore})`);
  assert.equal(size4.historicalGames, 10);
  assert.equal(size5.historicalGames, 9);
});

// --- partyDisplay.ts 视觉辅助函数回归保护 ---
// 这些测试只锁显示层文案 / 派生 key 的契约，确保未来重构不会
// 把 "· N场" 之类历史统计重新带回到 chip 里。
const displayModule = createLoader()('src/recentMatch/utils/partyDisplay.ts');
const { partyGroupStableKey } = displayModule;

test('partyGroupStableKey: 顺序无关、相同 PUUID 集合派生同一 key', () => {
  const makeGroup = (puuidOrder) => ({
    members: puuidOrder.map((puuid) => ({ puuid })),
  });
  const group123 = makeGroup(['p1', 'p2', 'p3']);
  const group321 = makeGroup(['p3', 'p2', 'p1']);
  const group213 = makeGroup(['p2', 'p1', 'p3']);
  const key123 = partyGroupStableKey(group123);
  const key321 = partyGroupStableKey(group321);
  const key213 = partyGroupStableKey(group213);
  assert.equal(key123, 'p1|p2|p3');
  assert.equal(key321, key123, '顺序不同也应派生同一 key');
  assert.equal(key213, key123, '任意排列都应派生同一 key');
});

test('partyGroupStableKey: 不同 PUUID 集合派生不同 key', () => {
  const groupA = { members: [{ puuid: 'p1' }, { puuid: 'p2' }] };
  const groupB = { members: [{ puuid: 'p1' }, { puuid: 'p3' }] };
  assert.notEqual(
    partyGroupStableKey(groupA),
    partyGroupStableKey(groupB),
    '只差一名成员的组必须派生不同 key',
  );
});

test('partyGroupStableKey: 过滤掉无 puuid 的成员', () => {
  const group = {
    members: [
      { puuid: 'p1' },
      { puuid: '' },
      { puuid: null },
      { puuid: 'p2' },
      {},
    ],
  };
  // 空 puuid / null / 缺字段都应被剔除，避免污染 key
  assert.equal(partyGroupStableKey(group), 'p1|p2');
});

// --- 凝聚力 fallback（修复 "4-黑 打了 2 场被拆成 2+2"）---

// 4 个真实黑友只同队了 2 次：size-based 默认门槛 size=4≥4 走不过，
// 但 6 对 PUUID 都各同队 2 场 → 凝聚力 fallback 应让 size=4 保留。
test('T8: 4-黑 只同队 2 场，凝聚力 fallback 让 size=4 保留', () => {
  const nowMs = Date.now();
  const fourBlack = [
    fixtures.CORE_PUUIDS.player,
    fixtures.CORE_PUUIDS.uzi,
    fixtures.CORE_PUUIDS.solo,
    fixtures.CORE_PUUIDS.yisi,
  ];
  const games = [
    fixtures.makeHexAramTeam({
      gameId: 3001,
      gameCreation: nowMs - 0,
      ownPuuids: fourBlack,
    }),
    fixtures.makeHexAramTeam({
      gameId: 3002,
      gameCreation: nowMs - 30 * 60 * 1000,
      ownPuuids: fourBlack,
    }),
  ];
  const players = fourBlack.map((puuid, i) =>
    fixtures.playerFromPuuid(puuid, `member-${i}`),
  );
  const snapshots = new Map(
    players.map((p) => [p.puuid, fixtures.snapshot(games)]),
  );
  const structures = analytics.buildPartyGroupsStructure(players, snapshots);
  const groups = structures.map((s) =>
    analytics.applyPartyGroupOverlay(s, new Map(), Date.now()),
  );
  const size4 = groups.find((g) => g.members.length === 4);
  assert.ok(size4, '4-黑 打了 2 场也应识别为 size=4 组');
  assert.equal(size4.historicalGames, 2);
  // 用户视角：通过 selectPrimaryPartyGroups 后仍是 1 个 4 人 chip，
  // 不是 2 个 2 人 chip。
  const { selectPrimaryPartyGroups } = createLoader()(
    'src/recentMatch/utils/partyPresentation.ts',
  );
  const primary = selectPrimaryPartyGroups(groups, 2);
  assert.equal(primary.length, 1, '4-黑不应该被拆成 2+2');
  assert.equal(primary[0].members.length, 4);
  assert.equal(primary[0].relationKind, 'historical');
});

// 控制组：4 名玩家两两只在随机场次相遇 1 次 → 凝聚力拒绝，不会
// 误识别为 4-黑。
test('T9: 4 人随机各只同队 1 次不会被误判为 4-黑', () => {
  const nowMs = Date.now();
  const playerPu = fixtures.CORE_PUUIDS.player;
  const uziPu = fixtures.CORE_PUUIDS.uzi;
  const soloPu = fixtures.CORE_PUUIDS.solo;
  const yisiPu = fixtures.CORE_PUUIDS.yisi;
  // 单场 4 人同队一次，但四人后续再也没有一起。
  const singleGame = fixtures.makeHexAramTeam({
    gameId: 4001,
    gameCreation: nowMs - 0,
    ownPuuids: [playerPu, uziPu, soloPu, yisiPu],
  });
  // 另外两场分别只有 player+uzi 和 solo+yisi，避免 player+solo 等其他对
  // 反复刷出 2+ 场。
  const onlyUzi = fixtures.makeHexAramTeam({
    gameId: 4002,
    gameCreation: nowMs - 30 * 60 * 1000,
    ownPuuids: [playerPu, uziPu],
  });
  const onlySoloYisi = fixtures.makeHexAramTeam({
    gameId: 4003,
    gameCreation: nowMs - 60 * 60 * 1000,
    ownPuuids: [soloPu, yisiPu],
  });
  const players = [
    playerPu,
    uziPu,
    soloPu,
    yisiPu,
  ].map((puuid, i) => fixtures.playerFromPuuid(puuid, `m-${i}`));
  const snapshots = new Map(
    players.map((p) => [
      p.puuid,
      fixtures.snapshot([singleGame, onlyUzi, onlySoloYisi]),
    ]),
  );
  const structures = analytics.buildPartyGroupsStructure(players, snapshots);
  const size4 = structures.find((s) => s.members.length === 4);
  assert.equal(size4, undefined, '单场 4 人同队 1 次不构成 4-黑');
});

// 关闭凝聚 fallback（cohesionPairThreshold=Infinity）应回到原行为：
// 4-黑 只打了 2 场 size=4 走不过 size 门槛 → 不输出。
test('T10: cohesionPairThreshold=Infinity 关闭 fallback，回到 size-based 门槛', () => {
  const nowMs = Date.now();
  const fourBlack = [
    fixtures.CORE_PUUIDS.player,
    fixtures.CORE_PUUIDS.uzi,
    fixtures.CORE_PUUIDS.solo,
    fixtures.CORE_PUUIDS.yisi,
  ];
  const games = [
    fixtures.makeHexAramTeam({
      gameId: 5001,
      gameCreation: nowMs - 0,
      ownPuuids: fourBlack,
    }),
    fixtures.makeHexAramTeam({
      gameId: 5002,
      gameCreation: nowMs - 30 * 60 * 1000,
      ownPuuids: fourBlack,
    }),
  ];
  const players = fourBlack.map((puuid, i) =>
    fixtures.playerFromPuuid(puuid, `m-${i}`),
  );
  const snapshots = new Map(
    players.map((p) => [p.puuid, fixtures.snapshot(games)]),
  );
  const structures = analytics.buildPartyGroupsStructure(players, snapshots, {
    cohesionPairThreshold: Infinity,
  });
  const size4 = structures.find((s) => s.members.length === 4);
  assert.equal(size4, undefined, '关闭 fallback 后 size=4 不应输出');
  const size2 = structures.filter((s) => s.members.length === 2);
  assert.equal(size2.length, 6, '保留 6 个 size=2 子组合');
});

// 用户实际场景：玩家+Uzi 有额外的双黑历史，但本局的真实队伍是 4-黑
// (玩家+Uzi+solo+1is)。修复前的算法把 size=2 AB 的高 stabilityScore
// 排到 size=4 ABCD 之前 → 显示 2-黑；修复后 size-first 让 size=4 胜出。
test('T11: 含额外 AB-2黑历史的 4-黑，仍识别为完整 size=4', () => {
  const nowMs = Date.now();
  const fourBlack = [
    fixtures.CORE_PUUIDS.player,
    fixtures.CORE_PUUIDS.uzi,
    fixtures.CORE_PUUIDS.solo,
    fixtures.CORE_PUUIDS.yisi,
  ];
  const players = [
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.player, '玩家'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.uzi, 'Uzi'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.solo, 'solo'),
    fixtures.playerFromPuuid(fixtures.CORE_PUUIDS.yisi, '1is'),
  ];
  const games = [];
  // 5 局 4-黑：构成 4-黑主体
  for (let i = 0; i < 5; i += 1) {
    games.push(fixtures.makeHexAramTeam({
      gameId: 6000 + i,
      gameCreation: nowMs - i * 30 * 60 * 1000,
      ownPuuids: fourBlack,
    }));
  }
  // 5 局 AB 2-黑：玩家+Uzi 还有额外双人局，让 AB 的 stabilityScore 高过 ABCD
  for (let i = 0; i < 5; i += 1) {
    games.push(fixtures.makeHexAramTeam({
      gameId: 6100 + i,
      gameCreation: nowMs - (5 + i) * 30 * 60 * 1000,
      ownPuuids: [fixtures.CORE_PUUIDS.player, fixtures.CORE_PUUIDS.uzi],
    }));
  }
  const snapshots = new Map(
    players.map((p) => [p.puuid, fixtures.snapshot(games)]),
  );
  const structures = analytics.buildPartyGroupsStructure(players, snapshots);
  const groups = structures.map((s) =>
    analytics.applyPartyGroupOverlay(s, new Map(), Date.now()),
  );
  const { selectPrimaryPartyGroups } = createLoader()(
    'src/recentMatch/utils/partyPresentation.ts',
  );
  const primary = selectPrimaryPartyGroups(groups, 2);
  assert.equal(primary.length, 1, '4-黑不应被 AB 高稳定性挤掉');
  assert.equal(primary[0].members.length, 4, 'primary 必须是 size=4');
  const key = primary[0].members.map((m) => m.puuid).sort().join('|');
  assert.equal(
    key,
    [
      fixtures.CORE_PUUIDS.player,
      fixtures.CORE_PUUIDS.uzi,
      fixtures.CORE_PUUIDS.solo,
      fixtures.CORE_PUUIDS.yisi,
    ].sort().join('|'),
    'primary 必须是玩家+Uzi+solo+1is 这个 4-黑',
  );
});
