import test from 'node:test';
import assert from 'node:assert/strict';
import {accountBotIds,accountBotView,accountCommitments,applyAccountAction,stepAccountSession} from '../lib/tennis/account.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,defaultTennisConfig} from '../lib/tennis/rules.ts';
import {lossAllowance,lossFloor} from '../lib/tennis/loss-limit.ts';
import {walletProjection} from '../lib/tennis/wallet-risk.ts';
import type {BotId,TennisInput,TennisPosition,TennisSession} from '../lib/tennis/types';
import {setPaperAccountLimits} from '../lib/tennis/account-limits.ts';
// These tests check the account limits themselves, which are off for paper accounts by default (lib/tennis/account-limits.ts).
setPaperAccountLimits(true);

const NOW=Date.parse('2026-10-03T20:00:00Z'),SLUG='synthetic-tennis-wallet';
const exact=(value:number)=>Math.round(value*1e6)/1e6;
function input(time:number,bid=.64,ask=.65,league:'ATP'|'CFB'='ATP'):TennisInput {
  const slug=league==='ATP'?SLUG:'synthetic-football-wallet';
  return {receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:1000}],asks:[{price:ask,quantity:1000}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{
    slug,eventId:slug,eventSlug:slug,title:'Synthetic A vs B',league,yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,
    score:'6-4, 2-2',period:'Set 2',tournament:'Synthetic',bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
    execution:{slug,league,active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695}}};
}
function base():TennisSession {
  const account=createTennisSession({...defaultLiveTennisConfig(100),leagues:['CFB'],focusSlug:'synthetic-football-wallet'},NOW-120000);account.id='synthetic-shared-wallet';return account;
}
function both():TennisSession {
  const football=applyAccountAction(base(),{action:'start',botId:'football',commandId:'start-football'},[],NOW-90000);
  return applyAccountAction(football,{action:'start',botId:'tennis',commandId:'start-tennis',config:{focusSlug:SLUG}},[],NOW-60000);
}
function closedPnl(account:TennisSession,botId:BotId,pnl:number){
  const market=input(NOW-1000,.49,.5,botId==='tennis'?'ATP':'CFB').market,id=botId+'-closed-'+account.positions.length,entryCost=25,proceeds=exact(entryCost+pnl);
  account.positions.push({id,botId,slug:market.slug,league:market.league,title:market.title,side:'YES',name:market.yesName,quantity:0,initialQuantity:50,costBasis:0,entryCost,entryPrice:.5,entryFees:0,openedAt:NOW-2000,status:'closed',closedAt:NOW-1000,
    realizedPnl:pnl,exitFees:0,proceeds,netLiquidationValue:null,liquidationQuantity:0,markedAt:null,market});
  account.ledger.push({id:id+'-buy',botId,positionId:id,time:NOW-2000,slug:market.slug,side:'YES',action:'BUY',source:'AUTOMATIC',reason:'Synthetic buy',cashDelta:-entryCost,realizedPnl:0},
    {id:id+'-sell',botId,positionId:id,time:NOW-1000,slug:market.slug,side:'YES',action:'SELL',source:'AUTOMATIC',reason:'Synthetic sale',cashDelta:proceeds,realizedPnl:pnl});
  account.cash=exact(account.cash+pnl);
}
function openPosition(botId:BotId,costBasis:number,time=NOW-1000):TennisPosition {
  const market=input(time,.49,.5,botId==='tennis'?'ATP':'CFB').market;
  return {id:botId+'-open',botId,slug:market.slug,league:market.league,title:market.title,side:'YES',name:market.yesName,quantity:costBasis*2,initialQuantity:costBasis*2,costBasis,entryCost:costBasis,entryPrice:.5,entryFees:0,openedAt:time,status:'open',
    realizedPnl:0,exitFees:0,proceeds:0,netLiquidationValue:costBasis,liquidationQuantity:costBasis*2,markedAt:time,market,exitPolicy:'hold-to-settlement'};
}
function queued():TennisSession {
  let account=both();
  for(let i=0;i<12;i++){const t=NOW-60000+i*4000;account=stepAccountSession(account,[input(t,.59,.60)],t);}
  for(const [i,[bid,ask]] of [[.60,.61],[.64,.65],[.64,.65]].entries()){const t=NOW-12000+i*5000;account=stepAccountSession(account,[input(t,bid,ask)],t);}
  assert.equal(account.bots?.tennis?.pending?.action,'BUY',accountBotView(account,'tennis').lastReason);return account;
}
function reconciles(account:TennisSession){assert.equal(exact(account.config.startingCash+account.ledger.reduce((sum,row)=>sum+row.cashDelta,0)),account.cash);assert.equal(new Set(account.ledger.map(row=>row.id)).size,account.ledger.length);}

test('legacy account wrappers retain byte-identical reducer results until explicit bot upgrade',()=>{
  const old=base(),action={action:'start' as const,commandId:'legacy-start'};
  assert.equal(JSON.stringify(applyAccountAction(old,action,[],NOW)),JSON.stringify(applyTennisAction(old,action,[],NOW)));
  assert.equal(JSON.stringify(stepAccountSession(old,[],NOW)),JSON.stringify(stepTennisSession(old,[],NOW)));
  assert.equal(old.bots,undefined);
});

test('opening Tennis is read-only and starting or restarting it retains shared cash and account history',()=>{
  const old=base();old.status='stopped';closedPnl(old,'football',5);old.histories['football-history']=[{time:NOW-1000,price:.5}];
  const before=structuredClone(old),idle=accountBotView(old,'tennis');assert.equal(idle.status,'idle');assert.equal(idle.cash,105);assert.deepEqual(old,before);assert.deepEqual(accountBotIds(old),['football']);
  const started=applyAccountAction(old,{action:'start',botId:'tennis',commandId:'new-tennis'},[],NOW);
  assert.equal(started.id,old.id);assert.equal(started.cash,105);assert.deepEqual(started.positions,old.positions);assert.deepEqual(started.ledger,old.ledger);assert.deepEqual(started.histories,old.histories);
  assert.equal(started.status,'stopped');assert.equal(started.bots?.tennis?.status,'running');assert.deepEqual(accountBotIds(started),['football','tennis']);reconciles(started);
  const stopped=applyAccountAction(started,{action:'stop',botId:'tennis',commandId:'stop-tennis'},[],NOW+1);
  const resumed=applyAccountAction(stopped,{action:'start',botId:'tennis',commandId:'restart-tennis'},[],NOW+2);
  assert.equal(resumed.bots?.tennis?.status,'running');assert.equal(resumed.cash,105);assert.deepEqual(resumed.ledger,old.ledger);assert.equal(resumed.positions.length,1);
  assert.equal(walletProjection(resumed),undefined);assert.equal(walletProjection(accountBotView(resumed,'tennis')),undefined);
});

test('selected rules and pause controls leave the other bot independent and reject duplicate or wrong-session commands',()=>{
  const old=both(),other=structuredClone(old.config),paused=applyAccountAction(old,{action:'pause',botId:'tennis',commandId:'pause-tennis'},[],NOW);
  assert.equal(paused.status,'running');assert.equal(paused.bots?.tennis?.status,'paused');assert.deepEqual(paused.config,other);
  const rules={action:'update-rules' as const,botId:'tennis' as const,sessionId:paused.id,expectedRulesRevision:0,commandId:'tennis-rules',rules:{targetReturn:.04}};
  const changed=applyAccountAction(paused,rules,[],NOW+1);assert.equal(changed.bots?.tennis?.config.targetReturn,.04);assert.equal(changed.config.targetReturn,other.targetReturn);
  assert.equal(applyAccountAction(changed,rules,[],NOW+2),changed);assert.equal(applyAccountAction(changed,{...rules,commandId:'wrong',sessionId:'other-account'},[],NOW+2),changed);
  assert.equal(changed.cash,100);
});

test('stopping Football preserves Tennis delayed entry, fill evidence and tagged position while spending the wallet once',()=>{
  const ready=queued(),pending=structuredClone(ready.bots!.tennis!.pending),stopped=applyAccountAction(ready,{action:'stop',botId:'football',commandId:'stop-football'},[],NOW-1000);
  assert.equal(stopped.status,'stopped');assert.equal(stopped.bots?.tennis?.status,'running');assert.deepEqual(stopped.bots?.tennis?.pending,pending);
  const filled=stepAccountSession(stopped,[input(NOW)],NOW);assert.equal(filled.status,'stopped');assert.equal(filled.positions.length,1);assert.equal(filled.positions[0].botId,'tennis');assert.equal(filled.ledger[0].botId,'tennis');assert.ok(filled.cash<100);
  assert.equal(accountBotView(filled,'football').positions.length,0);assert.equal(accountBotView(filled,'tennis').positions.length,1);reconciles(filled);
  const replay=stepAccountSession(filled,[input(NOW)],NOW+1);assert.equal(replay.cash,filled.cash);assert.equal(replay.ledger.length,1);
  const control=applyAccountAction(filled,{action:'pause',botId:'football',commandId:'foot-paused'},[],NOW+2);assert.equal(control.bots?.tennis?.status,'running');assert.deepEqual(control.positions,filled.positions);
});

test('all open cost, other-bot pending budgets and resting buys count toward the shared fifty-percent cap',()=>{
  const account=both();account.positions=[openPosition('football',20)];account.cash=80;
  const market=input(NOW).market;account.bots!.tennis!.pending={id:'pending-tennis',market,slug:market.slug,side:'YES',action:'BUY',budget:15,limitPrice:.65,createdAt:NOW,executeAfter:NOW+1000,observedAt:NOW,source:'AUTOMATIC',reason:'Synthetic delayed entry'};
  account.maker={slug:'synthetic-football-wallet',quotes:{YES:{price:.5,quantity:20,placedAt:NOW-1000,placedBookTime:NOW-1000,activeAfter:NOW}},pulledUntil:0,eventKey:null,lastBookTime:NOW-1000,reason:'Synthetic resting buy',fills:0,rebates:0};
  assert.deepEqual(accountCommitments(account),{open:20,pending:15,resting:10,total:45,cap:50,available:5});
  const ready=queued();ready.positions=[openPosition('football',46)];ready.cash=54;
  const blocked=stepAccountSession(ready,[input(NOW)],NOW);assert.equal(blocked.cash,54);assert.equal(blocked.ledger.length,0);assert.equal(blocked.positions.filter(p=>p.botId==='tennis').length,0);assert.equal(blocked.bots?.tennis?.pending,null);
  assert.ok(blocked.decisions.some(row=>row.botId==='tennis'&&row.action==='SKIP'));
});

test('combined bot losses stop both, acknowledgement preserves history and original allowance, and only the addressed bot resumes',()=>{
  const old=both();closedPnl(old,'football',-10);closedPnl(old,'tennis',-10.06);
  const stopped=stepAccountSession(old,[],NOW);assert.equal(stopped.status,'stopped');assert.equal(stopped.bots?.tennis?.status,'stopped');assert.deepEqual(stopped.accountLossStops,['football','tennis']);
  const action={action:'acknowledge-loss' as const,botId:'tennis' as const,sessionId:stopped.id,commandId:'ack-global',expectedLossAcknowledgement:null};
  const acknowledged=applyAccountAction(stopped,action,[],NOW+1);assert.equal(acknowledged.id,old.id);assert.equal(acknowledged.cash,79.94);assert.equal(acknowledged.status,'paused');assert.equal(acknowledged.bots?.tennis?.status,'running');
  assert.deepEqual(acknowledged.positions,stopped.positions);assert.deepEqual(acknowledged.ledger,stopped.ledger);assert.equal(acknowledged.lossCheckpoint?.realizedPnl,-20.06);assert.equal(lossAllowance(acknowledged),20);assert.equal(lossFloor(acknowledged),59.94);reconciles(acknowledged);
  assert.equal(applyAccountAction(acknowledged,action,[],NOW+2),acknowledged);
  const resumed=applyAccountAction(acknowledged,{action:'resume',botId:'football',commandId:'resume-football'},[],NOW+2);assert.equal(resumed.status,'running');assert.equal(resumed.bots?.tennis?.status,'running');
  closedPnl(resumed,'football',-20);const later=stepAccountSession(resumed,[],NOW+3);assert.equal(later.status,'stopped');assert.equal(later.bots?.tennis?.status,'stopped');
  assert.equal(applyAccountAction(later,{...action,commandId:'delayed-old'},[],NOW+4),later);
});

test('shared loss cannot be bypassed by Start or acknowledged while another bot has a pending exit',()=>{
  const old=base();old.status='stopped';closedPnl(old,'football',-20.06);
  const blocked=applyAccountAction(old,{action:'start',botId:'tennis',commandId:'bypass'},[],NOW);assert.equal(blocked.cash,79.94);assert.equal(blocked.bots?.tennis?.status,'idle');assert.equal(blocked.lossCheckpoint,undefined);
  const bothStopped=both();closedPnl(bothStopped,'football',-20.06);const stopped=stepAccountSession(bothStopped,[],NOW);
  const market=input(NOW).market;stopped.bots!.tennis!.pending={id:'exit',market,slug:market.slug,side:'YES',action:'SELL',positionId:'already-closing',limitPrice:.64,createdAt:NOW,executeAfter:NOW+1000,observedAt:NOW,source:'AUTOMATIC',reason:'Synthetic exit'};
  const refused=applyAccountAction(stopped,{action:'acknowledge-loss',botId:'football',sessionId:stopped.id,commandId:'too-early',expectedLossAcknowledgement:null},[],NOW+1);
  assert.equal(refused.lossCheckpoint,undefined);assert.equal(refused.status,'stopped');assert.equal(refused.cash,79.94);assert.deepEqual(refused.bots?.tennis?.pending,stopped.bots?.tennis?.pending);
});

test('Sell everything pauses both bots and Reset checks the entire wallet before abandoning fake trades explicitly',()=>{
  const account=both();account.positions=[openPosition('football',10),openPosition('tennis',10)];account.cash=80;
  const exited=applyAccountAction(account,{action:'exit-now',botId:'tennis',commandId:'exit-both'},[],NOW);
  assert.equal(exited.status,'paused');assert.equal(exited.bots?.tennis?.status,'paused');assert.equal(exited.exitAll,NOW);assert.equal(exited.bots?.tennis?.exitAll,NOW);
  const refused=applyAccountAction(account,{action:'reset',botId:'tennis',bankroll:50,commandId:'unsafe-reset'},[],NOW);assert.equal(refused.id,account.id);assert.equal(refused.cash,80);assert.equal(refused.positions.length,2);
  const reset=applyAccountAction(account,{action:'reset',botId:'tennis',bankroll:50,commandId:'reset-both',abandon:true},[],NOW);
  assert.equal(reset.cash,50);assert.equal(reset.config.startingCash,50);assert.equal(reset.positions.length,0);assert.equal(reset.ledger.length,0);assert.equal(reset.status,'idle');assert.equal(reset.bots?.tennis?.status,'idle');assert.equal(reset.bots?.tennis?.config.startingCash,50);
});

test('upgraded actions replay deterministically without storing transient wallet risk state',()=>{
  const old=base(),action={action:'start' as const,botId:'tennis' as const,commandId:'repeatable-start'};
  const a=applyAccountAction(old,action,[],NOW),b=applyAccountAction(old,action,[],NOW);assert.deepEqual(a,b);
  assert.equal(JSON.stringify(a).includes('otherPositions'),false);assert.equal(JSON.stringify(a).includes('otherResting'),false);assert.equal(walletProjection(a),undefined);
});

test('upgrading a legacy ATP holding retains its exit feed while a separate Tennis holding remains independent',()=>{
  const old=createTennisSession(defaultTennisConfig(100),NOW-90000);old.id='legacy-atp-wallet';old.status='running';old.cash=90;
  const legacy=openPosition('football',10),legacyInput=input(NOW,.49,.5);legacy.slug='legacy-atp';legacy.league='ATP';delete legacy.botId;delete legacy.exitPolicy;
  legacy.market={...legacyInput.market,slug:legacy.slug};legacyInput.market=legacy.market;legacyInput.market.execution={...legacyInput.market.execution!,slug:legacy.slug};
  old.positions=[legacy];old.ledger=[{id:'old-atp-buy',time:NOW-1000,slug:legacy.slug,side:'YES',action:'BUY',source:'AUTOMATIC',positionId:legacy.id,reason:'Synthetic historical ATP holding',cashDelta:-10,realizedPnl:0}];
  let account=applyAccountAction(old,{action:'start',botId:'tennis',commandId:'upgrade-tennis',config:{focusSlug:SLUG}},[],NOW);
  const tennis=openPosition('tennis',5);account.positions.push(tennis);account.cash-=5;account.ledger.push({id:'new-tennis-buy',botId:'tennis',time:NOW,slug:tennis.slug,side:'YES',action:'BUY',source:'AUTOMATIC',positionId:tennis.id,reason:'Synthetic separate Tennis holding',cashDelta:-5,realizedPnl:0});
  legacyInput.receivedAt=NOW+1;legacyInput.sourceTime=NOW+1;legacyInput.market={...legacyInput.market,observedAt:NOW+1};
  account=applyAccountAction(account,{action:'stop',botId:'football',commandId:'exit-legacy'},[legacyInput],NOW+1);assert.equal(account.pending?.action,'SELL');
  const later={...legacyInput,receivedAt:NOW+2001,sourceTime:NOW+2001,market:{...legacyInput.market,observedAt:NOW+2001}};
  const closed=stepAccountSession(account,[later,input(NOW+2001,.49,.5)],NOW+2001);
  assert.equal(closed.positions.find(position=>position.id===legacy.id)?.status,'closed');assert.equal(closed.positions.find(position=>position.id===tennis.id)?.status,'open');
  assert.equal(closed.bots?.tennis?.status,'running');assert.ok(closed.ledger.some(row=>row.positionId===legacy.id&&row.action==='SELL'));reconciles(closed);
});

test('upgraded resting buys reject stale, ended, inactive and closed match snapshots before spending shared cash',()=>{
  for(const variant of ['stale','ended','inactive','closed','pregame'] as const){
    const account=both(),book=input(NOW,.49,.5,'CFB');
    account.maker={slug:book.market.slug,quotes:{YES:{price:.5,quantity:10,placedAt:NOW-2000,placedBookTime:NOW-2000,activeAfter:NOW-1000}},pulledUntil:0,eventKey:null,lastBookTime:NOW-2000,reason:'Synthetic resting buy',fills:0,rebates:0};
    if(variant==='stale')book.market.observedAt=NOW-45001;
    if(variant==='ended')book.market.ended=true;
    if(variant==='inactive')book.market.execution!.active=false;
    if(variant==='closed')book.book.state='MARKET_STATE_EXPIRED';
    if(variant==='pregame')book.market.live=false;
    const checked=stepAccountSession(account,[book],NOW);assert.equal(checked.cash,100,variant);assert.equal(checked.ledger.length,0,variant);assert.equal(checked.positions.length,0,variant);
  }
});

test('another bot’s pending stake and simultaneous resting offers cannot overspend the combined reservation cap',()=>{
  const account=both(),book=input(NOW,.49,.5,'CFB'),market=input(NOW).market;
  account.config.entryBudget=20;account.bots!.tennis!.config.entryBudget=20;
  account.bots!.tennis!.pending={id:'reserved-tennis',market,slug:market.slug,side:'YES',action:'BUY',budget:20,limitPrice:.65,createdAt:NOW,executeAfter:NOW+10000,observedAt:NOW,source:'AUTOMATIC',reason:'Synthetic delayed entry'};
  account.maker={slug:book.market.slug,quotes:{YES:{price:.5,quantity:32,placedAt:NOW-2000,placedBookTime:NOW-2000,activeAfter:NOW-1000},NO:{price:.5,quantity:32,placedAt:NOW-2000,placedBookTime:NOW-2000,activeAfter:NOW-1000}},pulledUntil:0,eventKey:null,lastBookTime:NOW-2000,reason:'Synthetic resting pair',fills:0,rebates:0};
  const checked=stepAccountSession(account,[book],NOW);assert.equal(checked.cash,100);assert.equal(checked.ledger.length,0);assert.ok(checked.decisions.some(row=>row.code==='WALLET_COMMITMENT'));
  assert.ok(accountCommitments(checked).total<=accountCommitments(checked).cap+1e-7);
});

test('an unfilled upgraded dip attempt keeps its one successful-buy allowance and a later fill is immediately revalued',()=>{
  const account=both(),book=input(NOW,.59,.60,'CFB'),position=openPosition('football',4.9);
  position.exitPolicy='maker';position.quantity=7;position.initialQuantity=7;position.entryPrice=.7;position.market=book.market;position.slug=book.market.slug;
  account.positions=[position];account.cash=95.1;account.ledger=[{id:'maker-initial',botId:'football',time:NOW-1000,slug:position.slug,side:'YES',action:'BUY',source:'AUTOMATIC',positionId:position.id,reason:'Synthetic initial maker buy',cashDelta:-4.9,realizedPnl:0}];
  account.maker={slug:book.market.slug,quotes:{},pulledUntil:0,eventKey:null,lastBookTime:NOW-2000,reason:'Synthetic unpaired maker inventory',fills:0,rebates:0};
  book.book.asks[0].quantity=.1;
  const unfilled=stepAccountSession(account,[book],NOW);assert.equal(unfilled.positions[0].dipBuys,undefined);assert.equal(unfilled.ledger.length,1);assert.ok(unfilled.decisions.some(row=>row.code==='DIP_BUY_UNFILLED'));
  const filled=stepAccountSession(unfilled,[input(NOW+1000,.59,.60,'CFB')],NOW+1000),held=filled.positions[0];
  assert.equal(held.dipBuys,1);assert.equal(filled.ledger.length,2);assert.equal(held.liquidationQuantity,held.quantity);assert.equal(held.markedAt,NOW+1000);assert.ok(held.netLiquidationValue!==null);reconciles(filled);
});

test('editable shared loss allowances stop at exact stored money even without complete marks or a first checkpoint',()=>{
  const account=both();account.config.maxSessionLossFraction=.07;account.bots!.tennis!.config.maxSessionLossFraction=.07;
  closedPnl(account,'football',-3);closedPnl(account,'tennis',-4);
  const position=openPosition('football',5);position.netLiquidationValue=null;position.liquidationQuantity=0;position.markedAt=null;account.positions.push(position);account.cash-=5;
  account.ledger.push({id:'still-open-buy',botId:'football',positionId:position.id,time:NOW-1000,slug:position.slug,side:'YES',action:'BUY',source:'AUTOMATIC',reason:'Synthetic unavailable mark',cashDelta:-5,realizedPnl:0});
  assert.equal(lossAllowance(account),7);const stopped=stepAccountSession(account,[],NOW);assert.equal(stopped.status,'stopping');assert.equal(stopped.bots?.tennis?.status,'stopped');assert.deepEqual(stopped.accountLossStops,['football','tennis']);reconciles(stopped);
});

test('ordinary stopped Start replaces an expired service window only after valid rules, and acknowledgement requires the exact account ID',()=>{
  const account=both();account.bots!.tennis!.status='stopped';account.bots!.tennis!.testRun={startedAt:NOW-120000,endsAt:NOW-60000,watchedMs:60000,lastCheckAt:NOW-60000,startingCash:100,startingLedgerCount:0,liveSlugs:[],complete:true};
  account.testRun=structuredClone(account.bots!.tennis!.testRun);
  const invalid=applyAccountAction(account,{action:'start',botId:'tennis',commandId:'invalid-restart',config:{entryBudget:100}},[],NOW);assert.equal(invalid.bots?.tennis?.status,'stopped');assert.deepEqual(invalid.bots?.tennis?.testRun,account.bots?.tennis?.testRun);
  const started=applyAccountAction(account,{action:'start',botId:'tennis',commandId:'valid-restart'},[],NOW);assert.equal(started.bots?.tennis?.status,'running');assert.equal(started.bots?.tennis?.testRun,undefined);assert.equal(started.cash,100);
  assert.equal(accountBotView(started,'tennis').testRun,undefined);assert.deepEqual(accountBotView(started,'football').testRun,account.testRun);
  closedPnl(account,'football',-20.06);const stopped=stepAccountSession(account,[],NOW);
  assert.equal(applyAccountAction(stopped,{action:'acknowledge-loss',botId:'football',sessionId:'',commandId:'empty-account',expectedLossAcknowledgement:null},[],NOW+1),stopped);
});

test('missing Tennis-local optional fields never inherit Football maker, quotes or exit state',()=>{
  const account=both();account.maker={slug:'synthetic-football-wallet',quotes:{YES:{price:.5,quantity:10,placedAt:NOW,placedBookTime:NOW,activeAfter:NOW+1000}},pulledUntil:0,eventKey:null,lastBookTime:NOW,reason:'Synthetic Football quote',fills:0,rebates:0};
  account.exitAll=NOW;account.exitRequested={positionId:'football-only',reason:'Synthetic exit',source:'MANUAL'};account.quotes={'synthetic-football-wallet':{time:NOW,bid:.5,ask:.51,source:'REST'}};
  const tennis=accountBotView(account,'tennis');assert.equal(tennis.maker,undefined);assert.equal(tennis.exitAll,undefined);assert.equal(tennis.exitRequested,undefined);assert.deepEqual(tennis.quotes,{});
  assert.equal(accountCommitments(account).resting,5);
});
