import {assessFootballContext} from './football-context.ts';
import {createTennisSession} from './engine.ts';
import {decisionContext,marketPhase,sessionEngine} from './engine-plan.ts';
import {defaultLiveTennisConfig} from './rules.ts';
import {advanceShadows,openCandidateShadows,recordGameEvents,recordPregame,recordWhyNot,sessionTradeRecords,type ShadowLimits} from './research-tracking.ts';
import type {SweepSummary,TennisInput,TennisLeague,TennisMarket,TennisSession} from './types';

/**
 * The all-games sweep (docs/STRATEGY-ARCHITECTURE.md#8-shadow-measurement-and-counterfactuals). The bot trades one
 * focused game; the sweep measures every strategy on EVERY open college football game at once, from the games list
 * the runner already downloads (best bid and ask, score, quarter, possession), so it costs no order-book requests.
 *
 * It runs in its own shadow-only session, stored apart from the bot's: it never trades, never changes the bot's
 * session, and never enters the bot's replay journal. Its measurements appear on the dashboard scorecard as
 * forward-shadow rows. Games are measured at top of book: the entry is the best ask the list showed.
 */

export const SWEEP_LEAGUES:readonly TennisLeague[]=['CFB'];
/** Each game is evaluated at most this often. */
export const SWEEP_EVERY_MS=30_000;
/** Pregame games are measured from this long before kickoff. */
export const SWEEP_PREGAME_MS=6*3_600_000;
/** A game not seen for this long is forgotten (its pending shadows are kept until settled). */
export const SWEEP_FORGET_MS=6*3_600_000;
/** Nominal size for the list's top-of-book quote (the list carries prices, not sizes). */
const TOP_OF_BOOK_SIZE=1_000;
const LIMITS:ShadowLimits={open:120,closed:600};
const HISTORY_MS=600_000;


export function createSweepSession(evidencePack:string|undefined,now:number):TennisSession {
  const base=defaultLiveTennisConfig(100);
  return {...createTennisSession({...base,leagues:[...SWEEP_LEAGUES],focusSlug:null,maker:undefined,...(evidencePack?{evidencePack}:{})},now),status:'running'};
}

/** A list quote as a one-level book. */
export function listInput(market:TennisMarket,now:number):TennisInput|null {
  const bid=market.bid,ask=market.ask;
  if(bid===null||ask===null||!(bid>0&&ask<1&&bid<ask))return null;
  return {market,receivedAt:now,source:'REST',sourceTime:market.quoteObservedAt??market.observedAt,
    book:{bids:[{price:bid,quantity:TOP_OF_BOOK_SIZE}],asks:[{price:ask,quantity:TOP_OF_BOOK_SIZE}],state:'MARKET_STATE_OPEN',time:new Date(now).toISOString()}};
}

/**
 * One sweep over the games list. `settlements` carries final results (1 = YES won) for games whose shadows await them.
 * Pure: returns a new session.
 */
export function sweepStep(previous:TennisSession,markets:readonly TennisMarket[],settlements:Readonly<Record<string,number>>,now:number):TennisSession {
  const sweep=structuredClone(previous);
  sweep.lastTickAt=now;sweep.revision++;
  const resolved=sessionEngine(sweep);
  const seen=(sweep.sweepSeen??={});
  for(const [slug,value] of Object.entries(settlements)){
    if(!(value>=0&&value<=1))continue;
    const market=markets.find(m=>m.slug===slug)??({slug} as TennisMarket);
    advanceShadows(sweep,[{market,book:{bids:[],asks:[],state:'MARKET_STATE_EXPIRED',time:''},receivedAt:now,source:'REST',settlement:value,settlementReceivedAt:now}],now,()=>false,LIMITS);
  }
  if('error' in resolved)return sweep;
  for(const market of [...markets].sort((a,b)=>a.slug.localeCompare(b.slug))){
    if(!SWEEP_LEAGUES.includes(market.league)||market.ended)continue;
    const start=Date.parse(market.startTime);
    if(!market.live&&!(Number.isFinite(start)&&start-now<=SWEEP_PREGAME_MS))continue;
    const last=sweep.evaluatedBooks?.[market.slug]??-Infinity;
    if(now-last<SWEEP_EVERY_MS||market.observedAt<=last)continue;
    const input=listInput(market,now);
    if(!input)continue;
    (sweep.evaluatedBooks??={})[market.slug]=now;seen[market.slug]=now;
    const phase=marketPhase(input,now);
    if(market.league==='CFB'||market.league==='NFL'){
      const next=assessFootballContext(market,now,sweep.footballReports?.[market.slug]);
      (sweep.footballReports??={})[market.slug]=next;
      recordGameEvents(sweep,input,next,now);
    }
    recordPregame(sweep,input,now,phase==='pregame');
    // Existing shadows see this observation before new ones open on it.
    advanceShadows(sweep,[input],now,()=>true,LIMITS);
    if(phase){
      const plan=resolved.engine.plan(decisionContext(sweep,input,now,phase),{mode:'paper'});
      // Permitted entries are measured too: the bot trades only its focused game.
      openCandidateShadows(sweep,input,[...plan.shadow,...plan.actions.filter(action=>action.proposal.style!=='maker')],now,LIMITS);
      recordWhyNot(sweep,market.slug,plan.actions.length?null:plan.why,now);
    }
    remember(sweep,input,now);
  }
  forget(sweep,seen,now);
  return sweep;
}

/** The latest list quote per game, so score events have a pre-event price and the report a price at receipt. */
function remember(sweep:TennisSession,input:TennisInput,now:number){
  const bid=input.book.bids[0].price,ask=input.book.asks[0].price,key=`${input.market.slug}:YES`;
  sweep.histories[key]=[...(sweep.histories[key]??[]).filter(point=>point.time>=now-HISTORY_MS),{time:now,price:Math.round((bid+ask)/2*1e6)/1e6,bid,ask}];
  (sweep.quotes??={})[input.market.slug]={time:now,bid,ask,source:'REST',sourceTime:input.sourceTime??null};
}

function forget(sweep:TennisSession,seen:Record<string,number>,now:number){
  for(const [slug,time] of Object.entries(seen)){
    if(now-time<=SWEEP_FORGET_MS)continue;
    delete seen[slug];
    for(const store of [sweep.footballReports,sweep.gameTape,sweep.tapeState,sweep.pregame,sweep.quotes,sweep.evaluatedBooks])if(store)delete (store as Record<string,unknown>)[slug];
    delete sweep.histories[`${slug}:YES`];
  }
}

/** Games whose shadows wait for a final result. */
export function sweepAwaiting(sweep:TennisSession):string[] {
  const slugs=new Set<string>();
  for(const shadow of sweep.shadows??[])if(!shadow.done)slugs.add(shadow.slug);
  for(const result of sweep.shadowResults??[])if(result.awaiting.length)slugs.add(result.slug);
  return [...slugs].sort();
}

/** What the dashboard shows: counts and the scorecard records (newest first, bounded). */
export function sweepSummary(sweep:TennisSession,now:number):SweepSummary {
  const records=sessionTradeRecords(sweep).sort((a,b)=>b.time-a.time).slice(0,400);
  const games=Object.values(sweep.sweepSeen??{}).filter(time=>now-time<=3_600_000).length;
  return {updatedAt:sweep.lastTickAt,games,open:sweep.shadows?.filter(s=>!s.done).length??0,measured:sweep.shadowResults?.filter(r=>r.primary).length??0,records};
}
