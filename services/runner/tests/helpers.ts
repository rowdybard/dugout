import {DatabaseSync} from 'node:sqlite';
import {RunnerStore,type RunnerStorage,type SqlRow} from '../src/store.ts';
import {createTennisSession,defaultTennisConfig} from '../../../lib/tennis/engine.ts';
import {sha256} from '../../../lib/runner/protocol.ts';
import type {MigrationData,MigrationStart} from '../../../lib/runner/contracts';
import type {TennisInput,TennisSession} from '../../../lib/tennis/types';

export const OWNER='synthetic-owner-0001',EPOCH='synthetic-epoch-0001',NOW=Date.parse('2026-09-26T22:00:00Z');
export const SECRET='synthetic-test-only-signing-secret-32-bytes-minimum';
export function sqlite(){
  const db=new DatabaseSync(':memory:');let fail:string|null=null;
  const storage:RunnerStorage={sql:{exec<T extends SqlRow>(sql:string,...bindings:(string|number|null)[]){
    if(fail&&sql.includes(fail)){fail=null;throw new Error('Injected storage failure');}
    if(sql.includes(';')){db.exec(sql);return {toArray:()=>[] as T[],rowsWritten:0};}
    const statement=db.prepare(sql);if(statement.columns().length)return {toArray:()=>statement.all(...bindings) as T[],rowsWritten:0};
    const result=statement.run(...bindings);return {toArray:()=>[] as T[],rowsWritten:Number(result.changes)};
  }},transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
  return {storage,db,failOn:(value:string)=>{fail=value;}};
}
export function input(time:number,bid=.49,ask=.50):TennisInput{return {
  market:{slug:'synthetic-tennis',eventId:'fixture',eventSlug:'fixture',title:'Synthetic A vs Synthetic B',league:'ATP',yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW).toISOString(),live:true,ended:false,score:null,period:null,tournament:null,active:true,bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:null,history:[],execution:{slug:'synthetic-tennis',league:'ATP',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.05}},
  book:{bids:[{price:bid,quantity:1000}],asks:[{price:ask,quantity:1000}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},receivedAt:time,source:'WEBSOCKET',sourceTime:time,
};}
export function snapshot():TennisSession{const s=createTennisSession({...defaultTennisConfig(),focusSlug:'synthetic-tennis'},NOW);s.status='paused';return s;}
export async function migration(session=snapshot(),data:MigrationData={journal:[],observations:[]}):Promise<{start:MigrationStart;data:string}>{
  const json=JSON.stringify(data);
  return {start:{session,manifest:{schemaVersion:1,migrationId:'migration-fixture-0001',ownerId:OWNER,epoch:EPOCH,sourceSessionId:session.id,sourceRevision:session.revision,snapshotSha256:await sha256(JSON.stringify(session)),journalCount:data.journal.length,observationCount:data.observations.length,chunks:[{index:0,sha256:await sha256(json),byteLength:new TextEncoder().encode(json).length}]}},data:json};
}
export async function active(session=snapshot(),data:MigrationData={journal:[],observations:[]}){
  const fixture=sqlite(),store=new RunnerStore(fixture.storage,'synthetic-engine-version'),m=await migration(session,data);
  await store.beginImport(m.start,OWNER,EPOCH);await store.importChunk({migrationId:m.start.manifest.migrationId,index:0,data:m.data},OWNER,EPOCH);store.activate(m.start.manifest.migrationId,OWNER,EPOCH,NOW+1);
  return {...fixture,store,m};
}
