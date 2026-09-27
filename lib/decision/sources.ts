import {createEngine,type Engine,type EngineOptions} from './engine.ts';
import {BUNDLED_PACK,parsePack,type EvidencePack,type Trust} from './pack.ts';

/**
 * Where evidence packs come from. Research publishes a pack to storage (docs/DATA-PLATFORM.md);
 * a long-running host (runner, script, dashboard server) keeps a LivePack and asks it for the
 * current engine. Failures never widen permissions: an invalid or unreachable pack leaves the
 * last good pack in place, and an unpinned pack cannot enable real money.
 */

export type PackSource={id:string;load():Promise<{raw:unknown;text:string}>};

export const bundledSource:PackSource={id:'bundled',load:async()=>({raw:BUNDLED_PACK,text:JSON.stringify(BUNDLED_PACK)})};

/** Public HTTPS URL (an R2 public bucket or custom domain, a GitHub raw URL, any static host). */
export function urlSource(url:string,fetcher:(url:string,init?:RequestInit)=>Promise<Response>=fetch):PackSource {
  if(!/^https:\/\//.test(url))throw new Error('Evidence packs load over HTTPS only.');
  return {id:url,async load(){
    const response=await fetcher(url,{signal:AbortSignal.timeout(10_000),headers:{accept:'application/json'}});
    if(!response.ok)throw new Error(`Pack host returned ${response.status}.`);
    const text=await response.text();
    if(text.length>5_000_000)throw new Error('Evidence pack is larger than 5 MB.');
    return {raw:JSON.parse(text),text};
  }};
}

/** A Cloudflare R2 binding, typed structurally so this module needs no Workers types. */
export function r2BindingSource(bucket:{get(key:string):Promise<{text():Promise<string>}|null>},key:string):PackSource {
  return {id:`r2:${key}`,async load(){
    const object=await bucket.get(key);
    if(!object)throw new Error(`No pack at ${key}.`);
    const text=await object.text();
    return {raw:JSON.parse(text),text};
  }};
}

export async function sha256Hex(text:string):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

export type LivePackStatus={version:string;trust:Trust;source:string;loadedAt:number|null;lastAttemptAt:number|null;error:string|null};

export class LivePack {
  private engine:Engine;
  private state:LivePackStatus;
  private readonly source:PackSource;
  private readonly options:{pinSha256?:string|null;refreshMs:number;engine?:Omit<EngineOptions,'pack'|'trust'>;now:()=>number};

  constructor(source:PackSource,options:{pinSha256?:string|null;refreshMs?:number;engine?:Omit<EngineOptions,'pack'|'trust'>;now?:()=>number}={}){
    this.source=source;
    this.options={pinSha256:options.pinSha256?.toLowerCase()??null,refreshMs:options.refreshMs??600_000,engine:options.engine,now:options.now??Date.now};
    this.engine=createEngine({...this.options.engine});
    this.state={version:BUNDLED_PACK.version,trust:'bundled',source:'bundled',loadedAt:null,lastAttemptAt:null,error:null};
  }

  current():Engine {return this.engine;}
  status():LivePackStatus {return {...this.state};}
  due():boolean {return this.state.lastAttemptAt===null||this.options.now()-this.state.lastAttemptAt>=this.options.refreshMs;}

  /** Load the source once. Keeps the previous engine on any failure. */
  async refresh():Promise<LivePackStatus> {
    const now=this.options.now();
    this.state.lastAttemptAt=now;
    try{
      const {raw,text}=await this.source.load();
      const parsed=parsePack(raw);
      if(!parsed.ok)throw new Error(`Invalid pack: ${parsed.error}`);
      const pack:EvidencePack=parsed.pack;
      let trust:Trust=this.source===bundledSource?'bundled':'untrusted';
      if(this.options.pinSha256){
        const hash=await sha256Hex(text);
        if(hash!==this.options.pinSha256)throw new Error(`Pack hash ${hash.slice(0,12)}… does not match the pinned hash.`);
        trust='pinned';
      }
      this.engine=createEngine({...this.options.engine,pack,trust});
      this.state={version:pack.version,trust,source:this.source.id,loadedAt:now,lastAttemptAt:now,error:null};
    }catch(error){
      this.state.error=(error as Error).message;
    }
    return this.status();
  }

  /** Refresh when due, then return the engine to use. */
  async engineNow():Promise<Engine> {if(this.due())await this.refresh();return this.engine;}
}
