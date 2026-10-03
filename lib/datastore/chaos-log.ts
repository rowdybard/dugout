import type {R2Put} from './recorder';
import type {TennisSession} from '../tennis/types';
import {octopusOn,octopusSlugs} from '../tennis/octopus.ts';

/**
 * Octopus logs (experimental; "Chaos mode" in code): one short JSON line per event, written as tiny files.
 *   kind "decision"  every bot decision on a Chaos or main game (quotes placed or pulled, skips, fills)
 *   kind "fill"      every fill and sale, with price, quantity, cash change and result
 *   kind "balance"   cash and equity, at most once a minute
 * The runner writes them to the lake as <prefix>/octopus/<YYYY-MM-DD>/<account>/<HHMMSS>-<n>.jsonl, at most a minute or
 * 200 lines per file. The dashboard can download the same lines from the saved session.
 */
export type ChaosLine={t:number;kind:'decision'|'fill'|'balance';slug?:string;side?:string;action?:string;code?:string;note?:string;
  price?:number;qty?:number;cash?:number;pnl?:number;equity?:number};
export type ChaosCursor={decisions:number;ledger:number;balance:number};

const short=(text:string|undefined)=>text&&text.length>160?`${text.slice(0,157)}…`:text;
const round=(x:number|undefined)=>x===undefined?undefined:Math.round(x*1e4)/1e4;

/** New lines since the cursor, oldest first, and the advanced cursor. */
export function chaosLines(session:TennisSession,cursor:ChaosCursor,now:number):{lines:ChaosLine[];cursor:ChaosCursor} {
  const games=new Set([session.config.focusSlug,...octopusSlugs(session)].filter(Boolean));
  const lines:ChaosLine[]=[];
  for(const d of session.decisions)if(d.time>cursor.decisions&&(!d.slug||games.has(d.slug)))
    lines.push({t:d.time,kind:'decision',slug:d.slug||undefined,side:d.side,action:d.action,code:d.code,note:short(d.reason)});
  for(const e of session.ledger)if(e.time>cursor.ledger)
    lines.push({t:e.time,kind:'fill',slug:e.slug,side:e.side,action:e.action,price:round(e.execution?.averagePrice??e.actualPrice),qty:round(e.execution?.filledQty),cash:round(e.cashDelta),pnl:round(e.realizedPnl)});
  let balance=cursor.balance;
  if(now-cursor.balance>=60_000){
    const equity=session.equity.at(-1)?.price;
    lines.push({t:now,kind:'balance',cash:round(session.cash),equity:round(equity)});balance=now;
  }
  lines.sort((a,b)=>a.t-b.t);
  return {lines,cursor:{decisions:Math.max(cursor.decisions,...session.decisions.map(d=>d.time)),ledger:Math.max(cursor.ledger,...session.ledger.map(e=>e.time)),balance}};
}

export const chaosOn=(session:TennisSession)=>octopusOn(session);

/** Buffers lines and writes a tiny file once a minute or every 200 lines. */
export class ChaosFiles {
  private buffer:ChaosLine[]=[];private firstAt:number|null=null;private seq=0;
  private readonly prefix:string;private readonly now:()=>number;
  constructor(prefix:string,now=()=>Date.now()){this.prefix=prefix;this.now=now;}
  add(lines:ChaosLine[]){if(!lines.length)return;this.buffer.push(...lines);this.firstAt??=this.now();if(this.buffer.length>2000)this.buffer=this.buffer.slice(-2000);}
  async flush(bucket:R2Put,account:string,force=false):Promise<string|null>{
    if(!this.buffer.length||(!force&&this.buffer.length<200&&this.now()-(this.firstAt??this.now())<60_000))return null;
    const lines=this.buffer;this.buffer=[];this.firstAt=null;
    const at=new Date(lines[0].t),day=at.toISOString().slice(0,10),time=at.toISOString().slice(11,19).replace(/:/g,'');
    const key=`${this.prefix}/octopus/${day}/${account.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24)}/${time}-${this.seq++}.jsonl`;
    try{await bucket.put(key,lines.map(line=>JSON.stringify(line)).join('\n')+'\n',{httpMetadata:{contentType:'application/x-ndjson'}});return key;}
    catch(error){this.buffer=[...lines,...this.buffer].slice(-2000);throw error;}
  }
}
