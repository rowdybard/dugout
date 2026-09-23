import type { Market } from '../market/types';
import type { ContextChange, ContextPlayer, ScheduleGame, SportsContext } from './types';
import { array, id, iso, number, object, player, team, text } from './shared.ts';

export function mlbSchedule(raw: unknown): ScheduleGame[] {
  const games: ScheduleGame[] = [];
  for (const date of array(object(raw).dates)) for (const item of array(object(date).games)) {
    const g = object(item), teams = object(g.teams), away = object(teams.away), home = object(teams.home), status = object(g.status);
    const gameId = id(g.gamePk), start = iso(g.gameDate);
    if (!/^\d+$/.test(gameId) || !start) continue;
    games.push({ id: gameId, start, away: team(away.team, away.score), home: team(home.team, home.score),
      state: mlbState(status.abstractGameState), statusText: text(status.detailedState),
      sourceUrl: `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live` });
  }
  return games;
}
function mlbState(state: unknown): ScheduleGame['state'] {
  return state === 'Live' ? 'live' : state === 'Final' ? 'final' : state === 'Preview' ? 'pregame' : 'unknown';
}

/** Only actual MLB pitching_substitution actions generate a change. */
export function mlbContext(raw: unknown, market: Market, matched: ScheduleGame, receivedAt: number, previous?: SportsContext | null): SportsContext {
  const root = object(raw), data = object(root.gameData), live = object(root.liveData), lines = object(live.linescore);
  const rawTeams = object(data.teams), scores = object(lines.teams), status = object(data.status), people = object(data.players);
  const game = { id: matched.id, start: iso(object(data.datetime).dateTime) ?? matched.start,
    state: mlbState(status.abstractGameState), statusText: text(status.detailedState) || matched.statusText,
    away: team(rawTeams.away, object(scores.away).runs), home: team(rawTeams.home, object(scores.home).runs),
    period: [text(lines.inningState), text(lines.currentInningOrdinal)].filter(Boolean).join(' ') || undefined };
  if (!game.away.id || !game.home.id || !Object.keys(data).length) throw new Error('MLB game context was incomplete.');
  if (id(root.gamePk) !== matched.id || game.away.id !== matched.away.id || game.home.id !== matched.home.id) throw new Error('MLB feed did not match the selected game.');
  const latest = new Map<string, { who: ContextPlayer; time: string | null }>();
  const changes: ContextChange[] = [];
  const oldChanges = new Map((previous?.game?.id === matched.id ? previous.changes : []).map(c => [c.id, c]));
  const boxTeams = object(object(live.boxscore).teams);
  const resolve = (rawPlayer: unknown) => {
    const rawP = object(rawPlayer), identity = id(rawP.id);
    return player(rawP) ?? player(people[`ID${identity}`]);
  };
  const pitchingStats = (side: 'away' | 'home', playerId: string, season = false) => {
    const record = object(object(object(boxTeams[side]).players)[`ID${playerId}`]);
    return object(object(record[season ? 'seasonStats' : 'stats']).pitching);
  };
  const facts = (side: 'away' | 'home', before: ContextPlayer, after: ContextPlayer) => {
    const beforeStats = pitchingStats(side, before.id), afterSeason = pitchingStats(side, after.id, true);
    const facts: string[] = [];
    if (number(beforeStats.numberOfPitches) !== null && text(beforeStats.inningsPitched))
      facts.push(`${before.name}: ${beforeStats.numberOfPitches} pitches across ${beforeStats.inningsPitched} innings in this game.`);
    if (text(afterSeason.era) && text(afterSeason.inningsPitched))
      facts.push(`${after.name}: season ERA ${afterSeason.era} across ${afterSeason.inningsPitched} innings.`);
    return facts;
  };
  const plays = array(object(live.plays).allPlays).map(object).sort((a, b) => (number(object(a.about).atBatIndex) ?? 0) - (number(object(b.about).atBatIndex) ?? 0));
  for (const play of plays) {
    const about = object(play.about);
    if (typeof about.isTopInning !== 'boolean') continue;
    const side = about.isTopInning ? 'home' : 'away', fielding = game[side];
    for (const rawEvent of array(play.playEvents)) {
      const event = object(rawEvent), details = object(event.details);
      if (details.eventType !== 'pitching_substitution') continue;
      const replacement = resolve(event.player), before = latest.get(fielding.id)?.who;
      if (!replacement) continue;
      const eventTime = iso(event.startTime) ?? iso(event.endTime);
      if (eventTime && Date.parse(eventTime) > receivedAt + 60_000) continue;
      if (before && before.id !== replacement.id) {
        const identity = `${matched.id}:pitcher:${id(about.atBatIndex)}:${id(event.index)}:${replacement.id}`;
        changes.push({ id: identity, type: 'pitcher_change', team: fielding.name, previous: before, replacement,
          sourceEventTime: eventTime, detectedAt: oldChanges.get(identity)?.detectedAt ?? receivedAt,
          description: `${replacement.name} replaced ${before.name} for ${fielding.name}.`, implications: facts(side, before, replacement) });
      }
      latest.set(fielding.id, { who: replacement, time: eventTime });
    }
    // A matchup is useful context; a changed name alone is not a substitution alert.
    const pitcher = resolve(object(play.matchup).pitcher);
    if (pitcher) latest.set(fielding.id, { who: pitcher, time: iso(about.endTime) ?? iso(about.startTime) });
  }
  const players: SportsContext['players'] = [];
  for (const side of ['away', 'home'] as const) {
    const fielding = game[side], observed = latest.get(fielding.id);
    const who = observed?.who ?? resolve(object(data.probablePitchers)[side]);
    if (!who) continue;
    const rawStats = pitchingStats(side, who.id), season = pitchingStats(side, who.id, true);
    const stats: SportsContext['players'][number]['stats'] = [];
    for (const [field, label] of [['inningsPitched', 'Game innings'], ['numberOfPitches', 'Game pitches'], ['strikeOuts', 'Game strikeouts'], ['baseOnBalls', 'Game walks']] as const) {
      if (rawStats[field] !== undefined && rawStats[field] !== null && (text(rawStats[field]) || number(rawStats[field]) !== null)) stats.push({ label, value: String(rawStats[field]) });
    }
    if (text(season.era)) stats.push({ label: 'Season ERA', value: text(season.era) });
    players.push({ ...who, team: fielding.name, role: observed ? 'current_pitcher' : 'probable_pitcher', stats, observedAt: observed?.time ?? undefined });
  }
  return { slug: market.slug, league: 'MLB', status: 'available', receivedAt,
    source: { name: 'MLB Stats API', url: matched.sourceUrl, support: 'official' }, game, players,
    changes: changes.slice(-20).reverse(), injuryStatus: 'not_verified',
    limitations: ['Pitcher changes are official play events. Workload and season ERA describe observations; no win-probability impact is calculated.', 'Probable starters can change before first pitch.', 'Injury status has not been verified.'] };
}
