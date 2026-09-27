import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,defaultTennisConfig} from '../lib/tennis/rules.ts';
import {sessionExitResults,sessionTradeRecords} from '../lib/tennis/research-tracking.ts';
import {scoreRows} from '../lib/decision/scorecard.ts';
import type {TennisConfig,TennisInput,TennisSession} from '../lib/tennis/types';

const T0=Date.parse('2026-09-27T18:00:00Z'),AWAY=4001,HOME=4002;
type Report={score?:string;period?:string;possession?:number;down?:number;yfd?:number;field?:{teamId:number;yard:number};reportAt?:number};
const slugFor=(league:'NFL'|'CFB')=>`aec-${league.toLowerCase()}-away-home-2026-09-27`;

function input(at:number,yesBid:number,report:Report={},league:'NFL'|'CFB'='NFL',extra:Partial<TennisInput>={}):TennisInput {
  const {score='0-17',period='Q2',possession=AWAY,down=1,yfd=10,field={teamId:HOME,yard:25},reportAt=at-500}=report;
  const lg=league.toLowerCase();
  const raw={id:'300001',slug:`${lg}-away-home-2026-09-27`,title:'Away vs Home',startTime:'2026-09-27T17:00:00Z',active:true,live:true,ended:false,score,period,
    eventState:{type:'football',live:true,ended:false,period,elapsed:'8:00',updatedAt:new Date(reportAt).toISOString(),
      footballState:{driveState:{possessionTeamId:String(possession),down,yfd,fieldPosition:{teamId:String(field.teamId),yard:field.yard}}}},
    markets:[{slug:slugFor(league),sportsMarketType:'football_team_full_game_winner',status:'MARKET_STATUS_OPEN',active:true,closed:false,
      feeCoefficient:0.0695,orderPriceMinTickSize:0.01,minimumTradeQty:0.01,bestBidQuote:{value:String(yesBid)},bestAskQuote:{value:String(yesBid+0.01)},
      marketSides:[{long:true,description:'Away',teamId:AWAY,team:{id:AWAY,name:'Away Team',league:lg,ordering:'away'}},
        {long:false,description:'Home',teamId:HOME,team:{id:HOME,name:'Home Team',league:lg,ordering:'home'}}]}]};
  const market=normalizeTennisEvent(raw,league,at)[0];
  assert.ok(market?.active,market?.unavailableReason);
  const ask=Math.round((yesBid+0.01)*100)/100;
  return {receivedAt:at,source:'REST',sourceTime:at,market,book:{bids:[{price:yesBid,quantity:800},{price:Math.round((yesBid-0.01)*100)/100,quantity:900}],
    asks:[{price:ask,quantity:800},{price:Math.round((ask+0.01)*100)/100,quantity:900}],state:'MARKET_STATE_OPEN',time:new Date(at).toISOString()},...extra};
}
function running(config:TennisConfig=defaultLiveTennisConfig(100),league:'NFL'|'CFB'='NFL'):TennisSession {
  const session=createTennisSession({...config,leagues:[league],focusSlug:slugFor(league)},T0-120_000);
  return applyTennisAction(session,{action:'start',commandId:'go'},[],T0-120_000);
}
/** Feed successive books: [time offset, YES bid, report]. */
function play(session:TennisSession,steps:[number,number,Report?][],league:'NFL'|'CFB'='NFL',base=T0){
  for(const [dt,bid,report] of steps)session=stepTennisSession(session,[input(base+dt,bid,report,league)],base+dt);
  return session;
}

test('new accounts measure the drive candidates in shadow and never trade them',()=>{
  let session=play(running(),[[0,0.2],[2_500,0.2,{down:2,field:{teamId:HOME,yard:20}}]]);
  assert.equal(session.pending,null);assert.equal(session.positions.length,0,'no paper trade: nothing is measured yet');
  const ids=(session.shadows??[]).map(s=>`${s.strategy}@${s.version}`).sort();
  assert.deepEqual(ids,['comeback-drive-hold@1','comeback-drive@1','drive-fade@1'],'one shadow per candidate for this drive');
  assert.equal(session.whyNot?.code,'EVIDENCE_DROPPED','NFL blanket results block them all');
  const counts=session.whyCounts?.EVIDENCE_DROPPED;
  session=stepTennisSession(session,[input(T0+2_500,0.2,{down:2,field:{teamId:HOME,yard:20}})],T0+3_000);
  assert.equal(session.whyCounts?.EVIDENCE_DROPPED,counts,'a repeated book is not a new evaluation');
  // Touchdown for the trailing team; the drive ends; then the final.
  session=play(session,[[60_000,0.3,{score:'7-17',down:0,yfd:0,field:{teamId:HOME,yard:3}}],[120_000,0.31,{score:'7-17',possession:HOME,field:{teamId:HOME,yard:25}}]]);
  const tape=session.gameTape?.[slugFor('NFL')]??[];
  assert.deepEqual(tape.map(e=>[e.type,e.side,e.points]),[['score','yes',7],['dead-ball',null,0],['possession','no',0]]);
  const comeback=session.shadows!.find(s=>s.strategy==='comeback-drive')!;
  assert.equal(comeback.legs[0].policies.find(p=>p.id==='primary')!.why,'drive-end','sold (in shadow) when the drive ended');
  assert.ok(comeback.legs[0].policies.find(p=>p.id==='primary')!.ret!>0);
  session=stepTennisSession(session,[input(T0+4_000_000,0.99,{score:'7-17',possession:HOME},'NFL',{settlement:0,settlementReceivedAt:T0+4_000_000})],T0+4_000_000);
  assert.equal(session.shadows!.length,0,'the final settles every shadow');
  assert.equal(session.shadowResults!.length,4,'and keeps a compact result for each');
  assert.ok(JSON.stringify(session.shadowResults).length<4*1200,'compact: under 1.2 KB each');
  const records=sessionTradeRecords(session);
  // The trailing team's touchdown was itself a surprising score (scorer ~20¢, up 10¢), so surprise-fade shadowed the leader too.
  assert.deepEqual(records.map(r=>`${r.strategy}|${r.sample}`).sort(),['comeback-drive-hold|forward-shadow','comeback-drive|forward-shadow','drive-fade|forward-shadow','surprise-fade|forward-shadow']);
  assert.ok(records.find(r=>r.strategy==='drive-fade')!.ret>0,'the leader won');
  assert.ok(records.find(r=>r.strategy==='comeback-drive-hold')!.ret===-1,'the trailing team lost');
  const rows=scoreRows(records);
  assert.ok(rows.every(row=>row.verdict==='insufficient'));
  const exits=sessionExitResults(session);
  assert.ok(exits.some(e=>e.strategy==='comeback-drive'&&e.leg==='opposite'&&e.policy==='hold'));
});

test('a surprising score opens a surprise-fade shadow after the wait, with the pre-event price from before the report',()=>{
  let session=running(defaultLiveTennisConfig(100),'CFB');
  // YES (away) leads 17-0 and is the favourite at ~75¢; the home underdog has the ball.
  session=play(session,[[0,0.75,{score:'17-0',possession:HOME,field:{teamId:AWAY,yard:40}}],[20_000,0.75,{score:'17-0',possession:HOME,field:{teamId:AWAY,yard:30}}],
    [40_000,0.74,{score:'17-0',possession:HOME,field:{teamId:AWAY,yard:20}}]],'CFB');
  // Underdog touchdown: the favourite drops to 60¢.
  session=play(session,[[50_000,0.6,{score:'17-7',down:0,yfd:0,possession:HOME,field:{teamId:AWAY,yard:3}}]],'CFB');
  const event=session.gameTape![slugFor('CFB')].find(e=>e.type==='score')!;
  assert.equal(event.side,'no');assert.equal(event.preYesMid,0.755,'the book from ≥ 30 s before the report');
  assert.equal(event.atReportYesMid,0.745,'the last book before the report reached us');
  session=play(session,[[70_000,0.6,{score:'17-7',down:0,yfd:0,possession:HOME,field:{teamId:AWAY,yard:3}}]],'CFB');
  assert.ok(!(session.shadows??[]).some(s=>s.strategy==='surprise-fade'),'waits 45 s after the report');
  assert.equal(session.enginePlan?.notes?.find(n=>n.strategy==='surprise-fade')?.code,'WAITING');
  session=play(session,[[100_000,0.6,{score:'17-7',possession:AWAY,field:{teamId:AWAY,yard:25}}]],'CFB');
  const fade=session.shadows!.find(s=>s.strategy==='surprise-fade')!;
  assert.ok(fade,JSON.stringify(session.enginePlan?.notes));
  assert.equal(fade.legs[0].side,'yes');assert.equal(fade.legs[0].entry!.price,0.61);assert.equal(fade.setupKey,event.id);
  assert.equal(fade.preEventSideMid,0.755);assert.equal(session.positions.length,0);
});

test('quiet-window-v1 rests quotes only in a dead-ball window; paper-v1 accounts measure it in shadow',()=>{
  const quiet=running({...defaultLiveTennisConfig(100),maker:'quiet-window-v1'},'CFB');
  let session=play(quiet,[[0,0.5,{score:'7-7'}],[20_000,0.5,{score:'7-7'}]],'CFB');
  assert.ok(!session.maker?.quotes.YES,'ball in play: no quotes');
  session=play(session,[[40_000,0.5,{score:'7-10',down:0,yfd:0}]],'CFB');
  assert.equal(session.maker?.quotes.YES?.price,0.5,'college live resting orders are a lead; the dead ball opens the window');
  assert.equal(session.maker?.quotes.NO?.price,0.49);
  session=play(session,[[70_000,0.5,{score:'7-10',down:0,yfd:0}]],'CFB');
  assert.ok(!session.maker?.quotes.YES,'window over: pulled before the snap');
  const plain=play(running(defaultLiveTennisConfig(100),'CFB'),[[0,0.5,{score:'7-7'}],[20_000,0.5,{score:'7-7'}],[40_000,0.5,{score:'7-10',down:0,yfd:0}]],'CFB');
  assert.deepEqual((plain.shadows??[]).filter(s=>s.strategy==='quiet-window-maker').map(s=>s.legs[0].side).sort(),['no','yes']);
});

test('executed paper trades carry counterfactuals and excursions; legacy accounts get none of the bookkeeping',()=>{
  let session=running({...defaultLiveTennisConfig(100),explore:['comeback-drive']});
  session=play(session,[[0,0.2],[2_500,0.2,{down:2,field:{teamId:HOME,yard:20}}],[20_000,0.17,{down:3,field:{teamId:HOME,yard:18}}],[40_000,0.25,{down:1,field:{teamId:HOME,yard:9}}]]);
  const position=session.positions.find(p=>p.status==='open')!;
  assert.equal(position.plan?.strategy,'comeback-drive');assert.ok(position.mae!<0&&position.mfe!>0,`${position.mae} ${position.mfe}`);
  assert.equal(position.entrySpread,0.01);
  const exec=session.shadows!.find(s=>s.id===`exec|${position.id}`)!;
  assert.equal(exec.kind,'executed');assert.equal(exec.legs[0].entry!.price,position.entryPrice);
  assert.ok(exec.legs.some(l=>l.id==='opposite')&&exec.legs[0].policies.some(p=>p.id==='hold'));
  assert.ok(!session.shadows!.some(s=>s.kind==='candidate'&&s.strategy==='comeback-drive'),'traded, so not also a candidate');
  const legacy=play(running(defaultTennisConfig(100)),[[0,0.2],[2_500,0.2]]);
  assert.equal(legacy.gameTape,undefined);assert.equal(legacy.pregame,undefined);assert.equal(legacy.shadows,undefined);
});

test('engine accounts record the last pregame price per market',()=>{
  const league='CFB',start=Date.parse('2026-09-27T17:00:00Z');
  const pre=input(start-600_000,0.62,{},league);
  pre.market={...pre.market,live:false,period:'NS',football:null};
  let session=createTennisSession({...defaultLiveTennisConfig(100),leagues:[league],focusSlug:slugFor(league)},start-700_000);
  session=applyTennisAction(session,{action:'start',commandId:'go'},[],start-700_000);
  session=stepTennisSession(session,[pre],start-600_000);
  assert.deepEqual(session.pregame?.[slugFor(league)],{mid:0.625,time:start-600_000});
});
