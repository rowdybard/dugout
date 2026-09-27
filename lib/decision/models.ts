import {z} from 'zod';
import type {DecisionContext,FeatureValue,SideKey} from './context.ts';
import type {Phase,Sport} from './evidence.ts';
import {BUILTIN_FEATURES,readFeature,type FeatureRegistry} from './features.ts';
import {testCondition,type Condition} from './evidence.ts';
import type {FairEstimate} from './edge.ts';

/**
 * Research plug for win-probability models. A trained model is exported as JSON (the repo's
 * model-as-JSON pattern) and compiled here; nothing runs Python at decision time.
 *   logistic-v1: p = sigmoid(intercept + sum(weight * feature)), numeric features only.
 *   table-v1:    p looked up from bins of one numeric feature (calibration tables, simple curves).
 *   calibration-v1: realized win rate with its confidence interval, by bins of one feature (normally the side's
 *                price), optionally only in a game state (conditions). This is how research says "in this state,
 *                sides priced here actually win X% [lo, hi]" (research/studies/calibration.py, drive_entry.py).
 * Trading needs an interval, not a point (lib/decision/edge.ts): logistic and table specs give one only when they
 * carry a measured `uncertainty`; calibration bins always do.
 * A model's output is the probability that the given side wins. Models are context for strategies;
 * only evidence decides whether a model-driven bet may be placed.
 */

const SPORTS=['NFL','CFB','MLB','ATP','WTA'] as const;
const PHASES=['pregame','live'] as const;
const base={id:z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),version:z.string().min(1).max(40),
  sports:z.array(z.enum(SPORTS)).min(1),phases:z.array(z.enum(PHASES)).min(1),
  description:z.string().max(500).optional(),source:z.string().max(300).optional()};
/** Half-width of the model's measured error, in probability units (from held-out calibration). */
const uncertainty=z.number().min(0).max(0.5).optional();
const condition=z.object({feature:z.string().min(1).max(80),op:z.enum(['eq','ne','in','gt','gte','lt','lte','between']),
  value:z.union([z.number().finite(),z.string().max(200),z.boolean(),z.array(z.union([z.number().finite(),z.string().max(200)])).max(100)])}).strict();
export const modelSpecSchema=z.discriminatedUnion('kind',[
  z.object({...base,kind:z.literal('logistic-v1'),intercept:z.number().finite(),weights:z.record(z.string(),z.number().finite()),uncertainty}).strict(),
  z.object({...base,kind:z.literal('table-v1'),feature:z.string().min(1),
    bins:z.array(z.object({min:z.number(),max:z.number(),p:z.number().min(0).max(1)}).strict()).min(1),uncertainty}).strict(),
  z.object({...base,kind:z.literal('calibration-v1'),feature:z.string().min(1).default('price'),conditions:z.array(condition).max(20).optional(),
    bins:z.array(z.object({min:z.number(),max:z.number(),n:z.number().int().positive(),rate:z.number().min(0).max(1),lo:z.number().min(0).max(1),hi:z.number().min(0).max(1)}).strict()
      .refine(bin=>bin.lo<=bin.rate&&bin.rate<=bin.hi,'lo ≤ rate ≤ hi')).min(1)}).strict(),
]);
export type ModelSpec=z.infer<typeof modelSpecSchema>;

export type ProbabilityModel={
  id:string;version:string;
  applies(sport:Sport,phase:Phase):boolean;
  /** Probability that `side` wins, or null when the model cannot say (missing features, out of range). */
  predict(ctx:DecisionContext,side:SideKey,features?:FeatureRegistry):number|null;
  /** The same with a measured interval, or null when the model has no measured uncertainty. */
  estimate(ctx:DecisionContext,side:SideKey,features?:FeatureRegistry):FairEstimate|null;
};

const clampP=(p:number)=>Math.min(1-1e-6,Math.max(1e-6,p));

/** The market's own midpoint. The research found it at least as accurate as every model tested. */
export const MARKET_IMPLIED:ProbabilityModel={
  id:'market-implied',version:'1',applies:()=>true,
  predict(ctx,side){const q=ctx.market[side];return q.ask!==null&&q.bid!==null?clampP((q.ask+q.bid)/2):null;},
  estimate:()=>null,
};

const interval=(p:number,width:number|undefined,source:string):FairEstimate|null=>
  width===undefined?null:{p,lo:Math.max(0,p-width),hi:Math.min(1,p+width),source};

export function compileModel(spec:ModelSpec):ProbabilityModel {
  const applies=(sport:Sport,phase:Phase)=>spec.sports.includes(sport)&&spec.phases.includes(phase);
  const numeric=(value:FeatureValue|undefined)=>typeof value==='number'?value:typeof value==='boolean'?Number(value):undefined;
  const source=`${spec.id}@${spec.version}`;
  if(spec.kind==='logistic-v1'){
    const predict=(ctx:DecisionContext,side:SideKey,features:FeatureRegistry=BUILTIN_FEATURES)=>{
      let z=spec.intercept;
      for(const [name,weight] of Object.entries(spec.weights)){
        const value=numeric(readFeature(features,name,ctx,side));
        if(value===undefined)return null;
        z+=weight*value;
      }
      return clampP(1/(1+Math.exp(-z)));
    };
    return {id:spec.id,version:spec.version,applies,predict,estimate(ctx,side,features){const p=predict(ctx,side,features);return p===null?null:interval(p,spec.uncertainty,source);}};
  }
  const binFor=<B extends {min:number;max:number}>(bins:B[],value:number)=>bins.find(b=>value>=b.min&&value<b.max)??(value===bins.at(-1)!.max?bins.at(-1):undefined);
  if(spec.kind==='table-v1'){
    const predict=(ctx:DecisionContext,side:SideKey,features:FeatureRegistry=BUILTIN_FEATURES)=>{
      const value=numeric(readFeature(features,spec.feature,ctx,side));
      if(value===undefined)return null;
      const bin=binFor(spec.bins,value);
      return bin?clampP(bin.p):null;
    };
    return {id:spec.id,version:spec.version,applies,predict,estimate(ctx,side,features){const p=predict(ctx,side,features);return p===null?null:interval(p,spec.uncertainty,source);}};
  }
  const estimate=(ctx:DecisionContext,side:SideKey,features:FeatureRegistry=BUILTIN_FEATURES):FairEstimate|null=>{
    // Every state condition must be known and true; an unknown state gives no estimate.
    for(const condition of spec.conditions??[])if(testCondition(condition as Condition,readFeature(features,condition.feature,ctx,side))!==true)return null;
    const value=numeric(readFeature(features,spec.feature,ctx,side));
    if(value===undefined)return null;
    const bin=binFor(spec.bins,value);
    return bin?{p:bin.rate,lo:bin.lo,hi:bin.hi,n:bin.n,source}:null;
  };
  return {id:spec.id,version:spec.version,applies,estimate,predict(ctx,side,features){const e=estimate(ctx,side,features);return e?clampP(e.p):null;}};
}
