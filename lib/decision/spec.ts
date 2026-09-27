import {z} from 'zod';

/**
 * Strategy specifications: the machine-readable, pre-registered description of every strategy version
 * (docs/STRATEGY-ARCHITECTURE.md). A strategy's code proposes trades; its spec says WHY it should have an edge,
 * what data it needs, exactly how it enters and exits, what execution it assumes, and what would kill it.
 *
 * Rules:
 * - A spec is identified by id@version. Changing any rule parameter, exit, execution assumption or required feature
 *   is a new version (lib/decision/prereg.lock.json pins a hash of each version's rules; tests fail on a silent edit).
 * - Research status and forward-test status are recorded here, but PERMISSION to trade comes only from evidence
 *   packs (lib/decision/evidence.ts). A spec cannot make a strategy tradable; it can only stop one (status rejected).
 */

/** Exit rules, shared by strategy proposals, specs and shadow evaluation. The first rule that triggers wins. */
export type ExitRule=
  |{kind:'settlement'}
  /** Football: the drive ends (score, change of possession, end of the half). */
  |{kind:'drive-end'}
  |{kind:'possession-change'}
  |{kind:'time';ms:number}
  /** Net return (after both fees) reaches +netReturn. */
  |{kind:'target';netReturn:number}
  /** Net return falls to -netReturn. */
  |{kind:'stop';netReturn:number}
  /** Net return falls `drawdown` below its best so far (after it has been positive). */
  |{kind:'trailing';drawdown:number}
  /** Fair-value convergence after an event: the side's midpoint recovers `fraction` of the event's move against it. */
  |{kind:'retrace';fraction:number}
  /** Maker fills: marked to the midpoint `ms` after the fill (the research's markout convention). */
  |{kind:'markout';ms:number};

const exitRule:z.ZodType<ExitRule>=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('settlement')}).strict(),
  z.object({kind:z.literal('drive-end')}).strict(),
  z.object({kind:z.literal('possession-change')}).strict(),
  z.object({kind:z.literal('time'),ms:z.number().int().positive().max(6*3_600_000)}).strict(),
  z.object({kind:z.literal('target'),netReturn:z.number().positive().max(10)}).strict(),
  z.object({kind:z.literal('stop'),netReturn:z.number().positive().max(1)}).strict(),
  z.object({kind:z.literal('trailing'),drawdown:z.number().positive().max(1)}).strict(),
  z.object({kind:z.literal('retrace'),fraction:z.number().positive().max(1)}).strict(),
  z.object({kind:z.literal('markout'),ms:z.number().int().positive().max(3_600_000)}).strict(),
]) as z.ZodType<ExitRule>;

/** Where the profit is supposed to come from. Each needs a different exit (see the architecture doc). */
export const EDGE_SOURCES=['winner-identification','temporary-mispricing','liquidity-provision','speed'] as const;
export const FAMILIES=['event-reaction','state-calibration','favourite-longshot','liquidity-provision','model-disagreement','temporary-mispricing','control'] as const;
/** documented: published empirical finding in comparable markets. plausible: a mechanism with indirect support. speculative: neither. */
export const BASIS=['documented','plausible','speculative'] as const;
export const RESEARCH_STATUS=['idea','specified','historical-test','holdout','forward-paper','promoted','rejected','superseded'] as const;
export const FORWARD_STATUS=['not-started','shadow','paper','complete'] as const;

export const specSchema=z.object({
  id:z.string().regex(/^[a-z0-9-]+$/).max(60),version:z.string().regex(/^[0-9]+$/),
  title:z.string().min(3).max(120),
  family:z.enum(FAMILIES),
  sports:z.array(z.enum(['NFL','CFB','MLB','ATP','WTA'])).min(1),phases:z.array(z.enum(['pregame','live'])).min(1),
  /** The economic claim: who is wrong, about what, and why they stay wrong. */
  hypothesis:z.string().min(20).max(1200),
  /** Why the price should be wrong in exactly this situation, and what would make the claim false. */
  mechanism:z.string().min(20).max(1200),
  edgeSource:z.enum(EDGE_SOURCES),
  basis:z.object({kind:z.enum(BASIS),support:z.array(z.string().max(300)).max(10),against:z.array(z.string().max(300)).max(10)}).strict(),
  /** Feature names (lib/decision/features.ts, sports modules) the entry rule reads. Missing ones mean no trade. */
  requiredFeatures:z.array(z.string().max(80)).max(30),
  /** The pre-registered entry rule: a plain description plus every threshold it uses. */
  entry:z.object({rule:z.string().min(10).max(800),params:z.record(z.string(),z.union([z.number(),z.string(),z.boolean()]))}).strict(),
  /** Primary exit (the rule under test) and competing exits measured alongside it as counterfactuals. */
  exits:z.object({primary:z.array(exitRule).min(1).max(6),alternatives:z.array(z.object({id:z.string().regex(/^[a-z0-9-]+$/).max(40),rules:z.array(exitRule).min(1).max(6)}).strict()).max(10)}).strict(),
  style:z.enum(['taker-hold','taker-scalp','maker']),
  maxSpread:z.number().positive().max(0.1),
  latency:z.object({assumedMs:z.number().int().min(0).max(600_000),note:z.string().max(400)}).strict(),
  expectedHold:z.union([z.literal('settlement'),z.object({minMs:z.number().int().min(0),maxMs:z.number().int().positive()}).strict()]),
  sizing:z.enum(['paper-fixed','quarter-kelly-lower-bound']),
  /** What result kills this version. Checked by the study and the scorecard. */
  invalidation:z.array(z.string().min(5).max(300)).min(1).max(8),
  minSample:z.object({trades:z.number().int().positive(),games:z.number().int().positive()}).strict(),
  research:z.object({status:z.enum(RESEARCH_STATUS),study:z.string().max(200).optional(),result:z.string().max(400).optional()}).strict(),
  forward:z.object({status:z.enum(FORWARD_STATUS),note:z.string().max(300).optional()}).strict(),
  supersedes:z.string().regex(/^[a-z0-9-]+@[0-9]+$/).optional(),
}).strict();
export type StrategySpec=z.infer<typeof specSchema>;

export const specKey=(spec:{id:string;version:string})=>`${spec.id}@${spec.version}`;

/** The pre-registered part of a spec: anything that changes trading behaviour. Prose and statuses are excluded. */
export function registeredRules(spec:StrategySpec) {
  return {id:spec.id,version:spec.version,sports:spec.sports,phases:spec.phases,requiredFeatures:spec.requiredFeatures,
    entry:spec.entry.params,exits:spec.exits,style:spec.style,maxSpread:spec.maxSpread,latency:spec.latency.assumedMs,sizing:spec.sizing};
}

/** Stable JSON: object keys sorted, so the hash does not depend on how a spec was written. */
export function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function rulesHash(spec:StrategySpec):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(registeredRules(spec))));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

/**
 * Before the forward-paper stage a strategy's would-be trades are measured in shadow (lib/decision/shadow.ts) and never
 * take the paper account's slot, unless the owner explicitly explores it (config.explore) on paper.
 */
export const SHADOW_STATUS:ReadonlySet<string>=new Set(['idea','specified','historical-test','holdout']);
/** Killed or replaced versions never propose again. Their specs stay, as the record of what was tried. */
export const RETIRED_STATUS:ReadonlySet<string>=new Set(['rejected','superseded']);
