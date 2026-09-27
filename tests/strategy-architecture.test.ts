import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SPECS,specOf} from '../lib/decision/catalog.ts';
import {canonical,rulesHash,specKey,specSchema} from '../lib/decision/spec.ts';
import {createEngine,defaultEngine,namesStrategy} from '../lib/decision/engine.ts';
import {BUNDLED_PACK} from '../lib/decision/pack.ts';
import {fillForStake,holdEdge,roundTripHurdle} from '../lib/decision/edge.ts';
import {compileModel} from '../lib/decision/models.ts';
import {detectFootballEvents,latestEvent,latestScore,SCORING_PLAY_MS,type GameEvent} from '../lib/decision/events.ts';
import {BUILTIN_FEATURES,featureRegistry,readFeature} from '../lib/decision/features.ts';
import {SPORT_FEATURES} from '../lib/decision/sports/index.ts';
import {noTradeCode,primaryReason} from '../lib/decision/why.ts';
import {advanceShadow,compactShadow,openShadow,primaryResult,settleResult,settleShadow,shadowReadyToCompact} from '../lib/decision/shadow.ts';
import {clusteredInterval,exitComparison,scoreRows,type TradeRecord} from '../lib/decision/scorecard.ts';
import type {DecisionContext} from '../lib/decision/context.ts';
import type {Evidence} from '../lib/decision/evidence.ts';
import type {Strategy} from '../lib/decision/strategies.ts';

// ---- Specs and pre-registration ------------------------------------------------------------------------------

test('every strategy version has a valid spec, and every spec is locked unchanged',async()=>{
  const lock=JSON.parse(readFileSync(new URL('../lib/decision/prereg.lock.json',import.meta.url),'utf8')) as Record<string,string>;
  for(const spec of SPECS){
    assert.ok(specSchema.safeParse(spec).success,specKey(spec));
    assert.equal(lock[specKey(spec)],await rulesHash(spec),`${specKey(spec)} changed after registration: add a new version instead`);
  }
  for(const strategy of defaultEngine.strategies)assert.ok(specOf(strategy.id,strategy.version),`${strategy.id}@${strategy.version} has no spec`);
  // Prose does not change the hash; any rule does.
  const spec=specOf('surprise-fade','1')!;
  assert.equal(await rulesHash({...spec,hypothesis:`${spec.hypothesis} Reworded.`}),await rulesHash(spec));
  assert.notEqual(await rulesHash({...spec,entry:{...spec.entry,params:{...spec.entry.params,minMove:0.07}}}),await rulesHash(spec));
  assert.notEqual(await rulesHash({...spec,exits:{...spec.exits,primary:[{kind:'time',ms:300_000}]}}),await rulesHash(spec));
  assert.equal(canonical({b:1,a:[{d:2,c:3}]}),canonical({a:[{c:3,d:2}],b:1}));
});

test('specs carry the lifecycle: every candidate states its mechanism, evidence for and against, and what kills it',()=>{
  for(const spec of SPECS.filter(item=>item.family!=='control')){
    assert.ok(spec.mechanism.length>40&&spec.invalidation.length>=1,specKey(spec));
    assert.ok(spec.basis.against.length>0||spec.basis.kind==='documented',`${specKey(spec)} must record the evidence against it`);
  }
  assert.equal(specOf('comeback-drive','1')!.basis.kind,'speculative');
  assert.equal(specOf('model-edge-hold','1')!.research.status,'superseded');
  for(const id of ['surprise-fade','drive-fade','quiet-window-maker'])assert.equal(specOf(id,'1')!.research.status,'specified');
});

// ---- Edge ------------------------------------------------------------------------------------------------------

test('edge: the lower bound must clear depth slippage, the taker fee and the latency allowance',()=>{
  const asks=[{price:0.6,quantity:5},{price:0.61,quantity:100}];
  const fill=fillForStake(asks,6.05)!;
  // $3.00 buys all 5 at 60¢; the remaining $3.05 buys 5 at 61¢.
  assert.equal(fill.contracts,10);assert.ok(Math.abs(fill.average-0.605)<1e-12);
  assert.equal(fillForStake([{price:0.6,quantity:1}],5),null,'the visible book cannot fill the stake');
  const fair={p:0.7,lo:0.66,hi:0.74,source:'test'};
  const edge=holdEdge({fair,asks,stake:6.05,feeCoefficient:0.0695,latencyCents:0.5})!;
  const fee=0.0695*fill.average*(1-fill.average);
  assert.ok(Math.abs(edge.breakEven-(fill.average+fee+0.005))<1e-6);
  assert.ok(Math.abs(edge.lowerEdge-(0.66-edge.breakEven))<1e-6);assert.equal(edge.tradable,true);
  assert.ok(edge.slippage>0);
  assert.equal(holdEdge({fair:{p:0.64,lo:0.6,hi:0.68,source:'t'},asks,stake:6.05,feeCoefficient:0.0695,latencyCents:0.5})!.tradable,false);
  assert.equal(holdEdge({fair:{p:0.7,lo:0.8,hi:0.9,source:'bad'},asks,stake:1,feeCoefficient:0.0695,latencyCents:0}),null,'an invalid interval is refused');
  const hurdle=roundTripHurdle(0.5,0.49,0.0695);
  assert.ok(hurdle.requiredExitBid>0.534&&hurdle.requiredExitBid<0.536,`${hurdle.requiredExitBid}`);
});

test('calibration-v1 models return an interval only in their game state',()=>{
  const model=compileModel({kind:'calibration-v1',id:'leader-when-longshot-drives',version:'1',sports:['NFL'],phases:['live'],feature:'price',
    conditions:[{feature:'trailingBy',op:'eq',value:0}],bins:[{min:0.5,max:0.8,n:120,rate:0.71,lo:0.62,hi:0.79},{min:0.8,max:1,n:80,rate:0.93,lo:0.87,hi:0.97}]});
  const features=featureRegistry(SPORT_FEATURES);
  const ctx=(yesScore:number):DecisionContext=>({now:1,phase:'live',market:{slug:'s',sport:'NFL',startTime:0,yes:{ask:0.72,bid:0.71},no:{ask:0.29,bid:0.28}},
    game:{status:'live',yesScore,noScore:3}});
  assert.deepEqual(model.estimate(ctx(10),'yes',features),{p:0.71,lo:0.62,hi:0.79,n:120,source:'leader-when-longshot-drives@1'});
  assert.equal(model.estimate(ctx(0),'yes',features),null,'the state condition is false');
  assert.equal(model.estimate({...ctx(10),game:null},'yes',features),null,'an unknown state gives no estimate');
});

// ---- Events and features ---------------------------------------------------------------------------------------

const state=(over:Partial<{reportTime:number;score:string;period:string;possessionTeamId:string|null;deadBall:boolean}>={})=>
  ({reportTime:1000,score:'0-17',period:'Q2',possessionTeamId:'A',deadBall:false,...over});
test('events: scores, changes of possession, periods and dead balls are detected from successive states',()=>{
  const teams={yes:'A',no:'H'},base={receivedAt:2000,yesOrdering:'away' as const,teams,preYesMid:0.2,atReportYesMid:0.3};
  const score=detectFootballEvents({...base,previous:state(),next:state({reportTime:1100,score:'6-17',deadBall:true})});
  assert.deepEqual(score.map(e=>[e.type,e.side,e.points]),[['score','yes',6],['dead-ball',null,0]]);
  assert.equal(score[0].preYesMid,0.2);assert.equal(score[0].atReportYesMid,0.3);
  const turnover=detectFootballEvents({...base,previous:state(),next:state({reportTime:1100,possessionTeamId:'H'})});
  assert.deepEqual(turnover.map(e=>[e.type,e.side]),[['possession','no']]);
  assert.deepEqual(detectFootballEvents({...base,previous:state(),next:state({reportTime:1100,period:'Q3'})}).map(e=>e.type),['period']);
  assert.deepEqual(detectFootballEvents({...base,previous:state({reportTime:1100}),next:state({reportTime:1100,score:'7-17'})}),[],'not newer');
  assert.deepEqual(detectFootballEvents({...base,previous:state({score:'7-17'}),next:state({reportTime:1100,score:'0-17'})}),[],'a score correction is not an event');
  assert.deepEqual(detectFootballEvents({...base,previous:undefined,next:state()}),[],'the first state has no before');
  const home=detectFootballEvents({...base,yesOrdering:'home',previous:state(),next:state({reportTime:1100,score:'0-20'})});
  assert.equal(home[0].side,'yes','YES is the home team: the second number');
});

test('events: a touchdown and its try are one scoring play, timed and priced from the touchdown',()=>{
  const td:GameEvent={id:'100000:score',type:'score',reportTime:100_000,receivedAt:100_000,side:'no',points:6,score:'0-6',period:'Q2',preYesMid:0.75,atReportYesMid:0.7};
  const pat:GameEvent={...td,id:'160000:score',reportTime:160_000,receivedAt:160_000,points:1,score:'0-7',preYesMid:0.62,atReportYesMid:0.62};
  const play=latestScore([td,pat],170_000)!;
  assert.equal(play.id,td.id);assert.equal(play.receivedAt,100_000);assert.equal(play.preYesMid,0.75);assert.equal(play.points,7);assert.equal(play.score,'0-7');
  assert.equal(latestScore([td,pat],150_000),td,'the try is not seen before it arrives');
  const later={...pat,id:'x',receivedAt:100_000+SCORING_PLAY_MS+1};
  assert.equal(latestScore([td,later],10**9),later,'too far apart: a separate score');
  const other={...pat,side:'yes' as const};
  assert.equal(latestScore([td,other],170_000),other,'the other team scoring is a separate score');
  // surprise-fade keeps its window and its single entry through the try.
  const ctx=eventCtx({events:[{...td,receivedAt:100_000},pat]});
  assert.equal(byStrategy(plan(ctx),'surprise-fade')[0]?.proposal.setupKey,td.id);
});

function eventCtx(over:Partial<DecisionContext>={}):DecisionContext {
  const event:GameEvent={id:'1100:score',type:'score',reportTime:100_000,receivedAt:100_000,side:'no',points:7,score:'0-7',period:'Q2',preYesMid:0.75,atReportYesMid:0.7};
  return {now:190_000,phase:'live',market:{slug:'s',sport:'NFL',startTime:0,observedAt:189_000,pregameYesMid:0.8,
    yes:{ask:0.62,bid:0.61,askSize:400,bidSize:1200,asks:[{price:0.62,quantity:400},{price:0.63,quantity:300},{price:0.66,quantity:9000}],bids:[{price:0.61,quantity:1200}]},
    no:{ask:0.39,bid:0.38}},game:{status:'live',observedAt:180_000},events:[event],
    history:[{time:160_000,yesBid:0.64,yesAsk:0.65},{time:185_000,yesBid:0.61,yesAsk:0.62}],...over};
}
test('features: freshness, book shape, pregame move, velocity and the last score, per side',()=>{
  const ctx=eventCtx(),f=(name:string,side:'yes'|'no'='yes')=>readFeature(BUILTIN_FEATURES,name,ctx,side);
  assert.equal(f('quoteAgeMs'),1000);assert.equal(f('gameReportAgeMs'),10_000);
  assert.equal(f('imbalance'),0.5);assert.equal(f('askDepth2c'),700);assert.equal(f('bidDepth2c'),1200);
  assert.ok(Math.abs((f('velocity30s') as number)+3)<1e-9,'down 3¢ in 30 s');
  assert.equal(f('pregamePrice'),0.8);assert.ok(Math.abs((f('moveSincePregame') as number)+18.5)<1e-9);
  assert.equal(f('lastScore.secondsSince'),90);assert.equal(f('lastScore.bySide','no'),true);assert.equal(f('lastScore.bySide','yes'),false);
  assert.ok(Math.abs((f('lastScore.scorerPreEventPrice') as number)-0.25)<1e-9,'NO was 25¢ before it scored');
  assert.ok(Math.abs((f('lastScore.moveAgainst','yes') as number)-0.135)<1e-9,'YES fell from 75¢ to 61.5¢');
  assert.ok(Math.abs((f('lastScore.movedBeforeReport') as number)-0.05)<1e-9);
  assert.equal(latestEvent(ctx.events,'score',99_000),undefined,'events are not seen before they arrive');
  assert.equal(readFeature(BUILTIN_FEATURES,'driveNumber',ctx,'yes'),1);
});

// ---- The football candidates ---------------------------------------------------------------------------------

const plan=(ctx:DecisionContext)=>defaultEngine.plan(ctx,{mode:'paper'});
const byStrategy=(p:ReturnType<typeof plan>,id:string)=>p.considered.filter(t=>t.proposal.strategy===id);

test('surprise-fade@1 buys the team scored on only after a surprising score, a big move, inside its window',()=>{
  const trade=byStrategy(plan(eventCtx()),'surprise-fade')[0];
  assert.ok(trade,'underdog (25¢) scored, YES fell 13.5¢, 90 s later');
  assert.equal(trade.proposal.side,'yes');assert.equal(trade.proposal.price,0.62);assert.equal(trade.proposal.setupKey,'1100:score');
  assert.deepEqual(trade.proposal.exit,{kind:'hold-to-settlement'});
  // Not a paper trade: in NFL the blanket "live holds lose" result blocks it until its own study reports; in college
  // nothing is measured. Either way it is shadowed, never traded.
  assert.equal(trade.blocked,'DROPPED');assert.ok(plan(eventCtx()).shadow.some(t=>t.proposal.strategy==='surprise-fade'));
  const college=byStrategy(plan(eventCtx({market:{...eventCtx().market,sport:'CFB'}})),'surprise-fade')[0];
  assert.equal(college.blocked,'NO_EVIDENCE');
  const why=(ctx:DecisionContext)=>plan(ctx).notes.find(note=>note.strategy==='surprise-fade');
  assert.equal(why(eventCtx({now:120_000,market:{...eventCtx().market,observedAt:119_000}}))!.code,'WAITING');
  assert.equal(why(eventCtx({now:300_000,market:{...eventCtx().market,observedAt:299_000}}))!.code,'NO_SETUP');
  const expected={...eventCtx().events![0],preYesMid:0.4};
  assert.match(why(eventCtx({events:[expected]}))!.detail,/Expected score/);
  const small={...eventCtx().events![0],preYesMid:0.66};
  assert.match(why(eventCtx({events:[small]}))!.detail,/moved 4\.5¢/);
  assert.match(why(eventCtx({events:[]}))!.detail,/No score/);
});

function driveCtx(over:{possession?:'yes'|'no';yesAsk?:number;yards?:number;down?:number;yesScore?:number}={}):DecisionContext {
  const yesAsk=over.yesAsk??0.2;
  return {now:1_000_000,phase:'live',market:{slug:'d',sport:'NFL',startTime:0,feeCoefficient:0.0695,observedAt:999_000,
    yes:{ask:yesAsk,bid:yesAsk-0.01,askSize:500,bidSize:500},no:{ask:Math.round((1-yesAsk+0.01)*100)/100,bid:Math.round((1-yesAsk)*100)/100,askSize:500,bidSize:500}},
    game:{status:'live',period:2,yesScore:over.yesScore??0,noScore:17,extra:{possession:over.possession??'yes',yardsToEndZone:over.yards??25,down:over.down??1,distance:10,phase:'play'}}};
}
test('drive-fade@1 buys the leader when a trailing longshot drives; comeback-drive proposes the opposite on the same setup',()=>{
  const p=plan(driveCtx());
  const fade=byStrategy(p,'drive-fade')[0],comeback=p.considered.filter(t=>t.proposal.strategy.startsWith('comeback-drive'));
  assert.equal(fade.proposal.side,'no');assert.equal(fade.proposal.price,0.81);assert.deepEqual(fade.proposal.exit,{kind:'hold-to-settlement'});
  assert.deepEqual(comeback.map(t=>[t.proposal.strategyVersion,t.proposal.side,t.proposal.style]),[['1','yes','taker-scalp'],['1','yes','taker-hold']]);
  assert.equal(fade.proposal.setupKey,comeback[0].proposal.setupKey,'the same drive');
  // NFL: the blanket in-game results block all three; all are shadowed, none traded.
  assert.ok(['drive-fade','comeback-drive','comeback-drive-hold'].every(id=>p.shadow.some(t=>t.proposal.strategy===id)));
  assert.equal(p.actions.length,0);
  const note=(ctx:DecisionContext)=>plan(ctx).notes.find(n=>n.strategy==='drive-fade');
  assert.match(note(driveCtx({yesAsk:0.4}))!.detail,/not a longshot/);
  assert.equal(note(driveCtx({yards:40}))!.code,'WAITING');
  assert.equal(note(driveCtx({possession:'no'}))!.code,'NO_SETUP');
});

test('quiet-window-maker@1 rests quotes only during a fresh dead-ball window with a calm price',()=>{
  const ctx=(extra:Record<string,string|number>,history?:DecisionContext['history']):DecisionContext=>({now:1_000_000,phase:'live',
    market:{slug:'q',sport:'CFB',startTime:0,observedAt:999_000,yes:{ask:0.51,bid:0.5},no:{ask:0.5,bid:0.49}},game:{status:'live',extra},...(history?{history}:{})});
  const quiet=plan(ctx({phase:'dead-ball',deadBallSeconds:8}));
  const makers=byStrategy(quiet,'quiet-window-maker');
  assert.deepEqual(makers.map(t=>[t.proposal.side,t.proposal.price,t.proposal.style]),[['yes',0.5,'maker'],['no',0.49,'maker']]);
  assert.deepEqual(makers[0].proposal.exit,{kind:'maker',pullAfterEventMs:null,windowOnly:true});
  const note=(c:DecisionContext)=>plan(c).notes.find(n=>n.strategy==='quiet-window-maker')!;
  assert.match(note(ctx({phase:'play'})).detail,/Ball in play/);
  assert.match(note(ctx({phase:'dead-ball',deadBallSeconds:25})).detail,/window over/);
  assert.equal(note(ctx({phase:'dead-ball',deadBallSeconds:5},[{time:970_000,yesBid:0.46,yesAsk:0.47},{time:998_000,yesBid:0.5,yesAsk:0.51}])).code,'ALREADY_REACTED');
});

// ---- Engine: retirement, versioned evidence, why-no-trade ------------------------------------------------------

test('retired versions never propose; evidence can name one exact version',()=>{
  const old:Strategy={id:'model-edge-hold',version:'1',description:'',propose:()=>[{strategy:'model-edge-hold',strategyVersion:'1',side:'yes',style:'taker-hold',price:0.2,exit:{kind:'hold-to-settlement'},rationale:''}]};
  assert.equal(defaultEngine.plan(driveCtx(),{mode:'paper',use:[old]}).considered.length,0,'model-edge-hold@1 is superseded');
  const row=(strategies:string[]):Evidence=>({id:'r',title:'r',status:'lead',sports:['NFL'],phases:['live'],styles:['taker-hold'],strategies,estimate:{mean:0.05,lo:0.01,hi:0.09,unit:'return'},sample:'t',source:'t',plain:'t'});
  assert.equal(namesStrategy(row(['drive-fade@1']),'drive-fade','1'),true);
  assert.equal(namesStrategy(row(['drive-fade@2']),'drive-fade','1'),false,'a result for version 2 does not apply to version 1');
  assert.equal(namesStrategy(row(['drive-fade']),'drive-fade','7'),true,'a bare id covers every version');
  const engine=createEngine({pack:{...BUNDLED_PACK,version:'t-v2-only',evidence:[...BUNDLED_PACK.evidence,row(['drive-fade@2'])]},trust:'bundled'});
  assert.equal(byStrategy(engine.plan(driveCtx(),{mode:'paper'}),'drive-fade')[0].blocked,'DROPPED','v1 still blocked by the blanket NFL result');
  const v1=createEngine({pack:{...BUNDLED_PACK,version:'t-v1',evidence:[...BUNDLED_PACK.evidence,row(['drive-fade@1'])]},trust:'bundled'});
  assert.equal(byStrategy(v1.plan(driveCtx(),{mode:'paper'}),'drive-fade')[0].verdict.code,'LEAD_PAPER');
});

test('why no trade: one primary reason from a fixed vocabulary',()=>{
  assert.equal(noTradeCode('EVIDENCE_DROPPED'),'EVIDENCE_DROPPED');assert.equal(noTradeCode('DROPPED'),'EVIDENCE_DROPPED');
  assert.equal(noTradeCode('CONTEXT_STALE'),'STALE_GAME_STATE');assert.equal(noTradeCode('DRIVE_TRADED'),'DUPLICATE');assert.equal(noTradeCode('SPREAD'),'SPREAD_TOO_WIDE');
  assert.equal(noTradeCode('SOMETHING_NEW'),'STALE_BOOK','unknown codes block, never pass');
  assert.equal(primaryReason([],[]).code,'NO_SETUP');
  assert.equal(primaryReason([{strategy:'a',code:'NO_EVIDENCE',detail:''},{strategy:'b',code:'SPREAD',detail:''}],[]).code,'SPREAD_TOO_WIDE');
  assert.equal(primaryReason([],[{strategy:'a',code:'WAITING',detail:''},{strategy:'b',code:'NO_SETUP',detail:''}]).code,'WAITING');
  const p=plan(driveCtx({possession:'no'}));
  assert.ok(p.why);assert.equal(p.actions.length,0);
  const live=plan(eventCtx());
  assert.equal(live.why!.code,'EVIDENCE_DROPPED','a measured loser outranks "not measured yet"');
});

// ---- Shadow and counterfactuals --------------------------------------------------------------------------------

const exits=specOf('surprise-fade','1')!.exits;
function shadow(){
  return openShadow({id:'s1',kind:'candidate',strategy:'surprise-fade',version:'1',slug:'m',sport:'NFL',side:'yes',mode:'taker',time:0,yesBid:0.6,yesAsk:0.61,
    maxSpread:0.02,primary:exits.primary,alternatives:exits.alternatives,football:true,askDepth2c:700,state:'Q2',preEventSideMid:0.75});
}
test('shadow: the base leg enters at the signal ask; delayed, opposite and maker legs follow the books actually seen',()=>{
  const t=shadow();
  const base=t.legs.find(l=>l.id==='base')!;
  assert.deepEqual(base.entry,{time:0,price:0.61,fee:Math.round(0.0695*0.61*0.39*1e6)/1e6,mid:0.605});
  assert.equal(t.legs.find(l=>l.id==='opposite')!.entry!.price,0.4);
  assert.equal(t.legs.find(l=>l.id==='delay-15s')!.status,'waiting');
  assert.deepEqual(t.context,{priceBucket:'0.6–0.7',liquidity:'normal',state:'Q2',spread:0.01,fair:null});
  advanceShadow(t,{time:16_000,yesBid:0.63,yesAsk:0.64});
  assert.equal(t.legs.find(l=>l.id==='delay-15s')!.entry!.price,0.64);
  assert.equal(t.legs.find(l=>l.id==='maker')!.status,'waiting','YES ask never fell to the 60¢ resting bid');
  advanceShadow(t,{time:20_000,yesBid:0.58,yesAsk:0.6});
  assert.equal(t.legs.find(l=>l.id==='maker')!.entry!.price,0.6,'conservative maker fill');
  assert.ok(t.legs.find(l=>l.id==='maker')!.entry!.fee<0,'the maker rebate lowers the cost');
  // A 30 s delayed entry on a book wider than the spec allows waits, then misses.
  advanceShadow(t,{time:31_000,yesBid:0.5,yesAsk:0.6});advanceShadow(t,{time:62_000,yesBid:0.5,yesAsk:0.6});
  assert.equal(t.legs.find(l=>l.id==='delay-30s')!.status,'missed');
});

test('shadow: exits under every policy, the primary result, excursions, and settlement',()=>{
  const t=shadow();
  advanceShadow(t,{time:60_000,yesBid:0.55,yesAsk:0.56});
  const base=t.legs.find(l=>l.id==='base')!,policy=(id:string)=>base.policies.find(p=>p.id===id)!;
  assert.equal(policy('stop-10').status,'closed');assert.equal(policy('stop-10').why,'stop');
  assert.ok(t.mae<-0.1);
  advanceShadow(t,{time:130_000,yesBid:0.72,yesAsk:0.73});
  assert.equal(policy('time-2m').status,'closed');assert.equal(policy('time-2m').exitPrice,0.72);
  assert.equal(policy('target-10').why,'target');
  assert.equal(policy('retrace-half').why,'retrace','mid 72.5¢ recovered half of the 60.5¢→75¢ fall');
  assert.ok(t.mfe>0.1);
  advanceShadow(t,{time:200_000,yesBid:0.65,yesAsk:0.66,driveEnded:true});
  assert.equal(policy('drive-end').why,'drive-end');
  assert.equal(policy('trailing-10').why,'trailing');
  assert.equal(primaryResult(t),null,'the primary exit (settlement) is still open');
  settleShadow(t,1,4_000_000);
  const r=primaryResult(t)!;
  assert.equal(r.why,'settlement');assert.ok(Math.abs(r.ret-(1-0.61-base.entry!.fee)/(0.61+base.entry!.fee))<1e-6);
  assert.equal(t.legs.find(l=>l.id==='opposite')!.policies.find(p=>p.id==='hold')!.ret,-1);
  assert.equal(t.done,true);
});

test('shadow: maker candidates rest, fill conservatively, and mark out after 60 s with the rebate',()=>{
  const spec=specOf('quiet-window-maker','1')!;
  const t=openShadow({id:'m1',kind:'candidate',strategy:'quiet-window-maker',version:'1',slug:'m',sport:'CFB',side:'yes',mode:'maker',time:0,yesBid:0.5,yesAsk:0.51,
    maxSpread:0.03,primary:spec.exits.primary,alternatives:spec.exits.alternatives,football:true,state:'Q2',restMs:20_000});
  assert.equal(t.legs.length,1);
  advanceShadow(t,{time:5_000,yesBid:0.49,yesAsk:0.5});
  const leg=t.legs[0];assert.equal(leg.entry!.price,0.5);
  advanceShadow(t,{time:66_000,yesBid:0.52,yesAsk:0.53});
  const markout=leg.policies.find(p=>p.id==='primary')!;
  assert.equal(markout.why,'markout');
  assert.ok(Math.abs(markout.ret!-((0.525-0.5+0.0125*0.25)/0.5))<1e-6);
  const unfilled=openShadow({id:'m2',kind:'candidate',strategy:'quiet-window-maker',version:'1',slug:'m',sport:'CFB',side:'yes',mode:'maker',time:0,yesBid:0.5,yesAsk:0.51,
    maxSpread:0.03,primary:spec.exits.primary,alternatives:[],football:true,state:'Q2',restMs:20_000});
  advanceShadow(unfilled,{time:25_000,yesBid:0.5,yesAsk:0.51});
  assert.equal(unfilled.legs[0].status,'missed');
});

test('shadow: compacted once only the final is pending, then settled from the compact record',()=>{
  const t=shadow();
  advanceShadow(t,{time:16_000,yesBid:0.6,yesAsk:0.61});advanceShadow(t,{time:31_000,yesBid:0.6,yesAsk:0.61});
  assert.equal(shadowReadyToCompact(t),false,'in-game exits still running');
  advanceShadow(t,{time:1_000_000,yesBid:0.6,yesAsk:0.61});
  assert.equal(shadowReadyToCompact(t),false,'30-minute capped counterfactuals still running');
  advanceShadow(t,{time:1_900_000,yesBid:0.6,yesAsk:0.61});
  assert.equal(shadowReadyToCompact(t),true,'only settlement-only policies remain open');
  const compact=compactShadow(t,1_900_000);
  assert.equal(compact.primary,null);assert.ok(compact.awaiting.some(([leg,policy])=>leg==='base'&&policy==='primary'));
  assert.ok(compact.results.some(([leg,policy])=>leg==='base'&&policy==='time-12m'));
  settleResult(compact,0,5_000_000);
  assert.equal(compact.primary!.ret,-1);assert.equal(compact.awaiting.length,0);assert.equal(compact.closedAt,5_000_000);
  // The same as settling the full shadow.
  settleShadow(t,0,5_000_000);assert.equal(primaryResult(t)!.ret,compact.primary!.ret);
});

// ---- Scorecard ---------------------------------------------------------------------------------------------------

test('scorecard: comparable rows per version and sample, clustered by game, with a plain verdict',()=>{
  const rec=(i:number,ret:number,sample:TradeRecord['sample']='forward-shadow',strategy='surprise-fade'):TradeRecord=>
    ({strategy,version:'1',sample,game:`g${i%12}`,time:i,ret,pnl:ret*5,entrySpread:0.01,holdMs:60_000,priceBucket:ret>0?'0.6–0.7':'0.3–0.4',liquidity:'normal',state:'Q2',won:ret>0});
  const winners=Array.from({length:40},(_,i)=>rec(i,i%5===0?-0.2:0.15));
  const rows=scoreRows([...winners,...Array.from({length:40},(_,i)=>rec(i,i%3===0?0.1:-0.2,'forward-paper')),rec(1,0.5,'holdout','drive-fade')]);
  const shadowRow=rows.find(r=>r.key==='surprise-fade@1|forward-shadow')!;
  assert.equal(shadowRow.n,40);assert.equal(shadowRow.games,12);assert.equal(shadowRow.verdict,'edge');assert.match(shadowRow.reason,/above zero/);
  assert.equal(shadowRow.winRate,0.8);assert.deepEqual(Object.keys(shadowRow.byPrice),['0.3–0.4','0.6–0.7']);
  assert.equal(rows.find(r=>r.key==='surprise-fade@1|forward-paper')!.verdict,'no-edge');
  assert.equal(rows.find(r=>r.key==='drive-fade@1|holdout')!.verdict,'insufficient');
  assert.ok(shadowRow.maxDrawdown>0);
  // Deterministic: the same records give the same interval.
  assert.deepEqual(clusteredInterval(winners,'k'),clusteredInterval(winners,'k'));
  const exitsTable=exitComparison([{strategy:'s',version:'1',leg:'base',policy:'hold',ret:0.2,game:'a'},{strategy:'s',version:'1',leg:'base',policy:'hold',ret:-0.1,game:'b'},
    {strategy:'s',version:'1',leg:'base',policy:'time-5m',ret:0.01,game:'a'}]);
  assert.deepEqual(exitsTable.map(r=>[r.policy,r.n]),[['hold',2],['time-5m',1]]);
});
