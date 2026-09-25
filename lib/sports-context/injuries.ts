import type { SportsContext } from './types';
import { array, iso, normalize, object, text } from './shared.ts';

const explicitStatus = (value: string) => /^(questionable|doubtful|out|injured reserve|day-to-day|\d+-day[ -]il)$/i.test(value);

/** Keep only fields used by the UI, avoiding repeated logos/news in cached feeds. */
export function compactInjuryFeed(raw: unknown): unknown {
  if (!Array.isArray(object(raw).injuries)) throw new Error('Injury feed shape unavailable.');
  return { injuries: array(object(raw).injuries).map(rawGroup => {
    const group = object(rawGroup);
    return { displayName: text(group.displayName), injuries: array(group.injuries).map(object).filter(injury => explicitStatus(text(injury.status))).map(injury => ({
      status: text(injury.status), date: text(injury.date), athlete: { displayName: text(object(injury.athlete).displayName), position: { abbreviation: text(object(object(injury.athlete).position).abbreviation) } },
      details: { type: text(object(injury.details).type) },
    })) };
  }) };
}

/** ESPN's injury feed includes ordinary 'Active' player news. That is not an injury. */
export function reportedInjuries(raw: unknown, context: SportsContext, sourceUrl: string): NonNullable<SportsContext['injuries']> {
  if (!context.game) return [];
  const teams = [context.game.away, context.game.home], reports: NonNullable<SportsContext['injuries']> = [];
  for (const rawGroup of array(object(raw).injuries)) {
    const group = object(rawGroup);
    // MLB Stats API team IDs and ESPN IDs are different namespaces; match names.
    const matched = teams.find(team => normalize(team.name) === normalize(text(group.displayName)));
    if (!matched) continue;
    for (const rawInjury of array(group.injuries)) {
      const injury = object(rawInjury), athlete = object(injury.athlete), name = text(athlete.displayName), status = text(injury.status);
      if (!name || !status || !explicitStatus(status)) continue;
      const position = text(object(athlete.position).abbreviation), detail = text(object(injury.details).type);
      reports.push({ name, team: matched.name, position, status, detail, reportedAt: iso(injury.date), sourceUrl });
    }
  }
  return reports.sort((a, b) => Number(b.position === 'QB') - Number(a.position === 'QB') || (Date.parse(b.reportedAt ?? '') || 0) - (Date.parse(a.reportedAt ?? '') || 0));
}
