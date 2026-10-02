import test from 'node:test';
import assert from 'node:assert/strict';
import {VERIFIED_HEARTBEAT_MS,verifiedRowsToWrite} from '../lib/tennis/catalog-loader.ts';
import type {TennisMarket} from '../lib/tennis/types';

const T=Date.parse('2026-10-03T16:00:30Z');
const game=(slug:string,at:number,over:Partial<TennisMarket>={})=>({slug,league:'CFB',title:slug,yesName:'A',noName:'B',startTime:'2026-10-03T19:00:00Z',
  live:false,ended:false,score:null,period:'NS',clock:null,active:true,bid:.5,ask:.51,price:.505,observedAt:at,quoteObservedAt:at,contextUpdatedAt:null,history:[],...over}) as unknown as TennisMarket;

test('a refresh rewrites only games that changed, plus a 10-minute heartbeat (D1 write budget)',()=>{
  const before=[game('a',T),game('b',T),game('c',T)];
  // 30 s later: prices moved on every game, the score changed on b, and d is new.
  const after=[game('a',T+30_000,{bid:.6,ask:.61,price:.605}),game('b',T+30_000,{live:true,score:'7-0',period:'Q1'}),game('c',T+30_000),game('d',T+30_000)];
  assert.deepEqual(verifiedRowsToWrite(before,after).map(m=>m.slug),['b','d'],'price-only changes are not written');
  // Crossing a 10-minute window rewrites every game once.
  const window=Math.ceil((T+1)/VERIFIED_HEARTBEAT_MS)*VERIFIED_HEARTBEAT_MS;
  assert.deepEqual(verifiedRowsToWrite(before,before.map(m=>({...m,observedAt:window}))).map(m=>m.slug),['a','b','c']);
  // A full day of 30 s refreshes on 230 quiet games: about 33,000 rows instead of about 660,000.
  let rows=0,last=Array.from({length:230},(_,i)=>game(`g${i}`,T));
  for(let t=T+30_000;t<T+86_400_000;t+=30_000){const next=last.map(m=>({...m,observedAt:t}));rows+=verifiedRowsToWrite(last,next).length;last=next;}
  assert.ok(rows<=230*145,`${rows} rows a day`);
});
