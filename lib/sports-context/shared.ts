import type { Market } from '../market/types';
import type { ContextPlayer, ContextTeam, ScheduleGame } from './types';

export type RawObject = Record<string, unknown>;
export const object = (value: unknown): RawObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RawObject : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const text = (value: unknown): string => typeof value === 'string' ? value : '';
export const id = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
export const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
export const iso = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export const normalize = (value: string): string => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
export const player = (raw: unknown): ContextPlayer | null => {
  const p = object(raw), identity = id(p.id), name = text(p.fullName) || text(p.displayName);
  return identity && name ? { id: identity, name } : null;
};
export const team = (raw: unknown, score: unknown = null): ContextTeam => {
  const t = object(raw);
  return { id: id(t.id), name: text(t.displayName) || text(t.name), abbreviation: text(t.abbreviation), score: number(score) };
};
export function matchingGame(market: Pick<Market, 'teams' | 'start'>, games: ScheduleGame[]): { game: ScheduleGame | null; reason: string } {
  const start = Date.parse(market.start);
  if (market.teams.length !== 2 || !Number.isFinite(start)) return { game: null, reason: 'Two verified teams and a scheduled start are required to match this game.' };
  const matchTeam = (candidate: ContextTeam, source: Market['teams'][number]) =>
    (!!candidate.name && normalize(candidate.name) === normalize(source.name)) ||
    (!!candidate.abbreviation && !!source.abbreviation && normalize(candidate.abbreviation) === normalize(source.abbreviation));
  const pairMatches = games.filter(game =>
    (matchTeam(game.away, market.teams[0]) && matchTeam(game.home, market.teams[1])) ||
    (matchTeam(game.home, market.teams[0]) && matchTeam(game.away, market.teams[1])));
  const candidates = pairMatches.map(game => ({ game, distance: Math.abs(Date.parse(game.start) - start) }))
    .filter(x => Number.isFinite(x.distance) && x.distance <= 90 * 60_000).sort((a, b) => a.distance - b.distance);
  if (!candidates.length) return { game: null, reason: 'No game matched both teams within 90 minutes of the market’s scheduled start.' };
  // Matching on teams alone can silently attach Game 1 context to Game 2.
  if (candidates.length > 1 && (candidates[0].distance > 15 * 60_000 || candidates[1].distance - candidates[0].distance < 60 * 60_000))
    return { game: null, reason: 'The team/date match is ambiguous, so no game context is attached.' };
  return { game: candidates[0].game, reason: '' };
}

export function dateKeys(start: string): string[] {
  const time = Date.parse(start);
  if (!Number.isFinite(time)) return [];
  const utc = new Date(time).toISOString().slice(0, 10);
  const eastern = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
  return [...new Set([utc, eastern])];
}
