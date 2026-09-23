import type { Market } from '../market/types';
import type { ContextChange, ContextPlayer, ScheduleGame, SportsContext } from './types';
import { array, id, iso, number, object, player, team, text } from './shared.ts';

function nflState(value: unknown): ScheduleGame['state'] {
  return value === 'pre' ? 'pregame' : value === 'in' ? 'live' : value === 'post' ? 'final' : 'unknown';
}
export function nflSchedule(raw: unknown): ScheduleGame[] {
  const games: ScheduleGame[] = [];
  for (const rawEvent of array(object(raw).events)) {
    const event = object(rawEvent), competition = object(array(event.competitions)[0]);
    const competitors = array(competition.competitors).map(object);
    const away = competitors.find(c => c.homeAway === 'away'), home = competitors.find(c => c.homeAway === 'home');
    const gameId = id(event.id), start = iso(competition.date) ?? iso(event.date), status = object(competition.status), type = object(status.type);
    if (!away || !home || !/^\d+$/.test(gameId) || !start) continue;
    games.push({ id: gameId, start, away: team(away.team, away.score), home: team(home.team, home.score),
      state: nflState(type.state), statusText: text(type.detail) || text(type.description),
      period: number(status.period) !== null ? `Q${status.period}` : undefined, clock: text(status.displayClock) || undefined,
      sourceUrl: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${gameId}` });
  }
  return games;
}

/** References are identifiers only. Never follow arbitrary, private, or changed hosts. */
export function espnReferenceId(reference: unknown, collection: 'athletes' | 'teams' | 'positions'): string | null {
  const value = text(object(reference).$ref);
  try {
    const url = new URL(value);
    if (url.hostname !== 'sports.core.api.espn.com' || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
    const pattern = collection === 'positions' ? /^\/v2\/sports\/football\/leagues\/nfl\/positions\/(\d+)$/
      : new RegExp(`^/v2/sports/football/leagues/nfl/seasons/\\d{4}/${collection}/(\\d+)$`);
    return url.pathname.match(pattern)?.[1] ?? null;
  } catch { return null; }
}

export function nflContext(summaryRaw: unknown, playsRaw: unknown, market: Market, matched: ScheduleGame, receivedAt: number, previous?: SportsContext | null): SportsContext {
  const summary = object(summaryRaw), header = object(summary.header), competition = object(array(header.competitions)[0]);
  if (id(header.id) !== matched.id || !Object.keys(competition).length) throw new Error('NFL game context did not match the selected event.');
  const status = object(competition.status), statusType = object(status.type);
  const competitors = array(competition.competitors).map(object), away = competitors.find(c => c.homeAway === 'away'), home = competitors.find(c => c.homeAway === 'home');
  const game = { ...matched, state: nflState(statusType.state), statusText: text(statusType.detail) || text(statusType.description) || matched.statusText,
    away: away ? team(away.team, away.score) : matched.away, home: home ? team(home.team, home.score) : matched.home,
    period: number(status.period) !== null && Number(status.period) > 0 ? `Q${status.period}` : undefined,
    clock: text(status.displayClock) || undefined };
  if (game.away.id !== matched.away.id || game.home.id !== matched.home.id) throw new Error('NFL teams did not match the selected game.');
  const roster = new Map<string, { who: ContextPlayer; teamId: string; stats: { label: string; value: string }[] }>();
  for (const rawBox of array(object(summary.boxscore).players)) {
    const box = object(rawBox), teamId = id(object(box.team).id);
    if (teamId !== game.away.id && teamId !== game.home.id) continue;
    for (const rawStats of array(box.statistics)) {
      const group = object(rawStats);
      if (group.name !== 'passing') continue;
      const labels = array(group.labels).map(text), descriptions = array(group.descriptions).map(text);
      for (const rawAthlete of array(group.athletes)) {
        const record = object(rawAthlete), who = player(record.athlete), values = array(record.stats);
        if (!who) continue;
        // ESPN's `keys` can contain an omitted QBR column. Only verified labels
        // and displayed values align; refuse mismatched columns.
        const stats = labels.length === values.length ? labels.map((label, i) => ({ label: `${descriptions[i] || label} this game`, value: text(values[i]) })).filter(stat => stat.label && stat.value) : [];
        roster.set(who.id, { who, teamId, stats });
      }
    }
  }
  const history = object(playsRaw), complete = number(history.pageCount) === 1 && Array.isArray(history.items) && number(history.count) === history.items.length;
  const plays = complete ? array(history.items).map(object).sort((a, b) => (number(a.sequenceNumber) ?? 0) - (number(b.sequenceNumber) ?? 0)) : [];
  const seen = new Set<string>(), latest = new Map<string, { who: ContextPlayer; time: string | null }>();
  const priorChanges = new Map((previous?.game?.id === matched.id ? previous.changes : []).map(change => [change.id, change]));
  const changes: ContextChange[] = [];
  for (const play of plays) {
    const playId = id(play.id);
    if (!playId || seen.has(playId)) continue;
    seen.add(playId);
    const offense = array(play.teamParticipants).map(object).find(p => p.type === 'offense');
    const teamId = offense ? id(offense.id) : espnReferenceId(object(play.start).team, 'teams');
    if (!teamId || (teamId !== game.away.id && teamId !== game.home.id)) continue;
    const passer = array(play.participants).map(object).find(p => p.type === 'passer' && espnReferenceId(p.position, 'positions') === '8');
    // Position 8 was verified from ESPN's public positions/8 response as QB.
    if (!passer) continue;
    const playerId = espnReferenceId(passer.athlete, 'athletes'), record = playerId ? roster.get(playerId) : undefined;
    if (!record || record.teamId !== teamId) continue;
    const eventTime = iso(play.wallclock);
    if (eventTime && Date.parse(eventTime) > receivedAt + 60_000) continue;
    const before = latest.get(teamId), teamName = teamId === game.away.id ? game.away.name : game.home.name;
    if (before && before.who.id !== record.who.id) {
      const identity = `${matched.id}:qb:${playId}:${record.who.id}`;
      changes.push({ id: identity, type: 'QB_change', team: teamName, previous: before.who, replacement: record.who,
        sourceEventTime: eventTime, detectedAt: priorChanges.get(identity)?.detectedAt ?? receivedAt,
        description: `${record.who.name} is recorded throwing a pass for ${teamName} after ${before.who.name.replace(/\.$/, '')}.`,
        implications: [`This confirms a different quarterback on an observed passing play. It does not establish injury, benching, or a permanent replacement.`, ...record.stats.filter(s => s.label === 'Completions/Attempts this game' || s.label === 'Yards this game').map(s => `${record.who.name}: ${s.value} ${s.label.toLowerCase()}.`)] });
    }
    latest.set(teamId, { who: record.who, time: eventTime });
  }
  return { slug: market.slug, league: 'NFL', status: 'available', receivedAt,
    source: { name: 'ESPN public game data', url: matched.sourceUrl, support: 'public-undocumented' }, game,
    players: [...latest].map(([teamId, observed]) => ({ ...observed.who, team: teamId === game.away.id ? game.away.name : game.home.name,
      role: 'last_observed_passer', observedAt: observed.time ?? undefined, stats: roster.get(observed.who.id)?.stats ?? [] })),
    changes: changes.slice(-20).reverse(), injuryStatus: 'not_verified',
    limitations: ['ESPN’s public JSON feeds are undocumented and have no guaranteed delivery delay.', 'Quarterback changes require same-team, quarterback-tagged passing plays. A substitution before the next pass may not be visible; no win-probability impact is calculated.', ...(complete ? [] : ['Complete typed play history is unavailable. No quarterback change is inferred from box-score order.']), 'Injury status has not been verified.'] };
}
