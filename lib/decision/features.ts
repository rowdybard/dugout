import {otherSide,phaseOf,quoteOf,type DecisionContext,type FeatureValue,type SideKey} from './context.ts';

/**
 * Named features the evidence conditions, models and strategies read. Research plug: add a feature
 * here (or pass one to createEngine) and evidence rows can condition on it by name.
 * A feature returns undefined when it cannot be known from the context; the engine treats that as unknown,
 * never as false.
 */

export type Feature=(ctx:DecisionContext,side:SideKey)=>FeatureValue|undefined;
export type FeatureRegistry=Readonly<Record<string,Feature>>;

const finite=(x:number|null|undefined)=>typeof x==='number'&&Number.isFinite(x)?x:undefined;
const mid=(ctx:DecisionContext,side:SideKey)=>{const q=quoteOf(ctx,side);return q.ask!==null&&q.bid!==null?(q.ask+q.bid)/2:undefined;};
const yesMid=(point:{yesBid:number|null;yesAsk:number|null})=>point.yesBid!==null&&point.yesAsk!==null?(point.yesBid+point.yesAsk)/2:null;
const sideMid=(value:number,side:SideKey)=>side==='yes'?value:1-value;

/** Standard deviation of successive midpoint changes over the window, in cents. */
function volatility(ctx:DecisionContext,side:SideKey,windowMs:number){
  const points=(ctx.history??[]).filter(p=>p.time<=ctx.now&&ctx.now-p.time<=windowMs).map(yesMid).filter((x):x is number=>x!==null).map(x=>sideMid(x,side));
  if(points.length<3)return undefined;
  const changes=points.slice(1).map((x,i)=>(x-points[i])*100),mean=changes.reduce((a,b)=>a+b,0)/changes.length;
  return Math.sqrt(changes.reduce((a,b)=>a+(b-mean)**2,0)/changes.length);
}
/** Midpoint change over the window, in cents, from the side's perspective. */
function change(ctx:DecisionContext,side:SideKey,windowMs:number){
  const now=mid(ctx,side);
  const past=(ctx.history??[]).filter(p=>p.time<=ctx.now-windowMs).at(-1);
  const then=past?yesMid(past):null;
  return now===undefined||then===null?undefined:(now-sideMid(then,side))*100;
}

export const BUILTIN_FEATURES:FeatureRegistry={
  sport:ctx=>ctx.market.sport,
  phase:ctx=>phaseOf(ctx)??undefined,
  side:(_ctx,side)=>side,
  price:(ctx,side)=>finite(quoteOf(ctx,side).ask),
  bid:(ctx,side)=>finite(quoteOf(ctx,side).bid),
  mid:(ctx,side)=>mid(ctx,side),
  spread:(ctx,side)=>{const q=quoteOf(ctx,side);return q.ask!==null&&q.bid!==null?q.ask-q.bid:undefined;},
  role:(ctx,side)=>{const m=mid(ctx,side)??finite(quoteOf(ctx,side).ask);return m===undefined?undefined:m>=0.5-1e-9?'favourite':'underdog';},
  askSize:(ctx,side)=>finite(quoteOf(ctx,side).askSize),
  bidSize:(ctx,side)=>finite(quoteOf(ctx,side).bidSize),
  minutesToStart:ctx=>ctx.market.startTime===null?undefined:(ctx.market.startTime-ctx.now)/60_000,
  hourUtc:ctx=>new Date(ctx.now).getUTCHours(),
  weekdayUtc:ctx=>new Date(ctx.now).getUTCDay(),
  period:ctx=>finite(ctx.game?.period),
  secondsRemaining:ctx=>finite(ctx.game?.secondsRemaining),
  scoreDiff:(ctx,side)=>{
    const yes=finite(ctx.game?.yesScore),no=finite(ctx.game?.noScore);
    return yes===undefined||no===undefined?undefined:side==='yes'?yes-no:no-yes;
  },
  volatility1m:(ctx,side)=>volatility(ctx,side,60_000),
  volatility5m:(ctx,side)=>volatility(ctx,side,300_000),
  change1m:(ctx,side)=>change(ctx,side,60_000),
  change5m:(ctx,side)=>change(ctx,side,300_000),
  change60m:(ctx,side)=>change(ctx,side,3_600_000),
  otherPrice:(ctx,side)=>finite(quoteOf(ctx,otherSide(side)).ask),
};

export function featureRegistry(...extra:Record<string,Feature>[]):FeatureRegistry {
  return Object.freeze(Object.assign({},BUILTIN_FEATURES,...extra));
}

/** Resolve a feature by name, including `signal.<name>` and `game.<key>` pass-throughs. */
export function readFeature(registry:FeatureRegistry,name:string,ctx:DecisionContext,side:SideKey):FeatureValue|undefined {
  if(name.startsWith('signal.')){const value=ctx.signals?.[name.slice(7)];return value===null?undefined:value;}
  if(name.startsWith('game.')){const value=ctx.game?.extra?.[name.slice(5)];return value===null?undefined:value;}
  const feature=registry[name];
  if(!feature)return undefined;
  try{const value=feature(ctx,side);return typeof value==='number'&&!Number.isFinite(value)?undefined:value;}
  catch{return undefined;}
}
