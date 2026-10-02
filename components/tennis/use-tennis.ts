'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import type {FootballAssessment,TennisAction,TennisCatalog,TennisInput,TennisMarket,TennisRuntime,TennisSession,TennisSessionResponse} from '@/lib/tennis/types';
import type {StreamHealth,StreamQuote,StreamSnapshot} from '@/lib/trading/stream-types';
import {mergeTennisHistory,marketWithSessionQuotes,marketWithStreamQuote,marketWithWatchedBook,marketWithWatchedContext} from '@/lib/tennis/chart-data';
import {managedMarketStream} from '@/lib/trading/managed-market-stream';
import {recordContextCheck,type ContextCheckState} from '@/lib/tennis/context-check';

async function readJson<T>(url:string,init?:RequestInit):Promise<T> {
  const response=await fetch(url,{cache:'no-store',...init,signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)}).catch(cause=>{
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
  const [advisorEnabled,setAdvisorEnabled]=useState(false);
  const [streamStatus,setStreamStatus]=useState('connecting');
  const [now,setNow]=useState(()=>Date.now());
  const [watchedSlug,watchMarket]=useState<string|null>(null);
  const [watchedBookError,setWatchedBookError]=useState<string|null>(null);
  const [watchedContextError,setWatchedContextError]=useState<string|null>(null);
  const [contextAssessments,setContextAssessments]=useState<Record<string,FootballAssessment>>({});
  const [contextChecks,setContextChecks]=useState<Record<string,ContextCheckState>>({});
  const [catalogAttempt,setCatalogAttempt]=useState(0);
  const sessionId=session?.id;
  const leagueKey=session?.config.leagues.join(',');
  const focusSlug=session?.config.focusSlug;
  const contextSlugs=[...new Set([session?.pending?.market,...(session?.positions.filter(p=>p.status==='open').map(p=>p.lastContext??p.market)??[]),catalog?.markets.find(m=>m.slug===watchedSlug)].filter(m=>m&&(m.league==='CFB'||m.league==='NFL')).map(m=>m!.slug))].join(',');
  const inflight=useRef(false),mounted=useRef(true),sessionRef=useRef<TennisSession|null>(null),catalogBusy=useRef(false),catalogRerun=useRef(false);
  const runningRequest=useRef<Promise<boolean>|null>(null),commandQueued=useRef(false);
  const accept=useCallback((response:TennisSessionResponse)=>{
    if(!mounted.current)return;
    if(sessionRef.current&&sessionRef.current.revision>response.session.revision)return;
    sessionRef.current=response.session;
    setSession(response.session);
    setRuntime(response.runtime);
    setNow(Date.now());
    setConnectionIssue(null);
    setCatalog(current=>current?{...current,markets:[...current.markets,...response.session.positions.filter(p=>p.status==='open'&&!current.markets.some(m=>m.slug===p.slug)).map(p=>({...p.lastContext??p.market,active:false}))].map(m=>marketWithSessionQuotes(m,response.session))}:current);
    if(response.error)setError(response.error);
  },[]);
  const refresh=useCallback(async function refreshCatalog(){
    if(catalogBusy.current){catalogRerun.current=true;return;}
    catalogBusy.current=true;catalogRerun.current=false;setRefreshing(true);
    try{
      const data=await readJson<TennisCatalog>('/api/tennis');
      if(!mounted.current)return;
      const selected=sessionRef.current?.config.leagues;
      if(selected&&data.leagues&&[...selected].sort().join(',')!==[...data.leagues].sort().join(',')){catalogRerun.current=true;return;}
      const held=sessionRef.current?.positions.filter(p=>p.status==='open'&&!data.markets.some(m=>m.slug===p.slug)).map(p=>({...p.lastContext??p.market,active:false}))??[];
      setCatalog(previous=>({...data,markets:[...data.markets,...held].map(market=>{
        const existing=previous?.markets.find(row=>row.slug===market.slug);
        const rejected=new Set(market.rejectedQuoteTimes??[]);
        const history=mergeTennisHistory(market.history,(existing?.history??[]).filter(point=>!rejected.has(point.time)));
        const newest=existing&&(existing.quoteObservedAt??existing.observedAt)>(market.quoteObservedAt??market.observedAt)?{...market,bid:existing.bid,ask:existing.ask,price:existing.price,quoteObservedAt:existing.quoteObservedAt,quoteSource:existing.quoteSource,quoteSourceTime:existing.quoteSourceTime,history}:{...market,history};
        return marketWithSessionQuotes(existing?marketWithWatchedContext(newest,existing,Date.now()):newest,sessionRef.current);
      })}));setFeedError(null);
    }catch(cause){if(mounted.current)setFeedError(cause instanceof Error?cause.message:'Market data is unavailable.');}
    finally{catalogBusy.current=false;if(mounted.current){setLoading(false);setRefreshing(false);setCatalogAttempt(value=>value+1);if(catalogRerun.current)void refreshCatalog();}}
  },[]);
  // A command can be a function of the latest saved session: it is built after any in-flight check finishes, so a
  // rule change never carries a stale rules revision. Built commands retry once if the rules changed meanwhile.
  const perform=useCallback(async(request:TennisAction|((session:TennisSession|null)=>TennisAction|null),background=false)=>{
    // User commands wait behind the one in-flight check.
    if(background&&(inflight.current||commandQueued.current))return false;
    if(!background){
      if(commandQueued.current)return false;
      commandQueued.current=true;setBusy(true);setError(null);
      if(runningRequest.current)await runningRequest.current;
    }
    const build=()=>typeof request==='function'?request(sessionRef.current):request;
    let action=build();
    if(!action){if(!background){commandQueued.current=false;if(mounted.current)setBusy(false);}return false;}
    inflight.current=true;
    const task=(async()=>{
      for(let attempt=0;;attempt++)try{
        const response=await readJson<TennisSessionResponse>('/api/tennis/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)});
        accept(response);
        const result=response.session;
        const rejected=action.action==='start'?result.status!=='running'
          :action.action==='reset'?result.config.startingCash!==action.bankroll||result.status!=='idle'
          :action.action==='update-rules'?(result.rulesRevision??0)!==action.expectedRulesRevision+1
          :action.action==='resume'?result.status!=='running':false;
        if(rejected&&!response.error&&typeof request==='function'&&attempt===0&&action.action==='update-rules'&&/another tab/i.test(result.lastReason??'')){
          const next=build();if(next){action=next;continue;}
        }
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
    const controller=new AbortController();
    void readJson<{enabled?:boolean}>('/api/tennis/advisor',{signal:controller.signal}).then(data=>{
      if(!controller.signal.aborted)setAdvisorEnabled(data.enabled===true);
    }).catch(()=>{if(!controller.signal.aborted)setAdvisorEnabled(false);});
    return()=>controller.abort();
  },[]);
  useEffect(()=>{
    if(!visible)return;
    const delay=catalog?.discovery?.complete===false?Math.max(1000,Math.min(30000,(catalog.discovery.nextRefreshAt||Date.now()+2000)-Date.now())):30000;
    const timer=setTimeout(()=>void refresh(),delay);
    return()=>clearInterval(timer);
  },[visible,refresh,catalogAttempt,catalog?.discovery?.complete,catalog?.discovery?.nextRefreshAt]);
  useEffect(()=>{
    if(!visible||!contextSlugs){queueMicrotask(()=>setWatchedContextError(null));return;}
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const load=async()=>{
      // Held/pending games are first. Their reports never wait behind discovery or chart history.
      await Promise.all(contextSlugs.split(',').map(async slug=>{
        try{
          const data=await readJson<{market:TennisMarket;assessment:FootballAssessment;error:string|null;successfulCheckAt?:number|null}>(`/api/tennis/context?slug=${encodeURIComponent(slug)}`,{signal:controller.signal});
          if(controller.signal.aborted)return;
          // Render new receipt timestamps against this response's clock, rather
          // than the previous one-second UI tick (which can look like future data).
          setNow(Date.now());
          setContextChecks(current=>({...current,[slug]:recordContextCheck(current[slug],data)}));
          setContextAssessments(current=>({...current,[slug]:data.assessment}));
          setCatalog(current=>current?{...current,markets:current.markets.map(m=>m.slug===slug?marketWithWatchedContext(m,data.market,Date.now()):m)}:current);
          if(slug===watchedSlug)setWatchedContextError(data.error??(data.assessment.status==='conflicting'?data.assessment.reason:null));
        }catch(cause){if(!controller.signal.aborted){
          const message=cause instanceof Error?cause.message:'Waiting for the latest game report.';
          setContextChecks(current=>({...current,[slug]:recordContextCheck(current[slug],{error:message})}));
          if(slug===watchedSlug)setWatchedContextError(message);
        }}
      }));
      if(!controller.signal.aborted)timer=setTimeout(()=>void load(),3000);
    };
    queueMicrotask(()=>{if(!controller.signal.aborted){setWatchedContextError(null);void load();}});
    return()=>{controller.abort();clearTimeout(timer);};
  },[visible,contextSlugs,watchedSlug]);
  useEffect(()=>{
    if(!visible||!watchedSlug)return;
    let cancelled=false;
    const load=async()=>{
      try{
        const data=await readJson<TennisCatalog>(`/api/tennis?slug=${encodeURIComponent(watchedSlug)}`);
        if(cancelled)return;
        const detail=data.markets.find(m=>m.slug===watchedSlug);
        if(!detail)return;
        const rejected=new Set(detail.rejectedQuoteTimes??[]);
        setCatalog(current=>current?{...current,markets:current.markets.map(m=>m.slug!==watchedSlug?m:{...m,history:mergeTennisHistory(detail.history,m.history.filter(p=>!rejected.has(p.time))),rejectedQuoteTimes:detail.rejectedQuoteTimes})}:current);
      }catch{/* The catalog and stream retain their own connection/error state. */}
    };
    void load();const timer=setInterval(()=>void load(),30000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[visible,watchedSlug]);
  useEffect(()=>{
    if(!visible||!watchedSlug)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const load=async()=>{
      try{
        const {input}=await readJson<{input:TennisInput}>(`/api/tennis/book?slug=${encodeURIComponent(watchedSlug)}`,{signal:controller.signal});
        if(controller.signal.aborted)return;
        setCatalog(current=>current?{...current,markets:current.markets.map(m=>m.slug===watchedSlug?marketWithWatchedBook(m,input,sessionRef.current,Date.now()):m)}:current);
        setWatchedBookError(null);
      }catch(cause){if(!controller.signal.aborted)setWatchedBookError(cause instanceof Error?cause.message:'Waiting for a fresh book for this game.');}
      finally{if(!controller.signal.aborted)timer=setTimeout(()=>void load(),3000);}
    };
    queueMicrotask(()=>{if(!controller.signal.aborted){setWatchedBookError(null);void load();}});
    return()=>{controller.abort();clearTimeout(timer);};
  },[visible,watchedSlug]);
  useEffect(()=>{
    if(!visible||!sessionId)return;
    const tick=()=>{
      const current=sessionRef.current;
      if(!current||inflight.current)return;
      if(runtime?.mode==='service'||runtime?.mode==='migrating'){
        if(!commandQueued.current){inflight.current=true;readJson<TennisSessionResponse>('/api/tennis/session').then(accept).catch(cause=>{if(mounted.current)setConnectionIssue(cause instanceof Error?cause.message:'Background runner unavailable.');}).finally(()=>{inflight.current=false;});}
        return;
      }
      // Pausing entries does not pause exit checks; existing positions still need monitoring.
      if(['running','paused','stopping'].includes(current.status)||current.pending||current.positions.some(position=>position.status==='open')){
        void perform({action:'tick',sessionId:current.id},true);
      }
    };
    const timer=setInterval(tick,Math.max(2000,runtime?.intervalMs??2500));
    return()=>clearInterval(timer);
  },[visible,sessionId,runtime?.intervalMs,runtime?.mode,perform,accept]);
  useEffect(()=>{
    if(!visible||!runtime?.streamConfigured)return;
    queueMicrotask(()=>setStreamStatus('connecting'));
    const merge=(quote:StreamQuote)=>{
      if(!quote.valid)return;
      setStreamStatus('live');
      setNow(Date.now());
      // Provider order is checked even while entries are paused; receipt alone is insufficient.
      setCatalog(current=>!current?current:{...current,markets:current.markets.map(market=>marketWithStreamQuote(market,quote,sessionRef.current,Date.now()))});
    };
    const health=(status:StreamHealth)=>setStreamStatus(status.market.state==='connected'?'live':status.market.state==='connecting'?'connecting':'rest');
    return managedMarketStream(()=>new EventSource(`/api/tennis/stream${watchedSlug?`?watch=${encodeURIComponent(watchedSlug)}`:''}`),{
      snapshot:event=>{try{const data=JSON.parse((event as MessageEvent).data) as StreamSnapshot;health(data.health);data.quotes.forEach(merge);}catch{setStreamStatus('rest');}},
      quote:event=>{try{merge(JSON.parse((event as MessageEvent).data) as StreamQuote);}catch{setStreamStatus('rest');}},
      status:event=>{try{health(JSON.parse((event as MessageEvent).data) as StreamHealth);}catch{setStreamStatus('rest');}},
    },setStreamStatus);
  },[visible,runtime?.streamConfigured,leagueKey,focusSlug,watchedSlug]);
  const reloadAccount=useCallback(async()=>{
    try{accept(await readJson<TennisSessionResponse>('/api/tennis/session'));setError(null);}catch(cause){setError(cause instanceof Error?cause.message:'Could not reload paper account.');}
  },[accept]);
  return {catalog,session,runtime,loading,refreshing,error,feedError,connectionIssue,watchedBookError,watchedContextError,contextAssessments,contextChecks,advisorEnabled,busy,visible,streamStatus:!visible?'paused':runtime?.streamConfigured?streamStatus:'rest',now,perform,refresh,reloadAccount,watchMarket,clearError:()=>setError(null)};
}
