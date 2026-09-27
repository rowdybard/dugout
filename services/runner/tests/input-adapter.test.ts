import test from 'node:test';
import assert from 'node:assert/strict';
import {PolymarketInputAdapter} from '../src/input-adapter.ts';
import {RunnerStore} from '../src/store.ts';
import {active,NOW,input} from './helpers.ts';
import type {TennisInput,TennisMarket} from '../../../lib/tennis/types';
const marketRaw=(slug='synthetic-tennis')=>({slug,sportsMarketType:'tennis_match_winner',minimumTradeQty:1,orderPriceMinTickSize:.01,feeCoefficient:.05,active:true,status:'MARKET_STATUS_OPEN',marketSides:[{long:true,description:'Synthetic A'},{long:false,description:'Synthetic B'}]});
const eventRaw=(slug='synthetic-tennis')=>({id:'fixture',slug:'fixture',title:'Synthetic A vs Synthetic B',active:true,live:true,ended:false,startTime:new Date(NOW).toISOString(),eventState:{updatedAt:new Date(NOW).toISOString(),live:true},markets:[marketRaw(slug)]});
const bookRaw=(time:number)=>({marketData:{marketSlug:'synthetic-tennis',bids:[{px:{value:'0.49',currency:'USD'},qty:'1000'}],offers:[{px:{value:'0.50',currency:'USD'},qty:'1000'}],state:'MARKET_STATE_OPEN',transactTime:new Date(time).toISOString()}});
const fresh=(time:number)=>Response.json(bookRaw(time),{headers:{'CF-Cache-Status':'DYNAMIC'}});

for(const longest of ['metadata','event','book'] as const){
  test(`concurrent 429 responses cannot shorten ${longest}'s longer provider pause`,async(t)=>{
    const {store}=await active(),time=NOW+2000;t.mock.method(Date,'now',()=>time);
    const market=input(time).market;store.set('exchange-rules:'+market.slug,{at:time,execution:market.execution});
    const responses=new Map<string,(response:Response)=>void>();let calls=0;
    t.mock.method(globalThis,'fetch',async(url:string)=>{calls++;const source=url.includes('/v1/events?')?'event':url.includes('/book?')?'book':'metadata';return new Promise<Response>(resolve=>{responses.set(source,resolve);});});
    const adapter=new PolymarketInputAdapter(store,async()=>null) as unknown as {
      publicGet(path:string,signal:AbortSignal):Promise<unknown>;
      footballEvent(eventId:string,signal:AbortSignal):Promise<unknown>;
      load(market:TennisMarket,signal:AbortSignal):Promise<TennisInput>;
    };
    const signal=new AbortController().signal;
    const pending={metadata:adapter.publicGet('/v1/market/slug/'+market.slug,signal).catch(()=>{}),event:adapter.footballEvent('112943',signal).catch(()=>{}),book:adapter.load(market,signal).catch(()=>{})};
    assert.equal(responses.size,3);
    responses.get(longest)!(new Response(null,{status:429,headers:{'Retry-After':'180'}}));await pending[longest];
    assert.equal(store.get('provider-backoff'),time+180_000);
    for(const source of ['metadata','event','book'] as const){if(source===longest)continue;
      responses.get(source)!(new Response(null,{status:429,headers:{'Retry-After':'10'}}));await pending[source];
      assert.equal(store.get('provider-backoff'),time+180_000);
    }
    await assert.rejects(adapter.footballEvent('112943',signal),/backoff/);assert.equal(calls,3);
  });
}
class FakeSocket extends EventTarget {binaryType='arraybuffer';messages:string[]=[];closed=false;accept(){}send(value:string){this.messages.push(value);}close(){this.closed=true;this.dispatchEvent(new Event('close'));}message(value:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}}

test('native REST preserves actual receipt and provider clocks; cached books and backoff block reuse',async(t)=>{
  const {store}=await active();let now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!;session.status='running';store.set('focused-market:synthetic-tennis',input(now).market);
  let cache='DYNAMIC',requests=0;t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.includes('/events/slug/'))return Response.json(eventRaw());if(url.includes('/market/slug/'))return Response.json({market:marketRaw()});requests++;now+=100;return Response.json(bookRaw(NOW-20000),{headers:{'CF-Cache-Status':cache}});});
  const adapter=new PolymarketInputAdapter(store,async()=>null),first=await adapter.gather(session);assert.equal(first.inputs.length,1);assert.equal(first.inputs[0].receivedAt,NOW+2000);assert.equal(first.inputs[0].restReceipt?.receivedAt,NOW+2100);assert.equal(first.inputs[0].sourceTime,NOW-20000);
  cache='HIT';const blocked=await adapter.gather(session);assert.equal(blocked.inputs.length,0);assert.match(blocked.failures[0],/cached/);
  store.set('provider-backoff',now+60000);const before=requests;assert.equal((await adapter.gather(session)).inputs.length,0);assert.equal(requests,before);
});
test('focused selection survives reconstruction and never falls back to another game',async(t)=>{
  const {store,storage}=await active();const now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!;session.status='running';store.set('focused-market:synthetic-tennis',input(now).market);
  const urls:string[]=[];t.mock.method(globalThis,'fetch',async(url:string)=>{urls.push(url);if(url.includes('/events/slug/'))return Response.json(eventRaw());if(url.includes('/market/slug/'))return Response.json({market:marketRaw()});if(url.includes('/market/slug/'))return Response.json({market:marketRaw()});if(url.includes('/synthetic-tennis/book'))return fresh(now);throw new Error('Unexpected source route');});
  const adapter=new PolymarketInputAdapter(new RunnerStore(storage),async()=>null);assert.equal((await adapter.gather(session)).inputs[0].market.slug,'synthetic-tennis');assert.ok(urls.some(u=>u.includes('/v1/events/slug/fixture')));assert.ok(!urls.some(u=>u.includes('/leagues/')));
});
test('progressive discovery reaches focused games beyond the first eight events',async(t)=>{
  const {store}=await active();const now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!;session.status='running';session.config.leagues=['ATP'];
  const offsets:number[]=[];t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.includes('/leagues/')){const offset=Number(new URL(url).searchParams.get('offset'));offsets.push(offset);return Response.json({events:offset===0?Array.from({length:20},(_,i)=>({...eventRaw('other-'+i),id:'event-'+i,slug:'event-'+i})):[eventRaw()]});}if(url.includes('/market/slug/'))return Response.json({market:marketRaw()});if(url.includes('/synthetic-tennis/book'))return fresh(now);throw new Error('Unexpected source route');});
  const adapter=new PolymarketInputAdapter(store,async()=>null),result=await adapter.gather(session);assert.deepEqual(offsets,[0,20]);assert.equal(result.inputs[0].market.slug,'synthetic-tennis');
});
test('fresh context receipts cannot extend exchange fee and size metadata lifetime',async(t)=>{
  const {store}=await active();let now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!;session.status='running';store.set('focused-market:synthetic-tennis',input(now).market);let metadataReads=0;
  t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.includes('/events/slug/'))return Response.json(eventRaw());if(url.includes('/market/slug/')){metadataReads++;return Response.json({market:{...marketRaw(),feeCoefficient:metadataReads===1?.05:.07}});}return fresh(now);});
  const adapter=new PolymarketInputAdapter(store,async()=>null);await adapter.gather(session);now+=15000;await adapter.gather(session);assert.equal(metadataReads,1);now+=46001;const result=await adapter.gather(session);assert.equal(metadataReads,2);assert.equal(result.inputs[0].market.execution?.feeCoefficient,.07);
});
test('native websocket ignores old source clocks without refreshing receipt; invalid future clocks disconnect',async(t)=>{
  const {store}=await active();let now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!;session.status='running';store.set('focused-market:synthetic-tennis',input(now).market);const socket=new FakeSocket();
  t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.includes('/v1/ws/markets'))return {status:101,webSocket:socket} as unknown as Response;if(url.includes('/events/slug/'))return Response.json(eventRaw());if(url.includes('/market/slug/'))return Response.json({market:marketRaw()});return fresh(now);});
  const tasks:Promise<unknown>[]=[];const adapter=new PolymarketInputAdapter(store,async()=>({keyId:'synthetic-provider',secretKey:btoa('x'.repeat(32))}),task=>{tasks.push(task);});await adapter.gather(session);await Promise.all(tasks);
  assert.equal(socket.messages.length,1);assert.match(socket.messages[0],/SUBSCRIPTION_TYPE_MARKET_DATA/);assert.ok(!socket.messages[0].includes('PRIVATE'));
  socket.message({requestId:'fixture-request',subscriptionType:'SUBSCRIPTION_TYPE_MARKET_DATA',...bookRaw(now)});const streamed=await adapter.gather(session);assert.equal(streamed.inputs[0].source,'WEBSOCKET');assert.equal(streamed.inputs[0].receivedAt,now);
  now+=1000;socket.message({requestId:'fixture-request',subscriptionType:'SUBSCRIPTION_TYPE_MARKET_DATA',...bookRaw(now-2000)});
  assert.equal((await adapter.gather(session)).inputs[0].receivedAt,now-1000);
  socket.message({requestId:'fixture-request',subscriptionType:'SUBSCRIPTION_TYPE_MARKET_DATA',...bookRaw(now+10000)});
  assert.equal(socket.closed,true);assert.equal((await adapter.gather(session)).inputs[0].source,'REST');adapter.close();
});

test('successful websocket upgrade cancels its handshake deadline and requests unbatched updates',async(t)=>{
  const {store}=await active();let time=NOW+2000;t.mock.method(Date,'now',()=>time);
  const session=store.session()!;session.status='running';store.set('focused-market:synthetic-tennis',input(time).market);
  const socket=new FakeSocket();let handshakeSignal:AbortSignal|undefined;
  t.mock.timers.enable({apis:['setTimeout']});
  t.mock.method(globalThis,'fetch',async(url:string,options?:RequestInit)=>{
    if(url.includes('/v1/ws/markets')){handshakeSignal=options?.signal??undefined;handshakeSignal?.addEventListener('abort',()=>socket.close());return {status:101,webSocket:socket} as unknown as Response;}
    if(url.includes('/events/slug/'))return Response.json(eventRaw());
    if(url.includes('/market/slug/'))return Response.json({market:marketRaw()});return fresh(time);
  });
  const tasks:Promise<unknown>[]=[];
  const adapter=new PolymarketInputAdapter(store,async()=>({keyId:'synthetic-provider',secretKey:btoa('x'.repeat(32))}),task=>tasks.push(task));
  await adapter.gather(session);await Promise.all(tasks);
  assert.equal(JSON.parse(socket.messages[0]).subscribe.responsesDebounced,false);
  t.mock.timers.tick(4000);time+=4000;
  assert.equal(handshakeSignal?.aborted,false);assert.equal(socket.closed,false);
  socket.message({requestId:'fixture-request',subscriptionType:'SUBSCRIPTION_TYPE_MARKET_DATA',...bookRaw(time)});
  assert.equal((await adapter.gather(session)).inputs[0].source,'WEBSOCKET');adapter.close();
});
test('held football exits use their book before a slow direct game report, then use the persisted fresh report',async(t)=>{
  const {store}=await active();let now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!,market={...input(NOW).market,eventId:'112943',league:'CFB' as const,score:'7-0',period:'Q1',clock:'10:30',contextUpdatedAt:NOW,footballIdentity:{yesTeamId:'1',noTeamId:'2'},football:{possessionTeam:'Synthetic A',possessionTeamId:'1',down:2,yardsToGo:7,fieldPosition:{team:'Synthetic B',teamId:'2',yard:30},timeouts:[]},execution:{...input(NOW).market.execution!,league:'CFB' as const}};
  session.positions=[{status:'open',market,lastContext:market} as unknown as typeof session.positions[number]];
  let release!:(r:Response)=>void,requested=false;const delayed=new Promise<Response>(r=>{release=r;});
  const rawMarket={...marketRaw(),sportsMarketType:'football_team_full_game_winner',marketSides:[{long:true,teamId:'1',team:{id:'1',name:'Synthetic A',league:'CFB'}},{long:false,teamId:'2',team:{id:'2',name:'Synthetic B',league:'CFB'}}]};
  t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.includes('/v1/events?')){requested=true;return delayed;}if(url.includes('/market/slug/'))return Response.json({market:rawMarket});return fresh(now);});
  const tasks:Promise<unknown>[]=[];const adapter=new PolymarketInputAdapter(store,async()=>null,p=>{tasks.push(p);});const first=await adapter.gather(session);assert.equal(requested,true);assert.equal(first.inputs.length,1);assert.equal(first.inputs[0].receivedAt,now);assert.equal(first.inputs[0].market.football?.down,2);
  now+=1000;release(Response.json({events:[{...eventRaw(),id:'112943',score:'7-0',period:'Q1',eventState:{type:'football',live:true,period:'Q1',elapsed:'10:20',updatedAt:new Date(now-500).toISOString(),footballState:{driveState:{possessionTeamId:'1',down:4,yfd:7,fieldPosition:{teamId:'2',yard:30}}}},markets:[rawMarket]}]},{headers:{'CF-Cache-Status':'DYNAMIC'}}));await Promise.all(tasks);
  const second=await adapter.gather(session);assert.equal(second.inputs[0].market.football?.down,4);assert.equal(second.inputs[0].market.contextUpdatedAt,now-500);assert.equal(second.inputs[0].restReceipt?.requestedAt,now);
});

test('large event detail accepts a realistic 195-market payload without lifting metadata or book limits',async(t)=>{
  const {store}=await active(),now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!;session.status='running';store.set('focused-market:synthetic-tennis',input(now).market);
  const event={...eventRaw(),markets:[marketRaw(),...Array.from({length:194},(_,i)=>({...marketRaw('prop-'+i),sportsMarketType:'other_prop',description:'x'.repeat(5800)}))]};
  assert.ok(Buffer.byteLength(JSON.stringify({event}))>1_100_000);assert.ok(Buffer.byteLength(JSON.stringify({event}))<4_000_000);
  t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.includes('/events/slug/'))return Response.json({event});if(url.includes('/market/slug/'))return Response.json({market:marketRaw()});return fresh(now);});
  const result=await new PolymarketInputAdapter(store,async()=>null).gather(session);assert.equal(result.inputs.length,1);assert.deepEqual(result.failures,[]);
});

test('large twenty-event discovery page retains its cursor and selected winner with a bounded sixteen-megabyte cap',async(t)=>{
  const {store}=await active(),now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!;session.status='running';session.config.leagues=['ATP'];
  const events=Array.from({length:20},(_,i)=>({...eventRaw(i===0?'synthetic-tennis':'other-'+i),id:i===0?'fixture':'event-'+i,slug:i===0?'fixture':'event-'+i,
    markets:[marketRaw(i===0?'synthetic-tennis':'other-'+i),...Array.from({length:55},(_,j)=>({...marketRaw('prop-'+i+'-'+j),sportsMarketType:'other_prop',description:'x'.repeat(6700)}))]}));
  const bytes=Buffer.byteLength(JSON.stringify({events}));assert.ok(bytes>7_600_000&&bytes<16_000_000);
  const offsets:number[]=[];t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.includes('/leagues/')){const offset=Number(new URL(url).searchParams.get('offset'));offsets.push(offset);return Response.json({events:offset===0?events:[]});}if(url.includes('/events/slug/'))return Response.json(eventRaw());if(url.includes('/market/slug/'))return Response.json({market:marketRaw()});return fresh(now);});
  const result=await new PolymarketInputAdapter(store,async()=>null).gather(session);assert.equal(result.inputs[0]?.market.slug,'synthetic-tennis');assert.deepEqual(offsets,[0,20]);assert.ok(!result.failures.some(f=>f.includes('size limit')));
});

for(const [name,maxBytes] of [['event',4_000_000],['metadata',1_000_000],['league',16_000_000]] as const){
  test(`${name} oversized streams are cancelled at their endpoint-specific byte limit`,async(t)=>{
    const {store}=await active(),now=NOW+2000;t.mock.method(Date,'now',()=>now);const session=store.session()!;session.status='running';session.config.leagues=['ATP'];
    if(name!=='league')store.set('focused-market:synthetic-tennis',input(now).market);
    let cancelled=false;const oversized=()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(maxBytes+1));},cancel(){cancelled=true;}}));
    t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.includes('/leagues/'))return oversized();if(url.includes('/events/slug/'))return name==='event'?oversized():Response.json(eventRaw());if(url.includes('/market/slug/'))return name==='metadata'?oversized():Response.json({market:marketRaw()});return fresh(now);});
    const result=await new PolymarketInputAdapter(store,async()=>null).gather(session);assert.equal(cancelled,true);
    if(name!=='league')assert.ok(result.failures.some(f=>f.includes(`size limit (${maxBytes} bytes)`)),result.failures.join(';'));
    if(name==='metadata'||name==='league')assert.equal(result.inputs.length,0);
    if(name==='league')assert.match(store.get<{error:string}>('discovery:ATP')!.error,/16000000 bytes/);
  });
}
