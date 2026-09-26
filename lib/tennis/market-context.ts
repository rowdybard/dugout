import type {TennisMarket} from './types';

/** Reuse verified live context without making held-position exits wait on discovery. */
export function currentTennisContext(stored:TennisMarket,latest:TennisMarket|null|undefined,now:number):TennisMarket {
  if(!latest||latest.slug!==stored.slug||latest.league!==stored.league||latest.eventId!==stored.eventId||
    latest.yesName!==stored.yesName||latest.noName!==stored.noName||
    !Number.isFinite(latest.observedAt)||latest.observedAt<=stored.observedAt||latest.observedAt>now||now-latest.observedAt>45_000)return stored;
  // Catalog freshness must not reopen exchange metadata or replace its rules.
  return {...stored,live:latest.live,ended:latest.ended,active:stored.active&&latest.active,
    score:latest.score,period:latest.period,clock:latest.clock,tournament:latest.tournament,
    observedAt:latest.observedAt,contextUpdatedAt:latest.contextUpdatedAt,history:[]};
}
