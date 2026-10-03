import test from 'node:test';
import assert from 'node:assert/strict';
import {contextCheckView,recordContextCheck,type ContextCheckState} from '../lib/tennis/context-check.ts';
import {footballFieldView,type FootballFieldMarket} from '../lib/tennis/football-field.ts';

const now=1_000_000;
const live={live:true,ended:false,freshness:'stale' as const};

test('a successful source check does not rejuvenate a stale play report',()=>{
  const market:FootballFieldMarket={league:'CFB',yesName:'Clemson',noName:'California',live:true,ended:false,
    contextUpdatedAt:now-65_000,observedAt:now-500,football:null};
  const original=structuredClone(market);
  const check=recordContextCheck(undefined,{successfulCheckAt:now-500,error:null});
  const field=footballFieldView(market,now);
  const view=contextCheckView(check,now,{...live,freshness:field.freshness});
  assert.equal(field.freshness,'stale');assert.equal(field.reportAgeMs,65_000);
  assert.equal(view.checkedLabel,'0s ago');
  assert.equal(view.message,'Game feed checked; waiting for a newer play report.');
  assert.deepEqual(market,original);
});

test('cached responses and their response timestamp never reset Last checked',()=>{
  const previous=recordContextCheck(undefined,{successfulCheckAt:now-20_000});
  const response={successfulCheckAt:now-20_000,checkedAt:now,error:null};
  const next=recordContextCheck(previous,response);
  assert.equal(next.successfulCheckAt,now-20_000);
  assert.equal(contextCheckView(next,now,live).checkedLabel,'20s ago');
  assert.equal(contextCheckView(next,now,live).message,'Waiting for the next game-feed check.');
});

test('provider errors and transport failures retain the last successful check',()=>{
  const previous=recordContextCheck(undefined,{successfulCheckAt:now-5000});
  for(const response of [{successfulCheckAt:now-5000,error:'Provider timed out.'},{error:'Connection interrupted.'}]){
    const next=recordContextCheck(previous,response),view=contextCheckView(next,now,live);
    assert.equal(next.successfulCheckAt,now-5000);assert.equal(view.checkedLabel,'5s ago');
    assert.equal(view.failed,true);assert.equal(view.message,`Latest check failed (${response.error.replace(/\.$/,'')}). Showing the last available game report.`,'the reason is shown');
  }
});

test('first failed check is not labeled as a successful provider read',()=>{
  const next=recordContextCheck(undefined,{successfulCheckAt:null,error:'Unavailable'});
  assert.equal(next.successfulCheckAt,null);
  assert.equal(contextCheckView(next,now,live).checkedLabel,'Not verified yet');
});

test('successful recovery clears the fetch error while keeping stale-report status',()=>{
  const failed={successfulCheckAt:now-30_000,error:'Timed out'};
  const next=recordContextCheck(failed,{successfulCheckAt:now,error:null});
  const view=contextCheckView(next,now,live);
  assert.equal(next.error,null);assert.equal(view.failed,false);assert.match(view.message,/waiting for a newer play report/);
});

test('per-game check updates do not leak errors or receipt time to another field',()=>{
  const state:Record<string,ContextCheckState>={a:{successfulCheckAt:now-1000,error:null},b:{successfulCheckAt:now-2000,error:null}};
  const next:Record<string,ContextCheckState>={...state,a:recordContextCheck(state.a,{error:'Failed A'})};
  assert.equal(contextCheckView(next.a,now,live).failed,true);
  assert.equal(contextCheckView(next.b,now,live).failed,false);
  assert.equal(next.b.successfulCheckAt,now-2000);assert.equal(state.a.error,null);
});

test('older or invalid source timestamps cannot overwrite a newer successful check',()=>{
  const previous={successfulCheckAt:now-1000,error:null};
  for(const successfulCheckAt of [null,undefined,NaN,Infinity,-1,now-2000]){
    assert.equal(recordContextCheck(previous,{successfulCheckAt}).successfulCheckAt,now-1000);
  }
});

test('clock skew never displays a negative age or a large future check as current',()=>{
  assert.equal(contextCheckView({successfulCheckAt:now+1000,error:null},now,live).checkedLabel,'0s ago');
  assert.equal(contextCheckView({successfulCheckAt:now+60_000,error:null},now,live).checkedLabel,'Not verified yet');
});

test('ended and conflicting reports do not claim to be waiting for a normal new play',()=>{
  const checked={successfulCheckAt:now,error:null};
  assert.equal(contextCheckView(checked,now,{...live,ended:true}).message,'Game ended; showing the final available report.');
  assert.equal(contextCheckView(checked,now,{...live,freshness:'conflicting'}).message,'Waiting for the game reports to agree.');
});
