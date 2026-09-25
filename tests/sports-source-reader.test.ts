import test from 'node:test';
import assert from 'node:assert/strict';
import {createSportsReader,retryTime,SportsSourceError,type SportsSourceFailure} from '../lib/sports-context/source-reader.ts';
const T=1790300000000;
test('Retry-After is honored without shortening minimum source cooldowns',()=>{
 assert.equal(retryTime(403,null,T),T+300000);
 assert.equal(retryTime(503,null,T),T+15000);
 for(const value of [null,'','bad','0','1',new Date(T-1000).toUTCString()])assert.equal(retryTime(429,value,T),T+30000);
 assert.equal(retryTime(429,'120',T),T+120000);
 assert.equal(retryTime(429,new Date(T+90000).toUTCString(),T),T+90000);
});
test('denials retain evidence and stop requests without sliding the expiry',async()=>{
 let now=T,calls=0,writes=0,blocked:SportsSourceFailure|null=null;
 const read=createSportsReader({now:()=>now,readBlock:async()=>blocked,writeBlock:async(_,failure)=>{writes++;blocked=JSON.parse(JSON.stringify(failure));},fetch:async()=>{calls++;return calls===1?new Response('<title>Access Denied</title>',{status:403}):Response.json({events:[]});}});
 const url='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260925';
 await assert.rejects(()=>read(url,new AbortController().signal),(e:unknown)=>e instanceof SportsSourceError&&e.failure.status===403&&e.failure.endpoint===url&&e.failure.denial==='access_denied');
 for(const offset of [5000,299999]){now=T+offset;await assert.rejects(()=>read(url,new AbortController().signal),(e:unknown)=>e instanceof SportsSourceError&&e.failure.retryAt===T+300000);}
 assert.equal(calls,1);assert.equal(writes,1);
 now=T+300000;assert.deepEqual(await read(url,new AbortController().signal),{events:[]});assert.equal(calls,2);
});
test('invalid JSON is never presented as healthy game data',async()=>{
 let blocked:SportsSourceFailure|null=null;
 const read=createSportsReader({now:()=>T,readBlock:async()=>blocked,writeBlock:async(_,f)=>{blocked=f;},fetch:async()=>new Response('not json')});
 await assert.rejects(()=>read('https://example.invalid',new AbortController().signal),(e:unknown)=>e instanceof SportsSourceError&&e.failure.kind==='invalid_json');
});
test('an aborted caller makes no request or cooldown write',async()=>{
 let calls=0;const read=createSportsReader({now:()=>T,readBlock:async()=>null,writeBlock:async()=>{calls++;},fetch:async()=>{calls++;return Response.json({});}});
 const controller=new AbortController();controller.abort();await assert.rejects(()=>read('https://example.invalid',controller.signal));assert.equal(calls,0);
});
