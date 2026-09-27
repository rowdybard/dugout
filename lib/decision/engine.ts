import {formatEstimate,testCondition,type Evidence,type Phase,type Role,type Sport,type Style} from './evidence.ts';
import {BUNDLED_PACK,restrictUntrusted,type EvidencePack,type Trust} from './pack.ts';
import {BUILTIN_FEATURES,featureRegistry,readFeature,type Feature,type FeatureRegistry} from './features.ts';
import {compileModel,type ModelSpec,type ProbabilityModel} from './models.ts';
import {DEFAULT_STRATEGIES,type Proposal,type Strategy,type StrategyTools} from './strategies.ts';
import {DEFAULT_SIZING,stakeFor,type SizingLimits} from './sizing.ts';
import {checkRisk,DEFAULT_RISK,EMPTY_RISK,type RiskLimits,type RiskState} from './risk.ts';
import {DEFAULT_FEE_COEFFICIENT,estimateCosts,MAX_EXECUTABLE_SPREAD,roleOf,type Costs} from './costs.ts';
import {phaseOf,quoteOf,type DecisionContext,type FeatureValue,type SideKey} from './context.ts';

export {DEFAULT_FEE_COEFFICIENT,MAX_EXECUTABLE_SPREAD,estimateCosts,roleOf,type Costs} from './costs.ts';

/**
 * Evidence-gated decision engine. Pure and deterministic for a given pack, context and options.
 *   strategies propose  ->  evidence gates (losers win ties, unknown never permits)  ->  sizing  ->  risk  ->  plan
 * Bots and scripts ask `plan` (what should happen here?) or `gate`/`decide` (may this trade happen?).
 * The default answer is no. Nothing here forecasts profit; it applies measured results only.
 * Plugs for research: evidence packs, features, models and strategies (see docs/DECISION-ENGINE.md).
 */

export const ENGINE_VERSION='decision-engine-v2';

/**
 * paper: simulated fills. pilot: small, capped real money used only to measure resting-order leads,
 * which price history cannot backtest. real: normal real money, proven strategies only.
 */
export type Mode='paper'|'pilot'|'real';

export type DecisionRequest={
  sport:Sport;phase:Phase;style:Style;mode:Mode;
  /** Price to buy the side being considered (its ask) and to sell it (its bid), in dollars per contract. */
  ask:number;bid?:number|null;
  /** Taker fee coefficient from market metadata. Research fallback is 0.0695. */
  feeCoefficient?:number;
  /** Optional outside probability estimate, reported for context only (models have not beaten the market). */
  modelProbability?:number|null;
};

export type VerdictCode='PROVEN'|'LEAD_PAPER'|'LEAD_PILOT'|'UNPROVEN_REAL'|'DROPPED'|'NO_EVIDENCE'|'NOT_EXECUTABLE'|'CLOSED'|'INVALID';
export type Verdict={
  engine:string;pack:string;trust:Trust;
  action:'allow'|'paper-only'|'block';
  /** Whether this request, in its mode, may proceed. */
  permitted:boolean;
  code:VerdictCode;reason:string;role:Role|null;
  /** Every evidence row that matched, or could not be ruled out. */
  evidence:Evidence[];deciding:Evidence|null;costs:Costs|null;
  modelEdge:number|null;
};

export type QuotePolicy={
  engine:string;pack:string;quote:boolean;status:'dropped'|'lead'|'proven'|'none';reason:string;
  evidence:Evidence|null;
  /** Pull resting orders for this long after a play/pitch event, from the reaction studies. */
  pullAfterEventMs:number|null;
};

export type PlannedTrade={proposal:Proposal;verdict:Verdict;stake:number;
  /** Why it will not happen: a verdict code, NO_STAKE, a risk code, or ONE_TAKER_PER_MARKET. Null for actions. */
  blocked:string|null;reason:string};
export type Plan={
  engine:string;pack:string;trust:Trust;time:number;slug:string;sport:Sport;phase:Phase|null;mode:Mode;
  /** What should happen now, best first. At most one taker entry per market. */
  actions:PlannedTrade[];
  considered:PlannedTrade[];errors:string[];summary:string;
};

export type EngineOptions={
  pack?:EvidencePack;trust?:Trust;
  features?:Record<string,Feature>;
  models?:(ProbabilityModel|ModelSpec)[];
  strategies?:readonly Strategy[];
  sizing?:Partial<SizingLimits>;risk?:Partial<RiskLimits>;
};

export type Engine={
  version:string;pack:{version:string;trust:Trust;source:string};
  evidence:readonly Evidence[];strategies:readonly Strategy[];models:readonly ProbabilityModel[];
  gate(ctx:DecisionContext,proposal:Proposal,mode:Mode):Verdict;
  decide(request:DecisionRequest):Verdict;
  quotePolicy(sport:Sport,phase:Phase,mode:Mode):QuotePolicy;
  plan(ctx:DecisionContext,options:{mode:Mode;risk?:RiskState;strategies?:string[]}):Plan;
  regime(ctx:DecisionContext,side:SideKey):Record<string,FeatureValue|undefined>;
};

/**
 * NFL: 88% of a big play's move is priced 30 s after the snap. MLB: 92% by 10 s after the official PA end.
 * CFB has no reaction study; it reuses the NFL window as an assumption until measured.
 */
const PULL_AFTER_EVENT_MS:Partial<Record<Sport,number>>={NFL:30_000,CFB:30_000,MLB:10_000};
const EPSILON=1e-9;
const inBand=(price:number,band:{min:number;max:number})=>price>band.min+EPSILON&&price<=band.max+EPSILON;
/** Price- or role-specific findings outrank the general result for the same regime. */
const specificity=(item:Evidence)=>(item.price?2:0)+(item.role?1:0)+(item.conditions?.length??0)+(item.strategies?1:0);
const mostSpecific=(items:Evidence[])=>[...items].sort((a,b)=>specificity(b)-specificity(a))[0]??null;

type MatchInput={sport:Sport;phase:Phase;style:Style;strategy?:string;price?:number;role?:Role;read?:(feature:string)=>FeatureValue|undefined};
function matchRow(row:Evidence,input:MatchInput):'match'|'no'|'unknown' {
  if(!row.sports.includes(input.sport)||!row.phases.includes(input.phase)||!row.styles.includes(input.style))return 'no';
  if(row.strategies&&(!input.strategy||!row.strategies.includes(input.strategy)))return 'no';
  if(row.price&&(input.price===undefined||!inBand(input.price,row.price)))return 'no';
  if(row.role&&row.role!==input.role)return 'no';
  let unknown=false;
  for(const condition of row.conditions??[]){
    const result=testCondition(condition,input.read?.(condition.feature));
    if(result===false)return 'no';
    if(result===undefined)unknown=true;
  }
  return unknown?'unknown':'match';
}

export function createEngine(options:EngineOptions={}):Engine {
  const trust:Trust=options.trust??(options.pack&&options.pack!==BUNDLED_PACK?'untrusted':'bundled');
  const pack=trust==='untrusted'?restrictUntrusted(options.pack!):options.pack??BUNDLED_PACK;
  const evidence=Object.freeze([...pack.evidence]);
  const features:FeatureRegistry=options.features?featureRegistry(options.features):BUILTIN_FEATURES;
  const models=Object.freeze([...(pack.models??[]),...(options.models??[])].map(model=>'predict' in model?model:compileModel(model)));
  const strategies=options.strategies??DEFAULT_STRATEGIES;
  const sizing={...DEFAULT_SIZING,...options.sizing},riskLimits={...DEFAULT_RISK,...options.risk};
  const base={engine:ENGINE_VERSION,pack:pack.version};

  function gate(ctx:DecisionContext,proposal:Proposal,mode:Mode):Verdict {
    const quote=quoteOf(ctx,proposal.side),coefficient=ctx.market.feeCoefficient??DEFAULT_FEE_COEFFICIENT;
    const taker=proposal.style!=='maker',price=proposal.price,bid=quote.bid;
    const verdict=(action:Verdict['action'],code:VerdictCode,reason:string,extra:Partial<Verdict>={}):Verdict=>({...base,trust,action,code,reason,
      permitted:action==='allow'||(action==='paper-only'&&(mode==='paper'||(mode==='pilot'&&!taker))),
      role:null,evidence:[],deciding:null,costs:null,modelEdge:null,...extra});
    if(!Number.isFinite(price)||price<=0||price>=1||(taker&&bid!==null&&(!Number.isFinite(bid)||bid<=0||bid>price))||!Number.isFinite(coefficient)||coefficient<0)
      return verdict('block','INVALID','A valid price between 0 and 1 (and a bid not above the ask) is required.');
    const phase=phaseOf(ctx);
    if(!phase)return verdict('block','CLOSED','The game is final or has no scheduled start.');
    const costs=taker?estimateCosts(price,bid,coefficient):null;
    const role=roleOf(taker?price:quote.ask??price,taker?bid:quote.ask===null?null:bid);
    const modelEdge=costs&&typeof proposal.modelProbability==='number'&&Number.isFinite(proposal.modelProbability)?proposal.modelProbability-costs.breakEvenWinRate:null;
    const extra={role,costs,modelEdge};
    if(taker&&costs!.spread!==null&&costs!.spread>MAX_EXECUTABLE_SPREAD+EPSILON)
      return verdict('block','NOT_EXECUTABLE',`The ${Math.round(costs!.spread*100)}¢ spread is wider than the 5¢ the research counts as a real price.`,extra);
    const input:MatchInput={sport:ctx.market.sport,phase,style:proposal.style,strategy:proposal.strategy,price,role,
      read:name=>readFeature(features,name,ctx,proposal.side)};
    const matched=evidence.map(row=>({row,result:matchRow(row,input)})).filter(m=>m.result!=='no');
    const all=matched.map(m=>m.row),full={...extra,evidence:all};
    // Losers win ties, and a losing row that cannot be ruled out still blocks.
    const dropped=matched.filter(m=>m.row.status==='dropped').map(m=>m.row);
    if(dropped.length){
      const item=mostSpecific(dropped)!,certain=matched.some(m=>m.row===item&&m.result==='match');
      return verdict('block','DROPPED',`${certain?'':'May apply (a condition is unknown): '}${item.title}: ${formatEstimate(item.estimate)} measured (${item.sample}). ${item.plain}`,{...full,deciding:item});
    }
    const sure=matched.filter(m=>m.result==='match').map(m=>m.row);
    const proven=sure.filter(row=>row.status==='proven');
    if(proven.length){const item=mostSpecific(proven)!;return verdict('allow','PROVEN',`${item.title}: proven ${formatEstimate(item.estimate)} (${item.sample}).`,{...full,deciding:item});}
    const leads=sure.filter(row=>row.status==='lead');
    if(leads.length){
      const item=mostSpecific(leads)!,test=`${item.title}: unproven lead ${formatEstimate(item.estimate)}.`;
      if(mode==='paper')return verdict('paper-only','LEAD_PAPER',`${test} Paper trading only, to settle the question.`,{...full,deciding:item});
      if(mode==='pilot'&&!taker)return verdict('paper-only','LEAD_PILOT',`${test} Capped pilot only, to measure real fills and rewards.`,{...full,deciding:item});
      return verdict('paper-only','UNPROVEN_REAL',`${item.title}: ${formatEstimate(item.estimate)} is not proven yet. Real money waits for the forward test.`,{...full,deciding:item});
    }
    return verdict('block','NO_EVIDENCE',`No study covers ${ctx.market.sport} ${phase} ${proposal.style} trades${proposal.strategy!=='manual'?` from ${proposal.strategy}`:''} yet. The engine does not trade untested regimes.`,full);
  }

  function decide(request:DecisionRequest):Verdict {
    const ctx:DecisionContext={now:0,phase:request.phase,market:{slug:'manual',sport:request.sport,startTime:null,feeCoefficient:request.feeCoefficient,
      yes:{ask:request.ask,bid:request.bid??null},no:{ask:null,bid:null}}};
    const verdict=gate(ctx,{strategy:'manual',strategyVersion:'1',side:'yes',style:request.style,price:request.ask,
      exit:{kind:'hold-to-settlement'},rationale:'Manual request.',modelProbability:request.modelProbability},request.mode);
    return verdict;
  }

  function quotePolicy(sport:Sport,phase:Phase,mode:Mode):QuotePolicy {
    const item=mostSpecific(evidence.filter(row=>matchRow(row,{sport,phase,style:'maker'})==='match'));
    const pull=phase==='live'?PULL_AFTER_EVENT_MS[sport]??null:null;
    const shared={...base,evidence:item,pullAfterEventMs:pull};
    if(!item)return {...shared,quote:false,status:'none',reason:`No maker study covers ${sport} ${phase}.`};
    const summary=`${item.title}: ${formatEstimate(item.estimate)} per contract optimistic, ${item.conservative?formatEstimate(item.conservative):'n/a'} conservative, before rewards.`;
    if(item.status==='dropped')return {...shared,quote:false,status:'dropped',reason:`${summary} Stay out.`};
    if(item.status==='proven')return {...shared,quote:true,status:'proven',reason:summary};
    const permitted=mode!=='real';
    return {...shared,quote:permitted,status:'lead',reason:permitted?`${summary} Paper or capped pilot only, to measure real fills and rewards.`:`${summary} Unproven; full real-money quoting waits for the pilot's result.`};
  }

  function plan(ctx:DecisionContext,planOptions:{mode:Mode;risk?:RiskState;strategies?:string[]}):Plan {
    const mode=planOptions.mode,phase=phaseOf(ctx),sport=ctx.market.sport;
    const shared={...base,trust,time:ctx.now,slug:ctx.market.slug,sport,phase,mode};
    if(!phase)return {...shared,actions:[],considered:[],errors:[],summary:'The game is final or has no scheduled start.'};
    const coefficient=ctx.market.feeCoefficient??DEFAULT_FEE_COEFFICIENT;
    const research=models.filter(model=>model.id!=='market-implied'&&model.applies(sport,phase));
    const tools:StrategyTools={phase,
      feature:(name,side)=>readFeature(features,name,ctx,side),
      quote:side=>quoteOf(ctx,side),
      costs:side=>{const q=quoteOf(ctx,side);return q.ask===null?null:estimateCosts(q.ask,q.bid,coefficient);},
      model:side=>{for(const model of research){const p=model.predict(ctx,side,features);if(p!==null)return {id:model.id,p};}return null;},
      pullAfterEventMs:phase==='live'?PULL_AFTER_EVENT_MS[sport]??null:null};
    const errors:string[]=[],proposals:Proposal[]=[];
    for(const strategy of strategies){
      if(planOptions.strategies&&!planOptions.strategies.includes(strategy.id))continue;
      try{proposals.push(...strategy.propose(ctx,tools));}
      catch(error){errors.push(`${strategy.id}: ${(error as Error).message}`);}
    }
    const dataAge=typeof ctx.market.observedAt==='number'&&Number.isFinite(ctx.market.observedAt)&&ctx.market.observedAt<=ctx.now?ctx.now-ctx.market.observedAt:null;
    const risk={...(planOptions.risk??EMPTY_RISK)};
    const considered:PlannedTrade[]=proposals.map(proposal=>{
      const verdict=gate(ctx,proposal,mode);
      const stake=stakeFor({action:verdict.permitted?verdict.action:'block',mode,evidence:verdict.deciding,costs:verdict.costs,limits:sizing});
      if(!verdict.permitted)return {proposal,verdict,stake:0,blocked:verdict.code,reason:verdict.reason};
      if(stake<=0)return {proposal,verdict,stake:0,blocked:'NO_STAKE',reason:'The evidence lower bound does not support a real-money stake.'};
      return {proposal,verdict,stake,blocked:null,reason:verdict.reason};
    });
    const score=(trade:PlannedTrade)=>{const e=trade.verdict.deciding?.estimate;return e?(e.unit==='cents'?e.mean/100:e.mean):-Infinity;};
    const ranked=considered.filter(trade=>!trade.blocked).sort((a,b)=>score(b)-score(a)||specificity(b.verdict.deciding!)-specificity(a.verdict.deciding!));
    const actions:PlannedTrade[]=[];let taker=false;
    for(const trade of ranked){
      if(trade.proposal.style!=='maker'&&taker){trade.blocked='ONE_TAKER_PER_MARKET';trade.reason='Another taker entry on this market ranked higher.';continue;}
      const check=checkRisk(risk,riskLimits,trade.stake,dataAge);
      if(!check.ok){trade.blocked=check.code;trade.reason=check.reason;continue;}
      risk.openExposure+=trade.stake;risk.tradesToday++;
      if(trade.proposal.style!=='maker')taker=true;
      actions.push(trade);
    }
    const summary=actions.length?actions.map(a=>`${a.proposal.strategy} ${a.proposal.side.toUpperCase()} $${a.stake.toFixed(2)} at ${(a.proposal.price*100).toFixed(1)}¢ (${a.verdict.code})`).join('; ')
      :considered.length?`No action. ${considered[0].reason}`:errors.length?`No action. ${errors[0]}`:'No strategy proposed a trade here.';
    return {...shared,actions,considered,errors,summary};
  }

  function regime(ctx:DecisionContext,side:SideKey){
    return Object.fromEntries(Object.keys(features).map(name=>[name,readFeature(features,name,ctx,side)]));
  }

  return {version:ENGINE_VERSION,pack:{version:pack.version,trust,source:pack.source},evidence,strategies,models,gate,decide,quotePolicy,plan,regime};
}

/** The compiled-in engine: bundled evidence, built-in features and strategies. Deterministic for replay. */
export const defaultEngine=createEngine();
export const decide=(request:DecisionRequest)=>defaultEngine.decide(request);
export const quotePolicy=(sport:Sport,phase:Phase,mode:Mode)=>defaultEngine.quotePolicy(sport,phase,mode);

/** Bundled evidence rows matching a regime on base fields (conditions ignored). */
export function matchingEvidence(sport:Sport,phase:Phase,style:Style,price?:number,role?:Role):Evidence[] {
  return defaultEngine.evidence.filter(row=>!row.conditions?.length&&matchRow(row,{sport,phase,style,price,role})==='match');
}
