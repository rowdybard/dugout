import test from 'node:test';
import assert from 'node:assert/strict';
import {ChaosFiles,chaosLines,chaosOn} from '../lib/datastore/chaos-log.ts';
import type {TennisSession} from '../lib/tennis/types';

const T=Date.parse('2026-10-03T16:04:05Z');
const session=(over:Record<string,unknown>={})=>({
  config:{focusSlug:'a',chaosSlugs:['b'],entries:'steady'},cash:97.5,equity:[{time:T,price:100.25}],
  decisions:[{time:T+1,slug:'a',side:'YES',action:'quote',code:'maker-quote',reason:'x'.repeat(300)},
    {time:T+2,slug:'z',side:'NO',action:'skip',code:'other',reason:'not a Chaos game'},
    {time:T+3,slug:'b',side:'NO',action:'quote',code:'maker-quote',reason:'rest at 69¢'}],
  ledger:[{time:T+4,slug:'b',side:'YES',action:'BUY',cashDelta:-3.00004,realizedPnl:0,execution:{averagePrice:0.3,filledQty:10}}],
  ...over,
}) as unknown as TennisSession;

test('Chaos lines: decisions on Chaos games, every fill, balance once a minute, cursor moves forward',()=>{
  assert.equal(chaosOn(session()),true);
  assert.equal(chaosOn(session({config:{focusSlug:'a',chaosSlugs:['b'],entries:'all'}})),false,'Steady only');
  const first=chaosLines(session(),{decisions:0,ledger:0,balance:0},T+10);
  assert.deepEqual(first.lines.map(line=>`${line.kind}:${line.slug??''}`),['decision:a','decision:b','fill:b','balance:']);
  assert.ok(first.lines[0].note!.length<=160,'long reasons are cut short');
  assert.deepEqual(first.lines[2],{t:T+4,kind:'fill',slug:'b',side:'YES',action:'BUY',price:0.3,qty:10,cash:-3,pnl:0});
  assert.deepEqual(first.cursor,{decisions:T+3,ledger:T+4,balance:T+10});
  const again=chaosLines(session(),first.cursor,T+30_000);
  assert.deepEqual(again.lines,[],'nothing new and the balance was logged under a minute ago');
  assert.equal(chaosLines(session(),first.cursor,T+70_010).lines[0].kind,'balance');
});

test('Chaos files are tiny: written at 200 lines or after a minute, named by day, account and time',async()=>{
  const puts:{key:string;value:string}[]=[];const bucket={put:async(key:string,value:string)=>{puts.push({key,value});}};
  let clock=T;const files=new ChaosFiles('lake',()=>clock);
  files.add([{t:T,kind:'balance',cash:100}]);
  assert.equal(await files.flush(bucket,'u_chad/../x'),null,'waits for more lines');
  clock+=60_000;
  assert.equal(await files.flush(bucket,'u_chad/../x'),'lake/chaos/2026-10-03/u_chadx/160405-0.jsonl');
  assert.equal(puts[0].value,'{"t":'+T+',"kind":"balance","cash":100}\n');
  files.add(Array.from({length:200},(_,i)=>({t:T+i,kind:'decision' as const})));
  assert.match((await files.flush(bucket,'u_chad'))!,/-1\.jsonl$/,'200 lines write at once');
  assert.equal(puts[1].value.trim().split('\n').length,200);
  files.add([{t:T,kind:'balance'}]);
  const failing={put:async()=>{throw new Error('R2 down');}};
  await assert.rejects(files.flush(failing,'u_chad',true));
  assert.ok(await files.flush(bucket,'u_chad',true),'a failed write keeps its lines for the next try');
});
