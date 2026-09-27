import type {DecisionContext,FeatureValue,Quote,SideKey} from './context.ts';
import type {Phase,Style} from './evidence.ts';
import type {Costs} from './costs.ts';
import type {FairEstimate,Level} from './edge.ts';
import type {NoTradeCode} from './why.ts';
import {paramsOf} from './catalog.ts';
import {holdEdge} from './edge.ts';

/**
 * Strategy plugs. A strategy only proposes; the engine gates every proposal against evidence,
 * sizes it and applies risk limits. Adding a strategy never bypasses the evidence table.
 */

export type ExitPolicy=
  |{kind:'hold-to-settlement'}
  |{kind:'scalp';targetReturn:number;stopReturn:number;maxHoldMs:number}
  /**
   * Resting order: cancel for `pullAfterEventMs` after each play/pitch event. `windowOnly`: the strategy proposes
   * only inside its quiet windows, so quotes are cancelled as soon as it stops proposing.
   */
  |{kind:'maker';pullAfterEventMs:number|null;windowOnly?:boolean}
  /**
   * Football: hold while the drive lasts. Sell when it ends (score, change of possession, end of the half),
   * at a net loss of `stopReturn`, or after `maxHoldMs`, whichever comes first.
   */
  |{kind:'drive';stopReturn:number;maxHoldMs:number};

export type Proposal={
  strategy:string;strategyVersion:string;side:SideKey;style:Style;
  /** Buy price: the ask for takers, the resting bid for makers. */
  price:number;exit:ExitPolicy;rationale:string;
  modelProbability?:number|null;modelId?:string|null;
  /** One entry per setup (a drive, a score event): the bot and shadow evaluation dedupe on strategy + this key. */
  setupKey?:string;
};

export type StrategyTools={
  phase:Phase;
  feature(name:string,side:SideKey):FeatureValue|undefined;
  quote(side:SideKey):Quote;
  costs(side:SideKey):Costs|null;
  /** Best non-market model for this sport/phase, if research has loaded one. */
  model(side:SideKey):{id:string;p:number}|null;
  /** How long resting orders stay pulled after a play/pitch event (reaction studies). */
  pullAfterEventMs:number|null;
  /** Best calibrated estimate with a measured interval (lib/decision/edge.ts), if research has loaded one. */
  fair(side:SideKey):FairEstimate|null;
  /** This side's ask ladder, best first (for depth and slippage). */
  levels(side:SideKey):readonly Level[];
  /** The stake a trade would use here (paper stake in paper mode). */
  stake:number;
  /** Why this strategy is not proposing (lib/decision/why.ts). Shown in "why no trade". */
  note(code:NoTradeCode,detail:string):void;
};

export type Strategy={id:string;version:string;description:string;
  /**
   * A pre-registered idea the research has not measured yet, stated before any result. Only a strategy with a
   * hypothesis may be explored on paper (plan option `explore`), and only until evidence names the strategy.
   */
  hypothesis?:string;
  propose(ctx:DecisionContext,tools:StrategyTools):Proposal[]};

const SIDES:SideKey[]=['yes','no'];

/**
 * research/studies/pregame.py rule: buy the favourite at the close (the last quote at least 5 minutes before the
 * scheduled start) and hold to the final. A bot acts on the first tick inside the window, so the default window is
 * narrow (5–8 minutes) to stay at the close the evidence measured. Observers that refresh a pick (the forward test)
 * may use a wider window and keep only their latest observation.
 */
export function favouriteHold(options:{minLeadMinutes?:number;maxLeadMinutes?:number}={}):Strategy {
  const spec=paramsOf<{minLeadMinutes:number;maxLeadMinutes:number}>('favourite-hold','1');
  const min=options.minLeadMinutes??spec.minLeadMinutes,max=options.maxLeadMinutes??spec.maxLeadMinutes;
  return {id:'favourite-hold',version:'1',description:`Buy the pregame favourite ${min}–${max} minutes before start and hold to settlement.`,
    propose(_ctx,tools){
      if(tools.phase!=='pregame'){tools.note('PHASE','Pregame only.');return [];}
      const lead=tools.feature('minutesToStart','yes');
      if(typeof lead!=='number'||lead<min||lead>max){tools.note('WAITING',`Enters ${min}–${max} minutes before the start.`);return [];}
      return SIDES.filter(side=>tools.feature('role',side)==='favourite'&&tools.quote(side).ask!==null).slice(0,1).map(side=>({
        strategy:'favourite-hold',strategyVersion:'1',side,style:'taker-hold' as const,price:tools.quote(side).ask!,
        exit:{kind:'hold-to-settlement' as const},rationale:`Favourite ${Math.round(lead)} min before start.`}));
    }};
}

/**
 * model-edge-hold@2: a calibrated estimate whose LOWER bound clears the all-in break-even for the stake (depth
 * slippage, taker fee, latency allowance). Replaces @1, which bought on a point estimate 3 points above break-even.
 */
export function modelEdgeHold():Strategy {
  const spec=paramsOf<{minLowerEdge:number;latencyCents:number}>('model-edge-hold','2');
  return {id:'model-edge-hold',version:'2',description:'Buy when a calibrated model\'s lower bound beats the all-in break-even; hold to settlement.',
    propose(ctx,tools){
      const out:Proposal[]=[];let noted=false;
      for(const side of SIDES){
        const fair=tools.fair(side),ask=tools.quote(side).ask;
        if(!fair||ask===null){if(!noted&&!fair){tools.note('NO_ESTIMATE','No calibrated model with an interval is loaded for this state.');noted=true;}continue;}
        const edge=holdEdge({fair,asks:tools.levels(side),stake:tools.stake,feeCoefficient:ctx.market.feeCoefficient??0.0695,latencyCents:spec.latencyCents,minLowerEdge:spec.minLowerEdge});
        if(!edge){tools.note('THIN_BOOK','The visible book cannot fill the stake.');continue;}
        if(!edge.tradable){tools.note('EDGE_TOO_SMALL',`${side.toUpperCase()}: lower bound ${(fair.lo*100).toFixed(1)}% vs all-in ${(edge.breakEven*100).toFixed(1)}%.`);continue;}
        out.push({strategy:'model-edge-hold',strategyVersion:'2',side,style:'taker-hold',price:ask,exit:{kind:'hold-to-settlement'},
          rationale:`${fair.source}: ${(fair.lo*100).toFixed(1)}–${(fair.hi*100).toFixed(1)}% vs all-in ${(edge.breakEven*100).toFixed(1)}%.`,
          modelProbability:fair.p,modelId:fair.source});
      }
      return out;
    }};
}

/** Rest at the best bid on both sides (a two-sided quote), pulling after events. */
export function makerQuote():Strategy {
  return {id:'maker-quote',version:'1',description:'Join the best bid on both sides as a resting order; pull quotes after each event.',
    propose(_ctx,tools){
      return SIDES.flatMap(side=>{
        const bid=tools.quote(side).bid;
        if(bid===null)tools.note('THIN_BOOK',`No ${side.toUpperCase()} bid to join.`);
        return bid===null?[]:[{strategy:'maker-quote',strategyVersion:'1',side,style:'maker' as const,price:bid,
          exit:{kind:'maker' as const,pullAfterEventMs:tools.pullAfterEventMs},rationale:`Rest at the ${Math.round(bid*1000)/10}¢ bid.`}];
      });
    }};
}

/** Control for backtests and forward tests: a side fixed by the slug, bought at its ask and held. */
export function randomSideControl():Strategy {
  return {id:'random-side-control',version:'1',description:'Control: a side fixed by the market slug, held to settlement.',
    propose(ctx,tools){
      const side=hashSide(ctx.market.slug),ask=tools.quote(side).ask;
      return ask===null?[]:[{strategy:'random-side-control',strategyVersion:'1',side,style:'taker-hold',price:ask,exit:{kind:'hold-to-settlement'},rationale:'Control.'}];
    }};
}

export function hashSide(key:string):SideKey {
  let hash=2166136261;
  for(let i=0;i<key.length;i++){hash^=key.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return (hash>>>0)%2===0?'yes':'no';
}

export const DEFAULT_STRATEGIES:readonly Strategy[]=Object.freeze([favouriteHold(),modelEdgeHold(),makerQuote()]);
