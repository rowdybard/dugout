import {z} from 'zod';
import type {DecisionContext,FeatureValue,SideKey} from './context.ts';
import type {Phase,Sport} from './evidence.ts';
import {BUILTIN_FEATURES,readFeature,type FeatureRegistry} from './features.ts';

/**
 * Research plug for win-probability models. A trained model is exported as JSON (the repo's
 * model-as-JSON pattern) and compiled here; nothing runs Python at decision time.
 *   logistic-v1: p = sigmoid(intercept + sum(weight * feature)), numeric features only.
 *   table-v1:    p looked up from bins of one numeric feature (calibration tables, simple curves).
 * A model's output is the probability that the given side wins. Models are context for strategies;
 * only evidence decides whether a model-driven bet may be placed.
 */

const SPORTS=['NFL','CFB','MLB','ATP','WTA'] as const;
const PHASES=['pregame','live'] as const;
const base={id:z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),version:z.string().min(1).max(40),
  sports:z.array(z.enum(SPORTS)).min(1),phases:z.array(z.enum(PHASES)).min(1),
  description:z.string().max(500).optional(),source:z.string().max(300).optional()};
export const modelSpecSchema=z.discriminatedUnion('kind',[
  z.object({...base,kind:z.literal('logistic-v1'),intercept:z.number().finite(),weights:z.record(z.string(),z.number().finite())}).strict(),
  z.object({...base,kind:z.literal('table-v1'),feature:z.string().min(1),
    bins:z.array(z.object({min:z.number(),max:z.number(),p:z.number().min(0).max(1)}).strict()).min(1)}).strict(),
]);
export type ModelSpec=z.infer<typeof modelSpecSchema>;

export type ProbabilityModel={
  id:string;version:string;
  applies(sport:Sport,phase:Phase):boolean;
  /** Probability that `side` wins, or null when the model cannot say (missing features, out of range). */
  predict(ctx:DecisionContext,side:SideKey,features?:FeatureRegistry):number|null;
};

const clampP=(p:number)=>Math.min(1-1e-6,Math.max(1e-6,p));

/** The market's own midpoint. The research found it at least as accurate as every model tested. */
export const MARKET_IMPLIED:ProbabilityModel={
  id:'market-implied',version:'1',applies:()=>true,
  predict(ctx,side){const q=ctx.market[side];return q.ask!==null&&q.bid!==null?clampP((q.ask+q.bid)/2):null;},
};

export function compileModel(spec:ModelSpec):ProbabilityModel {
  const applies=(sport:Sport,phase:Phase)=>spec.sports.includes(sport)&&spec.phases.includes(phase);
  const numeric=(value:FeatureValue|undefined)=>typeof value==='number'?value:typeof value==='boolean'?Number(value):undefined;
  if(spec.kind==='logistic-v1')return {id:spec.id,version:spec.version,applies,predict(ctx,side,features=BUILTIN_FEATURES){
    let z=spec.intercept;
    for(const [name,weight] of Object.entries(spec.weights)){
      const value=numeric(readFeature(features,name,ctx,side));
      if(value===undefined)return null;
      z+=weight*value;
    }
    return clampP(1/(1+Math.exp(-z)));
  }};
  return {id:spec.id,version:spec.version,applies,predict(ctx,side,features=BUILTIN_FEATURES){
    const value=numeric(readFeature(features,spec.feature,ctx,side));
    if(value===undefined)return null;
    const bin=spec.bins.find(b=>value>=b.min&&value<b.max)??(value===spec.bins.at(-1)!.max?spec.bins.at(-1):undefined);
    return bin?clampP(bin.p):null;
  }};
}
