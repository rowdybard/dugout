import {env} from 'cloudflare:workers';
import {DEFAULT_CONFIG} from '@/lib/market/scanner';
import type {Profile} from '@/lib/market/types';
export function db(){if(!env.DB)throw new Error('History storage is unavailable.');return env.DB;}
export async function cached<T>(key:string,ttl:number,load:()=>Promise<T>):Promise<T>{
 const old=await db().prepare('SELECT value, updated FROM cache WHERE key=?').bind(key).first<{value:string;updated:number}>();
 if(old&&Date.now()-old.updated<ttl){const parsed=JSON.parse(old.value);if(parsed?.__chunks){const rows=await db().batch(Array.from({length:parsed.__chunks},(_,i)=>db().prepare('SELECT value FROM cache WHERE key=?').bind(`${key}:part:${parsed.generation}:${i}`)));return JSON.parse(rows.map(r=>(r.results[0] as {value:string}).value).join(''));}return parsed;}
 const value=await load(),serialized=JSON.stringify(value),now=Date.now();
 const write=(k:string,v:string)=>db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').bind(k,v,now);
 if(serialized.length>400000){const chunks=[];for(let i=0;i<serialized.length;i+=400000)chunks.push(serialized.slice(i,i+400000));const generation=crypto.randomUUID();await db().batch([...chunks.map((c,i)=>write(`${key}:part:${generation}:${i}`,c)),write(key,JSON.stringify({__chunks:chunks.length,generation}))]);}else await write(key,serialized).run();
 return value;
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
