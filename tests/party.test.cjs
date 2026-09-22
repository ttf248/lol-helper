const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./load-ts.cjs');
const load = createLoader();
const { participantMatchesPlayer, findPlayerParticipant, findParticipant } = load('src/recentMatch/utils/participantLookup.ts');
const a = { puuid: 'a', summonerId: 1, summonerName: 'Same#A' };
const b = { puuid: 'b', summonerId: 2, summonerName: 'Same#B' };

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
