import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {db,sameOrigin} from '@/lib/server/storage';
import {requireSiteOwner,siteOwnerEnabled,type SiteOwnerBindings} from '@/lib/server/owner-access';
import {requireSitesOwner} from '@/lib/runner/sites-proxy';
import {RunnerError} from '@/lib/runner/protocol';
import {readTennisSession} from '@/lib/tennis/server';
import {ADVISOR_ALLOWANCE,ADVISOR_RESERVATION,advisorPayload,estimatedAdvisorMicrodollars,type AdvisorMessage} from '@/lib/tennis/advisor';
import {reserveMessageSql,reserveAllowanceSql} from '@/lib/tennis/advisor-storage';

const allowanceKey='advisor:allowance:v1';
const headers={'Cache-Control':'no-store'};
const apiKey=()=>{const value=(env as unknown as Record<string,unknown>).ANTHROPIC_API_KEY;return typeof value==='string'?value.trim():'';};
type Entry={question:string;answer?:string;status:'processing'|'complete'|'failed';nonce:string;estimatedMicrodollars?:number;error?:string;truncated?:boolean};
async function state(owner:string){
  const prefix=`advisor:chat:${owner}:`;
  const [allowance,notes,rows]=await Promise.all([
    db().prepare('SELECT value FROM cache WHERE key=?').bind(allowanceKey).first<{value:string}>(),
    db().prepare('SELECT value FROM cache WHERE key=?').bind(`advisor:memory:${owner}`).first<{value:string}>(),
    db().prepare('SELECT value,updated FROM cache WHERE key>=? AND key<? ORDER BY updated DESC LIMIT 30').bind(prefix,prefix+'\uffff').all<{value:string;updated:number}>(),
  ]);
  const entries=rows.results.reverse().map(row=>({...JSON.parse(row.value) as Entry,time:row.updated}));
  return {enabled:true,configured:!!apiKey(),reservedMicrodollars:Number(allowance?.value??0),allowanceMicrodollars:ADVISOR_ALLOWANCE,
    messagesRemaining:Math.max(0,Math.floor((ADVISOR_ALLOWANCE-Number(allowance?.value??0))/ADVISOR_RESERVATION)),
    memory:notes?.value??'Explain clearly and concisely. Paper trading only. Keep API costs small.',
    messages:entries.flatMap(e=>[{role:'user' as const,content:e.question},...(e.answer?[{role:'assistant' as const,content:e.answer}]:e.error?[{role:'assistant' as const,content:e.error}]:[])]),
    recentEstimatedMicrodollars:entries.reduce((n,e)=>n+(e.estimatedMicrodollars??0),0)};
}
export async function GET(req:Request){try{
  const id=requireSitesOwner(req);
  if(!siteOwnerEnabled(id,env as SiteOwnerBindings))return Response.json({enabled:false,configured:false},{headers});
  return Response.json(await state(id),{headers});
}catch(error){return Response.json({error:error instanceof RunnerError?error.message:'The saved adviser chat is unavailable.'},{status:error instanceof RunnerError?error.status:503,headers});}}
const requestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('send'),requestId:z.string().uuid(),message:z.string().trim().min(1).max(1200)}).strict(),
  z.object({action:z.literal('memory'),memory:z.string().max(1200)}).strict(),
]);
export async function POST(req:Request){
  let recordKey:string|undefined,entry:Entry|undefined;
  try{
    sameOrigin(req);
    const id=requireSitesOwner(req);requireSiteOwner(id,env as SiteOwnerBindings);
    const raw=await req.text();if(raw.length>8000)throw new Error('Keep the message under 1,200 characters.');
    const body=requestSchema.parse(JSON.parse(raw)),now=Date.now();
    if(body.action==='memory'){
      await db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').bind(`advisor:memory:${id}`,body.memory,now).run();
      return Response.json(await state(id),{headers});
    }
    if(!apiKey())return Response.json({error:'Claude is not connected. Add ANTHROPIC_API_KEY as a private site secret. No call was made.'},{status:503,headers});
    recordKey=`advisor:chat:${id}:${body.requestId}`;
    const existing=await db().prepare('SELECT value FROM cache WHERE key=?').bind(recordKey).first<{value:string}>();
    if(existing){const saved=JSON.parse(existing.value) as Entry;
      if(saved.question!==body.message)throw new Error('That message ID was already used.');
      if(saved.status==='processing')return Response.json({error:'This message is already processing. It will not be sent twice.'},{status:409,headers});
      return Response.json({...await state(id),error:saved.error},{headers});
    }
    const before=await state(id),{session}=await readTennisSession(req);
    const payload=advisorPayload(session,before.memory,before.messages as AdvisorMessage[],body.message);
    entry={question:body.message,status:'processing',nonce:crypto.randomUUID()};
    const serialized=JSON.stringify(entry);
    await db().prepare('INSERT OR IGNORE INTO cache(key,value,updated) VALUES(?,?,?)').bind(allowanceKey,'0',now).run();
    // A single transaction reserves allowance and deduplicates Send across tabs.
    const result=await db().batch([
      db().prepare(reserveMessageSql).bind(recordKey,serialized,now,allowanceKey,ADVISOR_ALLOWANCE-ADVISOR_RESERVATION),
      db().prepare(reserveAllowanceSql).bind(ADVISOR_RESERVATION,now,allowanceKey,recordKey,serialized),
    ]);
    if(!result[0].meta.changes){entry=undefined;throw new Error('The adviser allowance is used up, or this message is already processing. No extra call was made.');}
    const auth={'Content-Type':'application/json','anthropic-version':'2023-06-01','x-api-key':apiKey()};
    const count=await fetch('https://api.anthropic.com/v1/messages/count_tokens',{method:'POST',headers:auth,body:JSON.stringify({model:payload.model,system:payload.system,messages:payload.messages}),signal:AbortSignal.timeout(15_000)});
    if(!count.ok)throw new Error('Claude could not check this message. Check the API key and account in Anthropic. No automatic retry was made.');
    const tokens=await count.json() as {input_tokens?:number};
    if(!Number.isSafeInteger(tokens.input_tokens)||tokens.input_tokens!<0||tokens.input_tokens!>18_000)throw new Error('The context exceeds the small-message budget. No reply was requested.');
    const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:auth,body:JSON.stringify(payload),signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error('Claude could not reply. Check your Anthropic balance or key. No automatic retry was made.');
    const data=await response.json() as {content?:{type:string;text?:string}[];usage?:{input_tokens:number;output_tokens:number};stop_reason?:string};
    const answer=data.content?.filter(c=>c.type==='text').map(c=>c.text??'').join('\n').trim();
    if(!answer)throw new Error('Claude returned no text. No automatic retry was made.');
    entry={...entry,status:'complete',answer:answer.slice(0,8000)+(data.stop_reason==='max_tokens'?'\n\nReply length limit reached. Send a follow-up if needed.':''),
      estimatedMicrodollars:data.usage?estimatedAdvisorMicrodollars(data.usage.input_tokens,data.usage.output_tokens):undefined,truncated:data.stop_reason==='max_tokens'};
    await db().prepare('UPDATE cache SET value=? WHERE key=?').bind(JSON.stringify(entry),recordKey).run();
    return Response.json(await state(id),{headers});
  }catch(error){
    const message=error instanceof Error&&!(error instanceof z.ZodError)?error.message:'Check your message and try again.';
    // Keep the allowance after uncertain outcomes; never assume a timeout was free.
    if(recordKey&&entry)await db().prepare('UPDATE cache SET value=? WHERE key=? AND value LIKE ?').bind(JSON.stringify({...entry,status:'failed',error:message}),recordKey,`%${entry.nonce}%`).run().catch(()=>{});
    return Response.json({error:message},{status:error instanceof RunnerError?error.status:400,headers});
  }
}
