import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import {makerRebate} from '../lib/tennis/maker.ts';
import type {TennisInput,TennisLeague,TennisSession} from '../lib/tennis/types';

const START=Date.parse('2026-10-03T19:00:00Z'),SLUG='aec-cfb-home-away-2026-10-03';
type Book={bid:number;ask:number};
type Drive={down:number;yard:number};
function input(time:number,book:Book,over:{live?:boolean;league?:TennisLeague;settlement?:number;ended?:boolean;drive?:Drive}={}):TennisInput{
  const league=over.league??'CFB';
  const football=over.live&&over.drive?{possessionTeam:'Home',possessionTeamId:'1',down:over.drive.down,yardsToGo:10,fieldPosition:{team:'Home',teamId:'1',yard:over.drive.yard},timeouts:[]}:null;
  return {receivedAt:time,source:'REST',sourceTime:time,
    book:{bids:[{price:book.bid,quantity:1000}],asks:[{price:book.ask,quantity:1000}],state:over.ended?'MARKET_STATE_EXPIRED':'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    market:{slug:SLUG,eventId:'4242',eventSlug:'cfb-home-away-2026-10-03',title:'Home vs Away',league,yesName:'Home',noName:'Away',startTime:new Date(START).toISOString(),
      live:over.live??false,ended:over.ended??false,active:!over.ended,score:over.live?'7-7':null,period:over.live?'Q2':null,clock:over.live?'10:00':null,tournament:null,
      football,footballIdentity:{yesTeamId:'1',noTeamId:'2'},
      bid:book.bid,ask:book.ask,price:(book.bid+book.ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
      execution:{slug:SLUG,league,active:!over.ended,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.005,feeCoefficient:.0695}},
    ...(over.settlement!==undefined?{settlement:over.settlement,settlementReceivedAt:time}:{})};
}
function started(league:TennisLeague='CFB',entries?:'steady'|'all'):TennisSession{
  let session=createTennisSession({...defaultLiveTennisConfig(100),leagues:[league],focusSlug:SLUG,...(entries?{entries}:{})},START-7_200_000);
  session.id='synthetic-maker';
  session=applyTennisAction(session,{action:'start',commandId:'maker-start'},[],START-7_200_000);
  return session;
}
const step=(session:TennisSession,time:number,book:Book,over={}):TennisSession=>stepTennisSession(session,[input(time,book,over)],time);
const T0=START-60*60_000;
/** The runner's own reconciliation rules (services/runner/src/store.ts). */
function assertReconciles(session:TennisSession){
  const cash=session.ledger.reduce((sum,entry)=>sum+entry.cashDelta,session.config.startingCash);
  assert.ok(Math.abs(cash-session.cash)<1e-6,`cash ${session.cash} vs ledger ${cash}`);
  assert.ok(session.cash>=0);
  assert.equal(new Set(session.ledger.map(entry=>entry.id)).size,session.ledger.length,'unique ledger ids');
  for(const entry of session.ledger)assert.ok(session.positions.some(position=>position.id===entry.positionId),'every ledger row has a position');
  for(const position of session.positions.filter(p=>p.status!=='open')){
    const rows=session.ledger.filter(entry=>entry.positionId===position.id),buys=rows.filter(entry=>entry.action==='BUY'),exits=rows.filter(entry=>entry.action!=='BUY');
    assert.ok(Math.abs(rows.reduce((sum,entry)=>sum+entry.cashDelta,0)-position.realizedPnl)<1e-6,'realized = ledger cash');
    assert.ok(Math.abs(-buys.reduce((sum,entry)=>sum+entry.cashDelta,0)-position.entryCost)<1e-6,'entry cost = buys');
    assert.ok(Math.abs(exits.reduce((sum,entry)=>sum+entry.cashDelta,0)-position.proceeds)<1e-6,'proceeds = exits');
    assert.equal(position.quantity,0);assert.equal(position.costBasis,0);
  }
}

test('pregame CFB: two-sided quotes rest at the best bids and fill only when sellers reach them',()=>{
  let session=step(started(),T0,{bid:.60,ask:.61});
  const quotes=session.maker!.quotes;
  assert.deepEqual({yes:quotes.YES?.price,yesQty:quotes.YES?.quantity,no:quotes.NO?.price,noQty:quotes.NO?.quantity},{yes:.6,yesQty:8,no:.39,noQty:12});
  assert.equal(session.pending,null);assert.equal(session.ledger.length,0);
  // Same prices: no fill, quotes unchanged (they keep their place and activation time).
  const placed=quotes.YES!.placedAt;
  session=step(session,T0+2500,{bid:.60,ask:.61});
  assert.equal(session.ledger.length,0);assert.equal(session.maker!.quotes.YES!.placedAt,placed);
  // Sellers come down to our 60¢ bid: the YES quote fills, with the maker rebate.
  const fill=T0+5000;
  session=step(session,fill,{bid:.59,ask:.60});
  const entry=session.ledger.at(-1)!,position=session.positions.find(p=>p.exitPolicy==='maker'&&p.side==='YES')!;
  assert.equal(entry.action,'BUY');assert.equal(entry.side,'YES');assert.equal(entry.execution!.filledQty,8);
  assert.equal(entry.cashDelta,Math.round((makerRebate(.6,8)-8*.6)*1e6)/1e6);
  assert.equal(position.quantity,8);assert.equal(position.status,'open');assert.equal(session.maker!.fills,1);
  // Only YES filled: no more YES is bought, and the NO offer is set to complete the pair for 8 shares. The pair pays
  // $1, so NO may cost at most 1 − 59.98¢ (paid, after the rebate) − 0.5¢ = 39.5¢, below the 40¢ NO bid here.
  assert.equal(session.maker!.quotes.YES,undefined);
  assert.deepEqual({price:session.maker!.quotes.NO?.price,quantity:session.maker!.quotes.NO?.quantity},{price:.395,quantity:8});
  assert.equal(session.positions.filter(p=>p.exitPolicy==='maker').length,1);
  assertReconciles(session);
});

test('a quote cannot fill before it is live, and the NO side fills when buyers reach it',()=>{
  let session=step(started(),T0,{bid:.60,ask:.61});
  // 0.5 s later the ask touches our bid, but the quote only goes live after the 1 s execution delay.
  session=step(session,T0+500,{bid:.59,ask:.60});
  assert.equal(session.ledger.length,0);
  // YES buyers rise to 61¢ = 1 − our 39¢ NO bid: the NO quote fills.
  let later=step(started(),T0,{bid:.60,ask:.61});
  later=step(later,T0+2000,{bid:.61,ask:.62});
  const entry=later.ledger.at(-1)!;
  assert.equal(entry.side,'NO');assert.equal(entry.actualPrice,.39);assert.equal(entry.execution!.filledQty,12);
  assertReconciles(later);
});

test('inventory cap, settlement payout and reconciliation',()=>{
  let session=step(started(),T0,{bid:.60,ask:.61});
  let time=T0;
  // Sellers keep hitting the YES bid; inventory stops growing at twice the quote stake.
  for(let i=0;i<5;i++){time+=2500;session=step(session,time,{bid:.60-.01*(i+1),ask:.60-.01*i});}
  const yes=session.positions.find(p=>p.exitPolicy==='maker'&&p.side==='YES')!;
  assert.ok(yes.costBasis<=10+1e-6+5,`inventory cost ${yes.costBasis}`);
  assert.equal(session.maker!.quotes.YES,undefined,'no more YES bids at the cap');
  assert.ok(session.maker!.quotes.NO,'the side that reduces risk keeps quoting');
  // YES wins: maker inventory settles at $1.
  const final=START+4*3_600_000;
  session=stepTennisSession(session,[input(final,{bid:.99,ask:.995},{ended:true,settlement:1})],final);
  const settled=session.positions.find(p=>p.id===yes.id)!;
  assert.equal(settled.status,'settled');assert.ok(settled.realizedPnl>0);
  assertReconciles(session);
});

test('Stop sells inventory at the bid; Pause cancels quotes but keeps inventory',()=>{
  let session=step(started(),T0,{bid:.60,ask:.61});
  session=step(session,T0+2500,{bid:.59,ask:.60});
  assert.equal(session.positions.filter(p=>p.status==='open').length,1);
  const paused=applyTennisAction(session,{action:'pause',commandId:'maker-pause'},[],T0+3000);
  assert.deepEqual(paused.maker!.quotes,{});assert.equal(paused.positions.filter(p=>p.status==='open').length,1);
  session=applyTennisAction(session,{action:'stop',commandId:'maker-stop'},[input(T0+5000,{bid:.58,ask:.59})],T0+5000);
  assert.deepEqual(session.maker!.quotes,{});
  assert.equal(session.positions.filter(p=>p.status==='open').length,0);
  assert.equal(session.ledger.at(-1)!.action,'SELL');
  session=step(session,T0+7500,{bid:.58,ask:.59});
  assert.equal(session.status,'stopped');
  assertReconciles(session);
});

test('no quotes where the evidence says stay out, or where no study exists',()=>{
  const nfl=step(started('NFL'),T0,{bid:.60,ask:.61},{league:'NFL'});
  assert.ok(!nfl.maker?.quotes.YES&&!nfl.maker?.quotes.NO);
  assert.match(nfl.maker!.reason,/NFL pregame resting orders/);
  const atp=step(started('ATP'),T0,{bid:.60,ask:.61},{league:'ATP'});
  assert.ok(!atp.maker?.quotes.YES&&!atp.maker?.quotes.NO);
  // A 6¢ book is a placeholder, not a market to make.
  const wide=step(started(),T0,{bid:.58,ask:.64});
  assert.ok(!wide.maker?.quotes.YES&&!wide.maker?.quotes.NO);
});

test('live CFB: quotes pull for 30 s after each play, then return',()=>{
  const live=START+20*60_000;
  let session=step(started(),live,{bid:.60,ask:.61},{live:true,drive:{down:1,yard:25}});
  assert.ok(session.maker!.quotes.YES,session.maker!.reason);
  session=step(session,live+5000,{bid:.60,ask:.61},{live:true,drive:{down:2,yard:30}});
  assert.ok(!session.maker!.quotes.YES&&!session.maker!.quotes.NO);assert.match(session.maker!.reason,/^Pulled for 30s after a play/);
  session=step(session,live+20_000,{bid:.60,ask:.61},{live:true,drive:{down:2,yard:30}});
  assert.ok(!session.maker!.quotes.YES);
  session=step(session,live+36_000,{bid:.60,ask:.61},{live:true,drive:{down:2,yard:30}});
  assert.ok(session.maker!.quotes.YES,'quotes return once the pull window passes');
});

test('market making replays exactly',()=>{
  const run=()=>{
    let session=step(started(),T0,{bid:.60,ask:.61});
    session=step(session,T0+2500,{bid:.59,ask:.60});
    session=step(session,T0+5000,{bid:.61,ask:.62});
    return session;
  };
  assert.equal(JSON.stringify(run()),JSON.stringify(run()));
});

test('one-sided fill: the pair completes when the other side fills, and both are kept to the final',()=>{
  let session=step(started(),T0,{bid:.60,ask:.61});
  session=step(session,T0+5000,{bid:.59,ask:.60});            // YES fills 8 at 60¢
  session=step(session,T0+7000,{bid:.60,ask:.61});            // NO pairing offer at 39.5¢ goes live
  session=step(session,T0+9000,{bid:.605,ask:.615});          // YES buyers reach 60.5¢ = 1 − 39.5¢: NO fills
  const yes=session.positions.find(p=>p.exitPolicy==='maker'&&p.side==='YES')!,no=session.positions.find(p=>p.exitPolicy==='maker'&&p.side==='NO')!;
  assert.equal(no.quantity,8);assert.equal(yes.quantity,8);
  assert.ok(yes.costBasis+no.costBasis<8,'the pair cost less than the $8 it pays at the end');
  // Paired: ten minutes later nothing is sold.
  session=step(session,T0+5000+11*60_000,{bid:.60,ask:.61});
  assert.equal(session.ledger.filter(e=>e.action==='SELL').length,0);
  assertReconciles(session);
});

test('Steady, one-sided fill: with no pair within 10 minutes the unpaired shares are sold at the best bid',()=>{
  let session=step(started('CFB','steady'),T0,{bid:.60,ask:.61});
  session=step(session,T0+5000,{bid:.59,ask:.60});            // YES fills 8 at 60¢
  session=step(session,T0+5000+9*60_000,{bid:.59,ask:.60});   // 9 minutes: still held
  assert.equal(session.ledger.filter(e=>e.action==='SELL').length,0);
  session=step(session,T0+5000+10*60_000+1000,{bid:.58,ask:.59});
  const sale=session.ledger.find(e=>e.action==='SELL')!;
  assert.ok(sale,'sold after 10 minutes');assert.equal(sale.side,'YES');assert.equal(sale.execution!.filledQty,8);
  assert.match(sale.reason,/unpaired/);
  assert.equal(session.positions.filter(p=>p.status==='open').length,0);
  assertReconciles(session);
});

test('Bold, one-sided fill: keeps the shares, buys once more on a 5-cent dip (capped), never sells at 10 minutes',()=>{
  let session=step(started('CFB','all'),T0,{bid:.60,ask:.61});
  session=step(session,T0+5000,{bid:.59,ask:.60});            // YES fills 8 at 60¢
  const yes=()=>session.positions.find(p=>p.exitPolicy==='maker'&&p.side==='YES')!;
  session=step(session,T0+60_000,{bid:.56,ask:.57});          // 3¢ lower: not a dip yet
  assert.equal(yes().dipBuys??0,0);
  session=step(session,T0+120_000,{bid:.54,ask:.55});         // 5¢ lower: buy once more
  const dip=session.ledger.find(e=>e.id.includes(':dip:'))!;
  assert.ok(dip,'dip buy recorded');assert.equal(dip.action,'BUY');assert.match(dip.reason,/Bold dip buy/);
  assert.ok(yes().quantity>8&&yes().entryPrice<.6,'more shares at a lower average');
  assert.ok(yes().costBasis<=2*session.config.entryBudget+1e-6,'capped at twice the order size');
  session=step(session,T0+180_000,{bid:.50,ask:.51});         // lower again (within the loss limit): no second buy
  assert.equal(session.ledger.filter(e=>e.id.includes(':dip:')).length,1);
  session=step(session,T0+5000+15*60_000,{bid:.50,ask:.51});  // past 10 minutes: still held
  assert.equal(session.ledger.filter(e=>e.action==='SELL').length,0);assert.equal(yes().status,'open');
  assertReconciles(session);
});

test('Bold loss limit: after a dip buy, the unpaired shares are sold once the bid is 10 cents under their average',()=>{
  let session=step(started('CFB','all'),T0,{bid:.60,ask:.61});
  session=step(session,T0+5000,{bid:.59,ask:.60});            // YES fills 8 at 60¢
  session=step(session,T0+120_000,{bid:.54,ask:.55});         // dip buy at 55¢
  const yes=()=>session.positions.find(p=>p.exitPolicy==='maker'&&p.side==='YES')!;
  const average=yes().entryPrice;assert.ok(average<.6&&average>.55);
  session=step(session,T0+180_000,{bid:Math.round((average-.08)*200)/200,ask:Math.round((average-.07)*200)/200});
  assert.equal(session.ledger.filter(e=>e.action==='SELL').length,0,'8 cents down: still held');
  session=step(session,T0+240_000,{bid:Math.floor((average-.10)*200)/200,ask:Math.floor((average-.09)*200)/200});
  const sale=session.ledger.find(e=>e.action==='SELL')!;
  assert.ok(sale,'sold at the loss limit');assert.match(sale.reason,/Bold loss limit/);assert.equal(yes().status,'closed');
  assert.ok(sale.realizedPnl<0);
  assertReconciles(session);
});

test('Bold with a single buy has no loss limit yet (it may still buy the dip first)',()=>{
  let session=step(started('CFB','all'),T0,{bid:.60,ask:.61});
  session=step(session,T0+5000,{bid:.59,ask:.60});
  session=step(session,T0+120_000,{bid:.62,ask:.63});         // rises: no dip buy
  session=step(session,T0+180_000,{bid:.62,ask:.63});
  assert.equal(session.ledger.filter(e=>e.action==='SELL').length,0);
  assertReconciles(session);
});

test('halftime: resting offers stay up while the report says halftime, for at most 20 minutes',()=>{
  const ht=(time:number,reportAt:number,book:Book)=>{const value=input(time,book,{live:true});
    value.market={...value.market,period:'HT',clock:null,football:null,contextUpdatedAt:reportAt};return value;};
  let session=started('CFB','steady');
  const reportAt=START+90*60_000;
  session=stepTennisSession(session,[ht(reportAt+60_000,reportAt,{bid:.60,ask:.61})],reportAt+60_000);
  session=stepTennisSession(session,[ht(reportAt+120_000,reportAt,{bid:.60,ask:.61})],reportAt+120_000);
  assert.ok(session.maker?.quotes.YES||session.maker?.quotes.NO,`offers rest at halftime: ${session.lastReason}`);
  session=stepTennisSession(session,[ht(reportAt+21*60_000,reportAt,{bid:.60,ask:.61})],reportAt+21*60_000);
  assert.ok(!session.maker?.quotes.YES&&!session.maker?.quotes.NO,'pulled once the halftime report is over 20 minutes old');
});

test('"Sell everything now": pauses entries, pulls offers, and sells held shares on the next fresh book',()=>{
  let session=step(started('CFB','all'),T0,{bid:.60,ask:.61});
  session=step(session,T0+5000,{bid:.59,ask:.60});            // YES fills 8 at 60¢
  assert.equal(session.positions.filter(p=>p.status==='open').length,1);
  session=applyTennisAction(session,{action:'exit-now',commandId:'sell-all'},[],T0+6000);
  assert.equal(session.status,'paused');assert.ok(session.exitAll);
  assert.ok(!session.maker?.quotes.YES&&!session.maker?.quotes.NO,'offers pulled');
  session=step(session,T0+8000,{bid:.62,ask:.63});
  const sale=session.ledger.find(e=>e.action==='SELL')!;
  assert.ok(sale,'sold on the next book');assert.match(sale.reason,/Sell everything now/);assert.ok(sale.realizedPnl>0);
  assert.equal(session.positions.filter(p=>p.status==='open').length,0);
  assert.equal(session.exitAll,undefined);assert.equal(session.status,'paused');
  // Nothing held: refused, nothing changes.
  const again=applyTennisAction(session,{action:'exit-now',commandId:'sell-all-2'},[],T0+9000);
  assert.match(again.lastReason,/nothing to sell/i);
  assertReconciles(session);
});
