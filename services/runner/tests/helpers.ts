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
/** Reconciled, closed synthetic loss only; no real account or market history. */
export async function activeStoppedLoss(){
  const session=snapshot(),market=input(NOW).market,positionId='synthetic-loss-position';
  session.status='stopped';session.cash=79.94;
  session.ledger=[
    {id:'synthetic-loss-buy',time:NOW-2000,slug:market.slug,side:'YES',action:'BUY',source:'AUTOMATIC',positionId,reason:'Synthetic fixture entry',cashDelta:-25,realizedPnl:0},
    {id:'synthetic-loss-sell',time:NOW-1000,slug:market.slug,side:'YES',action:'SELL',source:'AUTOMATIC',positionId,reason:'Synthetic fixture loss exit',cashDelta:4.94,realizedPnl:-20.06},
  ];
  session.positions=[{id:positionId,slug:market.slug,league:market.league,title:market.title,side:'YES',name:market.yesName,
    quantity:0,initialQuantity:50,costBasis:0,entryCost:25,entryPrice:.5,entryFees:0,openedAt:NOW-2000,
    status:'closed',closedAt:NOW-1000,exitPrice:.0988,realizedPnl:-20.06,exitFees:0,proceeds:4.94,
    netLiquidationValue:0,liquidationQuantity:0,markedAt:NOW-1000,market}];
  session.histories[market.slug+':YES']=[{time:NOW-1000,price:.0988}];
  session.equity=[{time:NOW-2000,price:100},{time:NOW-1000,price:79.94}];
  session.testRun={startedAt:NOW-3600000,endsAt:NOW-1,watchedMs:3600000,lastCheckAt:NOW-1,startingCash:100,startingLedgerCount:0,liveSlugs:[market.slug],complete:true};
  const data:MigrationData={journal:session.ledger.map(entry=>({id:OWNER+':'+entry.id,kind:'execution',value:entry,time:entry.time})),observations:[]};
  return active(session,data);
}
