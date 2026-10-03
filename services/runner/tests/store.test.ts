import test from 'node:test';
import assert from 'node:assert/strict';
import {RunnerStore,RUNNER_ENTRY_WRITE_LIMIT} from '../src/store.ts';
import {applyTennisAction,stepTennisSession} from '../../../lib/tennis/engine.ts';
import {sha256} from '../../../lib/runner/protocol.ts';
import {OWNER,EPOCH,NOW,sqlite,migration,active,activeStoppedLoss,input,snapshot} from './helpers.ts';
import type {ReplayFrame} from '../../../lib/runner/contracts';
import type {TennisInput} from '../../../lib/tennis/types';
import {replayFrame} from '../../../lib/runner/replay.ts';
import {accountBotView,applyAccountAction} from '../../../lib/tennis/account.ts';

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
  // Both start together; whichever commits first wins and the other is refused (either order is legitimate).
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  if(result[0].status==='fulfilled'){assert.notEqual(store.session()?.id,old.id);assert.equal(store.session()?.cash,90);}
  else{assert.equal(store.session()?.id,old.id);assert.equal(store.session()?.config.entryBudget,6);}
  assert.equal(store.session()?.revision,old.revision+1);
  await assert.rejects(()=>store.advance({action:'tick',sessionId:old.id},[],NOW+4,[],old.revision),/changed/);
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
for(const botId of ['football','tennis'] as const)test(`stopped ${botId} Start clears its persisted window only after valid rules and replays exactly`,async()=>{
  const old=snapshot();old.config.leagues=['CFB'];old.config.focusSlug='synthetic-football';
  const source=applyAccountAction(old,{action:'start',botId:'tennis',config:{focusSlug:'synthetic-tennis'}},[],NOW);
  source.status='stopped';source.bots!.tennis!.status='stopped';
  source.testRun={startedAt:NOW-60000,endsAt:NOW-1,watchedMs:60000,lastCheckAt:NOW-1,startingCash:100,startingLedgerCount:0,liveSlugs:[],complete:true};
  source.bots!.tennis!.testRun={...source.testRun};
  const {store}=await active(source),initial=store.session()!,peerId=botId==='football'?'tennis':'football',peer=accountBotView(initial,peerId);
  const rejected=(await store.advance({action:'start',botId,commandId:botId+'-invalid-stopped-start',config:{entryBudget:100}},[],NOW+2)).session;
  assert.equal(accountBotView(rejected,botId).status,'stopped');assert.deepEqual(accountBotView(rejected,botId).testRun,accountBotView(initial,botId).testRun);
  const started=(await store.advance({action:'start',botId,commandId:botId+'-valid-stopped-start'},[],NOW+3)).session;
  assert.equal(accountBotView(started,botId).status,'running');assert.equal(accountBotView(started,botId).testRun,undefined);
  assert.equal(started.id,initial.id);assert.equal(started.cash,initial.cash);assert.deepEqual(started.ledger,initial.ledger);
  assert.equal(accountBotView(started,peerId).status,peer.status);assert.deepEqual(accountBotView(started,peerId).testRun,peer.testRun);
  const page=store.exportPage(null,0,500,NOW+4),frames=page.records.filter(record=>record.kind==='replay').map(record=>record.value as unknown as ReplayFrame);
  assert.equal(frames[0].clearObservationWindow,undefined);assert.equal(frames[1].clearObservationWindow,true);
  let replay=initial;for(const frame of frames)replay=await replayFrame(replay,frame,new Map());assert.deepEqual(replay,started);
  assert.deepEqual(accountBotView(page.records.find(record=>record.kind==='migration')!.value.sourceSnapshot as typeof source,botId).testRun,accountBotView(source,botId).testRun);
  const timed=await active(source),timedInitial=timed.store.session()!,now=NOW+2;
  const bounded=(await timed.store.advance({action:'start',botId,commandId:botId+'-timed-stopped-start',runForMs:60000},[],now)).session;
  assert.equal(accountBotView(bounded,botId).status,'running');assert.equal(accountBotView(bounded,botId).testRun!.endsAt,now+60000);
  const boundedFrame=timed.store.exportPage(null,0,500,now+1).records.find(record=>record.kind==='replay')!.value as unknown as ReplayFrame;
  assert.equal(boundedFrame.clearObservationWindow,undefined);assert.deepEqual(await replayFrame(timedInitial,boundedFrame,new Map()),bounded);
});
test('loss acknowledgement retains account history, records one control and replays its cleared observation window',async()=>{
  const {store}=await activeStoppedLoss(),initial=store.session()!;
  const command={action:'acknowledge-loss' as const,sessionId:initial.id,commandId:'loss-acknowledgement',expectedLossAcknowledgement:null};
  const result=await store.advance(command,[],NOW+2),after=result.session;
  assert.equal(after.status,'running');assert.equal(after.id,initial.id);assert.equal(after.cash,79.94);
  assert.deepEqual(after.ledger,initial.ledger);assert.deepEqual(after.positions,initial.positions);
  assert.deepEqual(after.histories,initial.histories);assert.deepEqual(after.equity,initial.equity);assert.equal(after.testRun,undefined);
  const page=store.exportPage(null,0,500,NOW+3),frame=page.records.find(r=>r.kind==='replay')!.value as unknown as ReplayFrame;
  assert.equal(frame.clearObservationWindow,true);assert.equal(frame.action.action,'acknowledge-loss');
  assert.deepEqual(await replayFrame(initial,frame,new Map()),after);
  assert.equal(page.records.filter(r=>r.kind==='execution').length,initial.ledger.length);
  assert.equal(page.records.filter(r=>r.kind==='control').length,1);assert.equal(page.pageEvidenceComplete,true);
  assert.deepEqual((await store.advance(command,[],NOW+4)).session,after);
  assert.equal(store.exportPage(null,0,500,NOW+5).records.length,page.records.length);
  await assert.rejects(()=>store.advance({...command,runForMs:60000},[],NOW+6),/reused/);
});
test('loss acknowledgement cannot bypass runner budget or required focused game and preserves its window on rejection',async()=>{
  const {store}=await activeStoppedLoss(),initial=store.session()!,command={action:'acknowledge-loss' as const,sessionId:initial.id,commandId:'budget-loss-ack',expectedLossAcknowledgement:null};
  store.set('usage',{day:new Date(NOW).toISOString().slice(0,10),estimatedRowsWritten:RUNNER_ENTRY_WRITE_LIMIT+1,alarmChecks:0,entryPauseAt:RUNNER_ENTRY_WRITE_LIMIT});
  await assert.rejects(()=>store.advance(command,[],NOW+2),/write-budget/);assert.deepEqual(store.session(),initial);
  store.set('usage',{day:new Date(NOW).toISOString().slice(0,10),estimatedRowsWritten:0,alarmChecks:0,entryPauseAt:RUNNER_ENTRY_WRITE_LIMIT});
  const withoutFocus={...initial,config:{...initial.config,focusSlug:undefined}};store.set('session',withoutFocus);
  await assert.rejects(()=>store.advance(command,[],NOW+3),/focused game/);assert.deepEqual(store.session(),JSON.parse(JSON.stringify(withoutFocus)));
  store.set('session',initial);await assert.rejects(()=>store.advance({...command,sessionId:'wrong-session'},[],NOW+4),/changed/);
  assert.deepEqual(store.session(),initial);
});
test('rejected and concurrent loss acknowledgements cannot clear a window or duplicate resumed state',async()=>{
  const {store}=await activeStoppedLoss(),initial=store.session()!;
  const paused={...initial,status:'paused' as const};store.set('session',paused);
  const rejected=await store.advance({action:'acknowledge-loss',sessionId:initial.id,commandId:'paused-loss-ack',expectedLossAcknowledgement:null},[],NOW+2);
  assert.equal(rejected.session.status,'paused');assert.deepEqual(rejected.session.testRun,initial.testRun);
  const rejectedFrame=store.exportPage(null,0,500,NOW+3).records.find(r=>r.kind==='replay')!.value as unknown as ReplayFrame;
  assert.equal(rejectedFrame.clearObservationWindow,undefined);
  store.set('session',initial);
  const outcomes=await Promise.allSettled([
    store.advance({action:'acknowledge-loss',sessionId:initial.id,commandId:'concurrent-loss-ack-a',expectedLossAcknowledgement:null},[],NOW+4),
    store.advance({action:'acknowledge-loss',sessionId:initial.id,commandId:'concurrent-loss-ack-b',expectedLossAcknowledgement:null},[],NOW+4),
  ]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(result=>result.status==='rejected').length,1);
  const accepted=outcomes.find(result=>result.status==='fulfilled');assert.ok(accepted?.status==='fulfilled');
  assert.deepEqual(store.session(),accepted.value.session);assert.ok(store.session()!.revision>initial.revision);assert.equal(store.session()!.status,'running');
  const controls=store.exportPage(null,0,500,NOW+5).records.filter(record=>record.kind==='control'&&String((record.value.action as {commandId?:string}).commandId).startsWith('concurrent-loss-ack'));
  assert.equal(controls.length,1);
});
test('explicit loss acknowledgement duration replaces the completed window and remains replayable',async()=>{
  const {store}=await activeStoppedLoss(),initial=store.session()!,now=NOW+2;
  const result=await store.advance({action:'acknowledge-loss',sessionId:initial.id,commandId:'timed-loss-ack',expectedLossAcknowledgement:null,runForMs:60000},[],now);
  assert.equal(result.session.status,'running');assert.equal(result.session.testRun!.startedAt,now);assert.equal(result.session.testRun!.endsAt,now+60000);assert.equal(result.session.testRun!.complete,false);
  const frame=store.exportPage(null,0,500,now+1).records.find(record=>record.kind==='replay')!.value as unknown as ReplayFrame;
  assert.equal(frame.clearObservationWindow,undefined);assert.deepEqual(await replayFrame(initial,frame,new Map()),result.session);
});

test('an old distinct acknowledgement cannot reopen a later loss period in the same account',async()=>{
  const {store}=await activeStoppedLoss(),initial=store.session()!,firstCommand='first-loss-period';
  const first=await store.advance({action:'acknowledge-loss',sessionId:initial.id,commandId:firstCommand,expectedLossAcknowledgement:null},[],NOW+2);
  const secondPosition={...initial.positions[0],id:'synthetic-second-loss-position',openedAt:NOW+3,closedAt:NOW+4,markedAt:NOW+4};
  const stopped={...first.session,status:'stopped' as const,cash:59.88,
    positions:[...first.session.positions,secondPosition],
    ledger:[...first.session.ledger,...initial.ledger.map(entry=>({...entry,id:entry.id+'-second',positionId:secondPosition.id,time:entry.action==='BUY'?NOW+3:NOW+4}))],
    testRun:{...initial.testRun!,startedAt:NOW+2,endsAt:NOW+4,lastCheckAt:NOW+4,startingCash:79.94,startingLedgerCount:2}};
  store.set('session',stopped);
  const page=store.exportPage(null,0,500,NOW+5),delayed={action:'acknowledge-loss' as const,sessionId:stopped.id,commandId:'delayed-distinct-first-period',expectedLossAcknowledgement:null};
  await assert.rejects(()=>store.advance(delayed,[],NOW+6),/changed/);
  assert.deepEqual(store.session(),stopped);assert.equal(store.commandResult(delayed.commandId,JSON.stringify(delayed)),null);
  assert.equal(store.exportPage(page.exportId,0,500,NOW+7).records.length,page.records.length);
  const current={...delayed,commandId:'current-second-period',expectedLossAcknowledgement:firstCommand};
  const after=(await store.advance(current,[],NOW+8)).session;
  assert.equal(after.status,'running');assert.equal(after.id,stopped.id);assert.equal(after.cash,59.88);
  assert.deepEqual(after.ledger,stopped.ledger);assert.deepEqual(after.positions,stopped.positions);assert.equal(after.testRun,undefined);
  assert.equal(after.lossCheckpoint?.commandId,current.commandId);assert.equal(after.lossCheckpoint?.cash,59.88);
});
