import test from 'node:test';
import assert from 'node:assert/strict';
import {assessFootballContext,normalizePositionExitRules} from '../lib/tennis/football-context.ts';
import {applyTennisAction,createTennisSession,defaultTennisConfig,stepTennisSession} from '../lib/tennis/engine.ts';
import {normalizeTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisInput} from '../lib/tennis/types.ts';

const NOW=Date.parse('2026-09-26T01:00:00Z');
function input(time=NOW,bid=.64,ask=.65):TennisInput{
  return {receivedAt:time,source:'REST',book:{bids:[{price:bid,quantity:100}],asks:[{price:ask,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{
    slug:'synthetic-cfb',eventId:'game1',eventSlug:'game1',title:'Synthetic A vs B',league:'CFB',yesName:'A',noName:'B',startTime:new Date(NOW-600000).toISOString(),
    live:true,ended:false,active:true,score:'7-7',period:'Q2',clock:'10:00',tournament:null,bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,
    footballIdentity:{yesTeamId:'11',noTeamId:'22'},football:{possessionTeam:'A',possessionTeamId:'11',down:2,yardsToGo:7,fieldPosition:{team:'A',teamId:'11',yard:25},timeouts:[]},history:[],
    execution:{slug:'synthetic-cfb',league:'CFB',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695}}};
}
function queued(policy:'price-v1'|'football-context-v1'='football-context-v1'){
  let s=applyTennisAction(createTennisSession({...defaultTennisConfig(),decisionPolicy:policy,strategy:'momentum',entryBudget:10,leagues:['CFB'],targetReturn:.2,stopReturn:.15,maxHoldMs:1200000},NOW-60000),{action:'start',commandId:'start'},[],NOW-60000);
  for(let i=0;i<12;i++){const t=NOW-60000+i*4000;s=stepTennisSession(s,[input(t,.59,.60)],t);}
  for(const [i,p] of [.62,.65,.65].entries()){const t=NOW-12000+i*5000;s=stepTennisSession(s,[input(t,p-.01,p)],t);}
  assert.equal(s.pending?.action,'BUY');return s;
}
function bought(){const s=stepTennisSession(queued(),[input()],NOW);assert.equal(s.positions[0]?.status,'open');return s;}
function offense(book:TennisInput,team:'A'|'B',down=2){book.market.football!.possessionTeam=team;book.market.football!.possessionTeamId=team==='A'?'11':'22';book.market.football!.down=down;return book;}

test('context ages receipt and provider report independently; quote freshness cannot rejuvenate either',()=>{
  const book=input();book.market.contextUpdatedAt=NOW-45000;
  assert.equal(assessFootballContext(book.market,NOW).assessment.status,'fresh');
  book.market.contextUpdatedAt--;
  assert.equal(assessFootballContext(book.market,NOW).assessment.status,'stale');
  book.market.contextUpdatedAt=NOW-50000;book.market.observedAt=NOW-46000;
  assert.equal(assessFootballContext(book.market,NOW).assessment.status,'stale');
  for(const time of [null,NOW+1,NaN]){book.market.contextUpdatedAt=time;assert.equal(assessFootballContext(book.market,NOW).assessment.status,'unknown');}
});

test('mapping, transitions and malformed game fields fail closed rather than infer football facts',()=>{
  for(const mutate of [(b:TennisInput)=>{b.market.footballIdentity=undefined;},(b:TennisInput)=>{b.market.football!.possessionTeamId='99';},
    (b:TennisInput)=>{b.market.football!.down=0;},(b:TennisInput)=>{b.market.football!.yardsToGo=null;},(b:TennisInput)=>{b.market.clock='unknown';},
    (b:TennisInput)=>{b.market.football!.fieldPosition!.teamId='22';}]){
    const book=input();mutate(book);assert.equal(assessFootballContext(book.market,NOW).assessment.status,'unknown');
  }
  const reversed=input();reversed.market.yesName='B';reversed.market.noName='A';reversed.market.footballIdentity={yesTeamId:'22',noTeamId:'11'};
  assert.equal(assessFootballContext(reversed.market,NOW).report?.possessionTeamId,'11');
});

test('regressing and equal-time conflicting facts are quarantined until a strictly newer report',()=>{
  const original=assessFootballContext(input().market,NOW);
  const old=input(NOW-1);assert.equal(assessFootballContext(old.market,NOW,original).assessment.status,'conflicting');
  const conflict=input(NOW+1000);conflict.market.contextUpdatedAt=NOW;conflict.market.score='7-14';
  const blocked=assessFootballContext(conflict.market,NOW+1000,original);assert.equal(blocked.assessment.status,'conflicting');
  assert.equal(assessFootballContext(input(NOW).market,NOW+1000,blocked).assessment.status,'conflicting');
  assert.equal(assessFootballContext(input(NOW+2000).market,NOW+2000,blocked).assessment.status,'fresh');
});

test('new policy quality-gates football while older saved exports retain price-only semantics',()=>{
  const legacy={...defaultTennisConfig()};delete legacy.decisionPolicy;
  assert.equal(normalizeTennisConfig(legacy).decisionPolicy,'price-v1');
  assert.equal(defaultTennisConfig().decisionPolicy,'football-context-v1');
  const s=queued();const stale=input();stale.market.contextUpdatedAt=NOW-50000;
  const blocked=stepTennisSession(s,[stale],NOW);assert.equal(blocked.pending,null);assert.equal(blocked.ledger.length,0);assert.equal(blocked.cash,100);
  assert.equal(blocked.decisions.at(-1)?.code,'CONTEXT_CONFLICTING');
  const old=queued('price-v1');const missing=input();missing.market.football=undefined;missing.market.contextUpdatedAt=null;
  assert.equal(stepTennisSession(old,[missing],NOW).positions.length,1);
});

for(const boundary of ['score','possession','quarter'] as const)test(`pending football entry cancels before fill after a new ${boundary} report and resets confirmations`,()=>{
  const s=queued(),book=input(NOW-1500);
  if(boundary==='score')book.market.score='14-7';else if(boundary==='quarter')book.market.period='Q3';else offense(book,'B');
  const next=stepTennisSession(s,[book],NOW-1500);
  assert.equal(next.pending,null);assert.equal(next.ledger.length,0);assert.equal(next.cash,100);
  assert.equal(next.decisions.at(-1)?.code,'CONTEXT_CHANGED');assert.equal(next.signals['synthetic-cfb:YES'].confirmations,0);
});

test('frozen target stop and holding limit survive config edits and legacy normalization is idempotent',()=>{
  const held=bought(),original=structuredClone(held.positions[0].exitRules);
  const changed=applyTennisAction(held,{action:'update-rules',sessionId:held.id,expectedRulesRevision:0,commandId:'rules',rules:{targetReturn:.9,stopReturn:.5,maxHoldMs:3600000}},[],NOW+1);
  assert.deepEqual(changed.positions[0].exitRules,original);
  const stopped=stepTennisSession(changed,[input(NOW+2000,.5,.51)],NOW+2000);
  assert.equal(stopped.pending?.action,'SELL');assert.match(stopped.pending?.reason??'',/loss threshold/);
  const expired=stepTennisSession(changed,[input(NOW+1200001)],NOW+1200001);assert.match(expired.pending?.reason??'',/Maximum holding/);
  const target=stepTennisSession(changed,[input(NOW+2000,.85,.86)],NOW+2000);assert.match(target.pending?.reason??'',/profit target/);
  delete held.positions[0].exitRules;const legacy=normalizePositionExitRules(held);
  assert.equal(legacy.positions[0].exitRules?.source,'legacy-snapshot');assert.equal(held.positions[0].exitRules,undefined);
  assert.deepEqual(normalizePositionExitRules({...legacy,config:{...legacy.config,stopReturn:.5}}).positions,legacy.positions);
});

test('stale or missing football context cannot suppress a quoted risk exit',()=>{
  for(const missing of [false,true]){
    const held=bought(),book=input(NOW+50000,.5,.51);book.market.contextUpdatedAt=missing?null:NOW;
    const next=stepTennisSession(held,[book],NOW+50000);assert.equal(next.pending?.action,'SELL');assert.match(next.pending?.reason??'',/loss threshold/);
  }
});

for(const cause of ['fourth','possession'] as const)test(`shadow ${cause} exit uses delayed fresh books and fees without changing cash, positions or ledger`,()=>{
  const held=bought(),book=cause==='fourth'?offense(input(NOW+2000),'A',4):offense(input(NOW+2000),'B');
  const signalled=stepTennisSession(held,[book],NOW+2000),shadow=signalled.shadowExits![held.positions[0].id];
  assert.equal(shadow.fills.length,0);assert.ok(shadow.pending);assert.equal(signalled.pending,null);
  const same=stepTennisSession(signalled,[book],NOW+4000);assert.equal(same.shadowExits![shadow.positionId].fills.length,0);
  const later=offense(input(NOW+5000),cause==='fourth'?'A':'B',cause==='fourth'?4:2);
  const filled=stepTennisSession(same,[later],NOW+5000),result=filled.shadowExits![shadow.positionId];
  assert.equal(result.status,'closed');assert.ok(result.fees>0);assert.equal(result.remainingQuantity,0);
  assert.equal(filled.cash,held.cash);assert.deepEqual(filled.ledger,held.ledger);assert.equal(filled.positions[0].quantity,held.positions[0].quantity);assert.equal(filled.positions[0].status,'open');
  assert.equal(stepTennisSession(filled,[later],NOW+5001).shadowExits![shadow.positionId].fills.length,1);
});

test('shadow exits do not trigger on opponent fourth down, stale reports or legacy missing entry context',()=>{
  for(const variant of ['opponent','stale','legacy','replay'] as const){
    const held=bought(),book=offense(input(NOW+2000),variant==='opponent'?'B':'A',4);
    if(variant==='opponent'){held.positions[0].entryContext!.possessionTeamId='22';}
    if(variant==='stale')book.market.contextUpdatedAt=NOW-50000;
    if(variant==='legacy')delete held.positions[0].entryContext;
    if(variant==='replay')book.source='REPLAY';
    assert.equal(Object.keys(stepTennisSession(held,[book],NOW+2000).shadowExits??{}).length,0);
  }
});

test('NO shadow inventory sells the NO bid from the complementary YES offer',()=>{
  const held=bought(),position=held.positions[0];position.side='NO';position.name='B';position.entryContext!.possessionTeamId='22';
  const signal=stepTennisSession(held,[offense(input(NOW+2000,.34,.35),'B',4)],NOW+2000);
  const filled=stepTennisSession(signal,[offense(input(NOW+4000,.34,.35),'B',4)],NOW+4000);
  const shadow=filled.shadowExits![position.id];assert.equal(shadow.fills[0].execution.averagePrice,.65);
  assert.equal(shadow.fills[0].execution.commandId.startsWith('shadow:'),true);assert.equal(filled.cash,held.cash);
});

test('shadow limit rejects a vanished bid, retries on later depth, and supports partial exits separately',()=>{
  const held=bought(),first=stepTennisSession(held,[offense(input(NOW+2000),'A',4)],NOW+2000);
  const worse=stepTennisSession(first,[offense(input(NOW+4000,.63,.64),'A',4)],NOW+4000);
  let shadow=worse.shadowExits![held.positions[0].id];assert.equal(shadow.fills[0].execution.apply,false);assert.equal(shadow.proceeds,0);
  const retry=stepTennisSession(worse,[offense(input(NOW+6000,.63,.64),'A',4)],NOW+6000);
  const partial=offense(input(NOW+8000,.63,.64),'A',4);partial.book.bids[0].quantity=1;
  const next=stepTennisSession(retry,[partial],NOW+8000);shadow=next.shadowExits![held.positions[0].id];
  assert.equal(shadow.status,'partial');assert.equal(shadow.fills[1].execution.filledQty,1);assert.equal(shadow.remainingQuantity,held.positions[0].quantity-1);
  assert.equal(next.cash,held.cash);assert.deepEqual(next.ledger,held.ledger);
});
