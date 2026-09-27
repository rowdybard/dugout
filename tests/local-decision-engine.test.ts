import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,defaultTennisConfig,validateTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types';
import type {TradeSide} from '../lib/trading/types';
import {focusedEntryRest} from '../lib/tennis/entry-rest.ts';

const NOW=2_000_000,SLUG='synthetic-local-engine';
const trajectory:[number,number][]=[...[-60,-58,-56,-54,-52,-50,-48].map(t=>[t,.89] as [number,number]),[-40,.85],[-33,.81],[-26,.77],[-19,.73],[-12,.69],[-8,.71],[-4,.73],[0,.75]];
function input(time:number,bid:number,side:TradeSide='YES',football=false):TennisInput{
  const ask=Math.round((bid+.01)*1e6)/1e6,yesBid=side==='YES'?bid:Math.round((1-ask)*1e6)/1e6,yesAsk=side==='YES'?ask:Math.round((1-bid)*1e6)/1e6;
  return {receivedAt:time,source:'REST',book:{bids:[{price:yesBid,quantity:100}],asks:[{price:yesAsk,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    market:{slug:SLUG,eventId:'synthetic-event',eventSlug:'synthetic-event',title:'Synthetic A vs B',league:football?'CFB':'ATP',yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,score:'7-7',period:football?'Q2':'Set 1',clock:'10:00',tournament:null,bid:yesBid,ask:yesAsk,price:(yesBid+yesAsk)/2,observedAt:time,contextUpdatedAt:time,history:[],
      footballIdentity:{yesTeamId:'1',noTeamId:'2'},football:{possessionTeam:'Synthetic A',possessionTeamId:'1',down:1,yardsToGo:10,fieldPosition:{team:'Synthetic A',teamId:'1',yard:25},timeouts:[]},
      execution:{slug:SLUG,league:football?'CFB':'ATP',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.005,feeCoefficient:.0695}}};
}
function queued(side:TradeSide='YES',football=false){
  // Scalping mechanics are tested with the evidence gate off; tests/decision-engine.test.ts covers the gate.
  const config={...defaultLiveTennisConfig(),evidenceGate:undefined,maker:undefined,entryBudget:10,focusSlug:SLUG,leagues:[football?'CFB' as const:'ATP' as const]};
  let session=createTennisSession(config,NOW-60001);session.id='synthetic-local-account';
  session=applyTennisAction(session,{action:'start',commandId:'synthetic-start'},[],NOW-60001);
  for(const [offset,bid] of trajectory){const quote=input(NOW+offset*1000,bid,side,football);session=stepTennisSession(session,[quote],quote.receivedAt);if(session.pending)return {session,quote};}
  assert.fail('The independently specified executable move must reach delayed entry. '+session.lastReason);
}
function filled(side:TradeSide='YES',football=false){
  const {session,quote}=queued(side,football),later=structuredClone(quote),time=quote.receivedAt+1000;
  later.receivedAt=time;later.book.time=new Date(time).toISOString();later.market.observedAt=time;later.market.contextUpdatedAt=time;
  const next=stepTennisSession(session,[later],time);
  assert.equal(next.ledger.length,1,next.lastReason);assert.equal(next.ledger[0].action,'BUY');assert.equal(next.positions[0].status,'open');
  return {session:next,quote:later};
}

for(const side of ['YES','NO'] as const)test(`local engine stages, rechecks and fills ${side} with complete quantitative provenance`,()=>{
  const {session,quote}=queued(side),snapshot=JSON.stringify(session);
  assert.equal(session.pending?.side,side);assert.equal(session.pending?.analysis?.decision,'enter');assert.equal(session.pending?.analysis?.version,'local-move-v1');
  assert.equal(session.cash,100);assert.equal(session.ledger.length,0);
  assert.ok(session.pending!.analysis!.metrics.entryFees!>0);assert.ok(session.pending!.analysis!.metrics.modeledExitFees!>0);
  const duplicate=stepTennisSession(session,[quote],quote.receivedAt+1500);assert.equal(duplicate.ledger.length,0);assert.equal(duplicate.cash,100);
  assert.equal(JSON.stringify(session),snapshot);
  const f=filled(side).session,position=f.positions[0];
  assert.equal(position.exitPlan?.version,'adaptive-exit-v1');assert.equal(position.entryAnalysis?.decision,'enter');
  assert.equal(position.exitPlan!.entryAllInUnitCost,position.entryCost/position.initialQuantity);
  assert.ok(f.decisions.some(d=>d.code==='ENTRY_RECHECK'&&d.analysis?.decision==='enter'));
  assert.ok(f.decisions.some(d=>d.action==='BUY'&&d.analysis?.metrics.dropSigma!==null));
  assert.deepEqual(JSON.parse(JSON.stringify(position.exitPlan)),position.exitPlan);
  assert.equal(Math.round((f.cash+position.entryCost)*1e6),100_000_000);
});

test('delayed entry rejects lost depth, wide spread and changed football context without debiting cash',()=>{
  for(const failure of ['depth','spread','context'] as const){
    const {session,quote}=queued('YES',true),later=structuredClone(quote),time=quote.receivedAt+1000;
    later.receivedAt=time;later.book.time=new Date(time).toISOString();later.market.observedAt=time;later.market.contextUpdatedAt=time;
    if(failure==='depth')later.book.bids[0].quantity=1;
    if(failure==='spread')later.book.asks[0].price=later.book.bids[0].price+.04;
    if(failure==='context'){later.market.score='7-14';later.market.football!.possessionTeamId='2';later.market.football!.possessionTeam='Synthetic B';}
    const next=stepTennisSession(session,[later],time);
    assert.equal(next.pending,null);assert.equal(next.cash,100);assert.equal(next.ledger.length,0);assert.equal(next.positions.length,0);
    assert.ok(next.decisions.some(d=>d.code===(failure==='context'?'CONTEXT_CHANGED':'ENTRY_RECHECK')));
  }
});

test('scoring transition cancels a pending local buy; the next verified drive can form a new automatic entry',()=>{
  const queuedMove=queued('YES',true),time=queuedMove.quote.receivedAt+1000;
  const transition=input(time,.75,'YES',true);transition.market.score='7-14';
  transition.market.football={...transition.market.football!,phase:'between-plays',down:null,yardsToGo:null,fieldPosition:null};
  let session=stepTennisSession(queuedMove.session,[transition],time);
  assert.equal(session.pending,null);assert.equal(session.cash,100);assert.equal(session.ledger.length,0);
  assert.equal(session.footballReports![SLUG].assessment.status,'transition');
  assert.equal(stepTennisSession(session,[],time+46000).footballReports![SLUG].assessment.status,'stale');
  let confirmed:TennisInput|undefined;
  for(const [offset,bid] of trajectory){const quote=input(time+65000+offset*1000,bid,'YES',true);quote.market.score='7-14';session=stepTennisSession(session,[quote],quote.receivedAt);if(session.pending){confirmed=quote;break;}}
  assert.equal(session.pending?.action,'BUY',session.lastReason);
  const later=structuredClone(confirmed!);later.receivedAt+=1000;later.market.observedAt=later.receivedAt;later.market.contextUpdatedAt=later.receivedAt;later.book.time=new Date(later.receivedAt).toISOString();
  session=stepTennisSession(session,[later],later.receivedAt);
  assert.equal(session.positions[0]?.status,'open',session.lastReason);assert.equal(session.ledger[0]?.action,'BUY');
});

test('held positions keep collecting independent history and original exit limits after a rule change',()=>{
  const {session,quote}=filled('YES',true),plan=structuredClone(session.positions[0].exitPlan),time=quote.receivedAt+1;
  const updated=applyTennisAction(session,{action:'update-rules',sessionId:session.id,expectedRulesRevision:0,commandId:'synthetic-new-risk',rules:{stopReturn:.25,maxHoldMs:600000,executionDelayMs:30000,focusSlug:'different-synthetic-game'}},[],time);
  assert.deepEqual(updated.positions[0].exitPlan,plan);assert.equal(updated.positions[0].exitRules!.stopReturn,.08);
  const loss=input(time+2000,.66,'YES',true);loss.market.contextUpdatedAt=time-60000;
  const next=stepTennisSession(updated,[loss],loss.receivedAt);
  assert.equal(next.pending?.action,'SELL',next.lastReason);assert.match(next.pending!.reason,/loss threshold/);
  assert.equal(next.histories[`${SLUG}:YES`].at(-1)!.time,loss.receivedAt);
  assert.deepEqual(next.positions[0].exitPlan,plan);assert.ok(next.decisions.at(-1)?.exitAnalysis);
  assert.equal(next.pending!.executeAfter-next.pending!.createdAt,plan!.executionDelayMs);
});

test('local session reset retains the new engine, legacy reset retains historical semantics',()=>{
  for(const local of [true,false]){
    const config=local?defaultLiveTennisConfig():defaultTennisConfig();let session=createTennisSession(config,NOW);session.id='synthetic-reset';
    session=applyTennisAction(session,{action:'reset',bankroll:75,commandId:'synthetic-reset-command'},[],NOW+1);
    assert.equal(session.config.decisionEngine,local?'local-move-v1':undefined);assert.equal(session.cash,75);assert.equal(session.status,'idle');
  }
});

test('local engine preserves the spread/freshness floor and cannot be switched to a primitive pattern',()=>{
  assert.equal(validateTennisConfig(defaultLiveTennisConfig()),null);
  for(const change of [{strategy:'recovery' as const},{maxSpreadPoints:3},{maxBookAgeMs:6000},{minimumHistoryMs:1000},{minSamples:3}])assert.ok(validateTennisConfig({...defaultLiveTennisConfig(),...change}));
});

test('local cooldown is visible from the two quantitative outcome tracks',()=>{
  const {session,quote}=queued(),later=structuredClone(quote),time=quote.receivedAt+1000;
  later.receivedAt=time;later.market.observedAt=time;later.book.asks[0].price=later.book.bids[0].price+.04;
  const next=stepTennisSession(session,[later],time);
  assert.equal(focusedEntryRest(next,time),10);assert.equal(next.cash,100);
});

test('new decision state round-trips and runs without any model or network call',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>{assert.fail('Pure decision reducer cannot call a remote service');});
  const {session,quote}=filled();const restored=JSON.parse(JSON.stringify(session)) as TennisSession;
  const later=input(quote.receivedAt+2500,.75);
  assert.equal(JSON.stringify(stepTennisSession(session,[later],later.receivedAt)),JSON.stringify(stepTennisSession(restored,[later],later.receivedAt)));
});

test('adaptive holding passes the old target and a subsequent reversal closes with reconciled cash and fees',()=>{
  let {session,quote}=filled();const opened=session.positions[0].openedAt,entryCost=session.positions[0].entryCost;
  for(const [index,bid] of [.75,.76,.77,.78,.79,.80].entries()){
    quote=input(opened+(index+1)*1000,bid);session=stepTennisSession(session,[quote],quote.receivedAt);
    assert.equal(session.pending,null,session.lastReason);
  }
  const assessment=session.decisions.at(-1)!.exitAnalysis!;
  assert.equal(assessment.action,'hold');assert.ok(assessment.metrics.netReturn!>session.config.targetReturn);
  assert.equal(assessment.marketMeasurement!.available,true);
  assert.equal(assessment.marketMeasurement!.samples,7,'Exit history includes only the fill receipt and held-position quotes.');
  quote=input(opened+7000,.785);session=stepTennisSession(session,[quote],quote.receivedAt);
  assert.equal(session.pending?.action,'SELL',session.lastReason);
  assert.equal(session.decisions.at(-1)!.exitAnalysis!.code,'VOLATILITY_TRAIL');
  assert.equal(session.ledger.length,1,'Exit remains delayed.');
  quote=input(opened+8000,.785);session=stepTennisSession(session,[quote],quote.receivedAt);
  assert.equal(session.pending,null);assert.equal(session.ledger.length,2);assert.equal(session.positions[0].status,'closed');
  const buy=session.ledger[0],sell=session.ledger[1],position=session.positions[0];
  assert.ok(buy.execution!.fees>0&&sell.execution!.fees>0);
  assert.equal(Math.round(session.cash*1e6),Math.round((100+position.realizedPnl)*1e6));
  assert.equal(Math.round(position.realizedPnl*1e6),Math.round((sell.cashDelta-entryCost)*1e6));
  assert.ok(quote.receivedAt-opened<session.config.maxHoldMs);
});

test('malformed provider depth produces a recorded rejection instead of aborting the local reducer',()=>{
  const {session,quote}=queued();session.pending=null;
  const invalid=structuredClone(quote);invalid.receivedAt++;
  (invalid.book as unknown as {bids:null}).bids=null;
  const next=stepTennisSession(session,[invalid],invalid.receivedAt);
  assert.equal(next.cash,100);assert.equal(next.pending,null);assert.equal(next.ledger.length,0);
  assert.ok(next.decisions.at(-1)?.analysis?.reasons.some(r=>r.code==='BOOK_INVALID'));
});

test('evidence gate: the live bot asks the decision engine and never enters an untested or losing regime',()=>{
  const config={...defaultLiveTennisConfig(),entryBudget:10,focusSlug:SLUG,leagues:['ATP' as const]};
  assert.equal(config.evidenceGate,'evidence-v1');
  let session=createTennisSession(config,NOW-60001);session.id='synthetic-gated-account';
  session=applyTennisAction(session,{action:'start',commandId:'synthetic-start'},[],NOW-60001);
  for(const [offset,bid] of trajectory){const quote=input(NOW+offset*1000,bid);session=stepTennisSession(session,[quote],quote.receivedAt);}
  // The same move that stages an entry with the gate off is refused with the engine's reason.
  assert.equal(session.pending,null);assert.equal(session.ledger.length,0);assert.equal(session.cash,100);
  const refusal=session.decisions.find(d=>d.code==='EVIDENCE_NO_EVIDENCE');
  assert.ok(refusal,session.lastReason);assert.match(refusal.reason,/^Decision engine: No study covers ATP live taker-scalp/);
});
