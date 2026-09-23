import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverPages} from '../lib/server/catalog.ts';
import {collectBotInputs} from '../lib/bot/collect-inputs.ts';
import {newBot,defaultBotConfig,stepBot} from '../lib/bot/engine.ts';
import {requestBot} from '../lib/bot/request.ts';
import {abortable} from '../lib/server/request-budget.ts';
import type {Market,Profile} from '../lib/market/types';
import type {BotInput} from '../lib/bot/types';

const never=<T>():Promise<T>=>new Promise(()=>{});
const market=(i:number):Market=>({id:`synthetic-${i}`,slug:`synthetic-${i}`,gameId:`synthetic-${i}`,game:'Synthetic fixture',title:'Synthetic YES',question:'',rules:'',league:'MLB',start:new Date(Date.now()+3600000).toISOString(),teams:[],kind:'baseball_team_full_game_winner',bid:.4,ask:.42,price:.42,volume:null,fee:.0695,active:true,history:[],signals:[],observedAt:Date.now()});
const session=()=>newBot(defaultBotConfig(10),Date.now());

test('already-expired work consumes a simultaneous source rejection',async()=>{
  const controller=new AbortController();controller.abort(new DOMException('Expired','TimeoutError'));
  await assert.rejects(abortable(Promise.reject(new Error('Source also failed')),controller.signal),{name:'TimeoutError'});
  // node:test treats any orphan source rejection after this test as a test failure.
  await new Promise(resolve=>setImmediate(resolve));
});

test('cold discovery is capped at 12 pages regardless of number of available games',async()=>{
  const calls:{league:string;offset:number}[]=[];
  const result=await discoverPages(async(league,offset)=>{calls.push({league,offset});return {events:Array.from({length:4},(_,i)=>({id:offset+i})),observedAt:Date.now()};});
  assert.equal(calls.length,12);assert.equal(result.pages.length,12);assert.deepEqual(result.errors,[]);
  assert.equal(Math.max(...calls.map(c=>c.offset)),20);
});
test('one hung discovery source returns the other league promptly and aborts pending I/O',async()=>{
  let pending:AbortSignal|undefined;
  const start=Date.now();
  const result=await discoverPages(async(league,_offset,signal)=>{
    if(league==='NFL'){pending=signal;return never();}
    return {events:[{id:'synthetic'}],observedAt:Date.now()};
  },20);
  assert.equal(result.pages.length,1);assert.match(result.errors[0],/NFL/);assert.equal(pending?.aborted,true);
  assert.ok(Date.now()-start<1000);
});
test('candidate timeout advances the small batch without applying a late fill',async()=>{
  const original=session(),all=Array.from({length:14},(_,i)=>market(i));
  let calls=0,signal:AbortSignal|undefined;
  const result=await collectBotInputs(original,{markets:async()=>all,input:async(_m,_held,s)=>{calls++;signal=s;return never();}},20);
  assert.equal(calls,2);assert.equal(result.cursor,2);assert.equal(result.universeSize,14);assert.equal(result.failures.length,2);
  assert.equal(signal?.aborted,true);assert.deepEqual(result.inputs,[]);
  const next=stepBot(original,result.inputs,Date.now());assert.equal(next.cash,10);assert.equal(next.positions.length,0);
  const checked:string[]=[];
  await collectBotInputs({...next,cursor:result.cursor},{markets:async()=>all,input:async m=>{checked.push(m.slug);throw new Error('Synthetic outage');}},20);
  assert.equal(checked.length,2);assert.equal(checked.includes(all[0].slug),false);
});
test('held exits bypass discovery and preserve a pending exit through a data timeout',async()=>{
  const original=session();original.status='paused';
  original.positions=[{id:'synthetic-position',slug:'synthetic-held',title:'Synthetic held',game:'Synthetic game',league:'MLB',side:'YES',entry:.4,entryProbability:.4,amount:2,contracts:4,fee:.08,time:Date.now(),signal:'TEST',reason:'Synthetic test only',status:'open',mark:.39,coefficient:.0695}];
  original.exitRequests=['synthetic-position'];
  const result=await collectBotInputs(original,{markets:async()=>{throw new Error('Must never discover for an exit');},input:async(m,held,signal)=>{
    assert.equal(m.slug,'synthetic-held');assert.equal(held,true);return abortable(never<BotInput>(),signal);
  }},20);
  const next=stepBot(original,result.inputs,Date.now());
  assert.equal(next.cash,10);assert.equal(next.positions[0].status,'open');assert.deepEqual(next.exitRequests,['synthetic-position']);
  assert.match(result.failures[0].reason,/too long/);
});
test('a committed POST with a lost response is reconciled by GET and never resubmitted',async()=>{
  const saved={revision:8,trading:{autopilot:session()}} as Profile,calls:string[]=[];
  const fetcher:typeof fetch=async(_url,options)=>{
    calls.push(options?.method??'GET');
    if(options?.method==='POST')throw new DOMException('Signal timed out','TimeoutError');
    return Response.json({profile:saved});
  };
  const result=await requestBot({action:'start',bankroll:10,leagues:['MLB']},fetcher);
  assert.deepEqual(calls,['POST','GET']);assert.equal(result.profile?.revision,8);assert.equal(result.ok,false);assert.match(result.error??'',/restored/);
});
test('unavailable recovery never reports an unconfirmed bot control as successful',async()=>{
  const result=await requestBot({action:'stop'},async()=>{throw new Error('Synthetic network outage');});
  assert.equal(result.ok,false);assert.equal(result.profile,undefined);assert.match(result.error??'',/Refresh before retrying/);
});
