import test from 'node:test';
import assert from 'node:assert/strict';
import type { Market } from '../lib/market/types';
import type { ScheduleGame } from '../lib/sports-context/types';
import { dateKeys, matchingGame } from '../lib/sports-context/shared.ts';
import { mlbContext, mlbSchedule } from '../lib/sports-context/mlb.ts';
import { espnReferenceId, nflContext, nflSchedule } from '../lib/sports-context/nfl.ts';
import { reportedInjuries } from '../lib/sports-context/injuries.ts';

// Synthetic parser scenarios using field shapes verified against primary provider
// JSON. These names/stats are engineering fixtures, never production game data.
const now = Date.parse('2026-09-23T20:00:00Z');
const market: Market = { slug: 'synthetic-game', id: '1', gameId: '1', title: 'Home win', game: 'Away at Home', question: '', rules: '', league: 'MLB',
  start: '2026-09-23T17:10:00Z', teams: [{ id: 900, name: 'Away Team', abbreviation: 'AWY' }, { id: 901, name: 'Home Team', abbreviation: 'HME' }], kind: '',
  bid: null, ask: null, price: null, volume: null, fee: 0, active: true, history: [], signals: [], observedAt: now };
const game: ScheduleGame = { id: '123', start: market.start, state: 'live', statusText: 'In Progress',
  away: { id: '10', name: 'Away Team', abbreviation: 'AWY', score: 1 }, home: { id: '20', name: 'Home Team', abbreviation: 'HME', score: 2 }, sourceUrl: 'https://example.invalid' };

test('game matching uses unordered identities and refuses wrong date or ambiguous doubleheaders', () => {
  assert.equal(matchingGame({ ...market, teams: [...market.teams].reverse() }, [game]).game?.id, game.id);
  assert.equal(matchingGame({ ...market, start: '2026-09-24T17:10:00Z' }, [game]).game, null);
  assert.equal(matchingGame(market, [game, { ...game, id: '456', start: '2026-09-23T17:30:00Z' }]).game, null);
  assert.equal(matchingGame(market, [game, { ...game, id: '456', start: '2026-09-23T23:10:00Z' }]).game?.id, game.id);
  assert.equal(matchingGame({ ...market, teams: [market.teams[0]] }, [game]).game, null);
  assert.deepEqual(dateKeys('2026-09-25T00:15:00Z'), ['2026-09-25', '2026-09-24']);
});

function mlbFixture() {
  const person = (id: number, fullName: string) => ({ id, fullName });
  return { gamePk: 123, gameData: { datetime: { dateTime: market.start }, status: { abstractGameState: 'Live', detailedState: 'In Progress' },
    teams: { away: game.away, home: game.home }, players: { ID1: person(1, 'Home Starter'), ID2: person(2, 'Away Starter'), ID3: person(3, 'Home Reliever') },
    probablePitchers: { away: person(2, 'Away Starter'), home: person(1, 'Home Starter') } },
    liveData: { linescore: { inningState: 'Top', currentInningOrdinal: '7th', teams: { away: { runs: 1 }, home: { runs: 2 } } },
      boxscore: { teams: { home: { players: { ID1: { stats: { pitching: { numberOfPitches: 80, inningsPitched: '6.2' } } }, ID3: { stats: { pitching: { numberOfPitches: 4, inningsPitched: '0.1' } }, seasonStats: { pitching: { era: '3.10', inningsPitched: '40.2' } } } } } } },
      plays: { allPlays: [
        { about: { atBatIndex: 0, isTopInning: true, endTime: '2026-09-23T17:12:00Z' }, matchup: { pitcher: person(1, 'Home Starter') }, playEvents: [] },
        { about: { atBatIndex: 1, isTopInning: false, endTime: '2026-09-23T17:20:00Z' }, matchup: { pitcher: person(2, 'Away Starter') }, playEvents: [] },
        { about: { atBatIndex: 2, isTopInning: true, endTime: '2026-09-23T19:12:00Z' }, matchup: { pitcher: person(3, 'Home Reliever') }, playEvents: [
          { index: 0, details: { eventType: 'pitching_substitution' }, player: { id: 3 }, startTime: '2026-09-23T19:10:00Z' },
        ] },
      ] },
    } };
}

test('MLB pitching change needs actual substitution evidence and never compares opposing pitchers', () => {
  const context = mlbContext(mlbFixture(), market, game, now);
  assert.equal(context.changes.length, 1);
  assert.equal(context.changes[0].previous.name, 'Home Starter');
  assert.equal(context.changes[0].replacement.name, 'Home Reliever');
  assert.equal(context.changes[0].team, 'Home Team');
  assert.equal(context.changes[0].sourceEventTime, '2026-09-23T19:10:00.000Z');
  assert.equal(context.changes[0].detectedAt, now);
  assert.ok(context.changes[0].implications.some(f => f.includes('6.2 innings')));
  assert.equal(context.players.find(p => p.name === 'Home Reliever')?.stats.find(s => s.label === 'Game innings')?.value, '0.1');
  const again = mlbContext(mlbFixture(), market, game, now + 60_000, context);
  assert.equal(again.changes[0].detectedAt, now);
  const noEvidence = mlbFixture(); noEvidence.liveData.plays.allPlays[2].playEvents = [];
  assert.equal(mlbContext(noEvidence, market, game, now).changes.length, 0);
  assert.throws(() => mlbContext({ ...mlbFixture(), gamePk: 999 }, market, game, now), /match/);
});

test('MLB schedule parser uses verified gamePk and team fields and refuses unsafe IDs', () => {
  const rawGame = { gamePk: 123, gameDate: market.start, teams: { away: { team: game.away, score: 0 }, home: { team: game.home, score: 1 } }, status: { abstractGameState: 'Preview', detailedState: 'Scheduled' } };
  const parsed = mlbSchedule({ dates: [{ games: [rawGame, { ...rawGame, gamePk: '../private' }] }] });
  assert.equal(parsed.length, 1); assert.equal(parsed[0].state, 'pregame'); assert.equal(parsed[0].away.score, 0);
});

const ref = (kind: string, identity: string) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/${kind === 'positions' ? '' : 'seasons/2026/'}${kind}/${identity}?lang=en&region=us` });
const passerPlay = (playId: string, sequence: number, teamId: string, athleteId: string, position = '8') => ({
  id: playId, sequenceNumber: String(sequence), wallclock: `2026-09-23T18:${String(sequence).padStart(2, '0')}:00Z`,
  teamParticipants: [{ type: 'offense', id: teamId }], participants: [{ type: 'passer', athlete: ref('athletes', athleteId), position: ref('positions', position) }],
});
function nflFixture() {
  const box = (teamId: string, names: [string, string][]) => ({ team: { id: teamId }, statistics: [{ name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'adjQBR', 'QBRating'], labels: ['C/ATT', 'YDS', 'RTG'], descriptions: ['Completions/Attempts', 'Yards', 'Passer Rating'], athletes: names.map(([id, displayName]) => ({ athlete: { id, displayName }, stats: ['2/3', '24', '98.6'] })) }] });
  const summary = { header: { id: '123', competitions: [{ competitors: [{ homeAway: 'away', team: game.away, score: '1' }, { homeAway: 'home', team: game.home, score: '2' }], status: { period: 2, displayClock: '4:00', type: { state: 'in', detail: '4:00 - 2nd' } } }] },
    boxscore: { players: [box('10', [['1', 'Away QB'], ['3', 'Away Backup'], ['4', 'Away Receiver']]), box('20', [['2', 'Home QB']])] } };
  const items = [passerPlay('101', 1, '10', '1'), passerPlay('102', 2, '20', '2'), passerPlay('103', 3, '10', '4', '1'), passerPlay('104', 4, '10', '3')];
  return { summary, plays: { pageCount: 1, count: items.length, items } };
}

test('NFL records a same-team QB passer change while ignoring possession switches and WR trick passes', () => {
  const f = nflFixture(), context = nflContext(f.summary, f.plays, { ...market, league: 'NFL' }, game, now);
  assert.equal(context.changes.length, 1);
  assert.equal(context.changes[0].type, 'QB_change');
  assert.equal(context.changes[0].previous.name, 'Away QB');
  assert.equal(context.changes[0].replacement.name, 'Away Backup');
  assert.equal(context.changes[0].sourceEventTime, '2026-09-23T18:04:00.000Z');
  assert.equal(context.players.find(p => p.id === '3')?.stats.at(-1)?.label, 'Passer Rating this game');
  assert.equal(context.players.find(p => p.id === '3')?.stats.at(-1)?.value, '98.6');
  assert.ok(context.changes[0].implications[0].includes('does not establish injury'));
  assert.equal(nflContext(f.summary, { ...f.plays, pageCount: 2 }, market, game, now).changes.length, 0);
  assert.equal(nflContext(f.summary, { ...f.plays, count: 999 }, market, game, now).players.length, 0);
});

test('NFL missing typed passer evidence cannot infer QB changes from box-score ordering', () => {
  const f = nflFixture();
  const noPassers = { ...f.plays, items: f.plays.items.map(p => ({ ...p, participants: [] })) };
  const context = nflContext(f.summary, noPassers, market, game, now);
  assert.equal(context.players.length, 0); assert.equal(context.changes.length, 0);
  assert.equal(espnReferenceId({ $ref: 'http://sports.core.api.espn.pvt/v2/sports/football/leagues/nfl/seasons/2026/athletes/3' }, 'athletes'), null);
  assert.equal(espnReferenceId(ref('athletes', '3'), 'athletes'), '3');
  assert.equal(espnReferenceId({ $ref: 'https://attacker.example/athletes/3' }, 'athletes'), null);
});

test('NFL scoreboard normalization keeps exact event date and home/away identities', () => {
  const data = nflSchedule({ events: [{ id: '123', date: market.start, competitions: [{ competitors: [{ homeAway: 'home', team: game.home, score: '2' }, { homeAway: 'away', team: game.away, score: '1' }], status: { type: { state: 'post', detail: 'Final' } } }] }] });
  assert.equal(data[0].home.name, 'Home Team'); assert.equal(data[0].away.score, 1); assert.equal(data[0].state, 'final');
});

test('injury reports exclude Active news, retain explicit statuses, and cannot imply healthy', () => {
  const context = mlbContext(mlbFixture(), market, game, now);
  const injuries = reportedInjuries({ injuries: [{ id: 'different-provider-id', displayName: 'Home Team', injuries: [
    { status: 'Active', athlete: { displayName: 'Player A' }, date: '2026-09-23T17:00Z' },
    { status: 'Questionable', athlete: { displayName: 'Player B', position: { abbreviation: 'QB' } }, details: { type: 'Shoulder' }, date: '2026-09-23T17:00Z' },
    { status: '15-Day-IL', athlete: { displayName: 'Player C', position: { abbreviation: 'RP' } }, date: '2026-09-20T17:00Z' },
  ] }] }, context, 'https://example.invalid/injuries');
  assert.equal(injuries.length, 2); assert.equal(injuries[0].name, 'Player B'); assert.equal(injuries[0].detail, 'Shoulder');
  assert.deepEqual(reportedInjuries({}, context, ''), []);
  assert.equal(context.injuryStatus, 'not_verified');
});
