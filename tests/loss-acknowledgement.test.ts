import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {sessionEngine,sessionRisk} from '../lib/tennis/engine-plan.ts';
import {checkRisk,DEFAULT_RISK} from '../lib/decision/risk.ts';
import {canAcknowledgeLoss,lossAllowance,lossFloor,lossLimitReached} from '../lib/tennis/loss-limit.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisInput,TennisMarket,TennisPosition,TennisSession} from '../lib/tennis/types';
import {setPaperAccountLimits} from '../lib/tennis/account-limits.ts';
// These tests check the account limits themselves, which are off for paper accounts by default (lib/tennis/account-limits.ts).
setPaperAccountLimits(true);

const NOW=Date.parse('2026-10-04T18:00:00Z'),SLUG='synthetic-cfb-loss-ack';
const exact=(value:number)=>Math.round(value*1e6)/1e6;
function market(time=NOW):TennisMarket {
  return {slug:SLUG,eventSlug:SLUG,eventId:'synthetic',title:'Synthetic loss acknowledgement',league:'CFB',yesName:'Home',noName:'Away',
    startTime:new Date(time+3_600_000).toISOString(),live:false,ended:false,active:true,score:null,period:null,tournament:null,
    bid:.1,ask:.11,price:.105,observedAt:time,contextUpdatedAt:time,history:[],
    execution:{slug:SLUG,league:'CFB',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695}};
}
function closedLoss(session:TennisSession,pnl:number,time:number):void {
  const id=`closed-${session.positions.length}`,entryCost=25,proceeds=exact(entryCost+pnl),m=market(time);
  session.positions.push({id,slug:SLUG,league:'CFB',title:m.title,side:'YES',name:'Home',quantity:0,initialQuantity:50,costBasis:0,
    entryCost,entryPrice:.5,entryFees:0,openedAt:time-1000,status:'closed',closedAt:time,realizedPnl:pnl,exitFees:0,proceeds,
    netLiquidationValue:null,liquidationQuantity:0,markedAt:null,market:m,exitPolicy:'maker'});
  session.ledger.push({id:`${id}-buy`,positionId:id,time:time-1000,slug:SLUG,side:'YES',action:'BUY',source:'AUTOMATIC',reason:'Synthetic purchase',cashDelta:-entryCost,realizedPnl:0},
    {id:`${id}-sell`,positionId:id,time,slug:SLUG,side:'YES',action:'SELL',source:'AUTOMATIC',reason:'Synthetic sale',cashDelta:proceeds,realizedPnl:pnl});
  session.cash=exact(session.cash+pnl);
}
function stopped(pnl=-20.06,startingCash=100,maxSessionLossFraction=.2):TennisSession {
  const session=createTennisSession({...defaultLiveTennisConfig(startingCash),leagues:['CFB'],focusSlug:SLUG,entries:'all',maxSessionLossFraction},NOW-3_600_000);
  session.id='same-paper-run';closedLoss(session,pnl,NOW-1000);session.status='stopped';session.lastTickAt=NOW;
  session.histories[`${SLUG}:YES`]=[{time:NOW-1000,price:.1,bid:.09,ask:.11}];
  session.equity.push({time:NOW,price:session.cash});session.rulesRevision=4;
  return session;
}
const acknowledge=(session:TennisSession,commandId='ack-first',now=NOW+1000,runForMs?:number)=>
  applyTennisAction(session,{action:'acknowledge-loss',sessionId:session.id,commandId,expectedLossAcknowledgement:session.lossCheckpoint?.commandId??null,
    ...(runForMs===undefined?{}:{runForMs})},[],now);

test('explicit acknowledgement continues the same run with the original dollar allowance and complete history',()=>{
  const before=stopped(),snapshot=structuredClone(before);
  assert.equal(canAcknowledgeLoss(before),true);assert.equal(lossAllowance(before),20);assert.equal(lossFloor(before),80);
  const resumed=acknowledge(before);
  assert.equal(resumed.status,'running');assert.equal(resumed.id,before.id);assert.equal(resumed.cash,79.94);
  assert.deepEqual(resumed.config,before.config);assert.deepEqual(resumed.positions,before.positions);assert.deepEqual(resumed.ledger,before.ledger);
  assert.deepEqual(resumed.histories,before.histories);assert.deepEqual(resumed.equity,before.equity);assert.equal(resumed.rulesRevision,4);
  assert.deepEqual(resumed.lossCheckpoint,{commandId:'ack-first',acknowledgedAt:NOW+1000,cash:79.94,realizedPnl:-20.06,utcDay:'2026-10-04',dayPnl:-20.06});
  assert.equal(lossFloor(resumed),59.94);assert.equal(lossLimitReached(resumed),false);
  assert.equal(resumed.decisions.filter(decision=>decision.code==='LOSS_ACKNOWLEDGED').length,1);
  assert.deepEqual(before,snapshot,'the original reducer input is untouched');
});

test('ordinary resume and repeated ticks never acknowledge a loss or restart a stopped run',()=>{
  const before=stopped();
  const ticked=stepTennisSession(before,[],NOW+1000);assert.equal(ticked.status,'stopped');assert.equal(ticked.lossCheckpoint,undefined);
  const resumed=applyTennisAction(before,{action:'resume',sessionId:before.id,commandId:'ordinary-resume'},[],NOW+1000);
  assert.equal(resumed.status,'stopped');assert.equal(resumed.cash,79.94);assert.equal(resumed.lossCheckpoint,undefined);
  assert.equal(resumed.decisions.some(decision=>decision.code==='LOSS_ACKNOWLEDGED'),false);
});

test('a second loss stop needs its own acknowledgement and again allows twenty dollars',()=>{
  let session=acknowledge(stopped());closedLoss(session,-20,NOW+2000);
  session=stepTennisSession(session,[],NOW+3000);assert.equal(session.status,'stopped');assert.equal(session.cash,59.94);
  assert.equal(canAcknowledgeLoss(session),true);
  const resumed=acknowledge(session,'ack-second',NOW+4000);
  assert.equal(resumed.status,'running');assert.equal(resumed.cash,59.94);assert.equal(lossAllowance(resumed),20);assert.equal(lossFloor(resumed),39.94);
  assert.equal(resumed.lossCheckpoint!.realizedPnl,-40.06);assert.equal(resumed.ledger.length,4);
});

test('changing the saved loss fraction applies it to the original starting balance after acknowledgement',()=>{
  const resumed=acknowledge(stopped());
  const changed=applyTennisAction(resumed,{action:'update-rules',sessionId:resumed.id,commandId:'new-loss-fraction',
    expectedRulesRevision:4,rules:{maxSessionLossFraction:.15}},[],NOW+2000);
  assert.equal(changed.config.startingCash,100);assert.equal(changed.cash,79.94);assert.equal(changed.status,'running');
  assert.equal(lossAllowance(changed),15);assert.equal(lossFloor(changed),64.94);
  assert.deepEqual(changed.lossCheckpoint,resumed.lossCheckpoint,'a rule change does not silently acknowledge another loss');
});

test('command replay is inert, wrong sessions are ignored, and acknowledgement cannot be automatic',()=>{
  const before=stopped(),resumed=acknowledge(before);
  assert.equal(acknowledge(resumed,'ack-first',NOW+2000),resumed);
  assert.deepEqual(acknowledge(before),resumed,'same command and input replay exactly');
  assert.equal(applyTennisAction(before,{action:'acknowledge-loss',sessionId:'another-run',commandId:'wrong',expectedLossAcknowledgement:null},[],NOW+1000),before);
  assert.equal(applyTennisAction(before,{action:'acknowledge-loss',sessionId:'',commandId:'missing-session',expectedLossAcknowledgement:null},[],NOW+1000),before);
  assert.equal(applyTennisAction(before,{action:'acknowledge-loss',sessionId:before.id,commandId:'',expectedLossAcknowledgement:null},[],NOW+1000),before);
  assert.equal(canAcknowledgeLoss(resumed),false);
});

test('a delayed acknowledgement from an earlier stop cannot consent to a later loss stop in the same run',()=>{
  const before=stopped();
  const delayed={action:'acknowledge-loss' as const,sessionId:before.id,commandId:'delayed-old-consent',expectedLossAcknowledgement:null};
  let session=acknowledge(before);closedLoss(session,-20,NOW+2000);session=stepTennisSession(session,[],NOW+3000);
  assert.equal(session.status,'stopped');assert.equal(session.id,before.id);
  const rejected=applyTennisAction(session,delayed,[],NOW+4000);
  assert.equal(rejected,session,'stale consent changes no revision, checkpoint, timer, or balance');
  assert.equal(rejected.commandIds.includes(delayed.commandId),false);
  const resumed=acknowledge(session,'fresh-current-consent',NOW+5000);
  assert.equal(resumed.status,'running');assert.equal(resumed.lossCheckpoint!.commandId,'fresh-current-consent');
});

test('acknowledgement refuses unfinished exits, empty cash, and stops without a loss breach',()=>{
  const base=stopped(),open={...base.positions[0],id:'still-open',quantity:1,costBasis:.5,status:'open' as const,
    exitRules:{targetReturn:base.config.targetReturn,stopReturn:base.config.stopReturn,maxHoldMs:base.config.maxHoldMs,source:'entry' as const}};
  const variants:TennisSession[]=[{...base,status:'stopping'}, {...base,positions:[...base.positions,open]},
    {...base,pending:{id:'exit',market:market(),slug:SLUG,side:'YES',action:'SELL',positionId:open.id,limitPrice:.1,createdAt:NOW,executeAfter:NOW+1000,observedAt:NOW,source:'MANUAL',reason:'Exiting'}},
    {...base,exitAll:NOW}, {...base,exitRequested:{positionId:open.id,source:'MANUAL',reason:'Exiting'}},
    {...base,cash:0}, {...createTennisSession(defaultLiveTennisConfig(100),NOW),status:'stopped'}];
  for(const session of variants){
    assert.equal(canAcknowledgeLoss(session),false);
    const result=acknowledge(session);assert.equal(result.status,session.status);assert.equal(result.lossCheckpoint,undefined);
    assert.deepEqual(result.positions,session.positions);assert.deepEqual(result.ledger,session.ledger);assert.equal(result.cash,session.cash);
  }
});

test('acknowledgement restarts a requested observation window and removes an expired window when none is requested',()=>{
  const before=stopped();before.testRun={startedAt:NOW-120000,endsAt:NOW-60000,watchedMs:60000,lastCheckAt:NOW-60000,
    startingCash:100,startingLedgerCount:0,liveSlugs:[],complete:false};
  const service=acknowledge(before);assert.equal(service.status,'running');assert.equal(service.testRun,undefined);
  const browser=acknowledge(before,'ack-browser',NOW+1000,1800000);
  assert.equal(browser.status,'running');assert.equal(browser.testRun!.startedAt,NOW+1000);assert.equal(browser.testRun!.endsAt,NOW+1801000);
  assert.equal(browser.testRun!.startingCash,79.94);assert.equal(browser.testRun!.startingLedgerCount,2);
});

test('risk checks subtract acknowledged losses only for the matching UTC day and keep non-loss limits',()=>{
  const before=stopped();assert.equal(sessionRisk(before,NOW).dayPnl,-20.06);
  const resumed=acknowledge(before);assert.equal(sessionRisk(resumed,NOW+1000).dayPnl,0);assert.equal(sessionRisk(resumed,NOW+1000).sessionPnl,0);
  closedLoss(resumed,-2,NOW+2000);const today=sessionRisk(resumed,NOW+3000);assert.ok(Math.abs(today.dayPnl+2)<1e-9);assert.ok(Math.abs(today.sessionPnl+2)<1e-9);
  const tomorrow=Date.parse('2026-10-05T01:00:00Z');closedLoss(resumed,-3,tomorrow);
  const next=sessionRisk(resumed,tomorrow+1000);assert.equal(next.dayPnl,-3);assert.ok(Math.abs(next.sessionPnl+5)<1e-9);
  const engine=sessionEngine(resumed);assert.ok('engine' in engine);
  assert.equal(next.openExposure,0);assert.equal(next.tradesToday,1,'acknowledgement does not reset trade counting');
  assert.equal(sessionRisk({...resumed,status:'paused'},tomorrow).halted,'bot is paused');
  assert.equal(checkRisk({...next,tradesToday:20},DEFAULT_RISK,5,0).ok,false,'trade-count cap remains active');
  assert.equal(checkRisk({...next,openExposure:50},DEFAULT_RISK,5,0).ok,false,'exposure cap remains active');
  assert.equal(checkRisk(next,DEFAULT_RISK,5,null).ok,false,'unknown data age remains blocked');
});

function addOpen(session:TennisSession,exitPolicy:TennisPosition['exitPolicy']):void {
  const p:TennisPosition={...session.positions[0],id:'new-held',status:'open',openedAt:NOW+2000,closedAt:undefined,quantity:50,costBasis:25,
    initialQuantity:50,entryCost:25,realizedPnl:0,proceeds:0,exitPolicy,market:market(NOW+2000)};
  session.positions.push(p);session.cash=exact(session.cash-25);
  session.ledger.push({id:'new-held-buy',positionId:p.id,time:NOW+2000,slug:SLUG,side:'YES',action:'BUY',source:'AUTOMATIC',reason:'Synthetic new purchase',cashDelta:-25,realizedPnl:0});
}
function input(time:number):TennisInput {
  return {receivedAt:time,source:'REST',sourceTime:time,market:market(time),book:{state:'MARKET_STATE_OPEN',time:new Date(time).toISOString(),
    bids:[{price:.1,quantity:1000}],asks:[{price:.11,quantity:1000}]}};
}
test('maker and hold-to-settlement positions still close at the acknowledged account loss limit',()=>{
  for(const exitPolicy of ['maker','hold-to-settlement'] as const){
    let session=acknowledge(stopped());addOpen(session,exitPolicy);
    session=stepTennisSession(session,[input(NOW+3000)],NOW+3000);
    assert.equal(session.status,'stopping',exitPolicy);
    session=stepTennisSession(session,[input(NOW+5000)],NOW+5000);
    assert.equal(session.status,'stopped',exitPolicy);assert.equal(session.positions.filter(position=>position.status==='open').length,0);
    assert.ok(session.cash<=59.94);assert.ok(session.ledger.some(entry=>entry.action==='SELL'&&entry.positionId==='new-held'));
  }
});

test('six-place checkpoint subtraction stops exactly at a new twenty-dollar loss, including daily risk',()=>{
  let session=acknowledge(stopped(-20.000001));closedLoss(session,-20,NOW+2000);
  assert.equal(sessionRisk(session,NOW+2000).sessionPnl,-20);assert.equal(sessionRisk(session,NOW+2000).dayPnl,-20);
  assert.equal(lossLimitReached(session),true);
  session=stepTennisSession(session,[],NOW+3000);assert.equal(session.status,'stopped','flat maker account reaches the exact boundary');
  assert.equal(canAcknowledgeLoss(session),true);
  for(const exitPolicy of ['maker','hold-to-settlement'] as const){
    const held=acknowledge(stopped(-20.000001));held.config.entries='steady';addOpen(held,exitPolicy);
    const position=held.positions.at(-1)!;
    // A partial sale loses exactly $20; the remaining shares have a gain, so the
    // realised-loss branch must trigger even though marked equity is above the floor.
    position.quantity=10;position.costBasis=5;position.realizedPnl=-20;
    held.ledger.push({id:'boundary-partial-sale',positionId:position.id,time:NOW+2500,slug:SLUG,side:'YES',action:'SELL',source:'AUTOMATIC',
      reason:'Synthetic partial loss',cashDelta:0,realizedPnl:-20});
    const fresh=input(NOW+3000);fresh.book.bids[0].price=.7;fresh.book.asks[0].price=.71;
    fresh.market={...fresh.market,bid:.7,ask:.71,price:.705};
    const stoppedHeld=stepTennisSession(held,[fresh],NOW+3000);
    assert.equal(stoppedHeld.status,'stopping',`${exitPolicy} stops on the exact realised-loss boundary`);
  }
});

test('acknowledged allowance and floor use stored money precision for non-round balances and fractions',()=>{
  for(const {startingCash,fraction,firstLoss,allowance} of [
    {startingCash:100,fraction:.07,firstLoss:7.06,allowance:7},
    {startingCash:143.33,fraction:.1,firstLoss:14.334,allowance:14.333},
  ]){
    let session=acknowledge(stopped(-firstLoss,startingCash,fraction));
    assert.equal(lossAllowance(session),allowance);assert.equal(lossFloor(session),exact(session.cash-allowance));
    closedLoss(session,-allowance,NOW+2000);
    assert.equal(sessionRisk(session,NOW+2000).sessionPnl,-allowance);assert.equal(sessionRisk(session,NOW+2000).dayPnl,-allowance);
    assert.equal(lossLimitReached(session),true,'an exact stored-dollar loss reaches the allowance');
    session=stepTennisSession(session,[],NOW+3000);assert.equal(session.status,'stopped');assert.equal(canAcknowledgeLoss(session),true);
  }
});
