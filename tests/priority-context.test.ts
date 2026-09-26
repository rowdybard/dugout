import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPriorityContext,joinBookWithPriorityContext,type PriorityContextRecord,type PriorityContextDependencies} from '../lib/tennis/priority-context.ts';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';

const NOW=Date.parse('2026-09-26T22:00:00Z');
function event(time=NOW-1000,down=2){return {id:'game-123',slug:'cfb-navy-uab-2026-09-26',title:'Navy vs UAB',startTime:'2026-09-26T21:00:00Z',active:true,live:true,ended:false,score:'7-0',period:'Q1',eventState:{type:'football',live:true,ended:false,period:'Q1',elapsed:'10:37',updatedAt:new Date(time).toISOString(),footballState:{driveState:{possessionTeamId:'1245',down,yfd:12,fieldPosition:{teamId:'1157',yard:12}}}},markets:[{slug:'aec-cfb-navy-uab-2026-09-26',sportsMarketType:'football_team_full_game_winner',active:true,closed:false,status:'MARKET_STATUS_OPEN',minimumTradeQty:.01,orderPriceMinTickSize:.005,feeCoefficient:.0695,bestBidQuote:{value:'.415'},bestAskQuote:{value:'.420'},marketSides:[{long:false,description:'Blazers',teamId:1157,team:{id:1157,name:'UAB',league:'cfb',ordering:'home'}},{long:true,description:'Midshipmen',teamId:1245,team:{id:1245,name:'Navy',league:'cfb',ordering:'away'}}]}]};}
function fixture(){let time=NOW,calls=0,value=event();const values=new Map<string,PriorityContextRecord>();const market=normalizeTennisEvent(event(NOW-2000), 'CFB',NOW-1000)[0];const deps:PriorityContextDependencies={now:()=>time,read:async key=>values.get(key)??null,write:async(key,value)=>{values.set(key,value);},fetchEvent:async path=>{assert.equal(path,'/v1/events/slug/cfb-navy-uab-2026-09-26');calls++;return {event:value};}};return {market,deps,values,calls:()=>calls,setTime:(n:number)=>{time=n;},setEvent:(e:ReturnType<typeof event>)=>{value=e;}};}
test('direct report lookup uses explicit identity and preserves provider/receipt clocks across 3s cache',async()=>{
  const f=fixture(),first=await loadPriorityContext(f.market,f.deps);assert.equal(first.assessment.status,'fresh');assert.equal(first.reportMarket.observedAt,NOW);assert.equal(first.reportMarket.contextUpdatedAt,NOW-1000);assert.deepEqual(first.market.footballIdentity,{yesTeamId:'1245',noTeamId:'1157'});
  f.setTime(NOW+2000);const cached=await loadPriorityContext(f.market,f.deps);assert.equal(f.calls(),1);assert.equal(cached.cacheHit,true);assert.equal(cached.market.observedAt,NOW);assert.equal(cached.assessment.reportAgeMs,3000);
  f.setTime(NOW+3000);await loadPriorityContext(f.market,f.deps);assert.equal(f.calls(),2);
});
test('older and conflicting provider reports reach engine as conflicts while display retains consistent facts',async()=>{
  const f=fixture(),first=await loadPriorityContext(f.market,f.deps);
  f.setTime(NOW+3000);f.setEvent(event(NOW-1500,4));const old=await loadPriorityContext(f.market,f.deps);assert.equal(old.assessment.status,'conflicting');assert.equal(old.market.football?.down,2);assert.equal(old.reportMarket.football?.down,4);assert.equal(old.reportMarket.contextUpdatedAt,NOW-1500);
  f.setTime(NOW+6000);f.setEvent(event(NOW-1000,4));const conflict=await loadPriorityContext(f.market,f.deps);assert.equal(conflict.assessment.status,'conflicting');assert.equal(conflict.market.football?.down,2);
  f.setTime(NOW+9000);f.setEvent(event(NOW+8000,3));const resolved=await loadPriorityContext(f.market,f.deps);assert.equal(resolved.assessment.status,'fresh');assert.equal(resolved.market.football?.down,3);assert.equal(first.market.football?.down,2);
});
test('wrong event/team identity, expired reports and provider failure never invent fresh context',async()=>{
  const f=fixture(),wrong=event();wrong.id='wrong';f.setEvent(wrong);const bad=await loadPriorityContext(f.market,f.deps);assert.equal(bad.assessment.status,'unknown');assert.equal(bad.reportMarket.football,null);assert.equal(bad.market.observedAt,f.market.observedAt);
  f.setTime(NOW+3000);f.setEvent(event(NOW-50000));const old=await loadPriorityContext({...f.market,contextUpdatedAt:null},f.deps);assert.notEqual(old.assessment.status,'fresh');
  const g=fixture();g.deps.fetchEvent=async()=>{throw new Error('Provider backoff');};const failed=await loadPriorityContext(g.market,g.deps);assert.equal(failed.error,'Provider backoff');assert.equal(failed.market.contextUpdatedAt,g.market.contextUpdatedAt);assert.equal(failed.reportMarket.football,null);
});
test('held exit book returns before slow report; pending entry waits for bounded report and preserves all book evidence',async()=>{
  const f=fixture();let release:(value:Awaited<ReturnType<typeof loadPriorityContext>>)=>void=()=>{};const delayed=new Promise<Awaited<ReturnType<typeof loadPriorityContext>>>(resolve=>{release=resolve;});
  const book={market:{...f.market,bid:.55,ask:.56},receivedAt:NOW,source:'WEBSOCKET',sourceTime:NOW};
  assert.equal(await joinBookWithPriorityContext(Promise.resolve(book),delayed,f.deps.now,false),book);
  let finished=false;const pending=joinBookWithPriorityContext(Promise.resolve(book),delayed,f.deps.now,true).then(value=>{finished=true;return value;});await Promise.resolve();assert.equal(finished,false);
  const fresh=await loadPriorityContext(f.market,f.deps);release(fresh);const checked=await pending;assert.equal(checked.market.observedAt,NOW);assert.equal(checked.market.bid,.55);assert.equal(checked.market.execution,book.market.execution);assert.equal(checked.receivedAt,NOW);assert.equal(checked.sourceTime,NOW);
});
test('non-cooperating source times out, blocks context entries and leaves an available exit book untouched',async()=>{
  const f=fixture();f.deps.timeoutMs=5;f.deps.fetchEvent=()=>new Promise(()=>{});const report=loadPriorityContext(f.market,f.deps);const book={market:f.market,receivedAt:NOW};
  assert.equal(await joinBookWithPriorityContext(Promise.resolve(book),report,f.deps.now,false),book);
  const entry=await joinBookWithPriorityContext(Promise.resolve(book),report,f.deps.now,true);assert.equal(entry.market.football,null);assert.equal(entry.receivedAt,NOW);assert.equal((await report).assessment.status,'unknown');
});
test('an unexpected report-task rejection cannot bypass pending-entry context checks',async()=>{
  const f=fixture(),book={market:f.market,receivedAt:NOW};
  const entry=await joinBookWithPriorityContext(Promise.resolve(book),Promise.reject(new Error('Unexpected adapter failure')),f.deps.now,true);
  assert.equal(entry.market.football,null);assert.equal(entry.market.observedAt,f.market.observedAt);assert.equal(entry.receivedAt,NOW);
});
