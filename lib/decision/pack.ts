import {z} from 'zod';
import {EVIDENCE,EVIDENCE_VERSION,type Evidence} from './evidence.ts';
import {modelSpecSchema,type ModelSpec} from './models.ts';

/**
 * An evidence pack is everything research hands the engine: evidence rows plus model specs,
 * as one versioned JSON document. The bundled pack is compiled in; newer packs can be streamed
 * in from storage (lib/decision/sources.ts, docs/DATA-PLATFORM.md) without a code deploy.
 */

export const PACK_SCHEMA='dugout-evidence-v1';

const SPORTS=['NFL','CFB','MLB','ATP','WTA'] as const;
const estimate=z.object({mean:z.number().finite(),lo:z.number().finite().nullable(),hi:z.number().finite().nullable(),unit:z.enum(['return','cents'])}).strict();
const condition=z.object({feature:z.string().min(1).max(80),op:z.enum(['eq','ne','in','gt','gte','lt','lte','between']),
  value:z.union([z.number().finite(),z.string().max(200),z.boolean(),z.array(z.union([z.number().finite(),z.string().max(200)])).max(100)])}).strict();
export const evidenceSchema=z.object({
  id:z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),title:z.string().min(1).max(200),status:z.enum(['dropped','lead','proven']),
  sports:z.array(z.enum(SPORTS)).min(1),phases:z.array(z.enum(['pregame','live'])).min(1),styles:z.array(z.enum(['taker-scalp','taker-hold','maker'])).min(1),
  price:z.object({min:z.number().min(0).max(1),max:z.number().min(0).max(1)}).strict().refine(b=>b.min<b.max,'price.min must be below price.max').optional(),
  role:z.enum(['favourite','underdog']).optional(),
  conditions:z.array(condition).max(20).optional(),strategies:z.array(z.string().min(1).max(80)).max(20).optional(),
  estimate,conservative:estimate.optional(),
  sample:z.string().min(1).max(300),source:z.string().min(1).max(300),plain:z.string().min(1).max(1000),
}).strict();
export const packSchema=z.object({
  schema:z.literal(PACK_SCHEMA),version:z.string().min(1).max(80),generatedAt:z.string().min(1).max(40),source:z.string().min(1).max(300),
  evidence:z.array(evidenceSchema).max(2000),models:z.array(modelSpecSchema).max(100).optional(),
}).strict().superRefine((pack,ctx)=>{
  const ids=new Set<string>();
  for(const row of pack.evidence){if(ids.has(row.id))ctx.addIssue({code:z.ZodIssueCode.custom,message:`Duplicate evidence id ${row.id}`});ids.add(row.id);}
  const models=new Set<string>();
  for(const model of pack.models??[]){if(models.has(model.id))ctx.addIssue({code:z.ZodIssueCode.custom,message:`Duplicate model id ${model.id}`});models.add(model.id);}
});

export type EvidencePack={schema:typeof PACK_SCHEMA;version:string;generatedAt:string;source:string;evidence:Evidence[];models?:ModelSpec[]};
/**
 * bundled: compiled into this code. pinned: fetched, and its SHA-256 matched a configured pin.
 * untrusted: fetched without a pin. Untrusted packs cannot enable real money (see restrictUntrusted).
 */
export type Trust='bundled'|'pinned'|'untrusted';

export const BUNDLED_PACK:EvidencePack=Object.freeze({schema:PACK_SCHEMA,version:EVIDENCE_VERSION,generatedAt:'2026-09-27T00:00:00Z',
  source:'lib/decision/evidence.ts (research/studies/report.md)',evidence:[...EVIDENCE],models:[]});

export function parsePack(raw:unknown):{ok:true;pack:EvidencePack}|{ok:false;error:string} {
  const parsed=packSchema.safeParse(raw);
  if(!parsed.success){const issue=parsed.error.issues[0];return {ok:false,error:`${issue.path.join('.')||'pack'}: ${issue.message}`};}
  return {ok:true,pack:parsed.data as EvidencePack};
}

/** Whoever can write to storage must not be able to switch on real money: unpinned `proven` rows become leads. */
export function restrictUntrusted(pack:EvidencePack):EvidencePack {
  return {...pack,evidence:pack.evidence.map(row=>row.status==='proven'?{...row,status:'lead' as const,
    plain:`${row.plain} (Marked proven in an unpinned pack; treated as a lead until the pack is pinned.)`}:row)};
}
