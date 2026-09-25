import type { Market } from '../market/types';
import type { ScheduleGame, SportsContext } from './types';
import { cached, db } from '../server/storage';
import { dateKeys, matchingGame, object } from './shared.ts';
import { mlbContext, mlbSchedule } from './mlb.ts';
import { nflContext, nflSchedule } from './nfl.ts';
import { compactInjuryFeed, reportedInjuries } from './injuries.ts';
import {nflProbabilityUrl,readNflEstimate} from '../bot/nfl-reference';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
export const CONTEXT_REFRESH_MS = 30_000;
async function json(url: string,signal:AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal,AbortSignal.timeout(8000)]) });
  if (!response.ok) throw new Error(`Sports source returned HTTP ${response.status}.`);
  return response.json();
}
const sourceFor = (market: Market): SportsContext['source'] => market.league === 'MLB'
  ? { name: 'MLB Stats API', url: 'https://statsapi.mlb.com', support: 'official' }
  : { name: 'ESPN public game data', url: `${ESPN}/football/nfl/scoreboard`, support: 'public-undocumented' };
function unavailable(market: Market, status: SportsContext['status'], reason: string): SportsContext {
  return { slug: market.slug, league: market.league, status, receivedAt: Date.now(), source: sourceFor(market), game: null, players: [], changes: [], injuries: [], injuryStatus: 'not_verified', limitations: [reason, 'Missing reports do not mean players are healthy. No injury or replacement probability effect is assumed.'] };
}
async function lastContext(key: string): Promise<SportsContext | null> {
  const row = await db().prepare('SELECT value FROM cache WHERE key=?').bind(key).first<{ value: string }>();
  if (!row) return null;
  try { const value = JSON.parse(row.value); return value?.game?.id ? value as SportsContext : null; } catch { return null; }
}
async function schedule(market: Market,signal:AbortSignal): Promise<ScheduleGame[]> {
  const days = dateKeys(market.start);
  const schedules = await Promise.all(days.map(day => cached(`sports:schedule:v1:${market.league}:${day}`, 60_000, async () => {
    if (market.league === 'MLB') return mlbSchedule(await json(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team`,signal));
    return nflSchedule(await json(`${ESPN}/football/nfl/scoreboard?dates=${day.replaceAll('-', '')}`,signal));
  })));
  return [...new Map(schedules.flat().map(game => [game.id, game])).values()];
}

/** Selected game only. Cache entries retain compact source evidence and first-seen times. */
export async function getSportsContext(market: Market,signal:AbortSignal=AbortSignal.timeout(18000)): Promise<SportsContext> {
  signal.throwIfAborted();
  if (market.league !== 'MLB' && market.league !== 'NFL') return unavailable(market, 'unavailable', 'Only MLB and NFL game context is supported.');
  if (import.meta.env.DEV) {
    const capture = (await import('./development-capture.json')).default.contexts.find(entry => entry.marketGameId === market.gameId && entry.context.league === market.league);
    if (capture) {
      const context = capture.context as SportsContext;
      return { ...context, slug: market.slug, replayAt: context.receivedAt, limitations: [`Development capture recorded ${new Date(context.receivedAt).toISOString()}. Game context is recorded, not live.`, ...context.limitations] };
    }
    return unavailable(market, 'unavailable', 'This development game has no recorded sports context. Production uses current provider feeds.');
  }
  try {
    const match = matchingGame(market, await schedule(market,signal));
    if (!match.game) return unavailable(market, 'unmatched', match.reason);
    const game = match.game, key = `sports:context:v2:${market.league}:${game.id}`;
    const ttl = game.state === 'final' ? 300_000 : game.state === 'live' ? (market.league==='NFL'?10000:CONTEXT_REFRESH_MS) : 60_000;
    const context = await cached(key, ttl, async () => {
      const previous = await lastContext(key);
      let context: SportsContext;
      if (market.league === 'MLB') context = mlbContext(await json(game.sourceUrl,signal), market, game, Date.now(), previous);
      else {
        const [summary, plays] = await Promise.allSettled([
          json(game.sourceUrl,signal).then(raw=>({raw,receivedAt:Date.now()})),
          json(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${game.id}/competitions/${game.id}/plays?limit=500`,signal).then(raw=>({raw,receivedAt:Date.now()})),
        ]);
        if (summary.status !== 'fulfilled') throw new Error('NFL game summary is unavailable.');
        // Retain the oldest component receipt so later entry checks cannot refresh a slow feed.
        const contextReceipt=plays.status==='fulfilled'?Math.min(summary.value.receivedAt,plays.value.receivedAt):summary.value.receivedAt;
        context = nflContext(summary.value.raw, plays.status === 'fulfilled' ? plays.value.raw : null, market, game, contextReceipt, previous);
        if(plays.status==='fulfilled'&&context.game?.state==='live'){
          const probabilityUrl=nflProbabilityUrl(plays.value.raw,game.id);
          if(probabilityUrl){
            try{const raw=await json(probabilityUrl,signal),receivedAt=Date.now(),result=receivedAt-plays.value.receivedAt>45000?{reason:'The play feed is stale.'}:readNflEstimate(context,plays.value.raw,raw,receivedAt);context.winEstimate=result.estimate;context.winEstimateReason=result.reason;}
            catch{context.winEstimateReason='The latest play’s win estimate is temporarily unavailable.';}
          }else context.winEstimateReason='Waiting for the latest play’s probability reference.';
        }
      }
      const injuryUrl = `${ESPN}/${market.league === 'MLB' ? 'baseball/mlb' : 'football/nfl'}/injuries`;
      try {
        const reports = await cached(`sports:injuries:v1:${market.league}`, 120_000, async () => ({ raw: compactInjuryFeed(await json(injuryUrl,signal)), receivedAt: Date.now() }));
        if (!Array.isArray(object(reports.raw).injuries)) throw new Error('Injury feed shape unavailable.');
        context.injuries = reportedInjuries(reports.raw, context, injuryUrl);
        context.injuryStatus = 'source_reports';
        context.injuryReceivedAt = reports.receivedAt;
        context.limitations = context.limitations.filter(line => !line.includes('Injury status has not been verified.'));
        context.limitations.push('Injuries are explicit ESPN source reports, separate from substitution evidence. Report times are not injury occurrence times; absent reports do not mean healthy.');
      } catch { context.injuries = []; context.injuryStatus = 'not_verified'; }
      return context;
    });
    return { ...context, slug: market.slug };
  } catch (error) {
    console.error('sports context', market.league, error instanceof Error ? error.message : 'unavailable');
    return unavailable(market, 'unavailable', 'The sports source is temporarily unavailable. Game context and player changes have not been refreshed.');
  }
}
