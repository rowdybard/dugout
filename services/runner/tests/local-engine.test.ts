import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunnerStore,type RunnerStorage,type SqlRow} from '../src/store.ts';
import {createTennisSession} from '../../../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../../../lib/tennis/rules.ts';
import {replayFrame} from '../../../lib/runner/replay.ts';
import {sha256} from '../../../lib/runner/protocol.ts';
import type {ReplayFrame} from '../../../lib/runner/contracts';
import type {TennisInput} from '../../../lib/tennis/types';
import {active,input as fixtureInput,NOW} from './helpers.ts';

const VERSION='synthetic-local-move-engine-test';
function quote(time:number,bid:number):TennisInput{
  const value=fixtureInput(time,bid,Math.round((bid+.01)*1e6)/1e6);
  value.market.execution!.priceIncrement=.005;value.market.execution!.feeCoefficient=.0695;
  value.book.bids[0].quantity=100;value.book.asks[0].quantity=100;
  return value;
}
function diskStorage(db:DatabaseSync):RunnerStorage{
  return {sql:{exec<T extends SqlRow>(sql:string,...bindings:(string|number|null)[]){
    if(sql.includes(';')){db.exec(sql);return {toArray:()=>[] as T[],rowsWritten:0};}
    const statement=db.prepare(sql);
    if(statement.columns().length)return {toArray:()=>statement.all(...bindings) as T[],rowsWritten:0};
    const result=statement.run(...bindings);return {toArray:()=>[] as T[],rowsWritten:Number(result.changes)};
  }},transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
}

test('native SQLite runner restores a pending local entry, holds beyond fixed target, trails out, and exactly replays all cash and fees',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('Native local decision execution must not invoke a network or model service.');});
  const source=createTennisSession({...defaultLiveTennisConfig(),evidenceGate:undefined,entryBudget:10,focusSlug:'synthetic-tennis',leagues:['ATP']},NOW);
  source.id='synthetic-native-local-account';source.status='paused';
  const fixture=await active(source);let db=fixture.db,store=new RunnerStore(fixture.storage,VERSION);
  const directory=mkdtempSync(join(tmpdir(),'dugout-native-local-')),databasePath=join(directory,'runner.sqlite');
  t.after(()=>{db.close();rmSync(databasePath,{force:true});rmdirSync(directory);});
  const initial=store.session()!;
  await store.advance({action:'resume',commandId:'synthetic-native-local-start'},[],NOW+2);
  const base=NOW+63_000;
  const trajectory:[number,number][]=[...[-60,-58,-56,-54,-52,-50,-48].map(time=>[time,.89] as [number,number]),
    [-40,.85],[-33,.81],[-26,.77],[-19,.73],[-12,.69],[-8,.71],[-4,.73],[0,.75]];
  let pendingQuote:TennisInput|null=null;
  for(const [seconds,bid] of trajectory){
    const value=quote(base+seconds*1000,bid);await store.advance({action:'tick'},[value],value.receivedAt);
    if(store.session()!.pending){pendingQuote=value;break;}
  }
  assert.ok(pendingQuote,'The measured executable setup should stage a delayed entry.');
  const pending=store.session()!;
  assert.equal(pending.pending?.action,'BUY');assert.equal(pending.pending.analysis?.version,'local-move-v1');
  assert.equal(pending.pending.analysis.decision,'enter');assert.equal(pending.cash,100);assert.equal(pending.ledger.length,0);

  // Copy the actual SQLite database, close the original connection, then recover
  // solely from its disk file. No in-memory session object is handed to the store.
  db.prepare('VACUUM INTO ?').run(databasePath);db.close();db=new DatabaseSync(databasePath);
  store=new RunnerStore(diskStorage(db),VERSION);
  assert.deepEqual(store.session(),pending,'Pending provenance and original limit survive a real SQLite connection restart.');
  await store.advance({action:'tick'},[pendingQuote],pendingQuote.receivedAt+500);
  assert.equal(store.session()!.ledger.length,0);assert.equal(store.session()!.cash,100);
  assert.equal(store.session()!.pending!.id,pending.pending!.id);

  const fillTime=pendingQuote.receivedAt+1000;
  const fillQuote=quote(fillTime,pendingQuote.book.bids[0].price);
  await store.advance({action:'tick'},[fillQuote],fillTime);
  const opened=store.session()!,position=opened.positions[0],plan=structuredClone(position.exitPlan);
  assert.equal(opened.ledger.length,1,opened.lastReason);assert.equal(opened.ledger[0].action,'BUY');
  assert.equal(position.status,'open');assert.equal(position.entryAnalysis?.decision,'enter');
  assert.equal(position.exitPlan?.version,'adaptive-exit-v1');assert.equal(position.openedAt,fillTime);
  assert.ok(opened.ledger[0].execution!.fees>0);assert.ok(opened.decisions.some(d=>d.code==='ENTRY_RECHECK'&&d.analysis?.decision==='enter'));

  for(const [index,bid] of [.75,.76,.77,.78,.79,.80].entries()){
    const time=fillTime+(index+1)*1000;await store.advance({action:'tick'},[quote(time,bid)],time);
    assert.equal(store.session()!.pending,null,store.session()!.lastReason);
  }
  const holding=store.session()!,assessment=holding.decisions.at(-1)!.exitAnalysis!;
  assert.equal(assessment.action,'hold');assert.ok(assessment.metrics.netReturn!>holding.config.targetReturn);
  assert.deepEqual(holding.positions[0].exitPlan,plan);
  await store.advance({action:'tick'},[quote(fillTime+7000,.785)],fillTime+7000);
  const exiting=store.session()!;
  assert.equal(exiting.pending?.action,'SELL');assert.equal(exiting.ledger.length,1,'The trailing trigger does not bypass delayed execution.');
  assert.equal(exiting.decisions.at(-1)!.exitAnalysis!.code,'VOLATILITY_TRAIL');
  await store.advance({action:'tick'},[quote(fillTime+8000,.785)],fillTime+8000);
  const closed=store.session()!;
  assert.equal(closed.pending,null);assert.deepEqual(closed.ledger.map(row=>row.action),['BUY','SELL']);
  assert.equal(closed.positions[0].status,'closed');assert.deepEqual(closed.positions[0].exitPlan,plan);
  const [buy,sell]=closed.ledger,settled=closed.positions[0];
  assert.ok(buy.execution!.fees>0&&sell.execution!.fees>0);
  assert.equal(Math.round(closed.cash*1e6),Math.round((100+buy.cashDelta+sell.cashDelta)*1e6));
  assert.equal(Math.round(closed.cash*1e6),Math.round((100+settled.realizedPnl)*1e6));
  assert.equal(settled.entryFees,buy.execution!.fees);assert.equal(settled.exitFees,sell.execution!.fees);

  db.close();db=new DatabaseSync(databasePath);store=new RunnerStore(diskStorage(db),VERSION);
  assert.deepEqual(store.session(),closed,'A second SQLite reopen preserves the complete closed account.');
  const exported=store.exportPage(null,0,500,fillTime+9000);
  assert.equal(exported.complete,true);assert.equal(exported.pageEvidenceComplete,true);assert.deepEqual(exported.missingObservationIds,[]);
  assert.deepEqual(exported.session,closed);
  const observations=new Map(exported.observations.map(row=>[row.id,row.value]));
  const frames=exported.records.filter(row=>row.kind==='replay').map(row=>row.value as unknown as ReplayFrame);
  let replay=initial;
  for(const frame of frames){
    assert.equal(frame.engineVersion,VERSION);assert.equal(frame.beforeHash,await sha256(JSON.stringify(replay)));
    replay=await replayFrame(replay,frame,observations);
    assert.equal(frame.afterHash,await sha256(JSON.stringify(replay)));
  }
  assert.deepEqual(replay,closed,'Every persisted quantitative decision, pending order, exit state, fee and balance replays exactly.');
  assert.equal(exported.records.filter(row=>row.kind==='execution').length,2);
  assert.ok(exported.records.some(row=>row.kind==='decision'&&row.value.analysis));
  assert.ok(exported.records.some(row=>row.kind==='decision'&&row.value.exitAnalysis));
});
