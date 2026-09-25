import test from 'node:test';
import assert from 'node:assert/strict';
import type { Market } from '../lib/market/types';
import type { SportsContext } from '../lib/sports-context/types';
import { latestNflPlay, nflProbabilityUrl, readNflEstimate, nflReferenceInput } from '../lib/bot/nfl-reference.ts';

// Synthetic engineering fixtures with field shapes checked against actual ESPN
// core-play/probability and Polymarket US responses. Never production game data.
const now = Date.parse('2026-09-25T01:08:00Z');
const gameId = '9001';
const base = `/v2/sports/football/leagues/nfl/events/${gameId}/competitions/${gameId}`;
const ref = (path: string) => ({ $ref: `http://sports.core.api.espn.com${path}?lang=en&region=us` });
const teamRef = (id: string) => ref(`/v2/sports/football/leagues/nfl/seasons/2026/teams/${id}`);

function fixture() {
  const market: Market = {
    slug: 'synthetic-nfl-winner', id: '8001', gameId: '8000', title: 'Away Team win', game: 'Away Team at Home Team',
    question: '', rules: '', league: 'NFL', start: '2026-09-25T00:15:00Z', kind: 'football_team_full_game_winner',
    teams: [{ id: 900, name: 'Away Team', abbreviation: 'AWY' }, { id: 901, name: 'Home Team', abbreviation: 'HME' }],
    bid: null, ask: null, price: null, volume: null, fee: 0.0695, active: true, history: [], signals: [], observedAt: now,
  };
  const context: SportsContext = {
    slug: market.slug, league: 'NFL', status: 'available', receivedAt: now - 2_000,
    source: { name: 'Synthetic ESPN fixture', url: 'https://example.invalid/summary', support: 'public-undocumented' },
    game: { id: gameId, start: market.start, state: 'live', statusText: 'In Progress', period: 'Q2', clock: '10:34',
      away: { id: '10', name: 'Away Team', abbreviation: 'AWY', score: 7 },
      home: { id: '20', name: 'Home Team', abbreviation: 'HME', score: 7 } },
    players: [], changes: [], limitations: [], injuryStatus: 'not_verified',
  };
  const play = (id: string, sequenceNumber: string) => ({
    id, sequenceNumber, wallclock: new Date(now - 20_000).toISOString(), homeScore: 7 as unknown, awayScore: 7 as unknown,
    period: { number: 2 }, probability: ref(`${base}/probabilities/${id}`),
  });
  // Intentionally unsorted; lexical sort would select sequence 9 over 10.
  const plays = { pageCount: 1, count: 2, items: [play('900120', '10'), play('900110', '9')] };
  const probability = {
    ...ref(`${base}/probabilities/900120`), competition: ref(base), play: ref(`${base}/plays/900120`),
    homeTeam: teamRef('20'), awayTeam: teamRef('10'), sequenceNumber: '10',
    homeWinPercentage: 0.7 as unknown, awayWinPercentage: 0.3 as unknown, tiePercentage: 0 as unknown,
    // Actual provider responses contained a future lastModified and secondsLeft:0
    // in Q2. Neither is an acceptable substitute for the linked play wallclock.
    lastModified: '2026-09-25T04:07Z', secondsLeft: 0,
  };
  const metadata = { marketSides: [
    { long: true, description: 'Away Team', team: { id: 900, name: 'Away Team', abbreviation: 'AWY' } },
    { long: false, description: 'Home Team', team: { id: 901, name: 'Home Team', abbreviation: 'HME' } },
  ] };
  return { market, context, plays, probability, metadata };
}

function withEstimate() {
  const f = fixture();
  const read = readNflEstimate(f.context, f.plays, f.probability, now);
  assert.ok(read.estimate, read.reason);
  f.context.winEstimate = read.estimate;
  return f;
}

test('latest play requires complete history and sorts numeric sequences without changing input', () => {
  const { plays } = fixture();
  const before = structuredClone(plays);
  assert.equal(latestNflPlay(plays)?.id, '900120');
  assert.deepEqual(plays, before);
  assert.equal(latestNflPlay({ ...plays, pageCount: 2 }), null);
  assert.equal(latestNflPlay({ ...plays, count: 3 }), null);
  assert.equal(latestNflPlay({ pageCount: 1, count: 0, items: [] }), null);
  assert.equal(latestNflPlay({ ...plays, items: plays.items.map(p => ({ ...p, sequenceNumber: '10' })) }), null);
  assert.equal(latestNflPlay({ ...plays, items: [plays.items[0], { ...plays.items[1], sequenceNumber: 'NaN' }] }), null);
});

test('probability request follows only the exact latest-play reference on the fixed ESPN host', () => {
  const f = fixture();
  assert.equal(nflProbabilityUrl(f.plays, gameId), `https://sports.core.api.espn.com${base}/probabilities/900120?lang=en&region=us`);
  for (const bad of [
    `https://attacker.example${base}/probabilities/900120`,
    `https://sports.core.api.espn.com.evil.example${base}/probabilities/900120`,
    `https://user:secret@sports.core.api.espn.com${base}/probabilities/900120`,
    `https://sports.core.api.espn.com:8443${base}/probabilities/900120`,
    `https://sports.core.api.espn.com${base}/probabilities/900110`,
  ]) {
    const copy = fixture(); copy.plays.items[0].probability.$ref = bad;
    assert.equal(nflProbabilityUrl(copy.plays, gameId), null, bad);
  }
  assert.equal(nflProbabilityUrl(f.plays, '../9001'), null);
});

test('accepts exact game, latest play, teams, scores and probability; uses play clock for freshness', () => {
  const f = fixture(), result = readNflEstimate(f.context, f.plays, f.probability, now);
  assert.ok(result.estimate, result.reason);
  assert.equal(result.estimate.playId, '900120');
  assert.equal(result.estimate.gameId, gameId);
  assert.equal(result.estimate.homeProbability, 0.7);
  assert.equal(result.estimate.awayProbability, 0.3);
  assert.equal(result.estimate.playTime, now - 20_000);
  assert.equal(result.estimate.receivedAt, now);
});

test('rejects nonfinite probability receipts instead of allowing NaN comparisons to pass', () => {
  const f = fixture();
  for (const receivedAt of [NaN, Infinity, -Infinity]) {
    assert.equal(readNflEstimate(f.context, f.plays, f.probability, receivedAt).estimate, undefined, String(receivedAt));
  }
});

test('rejects stale, future and missing play wallclocks even with a fresh probability receipt', () => {
  for (const wallclock of [new Date(now - 120_001).toISOString(), new Date(now + 1).toISOString(), '', 'invalid']) {
    const f = fixture(); f.plays.items[0].wallclock = wallclock;
    assert.equal(readNflEstimate(f.context, f.plays, f.probability, now).estimate, undefined, wallclock);
  }
});

test('missing scores cannot become zero and score or period disagreements must wait', () => {
  for (const missing of [null, undefined, '']) {
    const f = fixture(); f.context.game!.home.score = 0; f.plays.items[0].homeScore = missing;
    assert.equal(readNflEstimate(f.context, f.plays, f.probability, now).estimate, undefined, String(missing));
  }
  const score = fixture(); score.plays.items[0].awayScore = 14;
  assert.equal(readNflEstimate(score.context, score.plays, score.probability, now).estimate, undefined);
  const period = fixture(); period.plays.items[0].period.number = 3;
  assert.equal(readNflEstimate(period.context, period.plays, period.probability, now).estimate, undefined);
});

test('rejects probability references to another play, event, team or sequence', () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.probability.$ref = ref(`${base}/probabilities/900110`).$ref; },
    f => { f.probability.play = ref(`${base}/plays/900110`); },
    f => { f.probability.competition = ref('/v2/sports/football/leagues/nfl/events/9999/competitions/9999'); },
    f => { f.probability.homeTeam = teamRef('10'); },
    f => { f.probability.awayTeam = teamRef('20'); },
    f => { f.probability.sequenceNumber = '9'; },
    f => { f.probability.play.$ref = `https://attacker.example${base}/plays/900120`; },
  ];
  for (const [i, change] of mutations.entries()) {
    const f = fixture(); change(f);
    assert.equal(readNflEstimate(f.context, f.plays, f.probability, now).estimate, undefined, `mismatch ${i}`);
  }
});

test('rejects missing, invalid, inconsistent or unmodeled tie probabilities', () => {
  for (const [home, away, tie] of [[null, 0.3, 0], [NaN, 0.3, 0], [1.1, -0.1, 0], [0.7, 0.5, 0], [0.65, 0.3, 0.05]]) {
    const f = fixture();
    f.probability.homeWinPercentage = home; f.probability.awayWinPercentage = away; f.probability.tiePercentage = tie;
    assert.equal(readNflEstimate(f.context, f.plays, f.probability, now).estimate, undefined);
  }
});

test('development replay, final games and unavailable contexts cannot create a live estimate', () => {
  const replay = fixture(); replay.context.replayAt = now;
  assert.equal(readNflEstimate(replay.context, replay.plays, replay.probability, now).estimate, undefined);
  const final = fixture(); final.context.game!.state = 'final';
  assert.equal(readNflEstimate(final.context, final.plays, final.probability, now).estimate, undefined);
  const unavailable = fixture(); unavailable.context.status = 'unavailable';
  assert.equal(readNflEstimate(unavailable.context, unavailable.plays, unavailable.probability, now).estimate, undefined);
});

test('YES mapping follows US long side identity, not array order or incompatible provider IDs', () => {
  const f = withEstimate(); f.metadata.marketSides.reverse();
  const away = nflReferenceInput(f.market, f.context, f.metadata, now);
  assert.equal(away.status, 'available');
  if (away.status !== 'available') return;
  assert.equal(away.yesTeamId, '10'); assert.equal(away.yesProbability, 0.3);
  assert.equal(away.playerImpactModeled, false);
  f.metadata.marketSides.forEach(side => { side.long = !side.long; });
  const home = nflReferenceInput(f.market, f.context, f.metadata, now);
  assert.equal(home.status, 'available');
  if (home.status !== 'available') return;
  assert.equal(home.yesTeamId, '20'); assert.equal(home.yesProbability, 0.7);
});

test('ambiguous YES sides or conflicting US team identity cannot map to a reference probability', () => {
  const both = withEstimate(); both.metadata.marketSides.forEach(side => { side.long = true; });
  assert.equal(nflReferenceInput(both.market, both.context, both.metadata, now).status, 'unavailable');
  const none = withEstimate(); none.metadata.marketSides.forEach(side => { side.long = false; });
  assert.equal(nflReferenceInput(none.market, none.context, none.metadata, now).status, 'unavailable');
  const conflict = withEstimate(); conflict.metadata.marketSides[0].team.name = 'Different Team';
  assert.equal(nflReferenceInput(conflict.market, conflict.context, conflict.metadata, now).status, 'unavailable');
});

test('summary, estimate and linked play ages are independently bounded', () => {
  const changes: ((f: ReturnType<typeof withEstimate>) => void)[] = [
    f => { f.context.receivedAt = now - 45_001; },
    f => { f.context.winEstimate!.receivedAt = now - 45_001; },
    f => { f.context.winEstimate!.playTime = now - 120_001; },
    f => { f.context.receivedAt = now + 1; },
    f => { f.context.winEstimate!.receivedAt = now + 1; },
    f => { f.context.winEstimate!.playTime = now + 1; },
  ];
  for (const [i, change] of changes.entries()) {
    const f = withEstimate(); change(f);
    assert.equal(nflReferenceInput(f.market, f.context, f.metadata, now).status, 'unavailable', `age boundary ${i}`);
  }
});

test('nonfinite now, summary receipt, estimate receipt and play timestamps cannot pass the final entry input', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const f = withEstimate();
    assert.equal(nflReferenceInput(f.market, f.context, f.metadata, invalid).status, 'unavailable', `now ${invalid}`);
    for (const key of ['summary', 'estimate', 'play'] as const) {
      const changed = withEstimate();
      if (key === 'summary') changed.context.receivedAt = invalid;
      if (key === 'estimate') changed.context.winEstimate!.receivedAt = invalid;
      if (key === 'play') changed.context.winEstimate!.playTime = invalid;
      assert.equal(nflReferenceInput(changed.market, changed.context, changed.metadata, now).status, 'unavailable', `${key} ${invalid}`);
    }
  }
});

test('entry input rejects missing estimate, wrong market/event and development replay', () => {
  const f = withEstimate();
  assert.equal(nflReferenceInput(f.market, { ...f.context, winEstimate: undefined }, f.metadata, now).status, 'unavailable');
  assert.equal(nflReferenceInput({ ...f.market, slug: 'other-market' }, f.context, f.metadata, now).status, 'unavailable');
  assert.equal(nflReferenceInput({ ...f.market, kind: 'football_spread' }, f.context, f.metadata, now).status, 'unavailable');
  assert.equal(nflReferenceInput({ ...f.market, league: 'MLB' }, f.context, f.metadata, now).status, 'unavailable');
  assert.equal(nflReferenceInput(f.market, { ...f.context, replayAt: now }, f.metadata, now).status, 'unavailable');
  f.context.winEstimate!.gameId = '9999';
  assert.equal(nflReferenceInput(f.market, f.context, f.metadata, now).status, 'unavailable');
});
