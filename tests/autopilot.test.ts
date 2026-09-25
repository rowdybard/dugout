import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultBotConfig,newBot,stepBot,contextBlock,entryCosts,botUniverse} from '../lib/bot/engine.ts';
import type {BotSession,BotInput} from '../lib/bot/types.ts';

// Synthetic engineering fixtures ONLY. No actual games, profits, or win claims.
const NOW=Date.parse('2026-09-23T18:00:00Z');
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<.000002,`${a} != ${b}`);
function input(slug='synthetic-a',bid=.39,ask=.41,time=NOW):BotInput {
  return {market:{slug,id:slug,gameId:slug,game:'Synthetic away @ Synthetic home',title:'Synthetic away wins',oppositeTitle:'Synthetic home wins',league:'MLB',start:new Date(NOW+3600000).toISOString(),kind:'baseball_team_full_game_winner',teams:[],question:'Synthetic',rules:'',bid,ask,price:ask,volume:null,fee:.0695,active:true,history:[],signals:[],observedAt:time},
    executionMarket:{slug,league:'MLB',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695},
    book:{bids:[{price:bid,quantity:100}],asks:[{price:ask,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    receivedAt:time,source:'REST',context:{slug,league:'MLB',status:'available',receivedAt:time,source:{name:'Synthetic context',url:'https://example.invalid',support:'official'},
      game:{id:`game-${slug}`,start:new Date(NOW+3600000).toISOString(),state:'pregame',statusText:'Synthetic pregame',away:{id:'a',name:'Synthetic away',abbreviation:'SA',score:null},home:{id:'h',name:'Synthetic home',abbreviation:'SH',score:null}},
      players:[{id:'pitcher-a',name:'Synthetic A',team:'Synthetic away',role:'probable_pitcher',stats:[]},{id:'pitcher-h',name:'Synthetic H',team:'Synthetic home',role:'probable_pitcher',stats:[]}],changes:[],injuries:[],injuryStatus:'source_reports',injuryReceivedAt:time,limitations:[]}};
}
function session():BotSession{const config=defaultBotConfig(10,['MLB']);delete config.outcomeFilter;return newBot(config,NOW-2000);}
function arm(s:BotSession,i:BotInput,side:'YES'|'NO'='YES',baseline=.60){
  const previous=structuredClone(i);previous.receivedAt=NOW-1000;previous.context.receivedAt=NOW-1000;previous.context.injuryReceivedAt=NOW-1000;
  contextBlock(s,previous,NOW-1000);
  s.states[`${i.market.slug}:${side}`]={version:s.config.strategy.version,phase:'DIP',baseline,trough:.37,dipAt:NOW-60000,recoveryCount:1,lastObservedAt:NOW-1,lastObservedPrice:.39};
  const p=side==='YES'?.40:.60;
  s.histories[i.market.slug]=[{time:NOW-130000,price:side==='YES'?baseline:1-baseline},{time:NOW-1,price:p}];
  return s;
}
function entered(side:'YES'|'NO'='YES'){
  const i=side==='YES'?input():input('synthetic-a',.59,.61);
  const s=stepBot(arm(session(),i,side),[i],NOW);
  assert.equal(s.positions.filter(p=>p.status==='open').length,1,'fixture produces one genuine engine fill');
  return s;
}

test('new bankroll is isolated; evaluating an entry leaves prior session immutable',()=>{
  const first=arm(session(),input()),other=session(),before=JSON.stringify(first);
  const next=stepBot(first,[input()],NOW);
  assert.equal(JSON.stringify(first),before);
  assert.equal(other.cash,10);assert.equal(other.positions.length,0);
  assert.equal(next.positions.length,1);assert.ok(next.cash<10);
  near(next.cash+next.positions[0].amount,10);
});

test('automatic side selection supports YES and NO with correct executable prices',()=>{
  const yes=entered('YES'),no=entered('NO');
  assert.equal(yes.positions[0].side,'YES');assert.equal(no.positions[0].side,'NO');
  near(yes.positions[0].entry,.41);near(no.positions[0].entry,.41);
  assert.equal(no.positions[0].title,'Synthetic home wins');
  near(yes.cash,no.cash);
});

test('single position goes to highest qualified candidate independent of input ordering',()=>{
  const a=input('synthetic-a'),b=input('synthetic-b');const seeded=arm(arm(session(),a,'YES',.60),b,'YES',.70);
  const forward=stepBot(seeded,[a,b],NOW),reverse=stepBot(seeded,[b,a],NOW);
  assert.equal(forward.positions.length,1);assert.equal(reverse.positions.length,1);
  assert.equal(forward.positions[0].slug,'synthetic-b');assert.equal(reverse.positions[0].slug,'synthetic-b');
  assert.ok(forward.decisions.some(d=>d.slug==='synthetic-a'&&d.action==='SKIP'));
});

test('stale, replay, future receipt and future context cannot fund entries',()=>{
  for(const mutate of [(i:BotInput)=>{i.receivedAt=NOW-16000;},(i:BotInput)=>{i.source='REPLAY';},(i:BotInput)=>{i.receivedAt=NOW+1;},(i:BotInput)=>{i.context.receivedAt=NOW+1;}]){
    const i=input(),s=arm(session(),i);mutate(i);const next=stepBot(s,[i],NOW);
    assert.equal(next.positions.length,0);assert.equal(next.cash,10);
  }
});

test('future strategy prices cannot improve a decision at an earlier time',()=>{
  const clean=arm(session(),input()),future=structuredClone(clean);
  future.histories['synthetic-a'].push({time:NOW+1,price:.99},{time:NOW+2,price:.01});
  const a=stepBot(clean,[input()],NOW),b=stepBot(future,[input()],NOW);
  assert.equal(a.positions.length,b.positions.length);near(a.cash,b.cash);
  assert.deepEqual(a.decisions.map(({id,...d})=>({...d,positionId:undefined})),b.decisions.map(({id,...d})=>({...d,positionId:undefined})));
});

test('missing or changed key player context vetoes entries without invented impact scores',()=>{
  const missing=input(),s=arm(session(),missing);missing.context.players=[];
  const blocked=stepBot(s,[missing],NOW);assert.equal(blocked.positions.length,0);assert.equal(blocked.cash,10);
  const changed=input(),prior=arm(session(),changed);changed.context.players[0].id='different-pitcher';
  const next=stepBot(prior,[changed],NOW);assert.equal(next.positions.length,0);
  assert.ok(next.decisions.some(d=>/identity changed/.test(d.reason)));
});

test('entry costs veto a setup whose immediate liquidation loss already breaches its stop',()=>{
  const s=session();s.config.strategy.stopReturn=.06;
  const costs=entryCosts(s,input('synthetic-a',.38,.40),'YES',.40,.60,NOW);
  assert.ok((costs.initialLoss??0)>.06);assert.match(costs.reason??'',/fees already exceed/);
});

test('paused entries retain automatic target exits, including unavailable sports context',()=>{
  const s=entered();s.status='paused';const fresh=input('synthetic-a',.70,.72,NOW+1000);
  fresh.context.status='unavailable';fresh.context.game=null;fresh.context.players=[];
  const next=stepBot(s,[fresh],NOW+1000);
  assert.equal(next.status,'paused');assert.equal(next.positions.filter(p=>p.status==='open').length,0);
  assert.ok(next.cash>s.cash);assert.equal(next.executions.filter(e=>e.apply&&e.cashDelta<0).length,1);
});

test('missing or stale buyers preserve last known mark and do not invent an exit',()=>{
  for(const missing of [true,false]){
    const s=entered(),old=structuredClone(s.positions[0]),i=input('synthetic-a',.01,.03,NOW+1000);
    if(missing)i.book.bids=[];else i.receivedAt=NOW-16000;
    const next=stepBot(s,[i],NOW+1000);
    assert.equal(next.positions[0].status,'open');near(next.positions[0].mark!,old.mark!);
    assert.equal(next.positions[0].markTime,old.markTime);near(next.cash,s.cash);
    assert.equal(next.executions.length,s.executions.length);
  }
});

test('partial stop exit retains cost basis, recycles net cash, and never opens another position',()=>{
  const s=entered();s.status='stopping';const old=structuredClone(s.positions[0]);
  const thin=input('synthetic-a',.39,.41,NOW+1000);thin.book.bids[0].quantity=1;
  const partial=stepBot(s,[thin],NOW+1000);
  assert.equal(partial.status,'stopping');assert.equal(partial.positions.filter(p=>p.status==='open').length,1);
  near(partial.positions.reduce((n,p)=>n+p.amount,0),old.amount);
  near(partial.positions.reduce((n,p)=>n+p.contracts,0),old.contracts);
  const closed=partial.positions.find(p=>p.status==='closed')!;near(partial.cash,s.cash+closed.payout!);
  const done=stepBot(partial,[input('synthetic-a',.39,.41,NOW+2000)],NOW+2000);
  assert.equal(done.status,'stopped');assert.equal(done.positions.filter(p=>p.status==='open').length,0);
  const repeated=stepBot(done,[input('synthetic-b',.39,.41,NOW+3000)],NOW+3000);
  assert.deepEqual(repeated,done);assert.equal(done.executions.filter(e=>e.apply&&e.cashDelta<0).length,1);
});

test('recycled proceeds can fund later setups without resetting or replenishing the bankroll',()=>{
  const s=entered();const closed=stepBot(s,[input('synthetic-a',.70,.72,NOW+1000)],NOW+1000);
  assert.equal(closed.positions.filter(p=>p.status==='open').length,0);
  const afterExit=closed.cash;
  const b=input('synthetic-b',.39,.41,NOW+2000);const primed=arm(closed,b);
  const reopened=stepBot(primed,[b],NOW+2000);
  const latest=reopened.positions.find(p=>p.status==='open')!;
  assert.ok(latest);near(reopened.cash+latest.amount,afterExit);
  assert.equal(reopened.config.startingCash,10);
});

test('official fractional settlement is idempotent and pays complementary NO quantity',()=>{
  for(const side of ['YES','NO'] as const){
    const s=entered(side),p=s.positions[0],settled=input('synthetic-a',.39,.41,NOW+1000);
    settled.book.state='MARKET_STATE_CLOSED';settled.executionMarket.active=false;settled.settlement=.25;
    const once=stepBot(s,[settled],NOW+1000),twice=stepBot(once,[{...settled,receivedAt:NOW+2000}],NOW+2000);
    near(once.cash,s.cash+p.contracts*(side==='YES'?.25:.75));near(twice.cash,once.cash);
    assert.equal(once.positions[0].status,'settled');assert.equal(twice.decisions.filter(d=>d.action==='SETTLE').length,1);
  }
});

test('replay or stale settlement cannot credit cash',()=>{
  for(const replay of [true,false]){
    const s=entered(),i=input();i.settlement=1;i.book.state='MARKET_STATE_CLOSED';i.executionMarket.active=false;
    if(replay)i.source='REPLAY';else i.receivedAt=NOW-16000;
    const next=stepBot(s,[i],NOW);near(next.cash,s.cash);assert.equal(next.positions[0].status,'open');
  }
});

test('an empty or ineligible universe does not force a trade',()=>{
  const s=session(),i=input();i.market.start=new Date(NOW+60000).toISOString();
  assert.deepEqual(botUniverse([i.market],s,NOW),[]);
  const next=stepBot(s,[i],NOW);assert.equal(next.cash,10);assert.equal(next.positions.length,0);
});

test('non-finite bankroll limits and clocks cannot create an apparently running session',()=>{
  for(const key of ['startingCash','entryBudget','maxSessionLoss'] as const){
    for(const value of [Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY]){
      const config=defaultBotConfig();config[key]=value;
      assert.throws(()=>newBot(config,NOW),`${key}=${value} must be rejected before a session exists`);
    }
  }
  assert.throws(()=>newBot(defaultBotConfig(),Number.NaN));
  assert.throws(()=>newBot(defaultBotConfig(),Number.POSITIVE_INFINITY));
});

test('one manual exit request survives a partial fill and prevents later automatic re-entry',()=>{
  const s=entered(),id=s.positions[0].id,thin=input('synthetic-a',.39,.41,NOW+1000);
  thin.book.bids[0].quantity=1;
  const partial=stepBot(s,[thin],NOW+1000,id);
  assert.equal(partial.positions.filter(p=>p.status==='open').length,1);
  assert.equal(partial.positions.filter(p=>p.status==='closed').length,1);
  // No repeated manual request. Persisted control state must finish the original intent.
  const done=stepBot(partial,[input('synthetic-a',.39,.41,NOW+2000)],NOW+2000);
  assert.equal(done.positions.filter(p=>p.status==='open').length,0);
  assert.notEqual(done.status,'running');
  const another=input('synthetic-b',.39,.41,NOW+3000);
  const after=stepBot(arm(done,another),[another],NOW+3000);
  assert.equal(after.positions.filter(p=>p.status==='open').length,0);
  assert.equal(after.executions.filter(e=>e.apply&&e.cashDelta<0).length,1);
});

test('manual exit requested during a data outage stays pending when quotes return',()=>{
  const s=entered(),id=s.positions[0].id;
  const unavailable=stepBot(s,[],NOW+1000,id);
  near(unavailable.cash,s.cash);assert.equal(unavailable.positions[0].status,'open');
  const recovered=stepBot(unavailable,[input('synthetic-a',.39,.41,NOW+2000)],NOW+2000);
  assert.equal(recovered.positions.filter(p=>p.status==='open').length,0);
  assert.notEqual(recovered.status,'running');
});
