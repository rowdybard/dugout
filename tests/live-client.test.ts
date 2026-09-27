import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveApiError,PolymarketUSClient} from '../lib/live/client.ts';

const secret=btoa(String.fromCharCode(...new Uint8Array(32).map((_,i)=>i+1)));
type Call={url:string;init:RequestInit};
function client(respond:(call:Call)=>Response|Promise<Response>){
  const calls:Call[]=[];
  const api=new PolymarketUSClient({keyId:'key-123',secretKey:secret},{now:()=>1_790_000_000_000,fetcher:async(url,init)=>{const call={url,init};calls.push(call);return respond(call);}});
  return {api,calls};
}

test('signed requests hit the official endpoints with the SDK header scheme; the query is not signed',async()=>{
  const {api,calls}=client(()=>Response.json({orders:[]}));
  await api.openOrders(['a-slug','b-slug']);
  const {url,init}=calls[0],headers=init.headers as Record<string,string>;
  assert.equal(url,'https://api.polymarket.us/v1/orders/open?slugs=a-slug&slugs=b-slug');
  assert.equal(init.method,'GET');assert.equal(headers['X-PM-Access-Key'],'key-123');assert.equal(headers['X-PM-Timestamp'],'1790000000000');
  // Ed25519 signatures are deterministic: the same timestamp, method and path give the same signature.
  const again=client(()=>Response.json({orders:[]}));
  await again.api.openOrders();
  assert.equal((again.calls[0].init.headers as Record<string,string>)['X-PM-Signature'],headers['X-PM-Signature']);
  await again.api.balances();
  assert.notEqual((again.calls[1].init.headers as Record<string,string>)['X-PM-Signature'],headers['X-PM-Signature']);
});

test('order endpoints send the documented bodies',async()=>{
  const {api,calls}=client(()=>Response.json({id:'o-1'}));
  await api.cancelOrder('o-1','a-slug');await api.cancelAll(['a-slug']);await api.previewOrder({marketSlug:'a-slug',intent:'ORDER_INTENT_BUY_LONG'});
  assert.deepEqual(calls.map(call=>[new URL(call.url).pathname,call.init.method,call.init.body]),[
    ['/v1/order/o-1/cancel','POST',JSON.stringify({marketSlug:'a-slug'})],
    ['/v1/orders/open/cancel','POST',JSON.stringify({slugs:['a-slug']})],
    ['/v1/order/preview','POST',JSON.stringify({request:{marketSlug:'a-slug',intent:'ORDER_INTENT_BUY_LONG'}})]]);
});

test('errors: 4xx are definite rejections; 408, 5xx and network loss have unknown outcomes',async()=>{
  const cases:[()=>Response|Promise<Response>,number,boolean][]=[
    [()=>Response.json({message:'post-only order would cross'},{status:400}),400,false],
    [()=>new Response('rate limited',{status:429}),429,false],
    [()=>new Response('',{status:408}),408,true],
    [()=>new Response('',{status:502}),502,true],
    [()=>Promise.reject(new Error('socket hang up')),0,true],
    [()=>new Response('not json',{status:200}),200,true],
  ];
  for(const [respond,status,unknown] of cases){
    const {api}=client(respond);
    await assert.rejects(api.createOrder({marketSlug:'a',intent:'ORDER_INTENT_BUY_LONG'}),(error:unknown)=>error instanceof LiveApiError&&error.status===status&&error.outcomeUnknown===unknown);
  }
  const {api}=client(()=>Response.json({message:'post-only order would cross'},{status:400}));
  await assert.rejects(api.createOrder({marketSlug:'a',intent:'ORDER_INTENT_BUY_LONG'}),/would cross/);
});
