import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultTennisBotConfig} from '../lib/tennis/rules.ts';
import {tennisPressure} from '../lib/tennis/tennis-pressure.ts';
import type {TennisInput,TennisScoreboardState,TennisSession} from '../lib/tennis/types.ts';

const NOW=Date.parse('2026-10-03T20:00:00Z'),SLUG='synthetic-pressure-tennis';
const board=(points:{yes:string;no:string}|null,serving:'YES'|'NO'|null,games={yes:2,no:2}):TennisScoreboardState=>({sets:[{number:1,yes:6,no:4},{number:2,...games}],setsWon:{yes:1,no:0},games,points,serving});
function input(time:number,bid:number,ask:number,tennis?:TennisScoreboardState,period='S2'):TennisInput {
  return {receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:1000}],asks:[{price:ask,quantity:1000}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{
    slug:SLUG,eventId:SLUG,eventSlug:SLUG,title:'Synthetic A vs B',league:'ATP',yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,
    score:'6-4, 2-2',period,tournament:'Synthetic',bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,history:[],...(tennis?{tennis}:{}),
    execution:{slug:SLUG,league:'ATP',active:true,minimumTradeQty:.01,quantityIncrement:.01,priceIncrement:.01,feeCoefficient:.0695}}};
}
/** A Tennis Auto momentum entry queued and due on the next book (as in tests/tennis-adaptive-v2.test.ts). */
function queued(ask=.40):TennisSession {
  let session=applyTennisAction(createTennisSession({...defaultTennisBotConfig(),focusSlug:SLUG},NOW-60000),{action:'start',commandId:'start'},[],NOW-60000);
  for(let i=0;i<12;i++){const time=NOW-60000+i*4000;session=stepTennisSession(session,[input(time,ask-.03,ask-.02)],time);}
  session=stepTennisSession(session,[input(NOW-12000,ask-.01,ask)],NOW-12000);
  session=stepTennisSession(session,[input(NOW-12000,ask-.01,ask)],NOW-11000);
  return stepTennisSession(session,[input(NOW-7000,ask-.01,ask)],NOW-7000);
}

test('pressure points: break points (either server) and tiebreaks; ordinary points and missing scores are not',()=>{
  const at=(tennis:TennisScoreboardState|undefined,period='S2')=>tennisPressure(input(NOW,.4,.41,tennis,period).market);
  assert.match(at(board({yes:'15',no:'40'},'YES'))!,/Break point/);
  assert.match(at(board({yes:'40',no:'30'},'NO'))!,/Break point/,'the YES player can break the NO server');
  assert.match(at(board({yes:'40',no:'AD'},'YES'))!,/Break point/,'advantage receiver');
  assert.equal(at(board({yes:'40',no:'40'},'YES')),null,'deuce');
  assert.equal(at(board({yes:'40',no:'15'},'YES')),null,'game point for the server');
  assert.equal(at(board({yes:'AD',no:'40'},'YES')),null,'advantage server');
  assert.match(at(board({yes:'3',no:'2'},'YES',{yes:6,no:6}),'TB2')!,/Tiebreak/);
  assert.match(at(board(null,null,{yes:6,no:6}))!,/Tiebreak/,'6-6 before the tiebreak score arrives');
  assert.equal(at(undefined),null,'no verified scoreboard: nothing blocked');
  assert.equal(tennisPressure({...input(NOW,.4,.41,board({yes:'0',no:'40'},'YES')).market,league:'CFB'}),null,'tennis only');
});

test('a queued tennis buy waits out a break point (recorded), and buys once it is over',()=>{
  const session=queued();
  assert.equal(session.pending?.action,'BUY',session.lastReason);
  const blocked=stepTennisSession(session,[input(NOW,.39,.40,board({yes:'15',no:'40'},'YES'))],NOW);
  assert.equal(blocked.ledger.length,0,'no purchase on break point');
  const skip=blocked.decisions.findLast(d=>d.code==='TENNIS_PRESSURE');
  assert.ok(skip,blocked.lastReason);assert.match(skip.reason,/Break point/);
  const normal=stepTennisSession(queued(),[input(NOW,.39,.40,board({yes:'15',no:'15'},'YES'))],NOW);
  assert.equal(normal.ledger.filter(e=>e.action==='BUY').length,1,normal.lastReason);
});

test('no daily trade-count cap: 25 bets already today does not stop the next one',()=>{
  const session=queued();
  for(let i=0;i<25;i++)session.ledger.push({id:`earlier-${i}`,time:NOW-3_600_000+i*1000,slug:'earlier-match',side:'YES',action:'BUY',source:'AUTOMATIC',positionId:`earlier-${i}`,reason:'Synthetic earlier bet',cashDelta:0,realizedPnl:0});
  const next=stepTennisSession(session,[input(NOW,.39,.40,board({yes:'15',no:'15'},'YES'))],NOW);
  assert.equal(next.ledger.filter(e=>e.action==='BUY'&&e.slug===SLUG).length,1,next.lastReason);
  assert.ok(!next.decisions.some(d=>/trades today/.test(d.reason)));
});
