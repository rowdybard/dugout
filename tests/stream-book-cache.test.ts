import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateKey,createPublicKey,verify} from 'node:crypto';
import {marketSocketHeaders} from '../lib/trading/us-signature.ts';
import {usableStreamBook} from '../lib/trading/stream-book.ts';
import type {StreamQuote} from '../lib/trading/stream-types.ts';
const now=1800000000000;
const quote=():StreamQuote=>({slug:'synthetic',league:'NFL',bid:.4,ask:.42,price:.41,bidDecimal:'.4',askDecimal:'.42',priceDecimal:'.41',priceKind:'last_trade',lastTradeDecimal:'.41',book:{bids:[{price:'.4',quantity:'100'}],asks:[{price:'.42',quantity:'100'}]},state:'MARKET_STATE_OPEN',sharesTraded:'1',sourceTime:now,receivedAt:now,lastPriceChangeAt:now,valid:true,source:'polymarket_us_websocket'});
test('book cache requires active matching generation and independently recent book',()=>{
 const stored={connectionId:'a',quote:quote()},connection={id:'a',active:true,updatedAt:now};
 assert.equal(usableStreamBook(stored,connection,now)?.receivedAt,now);
 assert.equal(usableStreamBook(stored,{...connection,id:'b'},now),null);
 assert.equal(usableStreamBook(stored,{...connection,active:false},now),null);
 assert.equal(usableStreamBook(stored,{...connection,updatedAt:now+13000},now+13000),null,'heartbeat cannot renew an old book');
 assert.equal(usableStreamBook(stored,{...connection,updatedAt:NaN},now),null);
 assert.equal(usableStreamBook({...stored,quote:{...quote(),receivedAt:NaN}},connection,now),null);
});
test('malformed, crossed and invalidated books cannot execute',()=>{
 for(const mutate of [(q:StreamQuote)=>q.valid=false,(q:StreamQuote)=>q.book=null,(q:StreamQuote)=>q.book!.asks[0].price='.3',(q:StreamQuote)=>q.book!.asks[0].quantity='NaN',(q:StreamQuote)=>q.book!.bids.push({price:'.5',quantity:'1'})]){
  const q=quote();mutate(q);assert.equal(usableStreamBook({connectionId:'a',quote:q},{id:'a',active:true,updatedAt:now},now),null);
 }
});
test('official US handshake signature verifies exact timestamp, method and path',async()=>{
 const seed=Buffer.alloc(32,7),privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'}),publicKey=createPublicKey(privateKey);
 const h=await marketSocketHeaders('synthetic-key',seed.toString('base64'),now);
 assert.equal(h['X-PM-Access-Key'],'synthetic-key');assert.equal(h['X-PM-Timestamp'],String(now));
 assert.ok(verify(null,Buffer.from(`${now}GET/v1/ws/markets`),publicKey,Buffer.from(h['X-PM-Signature'],'base64')));
 assert.ok(!verify(null,Buffer.from(`${now}POST/v1/ws/markets`),publicKey,Buffer.from(h['X-PM-Signature'],'base64')));
 const long=await marketSocketHeaders('synthetic-key',Buffer.concat([seed,Buffer.alloc(32,9)]).toString('base64'),now);
 assert.equal(long['X-PM-Signature'],h['X-PM-Signature']);
 await assert.rejects(()=>marketSocketHeaders('synthetic-key','AA==',now));
});
