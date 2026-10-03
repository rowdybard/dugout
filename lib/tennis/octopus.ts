import type {TennisMarket,TennisSession} from './types';
import {OCTOPUS_ARMS} from './maker.ts';
import {VISIBLE_LEAGUES} from './leagues.ts';

/**
 * The Octopus (experimental, "Chaos mode" in code): the bot also rests offers on up to OCTOPUS_ARMS extra games.
 * Pinned games (`config.chaosSlugs`) come first; with `config.octopusAuto` the bot fills the remaining arms itself.
 */
export const OCTOPUS_REPICK_MS=5*60_000;
const MAX_LIST_SPREAD=0.02,LOOKAHEAD_MS=6*60*60_000;

/** The arms in use: pinned games, then auto picks, without the main game or skipped games, at most OCTOPUS_ARMS. */
export function octopusSlugs(session:Pick<TennisSession,'config'|'octopus'>):string[] {
  const {config}=session,skip=new Set(config.octopusSkip??[]);
  const auto=config.octopusAuto?session.octopus?.slugs??[]:[];
  return [...new Set([...(config.chaosSlugs??[]),...auto])].filter(slug=>slug!==config.focusSlug&&!skip.has(slug)).slice(0,OCTOPUS_ARMS);
}
export const octopusOn=(session:Pick<TennisSession,'config'|'octopus'>)=>!!session.config.maker&&octopusSlugs(session).length>0;

/** A game the Octopus may pick: listed, open, live or starting within 6 h, with a narrow listed spread. */
function eligible(market:TennisMarket,now:number){
  if(!market.active||market.ended||!(VISIBLE_LEAGUES as readonly string[]).includes(market.league))return false;
  if(typeof market.bid!=='number'||typeof market.ask!=='number'||market.ask-market.bid>MAX_LIST_SPREAD+1e-9||market.bid<=0||market.ask>=1)return false;
  const start=Date.parse(market.startTime);
  return market.live||Number.isFinite(start)&&start>now&&start-now<=LOOKAHEAD_MS;
}

/**
 * Auto picks for the arms not pinned: current picks stay while still eligible (no churn), then the narrowest-spread,
 * soonest-starting eligible games. Returns null when no new pick is due (picked under 5 minutes ago, nothing changed).
 */
/** Whether new auto picks are due: auto on, and none yet, picked over 5 minutes ago, or a pick was pinned/skipped/focused. */
export function octopusPickDue(session:Pick<TennisSession,'config'|'octopus'>,now:number):boolean {
  const {config}=session,previous=session.octopus;
  if(!config.octopusAuto||!config.maker)return false;
  if(!previous||now-previous.pickedAt>=OCTOPUS_REPICK_MS||now<previous.pickedAt)return true;
  const taken=new Set([config.focusSlug,...(config.chaosSlugs??[]),...(config.octopusSkip??[])].filter(Boolean));
  return previous.slugs.some(slug=>taken.has(slug));
}
export function pickOctopusGames(markets:TennisMarket[],session:Pick<TennisSession,'config'|'octopus'>,now:number):string[]|null {
  const {config}=session;
  if(!octopusPickDue(session,now))return null;
  const previous=session.octopus,taken=new Set([config.focusSlug,...(config.chaosSlugs??[]),...(config.octopusSkip??[])].filter(Boolean));
  const kept=(previous?.slugs??[]).filter(slug=>!taken.has(slug));
  const room=Math.max(0,OCTOPUS_ARMS-(config.chaosSlugs??[]).filter(slug=>slug!==config.focusSlug).length);
  const ok=new Map(markets.filter(market=>eligible(market,now)&&!taken.has(market.slug)).map(market=>[market.slug,market]));
  const stay=kept.filter(slug=>ok.has(slug));
  const ranked=[...ok.values()].filter(market=>!stay.includes(market.slug))
    .sort((a,b)=>(a.ask!-a.bid!)-(b.ask!-b.bid!)||Number(b.live)-Number(a.live)||Date.parse(a.startTime)-Date.parse(b.startTime)||a.slug.localeCompare(b.slug));
  return [...stay,...ranked.map(market=>market.slug)].slice(0,room);
}

/** Record auto picks chosen for this check (no-op when none were due). */
export function applyOctopusPicks<T extends Pick<TennisSession,'octopus'>>(session:T,slugs:string[]|undefined,now:number):T {
  if(!slugs)return session;
  const clean=[...new Set(slugs.filter(slug=>typeof slug==='string'&&/^[a-zA-Z0-9:_.-]{1,250}$/.test(slug)))].slice(0,OCTOPUS_ARMS);
  return {...session,octopus:{slugs:clean,pickedAt:now}};
}
