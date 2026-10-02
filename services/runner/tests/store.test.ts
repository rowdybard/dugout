import test from 'node:test';
import assert from 'node:assert/strict';
import {RunnerStore,RUNNER_ENTRY_WRITE_LIMIT} from '../src/store.ts';
import {applyTennisAction,stepTennisSession} from '../../../lib/tennis/engine.ts';
import {sha256} from '../../../lib/runner/protocol.ts';
import {OWNER,EPOCH,NOW,sqlite,migration,active,input,snapshot} from './helpers.ts';
import type {ReplayFrame} from '../../../lib/runner/contracts';
import type {TennisInput} from '../../../lib/tennis/types';
import {replayFrame} from '../../../lib/runner/replay.ts';

test('runner freshness follows the accepted focused book, never a newer rejected receipt',async(t)=>{
  const {store}=await active();let time=NOW+2000;t.mock.method(Date,'now',()=>time);
  await store.advance({action:'resume'},[],time);
  await store.advance({action:'tick'},[input(time)],time);
  time+=7000;
  const older=input(time,.40,.41);older.sourceTime=NOW;
  await store.advance({action:'tick'},[older],time);
  assert.equal(store.state().runner.quoteAgeMs,7000);
  assert.equal(store.state().session.quotes['synthetic-tennis'].bid,.49);
  const s=store.session()!;s.config.focusSlug='different-game';store.set('session',s);
  assert.equal(store.state().runner.quoteAgeMs,null);
});

test('migration is inert, resumable by identical chunk, and preserves full source checkpoint',async()=>{
  const f=sqlite(),store=new RunnerStore(f.storage),session=snapshot();
  const quote=input(NOW),data={journal:[{id:OWNER+':legacy-decision',kind:'decision',time:NOW,value:{slug:quote.market.slug,bookTime:NOW}}],observations:[{id:quote.market.slug+':'+NOW,value:quote}]};
  const m=await migration(session,data);await store.beginImport(m.start,OWNER,EPOCH);assert.equal(store.session(),null);
  assert.throws(()=>store.activate(m.start.manifest.migrationId,OWNER,EPOCH,NOW+1),/incomplete/);
  const chunk={migrationId:m.start.manifest.migrationId,index:0,data:m.data};await store.importChunk(chunk,OWNER,EPOCH);
  const resumed=new RunnerStore(f.storage);await resumed.importChunk(chunk,OWNER,EPOCH);
  assert.deepEqual(resumed.importStatus(chunk.migrationId).receivedChunks,[0]);
  const state=resumed.activate(chunk.migrationId,OWNER,EPOCH,NOW+1);assert.equal(state.session.status,'paused');assert.equal(state.session.cash,100);assert.deepEqual(state.session.ledger,session.ledger);
  assert.equal(resumed.activate(chunk.migrationId,OWNER,EPOCH,NOW+2).session.revision,state.session.revision);
  const page=resumed.exportPage(null,0,100,NOW+2);assert.equal(page.records.length,2);assert.equal(page.observations.length,1);assert.deepEqual(page.records.find(r=>r.kind==='migration')?.value.sourceSnapshot,session);
  assert.throws(()=>resumed.assertIdentity(OWNER,EPOCH+'x'),/does not match/);
});
test('migration rejects wrong hash, missing source evidence and unreconciled cash',async()=>{
  const {storage}=sqlite(),store=new RunnerStore(storage),m=await migration();
  await store.beginImport(m.start,OWNER,EPOCH);
  await assert.rejects(()=>store.importChunk({migrationId:m.start.manifest.migrationId,index:0,data:m.data+' '},OWNER,EPOCH),/hash differs/);
  const bad=snapshot();bad.cash=99;await assert.rejects(()=>store.beginImport({...m.start,session:bad},OWNER,EPOCH),/reconcile/);
  const missing=await migration(snapshot(),{journal:[{id:OWNER+':missing',kind:'decision',value:{slug:'synthetic-tennis',bookTime:NOW},time:NOW}],observations:[]});
  const another=new RunnerStore(sqlite().storage);await another.beginImport(missing.start,OWNER,EPOCH);await another.importChunk({migrationId:missing.start.manifest.migrationId,index:0,data:missing.data},OWNER,EPOCH);
  assert.throws(()=>another.activate(missing.start.manifest.migrationId,OWNER,EPOCH,NOW+1),/observation is missing/);assert.equal(another.session(),null);
});
test('nonce replay protection survives object restart and expiry',()=>{
  const {storage}=sqlite(),store=new RunnerStore(storage);store.acceptNonce('nonce-1',NOW);
  assert.throws(()=>new RunnerStore(storage).acceptNonce('nonce-1',NOW+1),/already used/);
  store.acceptNonce('nonce-1',NOW+65001);
});
test('idempotent command retry returns current state and cannot duplicate ledger or replay',async()=>{
  const {store}=await active();const command={action:'resume' as const,commandId:'resume-fixture'};
  await store.advance(command,[],NOW+2);await store.advance({action:'tick'},[input(NOW+4000)],NOW+4000);
  const before=store.exportPage(null,0,500,NOW+4001),current=store.session();
  assert.deepEqual((await store.advance(command,[],NOW+5000)).session,current);
  assert.equal(store.exportPage(null,0,500,NOW+5001).records.length,before.records.length);
  await assert.rejects(()=>store.advance({...command,action:'pause'},[],NOW+5000),/reused/);
});
test('transaction rolls back inputs, replay and session when final session write fails',async()=>{
  const f=await active();const before=f.store.session(),page=f.store.exportPage(null,0,500,NOW+2);
  f.failOn('INSERT INTO runner_meta(k,v)');
  await assert.rejects(()=>f.store.advance({action:'resume',commandId:'resume-fault'},[],NOW+3),/Injected storage failure/);
  assert.deepEqual(f.store.session(),before);assert.equal(f.store.exportPage(null,0,500,NOW+4).records.length,page.records.length);
  await f.store.advance({action:'resume',commandId:'resume-fault'},[],NOW+5);assert.equal(f.store.session()?.status,'running');
});
test('concurrent operations use revision CAS, and stale command/session/time are rejected',async()=>{
  const {store}=await active();const results=await Promise.allSettled([store.advance({action:'resume',commandId:'concurrent-resume'},[],NOW+2),store.advance({action:'pause',commandId:'concurrent-pause'},[],NOW+2)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  await assert.rejects(()=>store.advance({action:'tick'},[],NOW+4,[],0),/changed/);
  await assert.rejects(()=>store.advance({action:'pause',commandId:'wrong-session',sessionId:'wrong'},[],NOW+4),/changed/);
  await assert.rejects(()=>store.advance({action:'pause',commandId:'wrong-clock'},[],NOW),/changed/);
});
test('frames replay exactly from frozen migration checkpoint including empty ticks and repeated-book changed context',async()=>{
  const {store}=await active();const initial=store.session()!;
  await store.advance({action:'resume',commandId:'replay-resume'},[],NOW+2);
  await store.advance({action:'tick'},[input(NOW+4000)],NOW+4000);
  const sameQuote=input(NOW+4000);sameQuote.market.contextUpdatedAt=NOW+4500;sameQuote.market.score='1-0';
  await store.advance({action:'tick'},[sameQuote],NOW+5000);
  await store.advance({action:'tick'},[],NOW+6000,['synthetic provider timeout']);
  const page=store.exportPage(null,0,500,NOW+6001),frames=page.records.filter(r=>r.kind==='replay').map(r=>r.value as unknown as ReplayFrame),observations=new Map(page.observations.map(r=>[r.id,r.value]));
  assert.notEqual(frames[1].inputIds[0],frames[2].inputIds[0]);let replay=initial;
  for(const frame of frames){assert.equal(frame.beforeHash,await sha256(JSON.stringify(replay)));const inputs=frame.inputIds.map(id=>observations.get(id) as TennisInput);replay=frame.action.action==='tick'?stepTennisSession(replay,inputs,frame.now):applyTennisAction(replay,frame.action,inputs,frame.now);assert.equal(frame.afterHash,await sha256(JSON.stringify(replay)));}
  assert.deepEqual(JSON.parse(JSON.stringify(replay)),store.session());assert.deepEqual(frames.at(-1)?.sourceFailures,['synthetic provider timeout']);
});
test('export pages remain pinned while later ticks append, and counters persist across restart',async()=>{
  const {store,storage}=await active();await store.advance({action:'resume',commandId:'export-resume'},[],NOW+2);
  const first=store.exportPage(null,0,1,NOW+3);await store.advance({action:'tick'},[],NOW+4000);
  // The counter is saved at most once a minute, but rows written in between already count toward the budget.
  assert.equal(store.usage(NOW+4000).alarmChecks,1);
  await store.advance({action:'tick'},[],NOW+65000);
  let cursor=first.nextCursor;const records=[...first.records];while(true){const p=store.exportPage(first.exportId,cursor,1,NOW+5000);assert.deepEqual(p.session,first.session);records.push(...p.records);cursor=p.nextCursor;if(p.complete)break;}
  assert.ok(!records.some(r=>r.kind==='replay'&&(r.value as unknown as ReplayFrame).now===NOW+4000));
  const reopened=new RunnerStore(storage);assert.equal(reopened.usage(NOW).alarmChecks,2);assert.ok(reopened.usage(NOW).estimatedRowsWritten>0);assert.equal(reopened.usage(NOW+86400000).estimatedRowsWritten,0);
});
test('actual synthetic delayed entry, fees and exit reproduce exactly, followed by deterministic reset',async()=>{
  const {store}=await active();const initial=store.session()!;
  await store.advance({action:'resume',commandId:'trade-resume'},[],NOW+2);
  for(let i=0;i<11;i++){const t=NOW+4000+i*4000;await store.advance({action:'tick'},[input(t,.59,.60)],t);}
  for(const [offset,bid,ask] of [[48000,.45,.46],[50000,.48,.49],[52000,.49,.50],[54000,.49,.50],[56000,.55,.56],[58000,.55,.56]])await store.advance({action:'tick'},[input(NOW+offset,bid,ask)],NOW+offset);
  const traded=store.session()!;assert.equal(traded.ledger.length,2);assert.deepEqual(traded.ledger.map(e=>e.action),['BUY','SELL']);assert.equal(traded.cash,100.23);assert.equal(traded.positions[0].entryFees,.11);assert.equal(traded.positions[0].exitFees,.11);assert.equal(traded.positions[0].status,'closed');
  await store.advance({action:'reset',bankroll:100,commandId:'reset-fixture'},[],NOW+60000);
  const page=store.exportPage(null,0,500,NOW+60001),observations=new Map(page.observations.map(r=>[r.id,r.value]));let replay=initial;
  for(const r of page.records.filter(r=>r.kind==='replay'))replay=await replayFrame(replay,r.value as unknown as ReplayFrame,observations);
  assert.deepEqual(replay,store.session());assert.equal(page.missingObservationIds.length,0);assert.equal(page.pageEvidenceComplete,true);assert.ok(page.records.some(r=>r.kind==='checkpoint'&&r.value.id===replay.id));
});
test('cutover rejects a missing execution journal, open holdings and a ledger-less position',async()=>{
  const {store}=await active();await store.advance({action:'resume',commandId:'fixture-entry'},[],NOW+2);
  for(let i=0;i<11;i++){const t=NOW+4000+i*4000;await store.advance({action:'tick'},[input(t,.59,.60)],t);}
  for(const [offset,bid,ask] of [[48000,.45,.46],[50000,.48,.49],[52000,.49,.50],[54000,.49,.50]])await store.advance({action:'tick'},[input(NOW+offset,bid,ask)],NOW+offset);
  const holding=store.session()!;holding.status='paused';await assert.rejects(async()=>new RunnerStore(sqlite().storage).beginImport((await migration(holding)).start,OWNER,EPOCH),/no open position/);
  for(const offset of [56000,58000])await store.advance({action:'tick'},[input(NOW+offset,.55,.56)],NOW+offset);const closed=store.session()!;closed.status='paused';
  const other=new RunnerStore(sqlite().storage),m=await migration(closed);await other.beginImport(m.start,OWNER,EPOCH);await other.importChunk({migrationId:m.start.manifest.migrationId,index:0,data:m.data},OWNER,EPOCH);assert.throws(()=>other.activate(m.start.manifest.migrationId,OWNER,EPOCH,NOW+60000),/execution journal/);
  const broken=structuredClone(closed);broken.ledger=[];broken.cash=100;await assert.rejects(async()=>new RunnerStore(sqlite().storage).beginImport((await migration(broken)).start,OWNER,EPOCH),/reconcile/);
});
test('reset revisions stay monotonic, racing stale commands lose, and budget cannot be bypassed by resume',async()=>{
  const {store}=await active();const beforeReset=store.session()!;await store.advance({action:'reset',bankroll:100,commandId:'initial-reset'},[],NOW+2);const old=store.session()!;assert.equal(old.revision,beforeReset.revision+1);
  const result=await Promise.allSettled([store.advance({action:'reset',bankroll:90,commandId:'race-reset'},[],NOW+3),store.advance({action:'update-rules',rules:{entryBudget:6},expectedRulesRevision:0,sessionId:old.id,commandId:'race-rules'},[],NOW+3)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.notEqual(store.session()?.id,old.id);assert.equal(store.session()?.cash,90);
  assert.equal(store.session()?.revision,old.revision+1);
  await assert.rejects(()=>store.advance({action:'tick',sessionId:old.id},[],NOW+4,[],0),/changed/);
  store.set('usage',{day:new Date(NOW).toISOString().slice(0,10),estimatedRowsWritten:RUNNER_ENTRY_WRITE_LIMIT+1,alarmChecks:1,entryPauseAt:75000});await assert.rejects(()=>store.advance({action:'resume',commandId:'over-budget'},[],NOW+5),/write-budget/);
});
test('reset is accepted by revision-monotonic UI polling and delayed old account responses remain older',async()=>{
  const {store}=await active();await store.advance({action:'resume',commandId:'revision-resume'},[],NOW+2);await store.advance({action:'tick'},[],NOW+4000);await store.advance({action:'pause',commandId:'revision-pause'},[],NOW+5000);const previous=store.session()!;
  const response=await store.advance({action:'reset',bankroll:125,commandId:'revision-reset'},[],NOW+6000);assert.equal(response.session.revision,previous.revision+1);assert.notEqual(response.session.id,previous.id);assert.equal(response.session.cash,125);
  const accepted=previous.revision>response.session.revision?previous:response.session;assert.equal(accepted.id,response.session.id);assert.ok(previous.revision<accepted.revision);
  const page=store.exportPage(null,0,500,NOW+6001),frame=page.records.filter(r=>r.kind==='replay').at(-1)!.value as unknown as ReplayFrame;
  assert.deepEqual(await replayFrame(previous,frame,new Map()),response.session);
});
test('indefinite service resume clears an expired browser window with an exactly replayable transition',async()=>{
  const source=snapshot();source.testRun={startedAt:NOW-3600000,endsAt:NOW-1,watchedMs:3600000,lastCheckAt:NOW-1,startingCash:100,startingLedgerCount:0,liveSlugs:[],complete:false};
  const {store}=await active(source),initial=store.session()!;await store.advance({action:'resume',commandId:'indefinite-resume'},[],NOW+2);await store.advance({action:'tick'},[],NOW+4000);
  assert.equal(store.session()?.status,'running');assert.equal(store.session()?.testRun,undefined);const page=store.exportPage(null,0,500,NOW+4001);let replay=initial;
  const frames=page.records.filter(r=>r.kind==='replay').map(r=>r.value as unknown as ReplayFrame);assert.equal(frames[0].clearObservationWindow,true);
  for(const frame of frames)replay=await replayFrame(replay,frame,new Map());assert.deepEqual(replay,store.session());
  assert.deepEqual((page.records.find(r=>r.kind==='migration')?.value.sourceSnapshot as typeof source).testRun,source.testRun);
});
