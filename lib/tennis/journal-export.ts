import {normalizeTennisConfig} from './rules.ts';
import type {TennisSession} from './types';

type JournalRow={rowid:number;id:string;kind:string;value:string;created_at:number};
type SnapshotRow={value:string;revision:number;journalThrough:number};

/** Snapshot the account and append-only journal boundary in one SQLite statement. */
export async function exportTennisJournal(database:Pick<D1Database,'prepare'>,ownerId:string):Promise<Response> {
  const snapshot=await database.prepare(`SELECT s.value,s.revision,
    (SELECT COALESCE(MAX(j.rowid),0) FROM tennis_journal j
      WHERE j.owner_id=s.owner_id AND j.session_id=json_extract(s.value,'$.id')) AS journalThrough
    FROM tennis_sessions s WHERE s.owner_id=?`).bind(ownerId).first<SnapshotRow>();
  if(!snapshot)throw new Error('The saved paper session is unavailable.');
  const saved=JSON.parse(snapshot.value) as TennisSession;
  const session={...saved,revision:snapshot.revision,config:normalizeTennisConfig(saved.config)};
  const capturedAt=Date.now(),encoder=new TextEncoder();
  async function* chunks(){
    yield `{"schemaVersion":2,"capturedAt":${capturedAt},"session":${JSON.stringify(session)},"records":[`;
    let cursor=0,count=0;
    const observationIds=new Set<string>();
    while(cursor<snapshot!.journalThrough){
      const page=await database.prepare('SELECT rowid,id,kind,value,created_at FROM tennis_journal WHERE owner_id=? AND session_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 1000')
        .bind(ownerId,session.id,cursor,snapshot!.journalThrough).all<JournalRow>();
      if(!page.results.length)throw new Error('The saved journal changed during export. Download it again.');
      const encoded=page.results.map(row=>{
        const value=JSON.parse(row.value);
        if((row.kind==='decision'||row.kind==='execution')&&typeof value.slug==='string'&&value.slug){
          for(const time of [value.bookTime,value.signalBookTime,value.executionBookTime])if(typeof time==='number'&&Number.isFinite(time))observationIds.add(`${value.slug}:${time}`);
        }
        return JSON.stringify({id:row.id,kind:row.kind,value,time:row.created_at});
      });
      yield `${count?',':''}${encoded.join(',')}`;
      count+=page.results.length;cursor=page.results.at(-1)!.rowid;
    }
    yield '],"observations":[';
    const ids=[...observationIds],missing:string[]=[];
    let observationCount=0;
    // A JSON table avoids the binding-count limit; bounded batches keep a full
    // three-hour focused watch within the Workers Free D1 query budget.
    for(let start=0;start<ids.length;start+=500){
      const batch=ids.slice(start,start+500);
      const rows=await database.prepare('SELECT id,value FROM tennis_observations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY time,id').bind(JSON.stringify(batch)).all<{id:string;value:string}>();
      const found=new Set(rows.results.map(row=>row.id));
      missing.push(...batch.filter(id=>!found.has(id)));
      if(rows.results.length){
        yield `${observationCount?',':''}${rows.results.map(row=>JSON.stringify({id:row.id,value:JSON.parse(row.value)})).join(',')}`;
        observationCount+=rows.results.length;
      }
    }
    yield `],"recordCount":${count},"observationCount":${observationCount},"missingObservationIds":${JSON.stringify(missing)},"truncated":false}`;
  }
  const iterator=chunks();
  const body=new ReadableStream<Uint8Array>({
    async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(next.value));}catch(error){controller.error(error);}},
    async cancel(){await iterator.return(undefined);},
  });
  return new Response(body,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="dugout-tennis-paper-session.json"'}});
}
