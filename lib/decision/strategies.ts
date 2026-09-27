import type {DecisionContext,FeatureValue,Quote,SideKey} from './context.ts';
import type {Phase,Style} from './evidence.ts';
import type {Costs} from './costs.ts';

/**
 * Strategy plugs. A strategy only proposes; the engine gates every proposal against evidence,
 * sizes it and applies risk limits. Adding a strategy never bypasses the evidence table.
 */

export type ExitPolicy=
  |{kind:'hold-to-settlement'}
  |{kind:'scalp';targetReturn:number;stopReturn:number;maxHoldMs:number}
  /** Resting order: cancel for `pullAfterEventMs` after each play/pitch event. */
  |{kind:'maker';pullAfterEventMs:number|null}
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
  const min=options.minLeadMinutes??5,max=options.maxLeadMinutes??8;
  return {id:'favourite-hold',version:'1',description:`Buy the pregame favourite ${min}–${max} minutes before start and hold to settlement.`,
    propose(_ctx,tools){
      if(tools.phase!=='pregame')return [];
      const lead=tools.feature('minutesToStart','yes');
      if(typeof lead!=='number'||lead<min||lead>max)return [];
      return SIDES.filter(side=>tools.feature('role',side)==='favourite'&&tools.quote(side).ask!==null).slice(0,1).map(side=>({
        strategy:'favourite-hold',strategyVersion:'1',side,style:'taker-hold' as const,price:tools.quote(side).ask!,
        exit:{kind:'hold-to-settlement' as const},rationale:`Favourite ${Math.round(lead)} min before start.`}));
    }};
}

/** Buy when a research model's probability beats the all-in break-even by `threshold`. */
export function modelEdgeHold(options:{threshold?:number}={}):Strategy {
  const threshold=options.threshold??0.03;
  return {id:'model-edge-hold',version:'1',description:`Buy when a loaded model beats the break-even win rate by ${threshold*100} points; hold to settlement.`,
    propose(_ctx,tools){
      return SIDES.flatMap(side=>{
        const model=tools.model(side),costs=tools.costs(side),ask=tools.quote(side).ask;
        if(!model||!costs||ask===null||model.p-costs.breakEvenWinRate<threshold)return [];
        return [{strategy:'model-edge-hold',strategyVersion:'1',side,style:'taker-hold' as const,price:ask,exit:{kind:'hold-to-settlement' as const},
          rationale:`${model.id} says ${(model.p*100).toFixed(1)}% vs break-even ${(costs.breakEvenWinRate*100).toFixed(1)}%.`,
          modelProbability:model.p,modelId:model.id}];
      });
    }};
}

/** Rest at the best bid on both sides (a two-sided quote), pulling after events. */
export function makerQuote():Strategy {
  return {id:'maker-quote',version:'1',description:'Join the best bid on both sides as a resting order; pull quotes after each event.',
    propose(_ctx,tools){
      return SIDES.flatMap(side=>{
        const bid=tools.quote(side).bid;
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
