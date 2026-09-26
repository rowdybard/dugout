'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import type {TennisAction,TennisCatalog,TennisRuntime,TennisSession,TennisSessionResponse} from '@/lib/tennis/types';
import type {StreamHealth,StreamQuote,StreamSnapshot} from '@/lib/trading/stream-types';
import {mergeTennisHistory,marketWithSessionQuotes} from '@/lib/tennis/chart-data';

async function readJson<T>(url:string,init?:RequestInit):Promise<T> {
  const response=await fetch(url,{cache:'no-store',...init,signal:AbortSignal.timeout(20000)}).catch(cause=>{
    throw new Error(cause?.name==='TimeoutError'?'The connection timed out. Reconnecting to your saved session.':'Connection interrupted. Retrying with fresh data; your saved balance is safe.');
  });
  let data:T & {error?:string};
  try {data=await response.json();} catch {throw new Error(`The server returned an unreadable response (${response.status}). Try again.`);}
  if(!response.ok) throw new Error(data.error||`Request failed (${response.status}). Try again.`);
  return data;
}

export function useTennis() {
  const [catalog,setCatalog]=useState<TennisCatalog|null>(null);
  const [session,setSession]=useState<TennisSession|null>(null);
  const [runtime,setRuntime]=useState<TennisRuntime|null>(null);
  const [loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false);
  const [error,setError]=useState<string|null>(null),[feedError,setFeedError]=useState<string|null>(null);
  const [connectionIssue,setConnectionIssue]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[visible,setVisible]=useState(true);
  const [streamStatus,setStreamStatus]=useState('connecting');
  const [now,setNow]=useState(()=>Date.now());
  const sessionId=session?.id;
  const inflight=useRef(false),mounted=useRef(true),sessionRef=useRef<TennisSession|null>(null),catalogBusy=useRef(false);
  const runningRequest=useRef<Promise<boolean>|null>(null),commandQueued=useRef(false);
  const accept=useCallback((response:TennisSessionResponse)=>{
    if(!mounted.current)return;
    setSession(current=>{
      if(current&&current.revision>response.session.revision)return current;
      sessionRef.current=response.session;
      return response.session;
    });
    setRuntime(response.runtime);
    setConnectionIssue(null);
    setCatalog(current=>current?{...current,markets:current.markets.map(m=>marketWithSessionQuotes(m,response.session))}:current);
    if(response.error)setError(response.error);
  },[]);
  const refresh=useCallback(async()=>{
    if(catalogBusy.current)return;
    catalogBusy.current=true;setRefreshing(true);
    try{
      const data=await readJson<TennisCatalog>('/api/tennis');
      if(!mounted.current)return;
      setCatalog(previous=>({...data,markets:data.markets.map(market=>{
        const existing=previous?.markets.find(row=>row.slug===market.slug);
        const history=mergeTennisHistory(market.history,existing?.history??[]);
        const newest=existing&&(existing.quoteObservedAt??existing.observedAt)>(market.quoteObservedAt??market.observedAt)?{...market,bid:existing.bid,ask:existing.ask,price:existing.price,quoteObservedAt:existing.quoteObservedAt,quoteSource:existing.quoteSource,history}:{...market,history};
        return marketWithSessionQuotes(newest,sessionRef.current);
      })}));setFeedError(null);
    }catch(cause){if(mounted.current)setFeedError(cause instanceof Error?cause.message:'Market data is unavailable.');}
    finally{catalogBusy.current=false;if(mounted.current){setLoading(false);setRefreshing(false);}}
  },[]);
  const perform=useCallback(async(action:TennisAction,background=false)=>{
    // User commands wait behind the one in-flight check. Never silently discard a click.
    if(background&&(inflight.current||commandQueued.current))return false;
    if(!background){
      if(commandQueued.current)return false;
      commandQueued.current=true;setBusy(true);setError(null);
      if(runningRequest.current)await runningRequest.current;
    }
    inflight.current=true;
    const task=(async()=>{
      try{
        const response=await readJson<TennisSessionResponse>('/api/tennis/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)});
        accept(response);
        const result=response.session;
        const rejected=action.action==='start'?result.status!=='running'
          :action.action==='reset'?result.config.startingCash!==action.bankroll||result.status!=='idle'
          :action.action==='update-rules'?(result.rulesRevision??0)!==action.expectedRulesRevision+1
          :action.action==='resume'?result.status!=='running':false;
        if(response.error||rejected){setError(response.error||result.lastReason);return false;}
        setError(null);return true;
      }catch(cause){
        const message=cause instanceof Error?cause.message:'The paper account could not be updated.';
        if(mounted.current){if(background)setConnectionIssue(message);else setError(message);}
        if(/session changed|another request|conflict|updated by|connection/i.test(message)){
          try{accept(await readJson<TennisSessionResponse>('/api/tennis/session'));}catch{/* Keep the actionable original error. */}
        }
        return false;
      }
    })();
    runningRequest.current=task;
    try{return await task;}finally{
      if(runningRequest.current===task)runningRequest.current=null;
      inflight.current=false;
      if(!background){commandQueued.current=false;if(mounted.current)setBusy(false);}
    }
  },[accept]);
  useEffect(()=>{
    mounted.current=true;
    queueMicrotask(()=>{if(mounted.current)void refresh();});
    readJson<TennisSessionResponse>('/api/tennis/session').then(accept).catch(cause=>{if(mounted.current)setError(cause instanceof Error?cause.message:'Could not load the paper account.');});
    const onVisibility=()=>setVisible(document.visibilityState==='visible');
    queueMicrotask(onVisibility);document.addEventListener('visibilitychange',onVisibility);
    const clock=setInterval(()=>setNow(Date.now()),1000);
    return()=>{mounted.current=false;document.removeEventListener('visibilitychange',onVisibility);clearInterval(clock);};
  },[accept,refresh]);
  useEffect(()=>{
    if(!visible)return;
    const timer=setInterval(()=>void refresh(),30000);
    return()=>clearInterval(timer);
  },[visible,refresh]);
  useEffect(()=>{
    if(!visible||!sessionId)return;
    const tick=()=>{
      const current=sessionRef.current;
      if(!current||inflight.current)return;
      // Pausing entries does not pause exit checks; existing positions still need monitoring.
      if(['running','paused','stopping'].includes(current.status)||current.pending||current.positions.some(position=>position.status==='open')){
        void perform({action:'tick',sessionId:current.id},true);
      }
    };
    const timer=setInterval(tick,Math.max(2000,runtime?.intervalMs??2500));
    return()=>clearInterval(timer);
  },[visible,sessionId,runtime?.intervalMs,perform]);
  useEffect(()=>{
    if(!visible||!runtime?.streamConfigured)return;
    queueMicrotask(()=>setStreamStatus('connecting'));
    const events=new EventSource('/api/tennis/stream');
    const merge=(quote:StreamQuote)=>{
      if(!quote.valid)return;
      setStreamStatus('live');
      setCatalog(current=>!current?current:{...current,markets:current.markets.map(market=>{
        if(market.slug!==quote.slug||quote.receivedAt<(market.quoteObservedAt??market.observedAt))return market;
        const points=[...market.history];
        if(quote.price!==null&&(!points.length||quote.receivedAt-points[points.length-1].time>=1000))points.push({time:quote.receivedAt,price:quote.price,bid:quote.bid??undefined,ask:quote.ask??undefined,score:market.score,period:market.period,scoreUpdatedAt:market.contextUpdatedAt});
        return {...market,bid:quote.bid,ask:quote.ask,price:quote.price,quoteObservedAt:quote.receivedAt,quoteSource:'WEBSOCKET' as const,history:points.slice(-1200)};
      })});
    };
    const health=(status:StreamHealth)=>setStreamStatus(status.market.state==='connected'?'live':status.market.state==='connecting'?'connecting':'rest');
    events.addEventListener('snapshot',event=>{try{const data=JSON.parse((event as MessageEvent).data) as StreamSnapshot;health(data.health);data.quotes.forEach(merge);}catch{setStreamStatus('rest');}});
    events.addEventListener('quote',event=>{try{merge(JSON.parse((event as MessageEvent).data) as StreamQuote);}catch{setStreamStatus('rest');}});
    events.addEventListener('status',event=>{try{health(JSON.parse((event as MessageEvent).data) as StreamHealth);}catch{setStreamStatus('rest');}});
    events.onerror=()=>setStreamStatus('rest');
    return()=>events.close();
  },[visible,runtime?.streamConfigured]);
  const reloadAccount=useCallback(async()=>{
    try{accept(await readJson<TennisSessionResponse>('/api/tennis/session'));setError(null);}catch(cause){setError(cause instanceof Error?cause.message:'Could not reload paper account.');}
  },[accept]);
  return {catalog,session,runtime,loading,refreshing,error,feedError,connectionIssue,busy,visible,streamStatus:!visible?'paused':runtime?.streamConfigured?streamStatus:'rest',now,perform,refresh,reloadAccount,clearError:()=>setError(null)};
}
