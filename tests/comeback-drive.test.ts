import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,defaultEngine} from '../lib/decision/engine.ts';
import {comebackDrive,COMEBACK_DRIVE} from '../lib/decision/sports/index.ts';
import {BUNDLED_PACK} from '../lib/decision/pack.ts';
import {registerPack} from '../lib/decision/registry.ts';
import type {DecisionContext} from '../lib/decision/context.ts';
import type {Evidence} from '../lib/decision/evidence.ts';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {decisionContext,footballSecondsRemaining,marketPhase,sideScores} from '../lib/tennis/engine-plan.ts';
import {defaultLiveTennisConfig,validateTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types';

// ---- Engine: the strategy, exploring and the evidence gate -------------------------------------------------

function ctx(over:{sport?:'NFL'|'CFB'|'MLB';yesScore?:number;noScore?:number;possession?:'yes'|'no';yards?:number;down?:number;period?:number;seconds?:number|null;phase?:'live'|'pregame'}={}):DecisionContext {
  return {now:1_000_000,phase:over.phase??'live',
    market:{slug:'aec-nfl-kc-buf-2026-09-27',sport:over.sport??'NFL',startTime:0,feeCoefficient:0.0695,observedAt:1_000_000,
      yes:{ask:0.21,bid:0.2,askSize:500,bidSize:500},no:{ask:0.8,bid:0.79,askSize:500,bidSize:500}},
    game:{status:'live',period:over.period??2,secondsRemaining:over.seconds??null,yesScore:over.yesScore??0,noScore:over.noScore??17,
      extra:{possession:over.possession??'yes',yardsToEndZone:over.yards??25,down:over.down??1,distance:10}}};
}
const drive=(plan:ReturnType<typeof defaultEngine.plan>)=>plan.considered.find(trade=>trade.proposal.strategy==='comeback-drive');

test('comeback-drive proposes the trailing team with the ball in scoring position, and nothing else',()=>{
  const plan=defaultEngine.plan(ctx(),{mode:'paper',explore:['comeback-drive']});
  const trade=drive(plan)!;
  assert.equal(trade.proposal.side,'yes');assert.equal(trade.proposal.price,0.21);assert.equal(trade.proposal.style,'taker-scalp');
  assert.deepEqual(trade.proposal.exit,{kind:'drive',stopReturn:COMEBACK_DRIVE.stopReturn,maxHoldMs:COMEBACK_DRIVE.maxHoldMs});
  assert.match(trade.proposal.rationale,/Down 17, ball on the opponent's 25, 1st and 10, Q2/);
  const none=(over:Parameters<typeof ctx>[0])=>assert.equal(drive(defaultEngine.plan(ctx(over),{mode:'paper',explore:['comeback-drive']})),undefined,JSON.stringify(over));
  none({possession:'no'});                       // the leader has the ball
  none({yards:31});                              // not in scoring position
  none({down:4});                                // fourth down
  none({noScore:2});none({noScore:25});          // deficit outside 3–24
  none({yesScore:17});                           // level
  none({period:4});                              // fourth quarter with the clock unknown
  none({period:4,seconds:299});                  // under five minutes left
  none({phase:'pregame'});none({sport:'MLB'});
  assert.ok(drive(defaultEngine.plan(ctx({period:4,seconds:300}),{mode:'paper',explore:['comeback-drive']})),'fourth quarter with the clock known');
  assert.ok(drive(defaultEngine.plan(ctx({sport:'CFB',possession:'no',yesScore:24,noScore:3}),{mode:'paper',explore:['comeback-drive']}))?.proposal.side==='no');
});

test('exploring is paper-only, needs a pre-registered hypothesis, and stops once evidence names the strategy',()=>{
  // NFL: the general in-game scalping result is a measured loser, so without exploring it is refused.
  assert.equal(drive(defaultEngine.plan(ctx(),{mode:'paper'}))!.blocked,'DROPPED');
  const explored=drive(defaultEngine.plan(ctx(),{mode:'paper',explore:['comeback-drive']}))!;
  assert.equal(explored.blocked,null);assert.equal(explored.verdict.code,'EXPLORE_PAPER');assert.equal(explored.stake,5);
  assert.equal(explored.verdict.deciding,null);assert.match(explored.reason,/Paper test of an unmeasured idea\..*NFL in-game scalping, −?-?10\.1%/);
  // CFB: nothing measured at all.
  assert.equal(drive(defaultEngine.plan(ctx({sport:'CFB'}),{mode:'paper'}))!.blocked,'NO_EVIDENCE');
  assert.equal(drive(defaultEngine.plan(ctx({sport:'CFB'}),{mode:'paper',explore:['comeback-drive']}))!.verdict.code,'EXPLORE_PAPER');
  // Never real or pilot money.
  for(const mode of ['pilot','real'] as const)assert.equal(drive(defaultEngine.plan(ctx(),{mode,explore:['comeback-drive']}))!.blocked,'DROPPED');
  // A strategy without a hypothesis cannot be explored.
  const bare={...comebackDrive(),hypothesis:undefined};
  assert.equal(drive(defaultEngine.plan(ctx(),{mode:'paper',explore:['comeback-drive'],use:[bare]}))!.blocked,'DROPPED');
  // Once research publishes a row for this strategy, its own result decides.
  const row=(status:Evidence['status']):Evidence=>({id:`drive-${status}`,title:'Comeback drives',status,sports:['NFL','CFB'],phases:['live'],styles:['taker-scalp'],strategies:['comeback-drive'],
    estimate:{mean:status==='dropped'?-0.05:0.04,lo:-0.1,hi:0.1,unit:'return'},sample:'test',source:'test',plain:'test'});
  for(const [status,code] of [['dropped','DROPPED'],['lead','LEAD_PAPER']] as const){
    // Its own result supersedes the general NFL scalping result, which measured other entry rules.
    const engine=createEngine({pack:{...BUNDLED_PACK,version:`t-${status}`,evidence:[...BUNDLED_PACK.evidence,row(status)]},trust:'bundled'});
    const verdict=drive(engine.plan(ctx(),{mode:'paper',explore:['comeback-drive']}))!.verdict;
    assert.equal(verdict.code,code,status);assert.equal(verdict.deciding?.id,`drive-${status}`);
    assert.ok(verdict.evidence.some(item=>item.id==='nfl-live-scalp'),'the general row is still listed');
    // Other scalps are unaffected by a strategy-specific row.
    assert.equal(engine.decide({sport:'NFL',phase:'live',style:'taker-scalp',mode:'paper',ask:0.21,bid:0.2}).code,'DROPPED');
  }
  // A finding about a narrower slice (here a price band) still applies to every strategy.
  const band:Evidence={id:'nfl-live-cheap-scalp',title:'Cheap NFL scalps',status:'dropped',sports:['NFL'],phases:['live'],styles:['taker-scalp'],price:{min:0,max:0.25},
    estimate:{mean:-0.2,lo:-0.3,hi:-0.1,unit:'return'},sample:'test',source:'test',plain:'test'};
  const narrow=createEngine({pack:{...BUNDLED_PACK,version:'t-band',evidence:[...BUNDLED_PACK.evidence,row('lead'),band]},trust:'bundled'});
  assert.equal(drive(narrow.plan(ctx(),{mode:'paper',explore:['comeback-drive']}))!.verdict.deciding?.id,'nfl-live-cheap-scalp');
  // A named row whose condition cannot be checked does not displace the general result.
  const unknown={...row('lead'),id:'drive-unknown',conditions:[{feature:'signal.weather',op:'eq' as const,value:'clear'}]};
  const cautious=createEngine({pack:{...BUNDLED_PACK,version:'t-unknown',evidence:[...BUNDLED_PACK.evidence,unknown]},trust:'bundled'});
  assert.equal(drive(cautious.plan(ctx(),{mode:'paper',explore:['comeback-drive']}))!.verdict.code,'DROPPED');
  const cfb=createEngine({pack:{...BUNDLED_PACK,version:'t-lead-cfb',evidence:[...BUNDLED_PACK.evidence,row('lead')]},trust:'bundled'});
  assert.equal(drive(cfb.plan(ctx({sport:'CFB'}),{mode:'paper',explore:['comeback-drive']}))!.verdict.code,'LEAD_PAPER');
});

test('measured leads outrank explored ideas for the one taker slot',()=>{
  const lead:Evidence={id:'cfb-live-hold-test',title:'Test live hold',status:'lead',sports:['CFB'],phases:['live'],styles:['taker-hold'],
    estimate:{mean:0.01,lo:-0.02,hi:0.04,unit:'return'},sample:'test',source:'test',plain:'test'};
  const holder={id:'test-hold',version:'1',description:'test',propose:()=>[{strategy:'test-hold',strategyVersion:'1',side:'no' as const,style:'taker-hold' as const,price:0.8,exit:{kind:'hold-to-settlement' as const},rationale:'test'}]};
  const engine=createEngine({pack:{...BUNDLED_PACK,version:'t-rank',evidence:[...BUNDLED_PACK.evidence,lead]},trust:'bundled',strategies:[comebackDrive(),holder]});
  const plan=engine.plan(ctx({sport:'CFB'}),{mode:'paper',explore:['comeback-drive']});
  assert.equal(plan.actions.length,1);assert.equal(plan.actions[0].proposal.strategy,'test-hold');
  assert.equal(drive(plan)!.blocked,'ONE_TAKER_PER_MARKET');
});

test('game clock and score helpers only report what is verified',()=>{
  assert.equal(footballSecondsRemaining('Q4','5:00'),null,'direction unverified: unknown');
  assert.equal(footballSecondsRemaining('Q4','5:00','countdown'),300);assert.equal(footballSecondsRemaining('Q4','5:00','elapsed'),600);
  assert.equal(footballSecondsRemaining('Q1','15:00','countdown'),3600);assert.equal(footballSecondsRemaining('Q3','0:00','elapsed'),1800);
  assert.equal(footballSecondsRemaining('OT','5:00','countdown'),null);assert.equal(footballSecondsRemaining('Q2','16:00','countdown'),null);
  assert.deepEqual(sideScores('0-17','away'),{yesScore:0,noScore:17});assert.deepEqual(sideScores('0 - 17','home'),{yesScore:17,noScore:0});
  assert.equal(sideScores('0-17',null),null);assert.equal(sideScores('6-4, 3-2','away'),null);
});

// ---- The bot: a whole drive, with a verified game report ----------------------------------------------------

const SLUG='aec-nfl-kc-buf-2026-09-27',T0=Date.parse('2026-09-27T18:00:00Z');
const CHIEFS=4001,BILLS=4002;
type Report={score?:string;period?:string;clock?:string;possession?:number;down?:number;yfd?:number;field?:{teamId:number;yard:number}};
function rawEvent(at:number,report:Report={},league:'nfl'|'cfb'='nfl'){
  const {score='0-17',period='Q2',clock='8:00',possession=CHIEFS,down=1,yfd=10,field={teamId:BILLS,yard:25}}=report;
  return {id:'200001',slug:'nfl-kc-buf-2026-09-27',title:'Chiefs vs Bills',startTime:'2026-09-27T17:00:00Z',active:true,live:true,ended:false,score,period,
    eventState:{type:'football',live:true,ended:false,period,elapsed:clock,updatedAt:new Date(at-500).toISOString(),
      footballState:{driveState:{possessionTeamId:String(possession),down,yfd,fieldPosition:{teamId:String(field.teamId),yard:field.yard}}}},
    markets:[{slug:SLUG,sportsMarketType:'football_team_full_game_winner',status:'MARKET_STATUS_OPEN',active:true,closed:false,
      feeCoefficient:0.0695,orderPriceMinTickSize:0.01,minimumTradeQty:0.01,bestBidQuote:{value:'0.2'},bestAskQuote:{value:'0.21'},
      marketSides:[{long:true,description:'Chiefs',teamId:CHIEFS,team:{id:CHIEFS,name:'Kansas City Chiefs',league,ordering:'away'}},
        {long:false,description:'Bills',teamId:BILLS,team:{id:BILLS,name:'Buffalo Bills',league,ordering:'home'}}]}]};
}
function input(at:number,yesBid:number,report:Report={},league:'NFL'|'CFB'='NFL'):TennisInput {
  const market=normalizeTennisEvent(rawEvent(at,report,league==='NFL'?'nfl':'cfb'),league,at)[0];
  assert.ok(market?.active&&market.live,market?.unavailableReason);
  return {receivedAt:at,source:'REST',sourceTime:at,market,
    book:{bids:[{price:yesBid,quantity:500}],asks:[{price:Math.round((yesBid+0.01)*100)/100,quantity:500}],state:'MARKET_STATE_OPEN',time:new Date(at).toISOString()}};
}
function started(config=defaultLiveTennisConfig(100),league:'NFL'|'CFB'='NFL'):TennisSession {
  const session=createTennisSession({...config,leagues:[league],focusSlug:SLUG},T0-60_000);
  return applyTennisAction(session,{action:'start',commandId:'drive-start'},[],T0-60_000);
}
const open=(session:TennisSession)=>session.positions.find(position=>position.status==='open');
const lastCode=(session:TennisSession)=>session.decisions.at(-1)!.code;

/** Enter on the setup, fill on the next report: returns the session holding the drive trade. */
function entered(){
  let session=started();
  session=stepTennisSession(session,[input(T0,0.2)],T0);
  assert.equal(session.pending?.action,'BUY',session.lastReason);
  assert.equal(session.pending!.plan?.exit,'drive');assert.equal(session.pending!.plan?.code,'EXPLORE_PAPER');
  assert.equal(session.pending!.contextSnapshot?.possessionTeamId,String(CHIEFS));
  session=stepTennisSession(session,[input(T0+1500,0.2,{down:2,yfd:6,field:{teamId:BILLS,yard:21}})],T0+1500);
  const position=open(session)!;
  assert.ok(position,session.lastReason);assert.equal(position.exitPolicy,'drive');assert.equal(position.side,'YES');
  assert.deepEqual(position.plan?.drive,{stopReturn:COMEBACK_DRIVE.stopReturn,maxHoldMs:COMEBACK_DRIVE.maxHoldMs});
  assert.deepEqual(session.drives?.[SLUG],{possessionTeamId:String(CHIEFS),score:'0-17',period:'Q2'});
  return session;
}

test('the bot reads the verified game report into the engine context',()=>{
  const fresh=stepTennisSession(started(),[input(T0,0.2)],T0);
  assert.equal(marketPhase(input(T0,0.2),T0),'live');
  const context=decisionContext(fresh,input(T0,0.2),T0,'live').game!;
  assert.equal(context.status,'live');assert.equal(context.yesScore,0);assert.equal(context.noScore,17);assert.equal(context.period,2);
  assert.equal(context.secondsRemaining,null,'clock direction not verified yet');
  assert.deepEqual(context.extra,{possession:'yes',yardsToEndZone:25,down:1,distance:10});
  // Without a fresh verified report there are no football facts.
  const unknown=decisionContext(createTennisSession(defaultLiveTennisConfig(),T0),input(T0,0.2),T0,'live').game!;
  assert.equal(unknown.extra,undefined);assert.equal(unknown.yesScore,undefined);
  // Own territory counts back from 100.
  const own=stepTennisSession(started(),[input(T0,0.2,{field:{teamId:CHIEFS,yard:40}})],T0);
  assert.equal(decisionContext(own,input(T0,0.2,{field:{teamId:CHIEFS,yard:40}}),T0,'live').game!.extra!.yardsToEndZone,60);
});

test('down 0-17 with the ball at the 25: the bot buys, rides the drive, and sells on the touchdown',()=>{
  let session=entered();
  session=stepTennisSession(session,[input(T0+30_000,0.22,{down:3,yfd:2,field:{teamId:BILLS,yard:12}})],T0+30_000);
  assert.equal(lastCode(session),'DRIVE_HOLD');assert.equal(session.pending,null);
  // Touchdown: between plays, the score has changed.
  session=stepTennisSession(session,[input(T0+60_000,0.3,{score:'6-17',down:0,yfd:0,field:{teamId:BILLS,yard:3}})],T0+60_000);
  assert.equal(session.pending?.action,'SELL');assert.match(session.pending!.reason,/Score changed from 0-17 to 6-17\. Drive over\./);
  session=stepTennisSession(session,[input(T0+61_500,0.3,{score:'7-17',down:0,yfd:0,field:{teamId:BILLS,yard:3}})],T0+61_500);
  const closed=session.positions.at(-1)!;
  assert.equal(closed.status,'closed');assert.ok(closed.realizedPnl>0,`profit ${closed.realizedPnl}`);
  // The drive is over; the Bills get the ball, and the leader having it is no setup.
  session=stepTennisSession(session,[input(T0+120_000,0.3,{score:'7-17',possession:BILLS,field:{teamId:BILLS,yard:25}})],T0+120_000);
  assert.equal(session.drives?.[SLUG],undefined);assert.equal(session.pending,null);assert.equal(open(session),undefined);
});

test('at the end of the drive the bot holds on instead of selling only when measured evidence supports a hold',()=>{
  // The owner publishes a pack mid-drive with a (test) college live-hold lead and a model that likes both sides.
  const pack={...BUNDLED_PACK,version:'test-drive-hold',
    evidence:[...BUNDLED_PACK.evidence,{id:'cfb-live-model-hold-test',title:'Test college live model hold',status:'lead' as const,sports:['CFB' as const],phases:['live' as const],
      styles:['taker-hold' as const],strategies:['model-edge-hold'],estimate:{mean:0.03,lo:-0.01,hi:0.07,unit:'return' as const},sample:'test',source:'test',plain:'test'}],
    models:[{kind:'logistic-v1' as const,id:'test-cfb-live',version:'1',sports:['CFB' as const],phases:['live' as const],intercept:3,weights:{}}]};
  assert.deepEqual(registerPack(pack,'bundled'),{ok:true});
  let session=started(defaultLiveTennisConfig(100),'CFB');
  session=stepTennisSession(session,[input(T0,0.2,{},'CFB')],T0);
  assert.equal(session.pending?.plan?.exit,'drive',session.lastReason);
  session=stepTennisSession(session,[input(T0+1500,0.2,{down:2,yfd:6,field:{teamId:BILLS,yard:21}},'CFB')],T0+1500);
  assert.equal(open(session)?.exitPolicy,'drive');
  session={...session,config:{...session.config,evidencePack:'test-drive-hold'}};
  session=stepTennisSession(session,[input(T0+40_000,0.18,{possession:BILLS,field:{teamId:BILLS,yard:8}},'CFB')],T0+40_000);
  assert.equal(session.pending,null);assert.equal(lastCode(session),'DRIVE_END_HOLD');
  const held=open(session)!;
  assert.equal(held.exitPolicy,'hold-to-settlement');assert.equal(held.plan?.strategy,'model-edge-hold');assert.equal(held.plan?.code,'LEAD_PAPER');
  assert.equal(held.plan?.drive,undefined);
  session=stepTennisSession(session,[input(T0+60_000,0.18,{possession:BILLS,field:{teamId:BILLS,yard:20}},'CFB')],T0+60_000);
  assert.equal(lastCode(session),'HOLD_TO_SETTLEMENT');
});

test('a turnover ends the drive: the bot takes the loss',()=>{
  let session=entered();
  session=stepTennisSession(session,[input(T0+40_000,0.15,{possession:BILLS,field:{teamId:BILLS,yard:8}})],T0+40_000);
  assert.equal(session.pending?.action,'SELL');assert.match(session.pending!.reason,/other team has the ball/);
  session=stepTennisSession(session,[input(T0+41_500,0.15,{possession:BILLS,field:{teamId:BILLS,yard:8}})],T0+41_500);
  assert.equal(session.positions.at(-1)!.status,'closed');assert.ok(session.positions.at(-1)!.realizedPnl<0);
});

test('the stop, the time limit and a silent feed each close the trade; one drive is traded once',()=>{
  // Stop: the bid collapses while the drive still lasts.
  let session=entered();
  session=stepTennisSession(session,[input(T0+20_000,0.12,{down:2,yfd:6,field:{teamId:BILLS,yard:21}})],T0+20_000);
  assert.match(session.pending?.reason??'',/Stop reached/);
  // Time limit, then no re-entry on the same drive.
  session=entered();
  const late=T0+1500+COMEBACK_DRIVE.maxHoldMs;
  session=stepTennisSession(session,[input(late,0.2,{down:3,yfd:3,field:{teamId:BILLS,yard:18}})],late);
  assert.match(session.pending?.reason??'',/Held 12 minutes/);
  session=stepTennisSession(session,[input(late+1500,0.2,{down:3,yfd:3,field:{teamId:BILLS,yard:18}})],late+1500);
  assert.equal(session.positions.at(-1)!.status,'closed');
  session=stepTennisSession(session,[input(late+60_000,0.2,{down:1,yfd:10,field:{teamId:BILLS,yard:15}})],late+60_000);
  assert.equal(session.pending,null);assert.ok(session.decisions.some(row=>row.code==='DRIVE_TRADED'),session.lastReason);
  // The Bills get the ball, then the Chiefs drive again at the same score: a new drive may be traded.
  session=stepTennisSession(session,[input(late+120_000,0.2,{possession:BILLS,field:{teamId:BILLS,yard:30}})],late+120_000);
  session=stepTennisSession(session,[input(late+180_000,0.2,{field:{teamId:BILLS,yard:28}})],late+180_000);
  assert.equal(session.pending?.action,'BUY',session.lastReason);
  // Silent feed: books keep arriving, game reports stop.
  session=entered();
  const quiet=input(T0+140_000,0.2,{down:2,yfd:6,field:{teamId:BILLS,yard:21}});
  quiet.market={...quiet.market,contextUpdatedAt:T0+1000};
  session=stepTennisSession(session,[quiet],T0+140_000);
  assert.match(session.pending?.reason??'',/No game report for 2 minutes/);
});

test('a planned entry is cancelled if possession changes before the fill; exploring off means no entry',()=>{
  let session=stepTennisSession(started(),[input(T0,0.2)],T0);
  assert.equal(session.pending?.action,'BUY');
  session=stepTennisSession(session,[input(T0+1500,0.18,{possession:BILLS,field:{teamId:BILLS,yard:20}})],T0+1500);
  assert.equal(session.pending,null);assert.equal(open(session),undefined);assert.equal(lastCode(session),'CONTEXT_CHANGED');
  const off=stepTennisSession(started({...defaultLiveTennisConfig(100),explore:undefined}),[input(T0,0.2)],T0);
  assert.equal(off.pending,null);
  assert.equal(off.enginePlan?.considered.find(trade=>trade.strategy==='comeback-drive')?.result,'DROPPED');
});

test('explore config: validated, needs the gate, and new accounts explore the comeback drive on paper',()=>{
  assert.deepEqual(defaultLiveTennisConfig().explore,['comeback-drive']);
  assert.equal(validateTennisConfig({...defaultLiveTennisConfig(),explore:['comeback-drive']}),null);
  assert.match(validateTennisConfig({...defaultLiveTennisConfig(),evidenceGate:undefined,maker:undefined,explore:['comeback-drive']})!,/evidence gate/);
  assert.match(validateTennisConfig({...defaultLiveTennisConfig(),explore:['favourite-hold' as 'comeback-drive']})!,/explore/);
  assert.match(validateTennisConfig({...defaultLiveTennisConfig(),explore:['comeback-drive','comeback-drive']})!,/once/);
});
