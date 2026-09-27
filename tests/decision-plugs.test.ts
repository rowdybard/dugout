import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,defaultEngine} from '../lib/decision/engine.ts';
import type {DecisionContext} from '../lib/decision/context.ts';
import {sidesFromYesBook} from '../lib/decision/context.ts';
import type {Evidence} from '../lib/decision/evidence.ts';
import {BUILTIN_FEATURES,readFeature} from '../lib/decision/features.ts';
import {compileModel,MARKET_IMPLIED} from '../lib/decision/models.ts';
import {BUNDLED_PACK,parsePack,type EvidencePack} from '../lib/decision/pack.ts';
import {kellyFraction,stakeFor,DEFAULT_SIZING} from '../lib/decision/sizing.ts';
import {checkRisk,DEFAULT_RISK,EMPTY_RISK} from '../lib/decision/risk.ts';
import {LivePack,sha256Hex,type PackSource} from '../lib/decision/sources.ts';
import {estimateCosts} from '../lib/decision/costs.ts';
import {parseCatalog,datasetUrls,duckdbSelect,evidencePackUrl} from '../lib/datastore/catalog.ts';
import type {Strategy} from '../lib/decision/strategies.ts';

const START=Date.parse('2026-10-03T19:00:00Z');
function ctx(over:Partial<DecisionContext>={},yes={ask:.78,bid:.77}):DecisionContext {
  // Six minutes before kickoff: inside the favourite-hold window (5–8 minutes), at the close the study measured.
  return {now:START-6*60_000,market:{slug:'aec-cfb-home-away-2026-10-03',sport:'CFB',startTime:START,feeCoefficient:.0695,open:true,observedAt:START-6*60_000,
    yes:{...sidesFromYesBook(yes).yes,name:'Home'},no:{...sidesFromYesBook(yes).no,name:'Away'}},...over};
}
const row=(over:Partial<Evidence>):Evidence=>({id:'test-row',title:'Test row',status:'lead',sports:['CFB'],phases:['live'],styles:['taker-hold'],
  estimate:{mean:.05,lo:.01,hi:.09,unit:'return'},sample:'synthetic',source:'test',plain:'Synthetic.',...over});
const pack=(evidence:Evidence[],extra:Partial<EvidencePack>={}):EvidencePack=>({...BUNDLED_PACK,version:'test-pack',evidence:[...BUNDLED_PACK.evidence,...evidence],...extra});

test('plan: strategies propose, evidence gates, sizing and risk decide the actions',()=>{
  const paper=defaultEngine.plan(ctx(),{mode:'paper'});
  assert.equal(paper.phase,'pregame');
  const fav=paper.actions.find(a=>a.proposal.strategy==='favourite-hold');
  assert.ok(fav,paper.summary);assert.equal(fav.proposal.side,'yes');assert.equal(fav.stake,5);assert.equal(fav.verdict.code,'LEAD_PAPER');
  // Pregame CFB resting orders are a paper lead too; the taker entry ranks first.
  assert.equal(paper.actions[0].proposal.strategy,'favourite-hold');
  assert.ok(paper.actions.some(a=>a.proposal.style==='maker'));
  const real=defaultEngine.plan(ctx(),{mode:'real'});
  assert.equal(real.actions.length,0);assert.ok(real.considered.every(t=>t.blocked));
  assert.match(real.summary,/^No action\./);
  const halted=defaultEngine.plan(ctx(),{mode:'paper',risk:{...EMPTY_RISK,halted:'owner stop'}});
  assert.equal(halted.actions.length,0);assert.ok(halted.considered.some(t=>t.blocked==='HALTED'));
  const stale=defaultEngine.plan(ctx({market:{...ctx().market,observedAt:START-3_600_000}}),{mode:'paper'});
  const early=defaultEngine.plan(ctx({now:START-30*60_000,market:{...ctx().market,observedAt:START-30*60_000}}),{mode:'paper'});
  assert.ok(!early.considered.some(t=>t.proposal.strategy==='favourite-hold'),'the bot waits for the close, not 30 minutes out');
  assert.ok(stale.considered.every(t=>t.blocked!==null));assert.ok(stale.considered.some(t=>t.blocked==='STALE_DATA'));
  const final=defaultEngine.plan(ctx({game:{status:'final'}}),{mode:'paper'});
  assert.equal(final.phase,null);assert.equal(final.actions.length,0);
});

test('plan: a throwing strategy is reported, never fatal; one taker entry per market',()=>{
  const broken:Strategy={id:'broken',version:'1',description:'',propose(){throw new Error('boom');}};
  const both:Strategy={id:'both-sides',version:'1',description:'',propose:(_c,t)=>(['yes','no'] as const).map(side=>({strategy:'both-sides',strategyVersion:'1',side,style:'taker-hold' as const,price:t.quote(side).ask!,exit:{kind:'hold-to-settlement' as const},rationale:''}))};
  const engine=createEngine({strategies:[broken,both],pack:pack([row({id:'any-side',phases:['pregame'],strategies:['both-sides']})]),trust:'pinned'});
  const plan=engine.plan(ctx(),{mode:'paper'});
  assert.deepEqual(plan.errors,['broken: boom']);
  // The underdog side is still refused by the dropped CFB underdog row; the favourite is allowed once.
  assert.equal(plan.actions.length,1);assert.equal(plan.actions[0].proposal.side,'yes');
  assert.equal(plan.considered.find(t=>t.proposal.side==='no')!.blocked,'DROPPED');
});

test('conditions: unknown never permits, and a losing row that cannot be ruled out still blocks',()=>{
  const lead=row({id:'late-lead',conditions:[{feature:'secondsRemaining',op:'lte',value:600}]});
  const loser=row({id:'q4-loser',status:'dropped',estimate:{mean:-.1,lo:-.2,hi:-.01,unit:'return'},conditions:[{feature:'period',op:'eq',value:4}]});
  const engine=createEngine({pack:pack([lead,loser]),trust:'pinned'});
  const proposal={strategy:'manual',strategyVersion:'1',side:'yes' as const,style:'taker-hold' as const,price:.78,exit:{kind:'hold-to-settlement' as const},rationale:''};
  const live=(game:DecisionContext['game'])=>engine.gate(ctx({phase:'live',game}),proposal,'paper');
  assert.equal(live({status:'live',period:3,secondsRemaining:300}).code,'LEAD_PAPER');
  assert.equal(live({status:'live',period:3,secondsRemaining:900}).code,'NO_EVIDENCE');
  assert.equal(live({status:'live',period:4,secondsRemaining:300}).code,'DROPPED');
  const unknown=live({status:'live',secondsRemaining:300});
  assert.equal(unknown.code,'DROPPED');assert.match(unknown.reason,/^May apply/);
  const signals=createEngine({pack:pack([row({id:'signal-lead',conditions:[{feature:'signal.starterOut',op:'eq',value:true}]})]),trust:'pinned'});
  assert.equal(signals.gate(ctx({phase:'live',signals:{starterOut:true}}),proposal,'paper').code,'LEAD_PAPER');
  assert.equal(signals.gate(ctx({phase:'live',signals:{starterOut:false}}),proposal,'paper').code,'NO_EVIDENCE');
});

test('features read context safely',()=>{
  const c=ctx({game:{status:'live',yesScore:14,noScore:7,period:2,extra:{down:3}},history:[{time:START-40*60_000,yesBid:.70,yesAsk:.71},{time:START-31*60_000,yesBid:.74,yesAsk:.75}]});
  assert.equal(readFeature(BUILTIN_FEATURES,'scoreDiff',c,'no'),-7);
  assert.equal(readFeature(BUILTIN_FEATURES,'role',c,'no'),'underdog');
  assert.equal(readFeature(BUILTIN_FEATURES,'minutesToStart',c,'yes'),6);
  // Latest quote at least 5 min old is the 74.5¢ midpoint at -31 min; now 77.5¢.
  assert.ok(Math.abs((readFeature(BUILTIN_FEATURES,'change5m',c,'yes') as number)-3)<1e-9);
  assert.equal(readFeature(BUILTIN_FEATURES,'game.down',c,'yes'),3);
  assert.equal(readFeature(BUILTIN_FEATURES,'nonexistent',c,'yes'),undefined);
  assert.equal(readFeature({boom:()=>{throw new Error('x');}},'boom',c,'yes'),undefined);
  assert.equal(readFeature(BUILTIN_FEATURES,'volatility1m',c,'yes'),undefined);
});

test('model plug: JSON specs compile; a model edge is proposed but evidence still decides',()=>{
  const logistic=compileModel({kind:'logistic-v1',id:'cfb-test',version:'1',sports:['CFB'],phases:['pregame'],intercept:0,weights:{mid:0}});
  assert.equal(logistic.predict(ctx(),'yes'),.5);
  const table=compileModel({kind:'table-v1',id:'cfb-table',version:'1',sports:['CFB'],phases:['pregame'],feature:'mid',bins:[{min:0,max:.5,p:.4},{min:.5,max:1,p:.9}]});
  assert.equal(table.predict(ctx(),'yes'),.9);assert.equal(table.predict(ctx(),'no'),.4);
  assert.ok(Math.abs(MARKET_IMPLIED.predict(ctx(),'yes')!-.775)<1e-9);
  const engine=createEngine({models:[table]});
  const plan=engine.plan(ctx(),{mode:'real'});
  const edge=plan.considered.find(t=>t.proposal.strategy==='model-edge-hold');
  assert.ok(edge,'a 90% model on a 78¢ favourite proposes');assert.equal(edge.proposal.modelId,'cfb-table');
  assert.equal(edge.blocked,'UNPROVEN_REAL');
  assert.ok(edge.verdict.modelEdge!>0.1);
});

test('packs: schema validated, duplicates refused, unpinned proven rows downgraded',()=>{
  assert.equal(parsePack(JSON.parse(JSON.stringify(BUNDLED_PACK))).ok,true);
  const dup=parsePack({...BUNDLED_PACK,evidence:[...BUNDLED_PACK.evidence,BUNDLED_PACK.evidence[0]]});
  assert.equal(dup.ok,false);
  assert.equal(parsePack({...BUNDLED_PACK,schema:'other'}).ok,false);
  assert.equal(parsePack({...BUNDLED_PACK,evidence:[{...BUNDLED_PACK.evidence[0],price:{min:.8,max:.2}}]}).ok,false);
  const proven=row({id:'proven-row',phases:['pregame'],status:'proven'});
  const request={sport:'CFB' as const,phase:'pregame' as const,style:'taker-hold' as const,mode:'real' as const,ask:.78,bid:.77};
  const untrusted=createEngine({pack:pack([proven])});
  assert.equal(untrusted.pack.trust,'untrusted');
  assert.equal(untrusted.decide(request).permitted,false);
  const pinned=createEngine({pack:pack([proven]),trust:'pinned'}).decide(request);
  // Proven beats the lead; the real-money stake comes from the lower bound.
  assert.equal(pinned.code,'PROVEN');assert.equal(pinned.permitted,true);
  const stake=stakeFor({action:'allow',mode:'real',evidence:pinned.deciding,costs:pinned.costs,limits:{...DEFAULT_SIZING,bankroll:1000,maxStake:1000,maxBankrollFraction:1}});
  assert.ok(stake>0);
});

test('live pack: loads, pins, and keeps the last good engine on failure',async()=>{
  const good=pack([row({id:'remote-lead'})],{version:'remote-1'}),text=JSON.stringify(good);
  let serve:()=>{raw:unknown;text:string}=()=>({raw:good,text});
  const source:PackSource={id:'test',load:async()=>serve()};
  let now=0;
  const live=new LivePack(source,{refreshMs:1000,now:()=>now});
  assert.equal(live.status().version,BUNDLED_PACK.version);assert.equal(live.due(),true);
  await live.refresh();
  assert.equal(live.status().version,'remote-1');assert.equal(live.status().trust,'untrusted');assert.equal(live.status().error,null);
  assert.ok(live.current().evidence.some(r=>r.id==='remote-lead'));
  serve=()=>({raw:{nope:true},text:'{}'});now=2000;
  await live.refresh();
  assert.match(live.status().error!,/^Invalid pack/);assert.equal(live.status().version,'remote-1');
  serve=()=>{throw new Error('offline');};now=4000;
  assert.equal((await live.engineNow()).pack.version,'remote-1');assert.equal(live.status().error,'offline');
  const pinnedLive=new LivePack({id:'pinned',load:async()=>({raw:good,text})},{pinSha256:await sha256Hex(text)});
  await pinnedLive.refresh();assert.equal(pinnedLive.status().trust,'pinned');
  const wrongPin=new LivePack({id:'pinned',load:async()=>({raw:good,text})},{pinSha256:'0'.repeat(64)});
  await wrongPin.refresh();assert.equal(wrongPin.status().trust,'bundled');assert.match(wrongPin.status().error!,/does not match/);
});

test('sizing and risk',()=>{
  assert.equal(kellyFraction(.5,.5),0);assert.ok(Math.abs(kellyFraction(.6,.5)-.2)<1e-12);assert.equal(kellyFraction(.4,.5),0);
  const costs=estimateCosts(.5,.49);
  const evidence=row({estimate:{mean:.05,lo:-.01,hi:.1,unit:'return'}});
  assert.equal(stakeFor({action:'allow',mode:'real',evidence,costs,limits:DEFAULT_SIZING}),0,'lower bound at or below zero stakes nothing');
  assert.equal(stakeFor({action:'paper-only',mode:'paper',evidence,costs,limits:DEFAULT_SIZING}),5);
  assert.equal(stakeFor({action:'block',mode:'paper',evidence,costs,limits:DEFAULT_SIZING}),0);
  assert.deepEqual(checkRisk(EMPTY_RISK,DEFAULT_RISK,5,1000),{ok:true});
  assert.equal((checkRisk({...EMPTY_RISK,dayPnl:-20},DEFAULT_RISK,5,1000) as {code:string}).code,'DAILY_LOSS');
  assert.equal((checkRisk({...EMPTY_RISK,openExposure:48},DEFAULT_RISK,5,1000) as {code:string}).code,'EXPOSURE');
  assert.equal((checkRisk(EMPTY_RISK,DEFAULT_RISK,5,null) as {code:string}).code,'STALE_DATA');
});

test('data catalog: validated, partition filters, DuckDB query and pack URL',()=>{
  const raw={schema:'dugout-catalog-v1',base:'https://data.example.com/dugout/',updatedAt:'2026-09-27T00:00:00Z',
    datasets:[{name:'pmus_history',description:'Price history',format:'parquet',path:'lake/pmus_history',partitions:['league','month'],
      files:['lake/pmus_history/league=cfb/month=2026-09/data_0.parquet','lake/pmus_history/league=nfl/month=2026-09/data_0.parquet'],updatedAt:'2026-09-27T00:00:00Z'}],
    evidencePack:{path:'packs/latest.json',sha256:'a'.repeat(64)}};
  const parsed=parseCatalog(raw);assert.ok(parsed.ok);
  const catalog=(parsed as {ok:true;catalog:ReturnType<typeof parseCatalog> extends infer R?R extends {catalog:infer C}?C:never:never}).catalog;
  assert.deepEqual(datasetUrls(catalog,'pmus_history',{league:'cfb'}),['https://data.example.com/dugout/lake/pmus_history/league=cfb/month=2026-09/data_0.parquet']);
  assert.match(duckdbSelect(catalog,'pmus_history',{league:'nfl'}),/read_parquet\(\['https:\/\/data\.example\.com\/dugout\/lake\/pmus_history\/league=nfl\/.*hive_partitioning = true\) LIMIT 100;$/);
  assert.deepEqual(evidencePackUrl(catalog),{url:'https://data.example.com/dugout/packs/latest.json',sha256:'a'.repeat(64)});
  assert.throws(()=>datasetUrls(catalog,'missing'));
  assert.equal(parseCatalog({...raw,base:'not a url'}).ok,false);
});
