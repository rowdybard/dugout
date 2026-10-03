import test from 'node:test';
import assert from 'node:assert/strict';
import {withEspnFootballFallback,loadEspnContext,type EspnContextCache} from '../lib/tennis/football-fallback.ts';
import {espnFootballMapping,normalizeEspnFootballReport} from '../lib/tennis/espn-football.ts';
import {loadPriorityContext,joinBookWithPriorityContext,type PriorityContextRecord,type PriorityContextDependencies} from '../lib/tennis/priority-context.ts';
import {assessFootballContext} from '../lib/tennis/football-context.ts';
import {FOOTBALL_FEED_NOW as NOW,montanaMarket,montanaEvent,espnSummary} from './helpers/football-feed-fixture.ts';

function cache(time=NOW-12_000):EspnContextCache{
  const market=montanaMarket();
  return {fetchedAt:NOW,retryAt:NOW+10_000,report:normalizeEspnFootballReport(espnSummary(time),espnFootballMapping(market)!,NOW)};
}
test('matching ESPN drive supplies only missing fields; PM clock and every market field survive',()=>{
  const market=montanaMarket(),result=withEspnFootballFallback(market,cache(),NOW);
  assert.equal(assessFootballContext(result,NOW).assessment.status,'fresh');
  assert.equal(result.clock,'1:31');assert.equal(result.football?.down,4);assert.equal(result.football?.fieldPosition?.yard,27);
  assert.equal(result.footballSources?.drive.provider,'ESPN');assert.equal(result.contextUpdatedAt,market.contextUpdatedAt);
  for(const key of ['bid','ask','execution','live','ended','active','score','period','quoteObservedAt'] as const)assert.deepEqual(result[key],market[key]);
});
test('score mismatch, old plays and excessive report skew never yield an executable drive',()=>{
  const market=montanaMarket();
  for(const result of [withEspnFootballFallback({...market,score:'10-14'},cache(),NOW),withEspnFootballFallback(market,cache(NOW-46_000),NOW),withEspnFootballFallback(market,cache(NOW-17_000),NOW)]){
    assert.equal(result.football,null);assert.ok(result.footballSourceIssue);assert.notEqual(assessFootballContext(result,NOW).assessment.status,'fresh');
  }
});
test('native complete reports, explicit transitions and final status remain primary',()=>{
  const market=montanaMarket(),espn=cache();
  const native={...market,football:{possessionTeam:'Montana State',possessionTeamId:'1110',down:2,yardsToGo:7,fieldPosition:{team:'Montana State',teamId:'1110',yard:25},timeouts:[]}};
  const complete=withEspnFootballFallback(native,espn,NOW);assert.equal(complete.football?.possessionTeamId,'1110');assert.equal(complete.footballSources?.drive.provider,'POLYMARKET');
  const transition=withEspnFootballFallback({...native,football:{...native.football,phase:'between-plays',down:null}},espn,NOW);
  assert.equal(transition.football?.phase,'between-plays');assert.equal(transition.footballSources?.drive.provider,'POLYMARKET');
  const final=withEspnFootballFallback({...market,ended:true,live:false,period:'FT',score:'17-14'},espn,NOW);
  assert.equal(final.football,null);assert.equal(assessFootballContext(final,NOW).scoreboard?.score,'17-14');
});
test('explicit partial primary possession cannot be overwritten by the backup',()=>{
  const market=montanaMarket();market.football={possessionTeam:'Montana State',possessionTeamId:'1110',down:null,yardsToGo:null,fieldPosition:null,timeouts:[]};
  const result=withEspnFootballFallback(market,cache(),NOW);assert.equal(result.football,null);assert.match(result.footballSourceIssue!,/disagree/);
});
test('ESPN cache preserves the original receipt and honors backoff from response time',async()=>{
  const market=montanaMarket();let time=NOW,calls=0;
  const fetcher=async()=>{calls++;return {data:espnSummary(),receipt:{receivedAt:time}};};
  const first=await loadEspnContext(market,undefined,fetcher,()=>time,new AbortController().signal);
  time+=9000;const second=await loadEspnContext(market,first,fetcher,()=>time,new AbortController().signal);
  assert.equal(calls,1);assert.equal(second?.report?.provenance.receivedAt,NOW);
  time+=1000;const failed=await loadEspnContext(market,second,async()=>{time+=2000;throw Object.assign(new Error('ESPN pause'),{status:429,retryAfterMs:30_000});},()=>time,new AbortController().signal);
  assert.equal(failed?.retryAt,time+30_000);assert.equal(failed?.report?.provenance.receivedAt,NOW);
});

function harness(){
  let time=NOW,espnCalls=0;const values=new Map<string,PriorityContextRecord>();
  let event=montanaEvent(),summary=espnSummary();
  const deps:PriorityContextDependencies={now:()=>time,read:async key=>values.get(key)??null,write:async(key,value)=>{values.set(key,value);},fetchEvent:async()=>({events:[event]}),
    fetchEspn:async()=>{espnCalls++;return {data:summary,receipt:{receivedAt:time}};}};
  return {deps,values,market:montanaMarket(NOW-1000,NOW-2000),setTime:(value:number)=>{time=value;},setEvent:(value:ReturnType<typeof montanaEvent>)=>{event=value;},setSummary:(value:ReturnType<typeof espnSummary>)=>{summary=value;},calls:()=>espnCalls};
}
test('primary ticks and later ESPN plays have independent ordering and ten-second caching',async()=>{
  const f=harness(),first=await loadPriorityContext(f.market,f.deps);assert.equal(first.assessment.status,'fresh');
  f.setTime(NOW+3000);const nextEvent=montanaEvent(NOW+2000);nextEvent.eventState.elapsed='1:28';f.setEvent(nextEvent);
  const clock=await loadPriorityContext(f.market,f.deps);assert.equal(clock.assessment.status,'fresh');assert.equal(clock.reportMarket.clock,'1:28');assert.equal(f.calls(),1);assert.equal(clock.reportMarket.footballSources?.drive.receiptTime,NOW);
  f.setTime(NOW+10_000);const nextPlay=espnSummary(NOW+9000);nextPlay.drives.current.plays[0].id='401868094162';nextPlay.drives.current.plays[0].sequenceNumber='39';nextPlay.drives.current.plays[0].end.down=1;f.setSummary(nextPlay);
  const play=await loadPriorityContext(f.market,f.deps);assert.equal(play.assessment.status,'fresh');assert.equal(play.reportMarket.football?.down,1);assert.equal(play.reportMarket.contextUpdatedAt,clock.reportMarket.contextUpdatedAt);assert.equal(f.calls(),2);
});
test('primary score changes remain visible while mismatched drive is retained only as last-known display',async()=>{
  const f=harness();await loadPriorityContext(f.market,f.deps);f.setTime(NOW+3000);const event=montanaEvent(NOW+2000);event.score='10-14';event.eventState.score='10-14';f.setEvent(event);
  const result=await loadPriorityContext(f.market,f.deps);assert.notEqual(result.assessment.status,'fresh');assert.equal(result.reportMarket.football,null);assert.equal(result.state.scoreboard?.score,'10-14');
  assert.equal(result.market.score,'10-14');assert.equal(result.market.football?.down,4);assert.ok(result.market.footballSourceIssue);assert.equal(result.market.footballSources?.drive.receiptTime,NOW);
});
test('primary failures still persist an ESPN requested pause',async()=>{
  const f=harness();let calls=0;f.deps.fetchEvent=async()=>{throw new Error('Primary unavailable');};f.deps.fetchEspn=async()=>{calls++;throw Object.assign(new Error('ESPN pause'),{status:429,retryAfterMs:60_000});};
  await loadPriorityContext(f.market,f.deps);f.setTime(NOW+3000);await loadPriorityContext(f.market,f.deps);assert.equal(calls,1);assert.equal([...f.values.values()][0].espn?.retryAt,NOW+60_000);
});

test('a non-cooperating ESPN timeout retains the successful primary scoreboard',async()=>{
  const f=harness();f.deps.timeoutMs=40;f.deps.fetchEspn=()=>new Promise(()=>{});
  const result=await loadPriorityContext(f.market,f.deps);
  assert.equal(result.successfulCheckAt,NOW);assert.equal(result.reportMarket.clock,'1:31');assert.equal(result.state.scoreboard?.score,'10-7');
  assert.notEqual(result.assessment.status,'fresh');assert.ok(result.espn?.error);
});

test('an older ESPN play cannot roll back a newer verified Polymarket clock on the display',async()=>{
  const f=harness();await loadPriorityContext(f.market,f.deps);
  f.setTime(NOW+10_000);const event=montanaEvent(NOW+9000);event.eventState.elapsed='1:21';f.setEvent(event);
  const older=espnSummary(NOW-2000);older.drives.current.plays[0].sequenceNumber='37';older.drives.current.plays[0].end.down=3;f.setSummary(older);
  const result=await loadPriorityContext(f.market,f.deps);
  assert.equal(result.assessment.status,'conflicting');assert.equal(result.market.clock,'1:21');assert.equal(result.market.football?.down,4);
  assert.equal(result.market.footballSources?.drive.reportTime,NOW-1000);assert.match(result.market.footballSourceIssue!,/older drive/);
  assert.equal(result.reportMarket.football?.down,3);
});
test('a held-position book returns immediately with entries blocked while backup reports are pending',async()=>{
  const f=harness(),book={market:f.market,receivedAt:NOW,bid:.6};
  const result=await joinBookWithPriorityContext(Promise.resolve(book),new Promise(()=>{}),()=>NOW,false);
  assert.equal(result.receivedAt,NOW);assert.equal(result.bid,.6);assert.equal(result.market.football,null);assert.match(result.market.footballSourceIssue!,/Waiting/);
});
