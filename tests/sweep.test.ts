import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';
import {createSweepSession,listInput,SWEEP_EVERY_MS,SWEEP_FORGET_MS,sweepAwaiting,sweepStep,sweepSummary} from '../lib/tennis/sweep.ts';
import {recordGameEvents} from '../lib/tennis/research-tracking.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import {BUNDLED_PACK} from '../lib/decision/pack.ts';
import {registerPack} from '../lib/decision/registry.ts';
import {defaultEngine,createEngine} from '../lib/decision/engine.ts';
import {readFeature,BUILTIN_FEATURES} from '../lib/decision/features.ts';
import type {DecisionContext} from '../lib/decision/context.ts';
import type {Evidence} from '../lib/decision/evidence.ts';
import type {FootballReportState,TennisInput,TennisMarket} from '../lib/tennis/types';

const T0=Date.parse('2026-10-03T18:00:00Z'),AWAY=5001,HOME=5002;
type Report={score?:string;period?:string;clock?:string;possession?:number;down?:number;yfd?:number;field?:{teamId:number;yard:number}};

/** A live college game as the games list shows it: YES (away) trails 0-17 with the ball at the home 25. */
function listed(at:number,{slug='aec-cfb-away-home-2026-10-03',bid=0.2,live=true,league='cfb',start='2026-10-03T17:00:00Z',report={} as Report}={}):TennisMarket {
  const {score='0-17',period='Q2',clock='8:00',possession=AWAY,down=1,yfd=10,field={teamId:HOME,yard:25}}=report;
  const raw={id:slug.length,slug:slug.replace(/^aec-/,''),title:'Away vs Home',startTime:start,active:true,live,ended:false,score:live?score:undefined,period:live?period:'',
    eventState:{type:'football',live,ended:false,period:live?period:'',elapsed:live?clock:'',updatedAt:new Date(at-500).toISOString(),
      ...(live?{footballState:{driveState:{possessionTeamId:String(possession),down,yfd,fieldPosition:{teamId:String(field.teamId),yard:field.yard}}}}:{})},
    markets:[{slug,sportsMarketType:'football_team_full_game_winner',status:'MARKET_STATUS_OPEN',active:true,closed:false,
      feeCoefficient:0.0695,orderPriceMinTickSize:0.01,minimumTradeQty:0.01,bestBidQuote:{value:String(bid)},bestAskQuote:{value:String(Math.round((bid+0.01)*100)/100)},
      marketSides:[{long:true,description:'Away',teamId:AWAY,team:{id:AWAY,name:'Away Team',league,ordering:'away'}},
        {long:false,description:'Home',teamId:HOME,team:{id:HOME,name:'Home Team',league,ordering:'home'}}]}]};
  const market=normalizeTennisEvent(raw,league==='cfb'?'CFB':'NFL',at)[0];
  assert.ok(market,'normalized');
  return market;
}

test('the sweep measures every open college game in its own shadow session, from the games list only',()=>{
  const sweep0=createSweepSession(undefined,T0-60_000);
  const games=[listed(T0),listed(T0,{slug:'aec-cfb-other-game-2026-10-03'}),listed(T0,{slug:'aec-nfl-kc-buf-2026-10-03',league:'nfl'})];
  const sweep=sweepStep(sweep0,games,{},T0);
  assert.equal(sweep0.shadows,undefined,'pure: the input session is unchanged');
  const strategies=new Set((sweep.shadows??[]).map(shadow=>`${shadow.slug}|${shadow.strategy}`));
  for(const slug of ['aec-cfb-away-home-2026-10-03','aec-cfb-other-game-2026-10-03'])
    for(const strategy of ['comeback-drive','comeback-drive-hold','drive-fade'])assert.ok(strategies.has(`${slug}|${strategy}`),`${slug} ${strategy}: ${[...strategies]}`);
  assert.ok(![...strategies].some(key=>key.startsWith('aec-nfl')),'college only');
  const fade=sweep.shadows!.find(shadow=>shadow.strategy==='drive-fade')!;
  assert.equal(fade.legs.find(leg=>leg.id==='base')!.side,'no','drive-fade buys the leader');
  assert.equal(sweep.positions.length,0);assert.equal(sweep.pending,null);
  // Each game at most every 30 s, and only on newer list data.
  const again=sweepStep(sweep,[listed(T0+10_000)],{},T0+10_000);
  assert.equal(again.evaluatedBooks!['aec-cfb-away-home-2026-10-03'],T0);
  const later=sweepStep(sweep,[listed(T0+SWEEP_EVERY_MS)],{},T0+SWEEP_EVERY_MS);
  assert.equal(later.evaluatedBooks!['aec-cfb-away-home-2026-10-03'],T0+SWEEP_EVERY_MS);
  // Summary for the dashboard.
  const summary=sweepSummary(later,T0+SWEEP_EVERY_MS);
  assert.equal(summary.games,2);assert.ok(summary.open>=6);assert.equal(summary.measured,0);
});

test('the sweep settles finished games from their final result and scores them as forward shadow',()=>{
  let sweep=sweepStep(createSweepSession(undefined,T0-60_000),[listed(T0)],{},T0);
  // The drive ends (the away team scores); later books let the drive exits close.
  let t=T0;
  for(const [bid,report] of [[0.3,{score:'7-17',period:'Q2',possession:HOME,field:{teamId:HOME,yard:25}}],[0.3,{score:'7-17',period:'Q3',possession:HOME,field:{teamId:HOME,yard:30}}]] as const){
    t+=SWEEP_EVERY_MS;sweep=sweepStep(sweep,[listed(t,{bid,report})],{},t);
  }
  // Held shadows wait for the final result; 31 minutes of books let every capped exit finish.
  for(let i=0;i<64;i++){t+=SWEEP_EVERY_MS;sweep=sweepStep(sweep,[listed(t,{bid:0.3,report:{score:'7-17',period:'Q3',possession:HOME,field:{teamId:HOME,yard:40}}})],{},t);}
  const slug='aec-cfb-away-home-2026-10-03';
  assert.deepEqual(sweepAwaiting(sweep),[slug]);
  t+=SWEEP_EVERY_MS;sweep=sweepStep(sweep,[],{[slug]:0},t);
  assert.deepEqual(sweepAwaiting(sweep),[],'settled: nothing left to ask for');
  const records=sweepSummary(sweep,t).records;
  assert.ok(records.length>=3&&records.every(record=>record.sample==='forward-shadow'),JSON.stringify(records.map(r=>r.strategy)));
  const hold=records.find(record=>record.strategy==='comeback-drive-hold')!,fade=records.find(record=>record.strategy==='drive-fade')!;
  assert.ok(hold.ret<-0.9,'the away team lost: the held longshot is worthless');assert.ok(fade.ret>0,'the leader won');
  // Games not seen for 6 hours are forgotten.
  const gone=sweepStep(sweep,[],{},t+SWEEP_FORGET_MS+1);
  assert.equal(gone.footballReports?.[slug],undefined);assert.equal(gone.sweepSeen?.[slug],undefined);
});

test('list quotes become one-level books with a nominal size; unusable quotes are skipped',()=>{
  const input=listInput(listed(T0),T0)!;
  assert.deepEqual(input.book.bids,[{price:0.2,quantity:1000}]);assert.deepEqual(input.book.asks,[{price:0.21,quantity:1000}]);
  assert.equal(listInput({...listed(T0),bid:null},T0),null);assert.equal(listInput({...listed(T0),bid:0.3,ask:0.3},T0),null);
});

// ---- Mined rules: evidence rows that ARE entry rules ------------------------------------------------------------

const MINED:Evidence={id:'cfb-mined-home-fav-early',title:'Mined: CFB home 70–80¢ favourites 30+ min out',status:'lead',sports:['CFB'],phases:['pregame'],styles:['taker-hold'],
  strategies:['mined-rule@1'],price:{min:0.7,max:0.8},conditions:[{feature:'venue',op:'eq',value:'home'},{feature:'minutesToStart',op:'gt',value:30}],
  estimate:{mean:0.04,lo:0.01,hi:0.07,unit:'return'},sample:'test',source:'test',plain:'Home favourites at 70–80¢ more than 30 minutes out.'};
function pregameCtx(yesAsk:number,minutes:number,yesOrdering:'away'|'home'='away'):DecisionContext {
  const now=T0;
  return {now,phase:'pregame',market:{slug:'aec-cfb-a-h-2026-10-03',sport:'CFB',startTime:now+minutes*60_000,feeCoefficient:0.0695,observedAt:now-1000,yesOrdering,
    yes:{ask:yesAsk,bid:yesAsk-0.01,askSize:500,bidSize:500},no:{ask:Math.round((1-yesAsk+0.01)*100)/100,bid:Math.round((1-yesAsk)*100)/100,askSize:500,bidSize:500}}};
}

test('venue: each side is home or away from the verified team ordering',()=>{
  assert.equal(readFeature(BUILTIN_FEATURES,'venue',pregameCtx(0.25,60),'yes'),'away');
  assert.equal(readFeature(BUILTIN_FEATURES,'venue',pregameCtx(0.25,60),'no'),'home');
  assert.equal(readFeature(BUILTIN_FEATURES,'venue',pregameCtx(0.25,60,'home'),'yes'),'home');
  assert.equal(readFeature(BUILTIN_FEATURES,'venue',{...pregameCtx(0.25,60),market:{...pregameCtx(0.25,60).market,yesOrdering:null}},'yes'),undefined);
});

test('mined-rule@1 proposes only where a measured row naming it fully matches, once per rule per game',()=>{
  const engine=createEngine({pack:{...BUNDLED_PACK,version:'test-mined',evidence:[...BUNDLED_PACK.evidence,MINED]},trust:'bundled'});
  const plan=engine.plan(pregameCtx(0.25,60),{mode:'paper'});
  const mined=plan.considered.filter(trade=>trade.proposal.strategy==='mined-rule');
  assert.equal(mined.length,1);assert.equal(mined[0].proposal.side,'no');assert.equal(mined[0].proposal.setupKey,MINED.id);
  assert.equal(mined[0].proposal.price,0.76);
  assert.ok(plan.actions.some(action=>action.proposal.strategy==='mined-rule'),JSON.stringify(mined[0].verdict));
  // 20 minutes out, the away side, a price outside the band: no proposal, and it says why.
  for(const ctx of [pregameCtx(0.25,20),pregameCtx(0.25,60,'home'),pregameCtx(0.15,60)]){
    const other=engine.plan(ctx,{mode:'paper'});
    assert.equal(other.considered.filter(trade=>trade.proposal.strategy==='mined-rule').length,0);
    assert.ok(other.notes.some(note=>note.strategy==='mined-rule'&&note.code==='NO_SETUP'));
  }
  // Without mined rows (the bundled pack) it never proposes.
  assert.equal(defaultEngine.plan(pregameCtx(0.25,60),{mode:'paper'}).considered.filter(trade=>trade.proposal.strategy==='mined-rule').length,0);
  // A dropped row is not a rule.
  const dropped=createEngine({pack:{...BUNDLED_PACK,version:'test-mined-dropped',evidence:[...BUNDLED_PACK.evidence,{...MINED,status:'dropped'}]},trust:'bundled'});
  assert.equal(dropped.plan(pregameCtx(0.25,60),{mode:'paper'}).considered.filter(trade=>trade.proposal.strategy==='mined-rule').length,0);
});

test('the sweep measures permitted mined-rule entries on every game, not only the bot\'s focused one',()=>{
  assert.deepEqual(registerPack({...BUNDLED_PACK,version:'test-sweep-mined',evidence:[...BUNDLED_PACK.evidence,MINED]},'bundled'),{ok:true});
  // Pregame, 2 hours out: NO (home) at 76¢.
  const game=listed(T0,{live:false,bid:0.24,start:new Date(T0+2*3_600_000).toISOString()});
  const sweep=sweepStep(createSweepSession('test-sweep-mined',T0-60_000),[game],{},T0);
  const shadow=sweep.shadows?.find(item=>item.strategy==='mined-rule');
  assert.ok(shadow,JSON.stringify(sweep.shadows?.map(s=>s.strategy)));
  assert.equal(shadow.legs.find(leg=>leg.id==='base')!.side,'no');assert.equal(shadow.setupKey,MINED.id);
});

// ---- Drive numbers keep rising after the tape is trimmed -------------------------------------------------------

test('drive numbers are counted when recorded, so trimming the event tape never repeats one',()=>{
  const session=createTennisSession({...defaultLiveTennisConfig(100),leagues:['CFB']},T0);
  const market=listed(T0);
  const state=(time:number,possession:number):FootballReportState=>({assessment:{status:'fresh',reason:'',reportTime:time,receiptTime:time,reportAgeMs:0,receiptAgeMs:0},
    report:{eventId:market.eventId,yesTeamId:String(AWAY),noTeamId:String(HOME),reportTime:time,receiptTime:time,score:'0-17',period:'Q2',clock:'8:00',
      possessionTeamId:String(possession),down:1,yardsToGo:10,fieldPosition:{teamId:String(HOME),yard:40}}});
  const input:TennisInput={market,book:{bids:[],asks:[],state:'MARKET_STATE_OPEN',time:''},receivedAt:T0,source:'REST'};
  for(let i=0;i<=40;i++)recordGameEvents(session,input,state(T0+i*60_000,i%2?HOME:AWAY),T0+i*60_000);
  const tape=session.gameTape![market.slug];
  assert.equal(tape.length,24,'the kept tape is trimmed');
  assert.equal(tape.at(-1)!.drive,40,'40 changes of possession');
  const ctx:DecisionContext={now:T0+41*60_000,phase:'live',market:{slug:market.slug,sport:'CFB',startTime:null,yes:{ask:0.3,bid:0.29},no:{ask:0.71,bid:0.7}},events:tape};
  assert.equal(readFeature(BUILTIN_FEATURES,'driveNumber',ctx,'yes'),40);
});
