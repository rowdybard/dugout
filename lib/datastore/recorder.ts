import type {BaseballContext,TennisInput} from '../tennis/types';

/**
 * Live order-book recorder for the runner. Price history has no depth or queue information, which is exactly
 * what resting-order (maker) research needs, so the runner records every accepted book (top 10 levels a side,
 * plus game status) and writes NDJSON batches to R2 under
 *   <prefix>/live-books/date=YYYY-MM-DD/league=<league>/<slug>/<first-ms>-<id>.ndjson
 * which research/datastore/lake.py exposes as the `live_books` table. Read-only: it never trades.
 * Recording is best effort: a failed write is retried with the next batch, and the buffer is bounded.
 */

export type R2Put={put(key:string,value:string,options?:{httpMetadata?:{contentType?:string}}):Promise<unknown>};
export type BookRecord={
  t:number;src:string;sourceTime:number|null;slug:string;league:string;state:string;
  live:boolean;ended:boolean;score:string|null;period:string|null;clock:string|null;
  bids:[number,number][];asks:[number,number][];
  /** Provider game-report time (ms); game facts age separately from books. */
  reportTime?:number|null;
  /** Team sports: whether YES is the away or home team (scores read "away-home"). */
  yesOrdering?:'away'|'home'|null;
  football?:{possession:string|null;down:number|null;yardsToGo:number|null;fieldTeam:string|null;yard:number|null;
    /** Team ids for YES and NO, so possession and field side map to a side. */
    yesTeamId?:string;noTeamId?:string;betweenPlays?:boolean};
  /** MLB: the verified inning, half, count, outs and runners at recording time. */
  baseball?:BaseballContext;
};

export const RECORDER_DEPTH=10;
const MAX_BUFFER=5000;

export function bookRecord(input:TennisInput):BookRecord {
  const market=input.market,football=market.football;
  const levels=(side:TennisInput['book']['bids'])=>side.slice(0,RECORDER_DEPTH).map(level=>[level.price,level.quantity] as [number,number]);
  return {t:input.receivedAt,src:input.source,sourceTime:input.sourceTime??null,slug:market.slug,league:market.league,state:input.book.state,
    live:market.live,ended:market.ended,score:market.score,period:market.period,clock:market.clock??null,
    bids:levels([...input.book.bids].sort((a,b)=>b.price-a.price)),asks:levels([...input.book.asks].sort((a,b)=>a.price-b.price)),
    reportTime:market.contextUpdatedAt,
    ...(market.yesOrdering!==undefined?{yesOrdering:market.yesOrdering}:{}),
    ...(football?{football:{possession:football.possessionTeamId??null,down:football.down,yardsToGo:football.yardsToGo,fieldTeam:football.fieldPosition?.teamId??null,yard:football.fieldPosition?.yard??null,
      ...(market.footballIdentity?{yesTeamId:market.footballIdentity.yesTeamId,noTeamId:market.footballIdentity.noTeamId}:{}),
      ...(football.phase==='between-plays'?{betweenPlays:true}:{})}}:{}),
    ...(market.baseball?{baseball:market.baseball}:{})};
}

export class BookRecorder {
  private buffer:BookRecord[]=[];
  private seen=new Map<string,number>();
  private firstAt:number|null=null;
  private readonly prefix:string;private readonly maxRecords:number;private readonly maxAgeMs:number;
  private readonly now:()=>number;private readonly id:()=>string;

  constructor(options:{prefix?:string;maxRecords?:number;maxAgeMs?:number;now?:()=>number;id?:()=>string}={}){
    this.prefix=(options.prefix??'dugout').replace(/^\/+|\/+$/g,'');this.maxRecords=options.maxRecords??500;this.maxAgeMs=options.maxAgeMs??60_000;
    this.now=options.now??Date.now;this.id=options.id??(()=>crypto.randomUUID().slice(0,8));
  }

  get size(){return this.buffer.length;}

  /** Record each distinct accepted book once; replays and repeats of the same receipt are skipped. */
  add(inputs:TennisInput[]) {
    for(const input of inputs){
      if(input.source==='REPLAY'||!input.market?.slug||!Number.isFinite(input.receivedAt))continue;
      if((this.seen.get(input.market.slug)??-1)>=input.receivedAt)continue;
      this.seen.set(input.market.slug,input.receivedAt);
      this.buffer.push(bookRecord(input));
      this.firstAt??=this.now();
    }
    if(this.buffer.length>MAX_BUFFER)this.buffer=this.buffer.slice(-MAX_BUFFER);
  }

  /** Write buffered records when the batch is big or old enough (or `force`). Returns the keys written. */
  async flush(bucket:R2Put,force=false):Promise<string[]> {
    if(!this.buffer.length)return [];
    if(!force&&this.buffer.length<this.maxRecords&&this.firstAt!==null&&this.now()-this.firstAt<this.maxAgeMs)return [];
    const batch=this.buffer;this.buffer=[];this.firstAt=null;
    const groups=new Map<string,BookRecord[]>();
    for(const record of batch){
      const date=new Date(record.t).toISOString().slice(0,10);
      const key=`${this.prefix}/live-books/date=${date}/league=${record.league.toLowerCase()}/${record.slug}`;
      groups.set(key,[...(groups.get(key)??[]),record]);
    }
    const written:string[]=[],failed:BookRecord[]=[];
    for(const [folder,records] of groups){
      const key=`${folder}/${records[0].t}-${this.id()}.ndjson`;
      try{await bucket.put(key,records.map(record=>JSON.stringify(record)).join('\n')+'\n',{httpMetadata:{contentType:'application/x-ndjson'}});written.push(key);}
      catch{failed.push(...records);}
    }
    if(failed.length){this.buffer=[...failed,...this.buffer].slice(-MAX_BUFFER);this.firstAt??=this.now();}
    return written;
  }
}
