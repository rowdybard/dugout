import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisInput,TennisLeague,TennisSession} from '../lib/tennis/types';

const START=Date.parse('2026-10-03T19:00:00Z'),SLUG='aec-cfb-home-away-2026-10-03';
type Quote={bid:number;ask:number;size?:number};
function input(time:number,quote:Quote,over:{live?:boolean;league?:TennisLeague;settlement?:number;ended?:boolean;slug?:string}={}):TennisInput{
  const league=over.league??'CFB',slug=over.slug??SLUG,size=quote.size??1000;
  return {receivedAt:time,source:'REST',sourceTime:time,
    book:{bids:[{price:quote.bid,quantity:size}],asks:[{price:quote.ask,quantity:size}],state:over.ended?'MARKET_STATE_EXPIRED':'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    market:{slug,eventId:'4242',eventSlug:'cfb-home-away-2026-10-03',title:'Home vs Away',league,yesName:'Home',noName:'Away',startTime:new Date(START).toISOString(),
      live:over.live??false,ended:over.ended??false,active:!over.ended,score:null,period:null,clock:null,tournament:null,football:null,footballIdentity:{yesTeamId:'1',noTeamId:'2'},
      bid:quote.bid,ask:quote.ask,price:(quote.bid+quote.ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
      execution:{slug,league,active:!over.ended,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.005,feeCoefficient:.0695}},
    ...(over.settlement!==undefined?{settlement:over.settlement,settlementReceivedAt:time}:{})};
}
function started(league:TennisLeague='CFB',extra:Partial<TennisSession['config']>={}):TennisSession{
  let session=createTennisSession({...defaultLiveTennisConfig(100),leagues:[league],focusSlug:SLUG,...extra},START-3_600_000);
  session.id='synthetic-engine-plan';
  session=applyTennisAction(session,{action:'start',commandId:'engine-plan-start'},[],START-3_600_000);
  assert.equal(session.status,'running');
  return session;
}
const at=(minutesBefore:number)=>START-minutesBefore*60_000;

test('the bot buys the engine-planned favourite at the close and holds it to settlement',()=>{
  let session=started();
  // 30 minutes out: the engine proposes nothing yet (the evidence is for the close).
  session=stepTennisSession(session,[input(at(30),{bid:.77,ask:.78})],at(30));
  assert.equal(session.pending,null);
  assert.ok(session.enginePlan);assert.match(session.lastReason,/^Decision engine: /);
  // Seven minutes out: favourite-hold proposes YES; the CFB favourite lead permits paper.
  const signal=at(7);
  session=stepTennisSession(session,[input(signal,{bid:.77,ask:.78})],signal);
  assert.equal(session.pending?.action,'BUY');assert.equal(session.pending?.side,'YES');
  assert.equal(session.pending?.plan?.strategy,'favourite-hold');assert.equal(session.pending?.plan?.evidence,'cfb-pregame-favourite');
  assert.equal(session.pending?.plan?.code,'LEAD_PAPER');assert.equal(session.pending?.budget,5);
  // A later book fills it after the execution delay.
  const fill=signal+1500;
  session=stepTennisSession(session,[input(fill,{bid:.77,ask:.78})],fill);
  const position=session.positions.find(p=>p.status==='open')!;
  assert.ok(position,session.lastReason);assert.equal(position.exitPolicy,'hold-to-settlement');assert.equal(position.plan?.strategy,'favourite-hold');
  assert.equal(session.ledger.at(-1)?.action,'BUY');
  const cashAfterBuy=session.cash;
  // A 12% drop would trip a scalp's stop; a planned hold ignores it.
  const drop=fill+60_000;
  session=stepTennisSession(session,[input(drop,{bid:.68,ask:.69})],drop);
  assert.equal(session.positions.find(p=>p.id===position.id)!.status,'open');assert.equal(session.pending,null);
  assert.equal(session.decisions.at(-1)?.code,'HOLD_TO_SETTLEMENT');
  // The game goes live and swings; still held.
  const live=START+30*60_000;
  session=stepTennisSession(session,[input(live,{bid:.40,ask:.41},{live:true})],live);
  assert.equal(session.positions.find(p=>p.id===position.id)!.status,'open');assert.equal(session.pending,null);
  // Settlement pays $1 per contract.
  const final=START+4*3_600_000;
  session=stepTennisSession(session,[input(final,{bid:.99,ask:.995},{ended:true,settlement:1})],final);
  const settled=session.positions.find(p=>p.id===position.id)!;
  assert.equal(settled.status,'settled');
  assert.equal(Math.round((session.cash-cashAfterBuy)*1e6),Math.round(position.quantity*1e6));
  assert.ok(settled.realizedPnl>0);
});

test('engine refusals: dropped regimes, unexecutable spreads and unknown packs never enter',()=>{
  // NFL pregame is dropped evidence: no entry.
  let nfl=started('NFL');
  nfl=stepTennisSession(nfl,[input(at(7),{bid:.77,ask:.78},{league:'NFL'})],at(7));
  assert.equal(nfl.pending,null);assert.match(nfl.enginePlan!.summary,/NFL pregame bets/);
  // A 4¢ spread passes the engine's 5¢ executable test but not the bot's 2¢ limit.
  let wide=started();
  wide=stepTennisSession(wide,[input(at(7),{bid:.76,ask:.80})],at(7));
  assert.equal(wide.pending,null);assert.ok(wide.decisions.some(d=>d.code==='SPREAD'&&/^Engine plan not executable/.test(d.reason)));
  // A pinned pack this host has not loaded blocks entries.
  let pinned=started('CFB',{evidencePack:'not-loaded-pack'});
  pinned=stepTennisSession(pinned,[input(at(7),{bid:.77,ask:.78})],at(7));
  assert.equal(pinned.pending,null);assert.ok(pinned.decisions.some(d=>d.code==='EVIDENCE_PACK_UNAVAILABLE'));
  // The underdog side is never bought even when it is the only side with depth on the ask.
  let dog=started();
  dog=stepTennisSession(dog,[input(at(7),{bid:.22,ask:.23})],at(7));
  assert.equal(dog.pending?.side,'NO','the NO side is the favourite at a 22¢ YES price');
});

test('a planned entry is cancelled if the game goes live during the execution delay',()=>{
  let session=started();
  session=stepTennisSession(session,[input(at(6),{bid:.77,ask:.78})],at(6));
  assert.equal(session.pending?.plan?.phase,'pregame');
  const later=at(6)+1500;
  session=stepTennisSession(session,[input(later,{bid:.77,ask:.78},{live:true})],later);
  assert.equal(session.pending,null);assert.equal(session.positions.length,0);
  assert.ok(session.decisions.some(d=>d.code==='PHASE_CHANGED'));
});

test('Stop still closes a planned hold; replaying the same inputs gives the same account',()=>{
  const run=()=>{
    let session=started();
    session=stepTennisSession(session,[input(at(7),{bid:.77,ask:.78})],at(7));
    session=stepTennisSession(session,[input(at(7)+1500,{bid:.77,ask:.78})],at(7)+1500);
    assert.equal(session.positions.filter(p=>p.status==='open').length,1);
    session=applyTennisAction(session,{action:'stop',commandId:'engine-plan-stop'},[input(at(6),{bid:.77,ask:.78})],at(6));
    assert.equal(session.pending?.action,'SELL');
    session=stepTennisSession(session,[input(at(6)+1500,{bid:.77,ask:.78})],at(6)+1500);
    return session;
  };
  const a=run(),b=run();
  assert.equal(a.positions[0].status,'closed');assert.equal(a.status,'stopped');
  assert.equal(JSON.stringify(a),JSON.stringify(b));
});
