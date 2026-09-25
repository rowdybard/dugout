import {env} from 'cloudflare:workers';
import {polymarketSecrets} from '../trading/credentials';
import {marketSocketHeaders} from '../trading/us-signature';
import {StreamState} from '../../services/trading/state';
import type {StreamQuote,StreamSelection} from '../trading/stream-types';
import {saveStreamBooks} from './stream-books';

/** One upstream connection per streamed request. No private account feed or order methods. */
export async function marketStream(request:Request,selections:StreamSelection[]){
  const keys=polymarketSecrets(env as unknown as Record<string,unknown>);
  if(!keys)return Response.json({error:'Polymarket US keys are not configured.'},{status:503});
  if(!selections.length)return Response.json({error:'No eligible markets to stream right now.'},{status:409});
  const headers=await marketSocketHeaders(keys.keyId,keys.secretKey);
  const handshake=new AbortController(),timeout=setTimeout(()=>handshake.abort(),8000);
  let response:Response;
  try{response=await fetch('https://api.polymarket.us/v1/ws/markets',{headers:{...headers,Upgrade:'websocket'},signal:AbortSignal.any([handshake.signal,request.signal])});}
  catch{return Response.json({error:'The live connection could not be opened. REST checks remain available.'},{status:503});}
  finally{clearTimeout(timeout);}
  if(response.status!==101||!response.webSocket)return Response.json({error:`Polymarket US live connection returned HTTP ${response.status}.`},{status:503});
  const socket=response.webSocket;
  const state=new StreamState(true),connectionId=crypto.randomUUID(),encoder=new TextEncoder();
  state.health.private.state='stopped';state.health.private.reason='Market data only; no private account stream.';
  state.health.reconciliation.state='not_configured';state.setSelections(selections);
  const dirty=new Map<string,StreamQuote>();
  let ended=false,timer:ReturnType<typeof setInterval>|undefined,ageTimer:ReturnType<typeof setTimeout>|undefined;
  let writer:ReadableStreamDefaultController<Uint8Array>|undefined,writing=false;
  let tail=Promise.resolve();
  const send=(type:string,data:unknown)=>{
    if(ended||!writer)return;
    if((writer.desiredSize??0)<-65536){void stop('Slow browser connection. Reconnecting.');return;}
    try{writer.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));}catch{void stop('Browser disconnected.');}
  };
  const flush=()=>{
    if(ended||writing)return;
    writing=true;const quotes=[...dirty.values()];dirty.clear();
    const connection={id:connectionId,active:state.health.market.state==='connected',updatedAt:Date.now()};
    tail=tail.then(()=>saveStreamBooks(connection,quotes)).catch(()=>{send('notice',{message:'Live display connected; bot is using REST until book storage recovers.'});}).finally(()=>{writing=false;});
  };
  async function stop(reason:string){
    if(ended)return;
    // Set the re-entry guard before disconnect events can reach a canceled writer.
    ended=true;state.disconnected('market','stopped',reason);
    clearInterval(timer);clearTimeout(ageTimer);request.signal.removeEventListener('abort',onAbort);
    try{socket.close(1000,'Stream ended');}catch{}
    // A closed generation is terminal in storage, even if an earlier flush finishes later.
    const invalidate=saveStreamBooks({id:connectionId,active:false,updatedAt:Date.now()},[]).catch(()=>{});
    try{writer?.close();}catch{}
    await Promise.race([invalidate,new Promise<void>(resolve=>setTimeout(resolve,2000))]);
  }
  const onAbort=()=>{void stop('Browser disconnected.');};
  const body=new ReadableStream<Uint8Array>({
    start(controller){
      writer=controller;
      controller.enqueue(encoder.encode('retry: 10000\n\n'));
      state.onEvent(event=>{
        send(event.type,event.data);
        if(event.type==='quote'&&event.data.book)dirty.set(event.data.slug,event.data);
      });
      socket.binaryType='arraybuffer';
      socket.addEventListener('message',event=>{
        if(ended)return;
        try{
          const payload=typeof event.data==='string'?event.data:new TextDecoder().decode(event.data as ArrayBuffer);
          if(payload.length>1000000){void stop('Oversized provider message.');return;}
          const rejected=state.health.market.rejectedMessages;
          state.ingestMarket(JSON.parse(payload));
          if(state.health.market.rejectedMessages>rejected)void stop('Provider message could not be verified. Reconnecting.');
        }catch{void stop('Unreadable provider message. Reconnecting.');}
      });
      socket.addEventListener('close',()=>{void stop('Polymarket connection closed. Reconnecting.');});
      socket.addEventListener('error',()=>{void stop('Polymarket connection interrupted. Reconnecting.');});
      socket.accept();state.connected('market');
      send('snapshot',state.snapshot());
      socket.send(JSON.stringify({subscribe:{requestId:connectionId,subscriptionType:'SUBSCRIPTION_TYPE_MARKET_DATA',marketSlugs:selections.map(s=>s.slug)}}));
      timer=setInterval(()=>{
        if(state.checkHealth(45000).includes('market')){void stop('The live feed stopped responding. Reconnecting.');return;}
        flush();send('status',state.health);
      },3000);
      // Refresh catalogue/subscriptions periodically, without ever inventing new quote timestamps.
      ageTimer=setTimeout(()=>{void stop('Refreshing selected markets.');},180000);
      request.signal.addEventListener('abort',onAbort,{once:true});
      if(request.signal.aborted)onAbort();
    },cancel(){return stop('Browser disconnected.');},
  },{highWaterMark:65536,size:chunk=>chunk.byteLength});
  return new Response(body,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'}});
}
