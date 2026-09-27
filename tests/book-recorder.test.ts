import test from 'node:test';
import assert from 'node:assert/strict';
import {BookRecorder,bookRecord} from '../lib/datastore/recorder.ts';
import type {TennisInput} from '../lib/tennis/types';

const T=Date.parse('2026-10-03T19:00:00Z');
function input(time:number,slug='aec-cfb-home-away-2026-10-03',source:TennisInput['source']='REST'):TennisInput{
  const bids=Array.from({length:12},(_,i)=>({price:Math.round((.60-i*.005)*1e3)/1e3,quantity:100+i}));
  const asks=Array.from({length:12},(_,i)=>({price:Math.round((.61+i*.005)*1e3)/1e3,quantity:200+i}));
  return {receivedAt:time,source,sourceTime:time-100,book:{bids:[...bids].reverse(),asks,state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    market:{slug,eventId:'1',eventSlug:'e',title:'Home vs Away',league:'CFB',yesName:'Home',noName:'Away',startTime:new Date(T).toISOString(),live:true,ended:false,active:true,
      score:'7-3',period:'Q2',clock:'4:10',tournament:null,football:{possessionTeam:'Home',possessionTeamId:'1',down:3,yardsToGo:4,fieldPosition:{team:'Away',teamId:'2',yard:31},timeouts:[]},
      footballIdentity:{yesTeamId:'1',noTeamId:'2'},bid:.6,ask:.61,price:.605,observedAt:time,contextUpdatedAt:time,history:[],execution:null}};
}
function bucket(fail=0){
  const objects=new Map<string,string>();let failures=fail;
  return {objects,put:async(key:string,value:string)=>{if(failures>0){failures--;throw new Error('R2 unavailable');}objects.set(key,value);}};
}

test('records top-10 depth best-first with game status', () => {
  const record=bookRecord(input(T));
  assert.equal(record.bids.length,10);assert.equal(record.asks.length,10);
  assert.deepEqual(record.bids[0],[.6,100]);assert.deepEqual(record.asks[0],[.61,200]);
  assert.ok(record.bids.every((level,i)=>i===0||level[0]<record.bids[i-1][0]));
  assert.deepEqual(record.football,{possession:'1',down:3,yardsToGo:4,fieldTeam:'2',yard:31,yesTeamId:'1',noTeamId:'2'});
  assert.equal(record.reportTime,T);
  assert.equal(record.score,'7-3');assert.equal(record.src,'REST');
});

test('batches by size or age, dedupes repeated receipts, skips replays, and partitions keys', async () => {
  let now=T,id=0;
  const recorder=new BookRecorder({maxRecords:3,maxAgeMs:60_000,now:()=>now,id:()=>`b${++id}`});
  const r2=bucket();
  recorder.add([input(T),input(T),input(T,'x','REPLAY')]);
  assert.equal(recorder.size,1);
  assert.deepEqual(await recorder.flush(r2),[],'small and young batches wait');
  recorder.add([input(T+2500),input(T+5000)]);
  const keys=await recorder.flush(r2);
  assert.deepEqual(keys,[`dugout/live-books/date=2026-10-03/league=cfb/aec-cfb-home-away-2026-10-03/${T}-b1.ndjson`]);
  assert.equal(r2.objects.get(keys[0])!.trim().split('\n').length,3);
  recorder.add([input(T+7500)]);now+=61_000;
  assert.equal((await recorder.flush(r2)).length,1,'old batches are written even when small');
});

test('a failed write keeps the records for the next batch', async () => {
  const recorder=new BookRecorder({maxRecords:1});
  const r2=bucket(1);
  recorder.add([input(T)]);
  assert.deepEqual(await recorder.flush(r2),[]);
  assert.equal(recorder.size,1);
  assert.equal((await recorder.flush(r2)).length,1);
  assert.equal(recorder.size,0);
});
