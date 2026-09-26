import {env} from 'cloudflare:workers';
import {DEFAULT_CONFIG} from '@/lib/market/scanner';
import type {Profile} from '@/lib/market/types';
export function db(){if(!env.DB)throw new Error('History storage is unavailable.');return env.DB;}
async function readCacheEntry<T>(key:string):Promise<{value:T;updated:number;stored:string}|null>{
 const old=await db().prepare('SELECT value, updated FROM cache WHERE key=?').bind(key).first<{value:string;updated:number}>();
 if(!old)return null;
 const parsed=JSON.parse(old.value);
 if(parsed?.__chunks){const rows=await db().batch(Array.from({length:parsed.__chunks},(_,i)=>db().prepare('SELECT value FROM cache WHERE key=?').bind(`${key}:part:${parsed.generation}:${i}`)));return {value:JSON.parse(rows.map(r=>(r.results[0] as {value:string}).value).join('')),updated:old.updated,stored:old.value};}
 return {value:parsed,updated:old.updated,stored:old.value};
}
export async function readCached<T>(key:string):Promise<{value:T;updated:number}|null>{
 const entry=await readCacheEntry<T>(key);return entry?{value:entry.value,updated:entry.updated}:null;
}
export async function cached<T>(key:string,ttl:number,load:()=>Promise<T>):Promise<T>{
 const old=await readCacheEntry<T>(key);
 if(old&&Date.now()-old.updated<ttl)return old.value;
 // Worker I/O belongs to its originating request. Reuse only completed D1
 // values; an abandoned loader or write must not strand later requests.
 const value=await load(),serialized=JSON.stringify(value),now=Date.now();
 // Compare both timestamp and serialized value: two writers may complete in
 // the same millisecond. Chunk manifests participate in the same atomic CAS.
 const guard=old?'EXISTS(SELECT 1 FROM cache WHERE key=? AND updated=? AND value=?)':'NOT EXISTS(SELECT 1 FROM cache WHERE key=?)';
 const expected=old?[key,old.updated,old.stored]:[key];
 const head=(text:string)=>old
  ?db().prepare('UPDATE cache SET value=?,updated=? WHERE key=? AND updated=? AND value=?').bind(text,now,...expected)
  :db().prepare('INSERT INTO cache(key,value,updated) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM cache WHERE key=?) ON CONFLICT(key) DO NOTHING').bind(key,text,now,key);
 let changed:number;
 if(serialized.length>400000){
  const chunks=[];for(let i=0;i<serialized.length;i+=400000)chunks.push(serialized.slice(i,i+400000));const generation=crypto.randomUUID();
  const statements=chunks.map((chunk,i)=>db().prepare(`INSERT INTO cache(key,value,updated) SELECT ?,?,? WHERE ${guard}`).bind(`${key}:part:${generation}:${i}`,chunk,now,...expected));
  const results=await db().batch([...statements,head(JSON.stringify({__chunks:chunks.length,generation}))]);changed=results.at(-1)!.meta.changes;
 }else changed=(await head(serialized).run()).meta.changes;
 if(changed)return value;
 const winner=await readCached<T>(key);
 if(!winner)throw new Error('The shared cache changed before this result could be saved. Retry with a fresh request.');
 return winner.value;
}
export async function profile(req:Request){
 const id=req.headers.get('oai-authenticated-user-id')||'private-owner';
 const initial:Profile={cash:100,positions:[],watches:[],equity:[{time:Date.now(),price:100}],config:DEFAULT_CONFIG};
 await db().prepare('INSERT OR IGNORE INTO profiles(id,value,version) VALUES(?,?,0)').bind(id,JSON.stringify(initial)).run();
 const row=await db().prepare('SELECT value,version FROM profiles WHERE id=?').bind(id).first<{value:string;version:number}>();
 if(!row)throw new Error('Paper account is unavailable.');
 const data=JSON.parse(row.value) as Profile;
 // The SQL column is authoritative even for older JSON or a stale redundant field.
 data.revision=row.version;
 return {id,data,version:row.version};
}
export async function saveProfile(p:Awaited<ReturnType<typeof profile>>){
 const revision=p.version+1;
 const r=await db().prepare('UPDATE profiles SET value=?,version=version+1 WHERE id=? AND version=?')
  .bind(JSON.stringify({...p.data,revision}),p.id,p.version).run();
 if(!r.meta.changes)throw new Error('Another update just finished. Please try again.');
 // Never claim a newer revision until the compare-and-swap succeeded.
 p.version=revision;p.data.revision=revision;
}
export function sameOrigin(req:Request){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)throw new Error('Request origin mismatch.');}
