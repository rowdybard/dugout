import test from 'node:test';
import assert from 'node:assert/strict';
import {assessFootballContext} from '../lib/tennis/football-context.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {decisionContext} from '../lib/tennis/engine-plan.ts';
import {recordGameEvents} from '../lib/tennis/research-tracking.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types.ts';

const T0=Date.parse('2026-10-03T03:00:00Z'),SLUG='synthetic-cfb-composite';
function input(time=T0,bid=.60,ask=.61):TennisInput {
  return {receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:1000}],asks:[{price:ask,quantity:1000}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{
    slug:SLUG,eventId:'pm-game',eventSlug:'cfb-a-b',title:'A vs B',league:'CFB',yesName:'A',noName:'B',yesOrdering:'away',startTime:new Date(T0-600000).toISOString(),
    live:true,ended:false,active:true,score:'7-7',period:'Q2',clock:'10:00',tournament:null,bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
    footballIdentity:{yesTeamId:'11',noTeamId:'22'},football:{possessionTeam:'A',possessionTeamId:'11',down:1,yardsToGo:10,fieldPosition:{team:'A',teamId:'11',yard:25},timeouts:[]},
    footballSources:{scoreboard:{provider:'POLYMARKET',eventId:'pm-game',reportTime:time,receiptTime:time},
      drive:{provider:'ESPN',eventId:'espn-game',playId:'play-1',sequence:1,reportTime:T0,receiptTime:time,score:'7-7',period:'Q2'},
      mapping:{yesPolymarketTeamId:'11',noPolymarketTeamId:'22',yesEspnTeamId:'101',noEspnTeamId:'202'}},
    execution:{slug:SLUG,league:'CFB',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.005,feeCoefficient:.0695}}};
}
function native(time:number,bid=.60,ask=.61){const next=input(time,bid,ask);next.market.footballSources!.drive={provider:'POLYMARKET',eventId:'pm-game',reportTime:time,receiptTime:time};delete next.market.footballSources!.mapping;return next;}
function started(bold=false,drive=false):TennisSession {
  const session=createTennisSession({...defaultLiveTennisConfig(100),leagues:['CFB'],focusSlug:SLUG,entries:bold?'all':'steady',autoMode:false,explore:drive?['comeback-drive']:[]},T0-60000);
  return applyTennisAction(session,{action:'start',commandId:'start'},[],T0-60000);
}
function changedPlay(book:TennisInput,sequence:number,team:'A'|'B'='A'){
  const drive=book.market.footballSources!.drive;
  drive.playId=`play-${sequence}`;drive.sequence=sequence;drive.reportTime=book.receivedAt;
  book.market.football!.possessionTeam=team;book.market.football!.possessionTeamId=team==='A'?'11':'22';
  return book;
}

test('PM clock refreshes never refresh the ESPN play time; the older component controls freshness',()=>{
  const first=assessFootballContext(input().market,T0);
  const clock=input(T0+10000);clock.market.clock='9:50';
  const fresh=assessFootballContext(clock.market,T0+10000,first);
  assert.equal(fresh.assessment.status,'fresh');assert.equal(fresh.report?.reportTime,T0);
  assert.equal(fresh.report?.clock,'9:50');assert.equal(fresh.scoreboard?.reportTime,T0+10000);
  const session=started();session.footballReports={[SLUG]:fresh};
  assert.equal(decisionContext(session,clock,T0+10000,'live').game?.observedAt,T0);
  const stale=input(T0+46000);stale.market.footballSources!.scoreboard.reportTime=T0+44000;stale.market.contextUpdatedAt=T0+44000;
  assert.equal(assessFootballContext(stale.market,T0+46000,fresh).assessment.status,'stale');
  const gap=input(T0+15001);assert.equal(assessFootballContext(gap.market,T0+15001,first).assessment.status,'unknown');
});

test('component regressions and same-play changes are blocked independently of the PM clock',()=>{
  const original=assessFootballContext(input().market,T0);
  const conflict=input(T0+1000);conflict.market.football!.down=2;
  const blocked=assessFootballContext(conflict.market,T0+1000,original);
  assert.equal(blocked.assessment.status,'conflicting');
  assert.equal(assessFootballContext(input(T0+2000).market,T0+2000,blocked).assessment.status,'conflicting');
  const next=changedPlay(input(T0+3000),2);next.market.football!.down=2;
  const recovered=assessFootballContext(next.market,T0+3000,blocked);assert.equal(recovered.assessment.status,'fresh');
  const old=changedPlay(input(T0+4000),1);old.market.footballSources!.drive.reportTime=T0+1000;
  assert.equal(assessFootballContext(old.market,T0+4000,recovered).assessment.status,'conflicting');
  const oldScore=changedPlay(input(T0+5000),3);oldScore.market.contextUpdatedAt=T0+2000;oldScore.market.footballSources!.scoreboard.reportTime=T0+2000;
  assert.equal(assessFootballContext(oldScore.market,T0+5000,recovered).assessment.status,'conflicting');
  const sameTime=changedPlay(input(T0+4000),3);sameTime.market.footballSources!.drive.reportTime=T0+3000;
  assert.equal(assessFootballContext(sameTime.market,T0+4000,recovered).assessment.status,'fresh','a higher sequence orders plays that share a wall clock');
  delete sameTime.market.footballSources!.drive.sequence;
  assert.equal(assessFootballContext(sameTime.market,T0+4000,recovered).assessment.status,'conflicting','a changed play at the same wall clock needs explicit ordering');
});

test('coherence and mapping are required, and a fresh PM scoreboard survives an invalid fallback',()=>{
  for(const change of [(b:TennisInput)=>{b.market.footballSources!.drive.score='0-7';},(b:TennisInput)=>{b.market.footballSources!.drive.period='Q1';},
    (b:TennisInput)=>{b.market.footballSources!.mapping!.yesPolymarketTeamId='22';},(b:TennisInput)=>{b.market.footballSources!.drive.receiptTime=T0+1;}]){
    const book=input();change(book);const state=assessFootballContext(book.market,T0);
    assert.equal(state.assessment.status,'unknown');assert.equal(state.report,undefined);assert.equal(state.scoreboard?.score,'7-7');
  }
  const missing=input();delete missing.market.footballSources;missing.market.football=null;missing.market.footballSourceIssue='Waiting for an ESPN play.';
  const state=assessFootballContext(missing.market,T0);assert.equal(state.assessment.status,'unknown');assert.equal(state.scoreboard?.reportTime,T0);
});

test('source event times stay independent, clock-only updates do not repeat a play, and handoffs invent no possession event',()=>{
  const session=started();let state=assessFootballContext(input().market,T0);recordGameEvents(session,input(),state,T0);
  const clock=input(T0+1000);clock.market.clock='9:59';state=assessFootballContext(clock.market,T0+1000,state);recordGameEvents(session,clock,state,T0+1000);
  assert.equal((session.gameTape?.[SLUG]??[]).length,0);
  const possession=changedPlay(input(T0+2000),2,'B');possession.market.footballSources!.drive.reportTime=T0+1500;
  state=assessFootballContext(possession.market,T0+2000,state);recordGameEvents(session,possession,state,T0+2000);
  assert.equal(session.gameTape?.[SLUG]?.[0].type,'possession');assert.equal(session.gameTape?.[SLUG]?.[0].reportTime,T0+1500);assert.equal(session.gameTape?.[SLUG]?.[0].receivedAt,T0+2000);
  const score=input(T0+3000);score.market.score='14-7';score.market.football=null;score.market.footballSourceIssue='ESPN score differs.';
  state=assessFootballContext(score.market,T0+3000,state);recordGameEvents(session,score,state,T0+3000);
  assert.equal(session.gameTape?.[SLUG]?.at(-1)?.type,'score');assert.equal(session.gameTape?.[SLUG]?.at(-1)?.reportTime,T0+3000);
  const handoff=native(T0+4000);handoff.market.score='14-7';state=assessFootballContext(handoff.market,T0+4000,state);recordGameEvents(session,handoff,state,T0+4000);
  assert.equal(session.gameTape?.[SLUG]?.length,2);
});

test('invalid composite evidence cancels resting maker buys before a crossing book can fill them',()=>{
  for(const issueOnly of [false,true]){
    const quoted=stepTennisSession(started(),[input()],T0);assert.ok(quoted.maker?.quotes.YES,quoted.lastReason);
    const invalid=input(T0+2000,.58,.59);invalid.market.football=null;
    if(issueOnly){delete invalid.market.footballSources;invalid.market.footballSourceIssue='No verified ESPN play.';}
    else invalid.market.footballSources!.drive.score='0-7';
    const blocked=stepTennisSession(quoted,[invalid],T0+2000);
    assert.equal(blocked.ledger.length,0);assert.equal(blocked.cash,100);assert.equal(blocked.maker?.quotes.YES,undefined);
  }
});

test('an invalid fallback cannot spend the Bold dip allowance; a later valid report can',()=>{
  let session=stepTennisSession(started(true),[input()],T0);
  session=stepTennisSession(session,[input(T0+2000,.59,.60)],T0+2000);
  assert.ok(session.positions.some(p=>p.side==='YES'&&p.status==='open'));
  const invalid=input(T0+4000,.54,.55);invalid.market.football=null;invalid.market.footballSourceIssue='ESPN score differs.';
  const blocked=stepTennisSession(session,[invalid],T0+4000);
  assert.equal(blocked.cash,session.cash);assert.equal(blocked.positions.find(p=>p.side==='YES')?.dipBuys??0,0);assert.equal(blocked.ledger.length,session.ledger.length);
  const recovered=stepTennisSession(blocked,[input(T0+5000,.54,.55)],T0+5000);
  assert.equal(recovered.positions.find(p=>p.side==='YES')?.dipBuys,1);assert.equal(recovered.ledger.filter(row=>row.id.includes(':dip:')).length,1);
});

test('ESPN to native PM handoff cancels existing maker buys and returns on a later confirmed check',()=>{
  const quoted=stepTennisSession(started(),[input()],T0);assert.ok(quoted.maker?.quotes.YES);
  const handoff=stepTennisSession(quoted,[native(T0+2000,.58,.59)],T0+2000);
  assert.equal(handoff.cash,100);assert.equal(handoff.ledger.length,0);assert.equal(handoff.maker?.quotes.YES,undefined);
  assert.equal(handoff.footballReports?.[SLUG].sourceChangedAt,T0+2000);
  const next=stepTennisSession(handoff,[native(T0+3000,.58,.59)],T0+3000);assert.ok(next.maker?.quotes.YES,next.maker?.reason);
});

function driveInput(time:number){const book=input(time,.2,.21);book.market.score='0-17';book.market.footballSources!.drive.score='0-17';book.market.football!.fieldPosition={team:'B',teamId:'22',yard:25};return book;}
function heldDrive(){let s=stepTennisSession(started(true,true),[driveInput(T0)],T0);assert.equal(s.pending?.action,'BUY',s.lastReason);s=stepTennisSession(s,[driveInput(T0+1500)],T0+1500);assert.equal(s.positions[0]?.exitPolicy,'drive',s.lastReason);return s;}

for(const boundary of ['score','half'] as const)test(`fresh PM ${boundary} ends an ESPN drive trade even when fallback evidence is invalid`,()=>{
  const held=heldDrive(),book=driveInput(T0+3000);book.market.football=null;book.market.footballSourceIssue='ESPN no longer agrees.';
  if(boundary==='score')book.market.score='7-17';else{book.market.period='HT';book.market.clock='';}
  const stopped=stepTennisSession(held,[book],T0+3000);
  assert.equal(stopped.footballReports?.[SLUG].assessment.status,'unknown');assert.equal(stopped.pending?.action,'SELL');
  assert.match(stopped.pending?.reason??'',boundary==='score'?/Score changed/:/half.*ended/);
});

test('a source handoff cancels a delayed drive buy before execution',()=>{
  const queued=stepTennisSession(started(true,true),[driveInput(T0)],T0);assert.equal(queued.pending?.action,'BUY');
  const next=driveInput(T0+1500);next.market.footballSources!.drive={provider:'POLYMARKET',eventId:'pm-game',reportTime:T0+1500,receiptTime:T0+1500};delete next.market.footballSources!.mapping;
  const blocked=stepTennisSession(queued,[next],T0+1500);assert.equal(blocked.pending,null);assert.equal(blocked.ledger.length,0);assert.equal(blocked.cash,100);
});
