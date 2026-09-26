import {env} from 'cloudflare:workers';
import {db,profile} from '../server/storage';
import {polymarketSecrets} from '../trading/credentials';
import {defaultTennisConfig,createTennisSession,stepTennisSession,applyTennisAction} from './engine';
import {normalizeTennisConfig} from './rules';
import {getTennisCatalog,getTennisMarket,loadTennisInput} from './data';
import type {TennisAction,TennisInput,TennisMarket,TennisRuntime,TennisSession} from './types';

export function tennisRuntime():TennisRuntime {
  return {mode:'browser',intervalMs:2500,backgroundConnected:false,
    streamConfigured:!!polymarketSecrets(env as unknown as Record<string,unknown>),
    description:'Paper checks run while this page is open and visible. Keep it open to manage exits.'};
}
export async function readTennisSession(req:Request):Promise<{ownerId:string;session:TennisSession;stored:boolean}> {
  const {id:ownerId}=await profile(req);
  let row=await db().prepare('SELECT value,revision FROM tennis_sessions WHERE owner_id=?').bind(ownerId).first<{value:string;revision:number}>();
  if(!row){
    const session=createTennisSession({...defaultTennisConfig(100),strategy:'auto'},Date.now());
    await db().prepare('INSERT OR IGNORE INTO tennis_sessions(owner_id,value,revision) VALUES(?,?,0)').bind(ownerId,JSON.stringify({...session,revision:0})).run();
    row=await db().prepare('SELECT value,revision FROM tennis_sessions WHERE owner_id=?').bind(ownerId).first<{value:string;revision:number}>();
  }
  if(!row)throw new Error('The tennis paper account could not be loaded.');
  const saved=JSON.parse(row.value) as TennisSession;
  return {ownerId,session:{...saved,config:normalizeTennisConfig(saved.config),revision:row.revision},stored:true};
}
type Loaded=Awaited<ReturnType<typeof readTennisSession>>;
const reason=(e:unknown)=>e instanceof Error?e.message:'A tennis source is unavailable.';
async function withDeadline<T>(promise:Promise<T>,ms:number,message='Tennis discovery is taking too long. Known positions remain available for exit checks.'):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}

export async function gatherTennisInputs(session:TennisSession,action:TennisAction){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('Tennis data deadline','TimeoutError')),9500);
  const chosen=new Map<string,{market:TennisMarket;allowRest:boolean}>(),failures:string[]=[];
  let cursor=session.scanCursor??0;
  try{
    for(const p of session.positions.filter(p=>p.status==='open'))chosen.set(p.slug,{market:p.market,allowRest:true});
    if(session.pending?.market){
      const pending=session.pending;
      // Entry permission must use a current catalog status, not the saved signal.
      const market=pending.action==='BUY'
        ?await withDeadline(getTennisMarket(pending.slug,session.config.leagues),7000).catch(e=>{failures.push(reason(e));return {...pending.market,active:false,live:false};})
        :pending.market;
      chosen.set(pending.slug,{market,allowRest:true});
    }
    // Existing positions and pending orders get the entire data budget. A slow
    // discovery request must never delay a possible exit on a known market.
    if(action.action==='tick'&&!chosen.size&&session.status==='running'){
      const catalog=await withDeadline(getTennisCatalog({includeHistory:false,leagues:session.config.leagues}),7000).catch(e=>{failures.push(reason(e));return {markets:[] as TennisMarket[]};});
      const candidates=catalog.markets.filter(m=>m.active&&m.live&&!m.ended&&session.config.leagues.includes(m.league)&&(!session.config.focusSlug||m.slug===session.config.focusSlug)).sort((a,b)=>a.slug.localeCompare(b.slug));
      // Rotate over every live candidate. Both tours receive books when available.
      const tourPools=session.config.leagues.map(league=>candidates.filter(m=>m.league===league));
      const interleaved:TennisMarket[]=[];
      for(let i=0;i<Math.max(0,...tourPools.map(p=>p.length));i++)for(const pool of tourPools)if(pool[i])interleaved.push(pool[i]);
      // Keep two matches long enough to build a baseline, then move to the next cohort.
      const cohort=Math.floor(Date.now()/Math.max(180_000,session.config.baselineWindowMs*3));
      const start=interleaved.length?(cohort*2)%interleaved.length:0;
      const fallback=Array.from({length:Math.min(2,interleaved.length)},(_,i)=>interleaved[(start+i)%interleaved.length]),restSlugs=new Set<string>();
      for(let i=0;i<Math.min(2,fallback.length);i++)restSlugs.add(fallback[(cursor+i)%fallback.length].slug);
      for(const market of candidates)chosen.set(market.slug,{market,allowRest:restSlugs.has(market.slug)});
      if(!candidates.length)failures.push(session.config.focusSlug?'The focused game is not currently confirmed live and open. Waiting without switching games.':`No live ${session.config.leagues.join(' or ')} game is available. Waiting for play to begin.`);
      cursor=fallback.length?(cursor+2)%fallback.length:0;
    }
    // A slow second book must not age a usable first book past the five-second gate.
    const bookTimer=setTimeout(()=>controller.abort(new DOMException('Book collection deadline','TimeoutError')),4500);
    let responses:PromiseSettledResult<TennisInput>[];
    try{responses=await Promise.allSettled([...chosen.values()].map(({market,allowRest})=>withDeadline(loadTennisInput(market,controller.signal,{allowRest}),4500,'A book check took too long. Waiting for a fresh quote.')));}
    finally{clearTimeout(bookTimer);}
    const inputs:TennisInput[]=[];
    responses.forEach((r,i)=>{if(r.status==='fulfilled')inputs.push(r.value);else if([...chosen.values()][i].allowRest)failures.push(reason(r.reason));});
    return {inputs,failures,cursor};
  }finally{clearTimeout(timer);}
}

/** One D1 batch commits account revision and all new journal entries together. */
async function persist(loaded:Loaded,next:TennisSession,action:TennisAction,inputs:TennisInput[]){
  const {ownerId,session:old}=loaded,revision=old.revision+1;
  next.revision=revision;
  const statements:D1PreparedStatement[]=[];
  const addJournal=(id:string,kind:string,value:unknown,time:number)=>statements.push(db().prepare('INSERT OR IGNORE INTO tennis_journal(id,owner_id,session_id,kind,value,created_at) SELECT ?,?,?,?,?,? FROM tennis_sessions WHERE owner_id=? AND revision=?').bind(`${ownerId}:${id}`,ownerId,next.id,kind,JSON.stringify(value),time,ownerId,old.revision));
  const knownDecisions=new Set(old.decisions.map(d=>d.id)),knownLedger=new Set(old.ledger.map(e=>e.id));
  for(const d of next.decisions)if(!knownDecisions.has(d.id))addJournal(`${next.id}:${d.id}`,'decision',d,d.time);
  for(const e of next.ledger)if(!knownLedger.has(e.id))addJournal(`${next.id}:${e.id}`,'execution',{...e,configVersion:next.config.version},e.time);
  if(action.commandId)addJournal(`command:${action.commandId}`,'control',{fingerprint:JSON.stringify(action),action,sessionId:next.id},Date.now());
  if(next.id!==old.id){addJournal(`archive:${old.id}`,'archive',old,Date.now());addJournal(`config:${next.id}`,'config',next.config,Date.now());}
  if(JSON.stringify(next.config)!==JSON.stringify(old.config))addJournal(`rules:${next.id}:${next.rulesRevision??0}:${revision}`,'config',{before:old.config,after:next.config,rulesRevision:next.rulesRevision??0,source:'USER'},Date.now());
  // Capture each decision's exact input once. Shared market rows contain no account data.
  const usedBooks=new Set(next.decisions.filter(d=>!knownDecisions.has(d.id)).map(d=>`${d.slug}:${d.bookTime}`));
  for(const input of inputs){
    if(!usedBooks.has(`${input.market.slug}:${input.receivedAt}`))continue;
    const value={...input,market:{...input.market,history:[]}};
    statements.push(db().prepare('INSERT OR IGNORE INTO tennis_observations(id,slug,time,value) SELECT ?,?,?,? FROM tennis_sessions WHERE owner_id=? AND revision=?').bind(`${input.market.slug}:${input.receivedAt}`,input.market.slug,input.receivedAt,JSON.stringify(value),ownerId,old.revision));
  }
  statements.push(db().prepare('UPDATE tennis_sessions SET value=?,revision=? WHERE owner_id=? AND revision=?').bind(JSON.stringify(next),revision,ownerId,old.revision));
  const results=await db().batch(statements);
  if(!results.at(-1)?.meta.changes)throw new Error('Another tab updated this paper session. Refreshing will show the current balance.');
  return next;
}

export async function updateTennisSession(req:Request,action:TennisAction){
  const loaded=await readTennisSession(req),now=Date.now(),s=loaded.session;
  if(action.commandId){
    const prior=await db().prepare("SELECT value FROM tennis_journal WHERE id=? AND owner_id=? AND kind='control'").bind(`${loaded.ownerId}:command:${action.commandId}`,loaded.ownerId).first<{value:string}>();
    if(prior){if(JSON.parse(prior.value).fingerprint!==JSON.stringify(action))throw new Error('This command ID was already used for different instructions.');return (await readTennisSession(req)).session;}
  }
  if('sessionId' in action&&action.sessionId&&action.sessionId!==s.id)throw new Error('The paper session changed. Refresh before sending that action.');
  if(action.action==='tick'&&now-s.lastTickAt<2000)return s;
  const needsInputs=action.action==='tick';
  const {inputs,failures,cursor}=needsInputs?await gatherTennisInputs(s,action):{inputs:[] as TennisInput[],failures:[] as string[],cursor:s.scanCursor??0};
  const next=action.action==='tick'?stepTennisSession(s,inputs,Date.now()):applyTennisAction(s,action,inputs,Date.now());
  next.scanCursor=cursor;
  if(failures.length){
    const time=Date.now(),message=failures[0];
    next.decisions.push({id:crypto.randomUUID(),time,slug:'',side:'YES',action:'SKIP',code:'SOURCE',reason:message});
    next.decisions=next.decisions.slice(-300);
    next.rejectionCounts.SOURCE=(next.rejectionCounts.SOURCE??0)+1;
    if(inputs.length===0){next.lastReason=message;if(action.action==='tick')next.lastTickAt=time;}
  }
  return persist(loaded,next,action,inputs);
}
