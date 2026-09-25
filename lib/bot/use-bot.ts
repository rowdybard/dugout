'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {Profile,League} from '../market/types';
import {shouldAcceptProfile} from '../trading/profile-version';
import {requestBot} from './request';
import type {StreamHealth,StreamQuote} from '../trading/stream-types';

export function useBot(profile:Profile|null,onProfile:(p:Profile)=>void,blocked=false){
  const ref=useRef(profile),onChange=useRef(onProfile),pending=useRef(0),blockedRef=useRef(blocked);
  const tail=useRef<Promise<unknown>>(Promise.resolve()),controls=useRef(0);
  const [controlPending,setControlPending]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
  const [streamStatus,setStreamStatus]=useState<'connecting'|'live'|'polling'>('polling');
  const [quotes,setQuotes]=useState<Record<string,StreamQuote>>({});
  onChange.current=onProfile;blockedRef.current=blocked;
  if(profile&&shouldAcceptProfile(ref.current,profile))ref.current=profile;
  const receive=useCallback((p:Profile)=>{if(shouldAcceptProfile(ref.current,p)){ref.current=p;onChange.current(p);}},[]);
  const send=useCallback((action:string,extra:Record<string,unknown>={})=>{
    if(action==='step'&&pending.current)return Promise.resolve(false);
    if(blockedRef.current&&(action==='start'||action==='resume')){setError('Resolve the pending manual order first.');return false;}
    const sessionId=ref.current?.trading?.autopilot?.id;
    pending.current++;setBusy(true);
    if(action!=='step'){controls.current++;setControlPending(true);}
    const task=tail.current.then(async()=>{
    try{
      const result=await requestBot({action,...(action==='start'?{}:{sessionId}),...extra});
      if(result.profile)receive(result.profile);
      setError(result.error??'');return result.ok;
    }catch(e){setError(e instanceof Error?e.message:'Bot request failed.');return false;}
    finally{pending.current--;setBusy(pending.current>0);if(action!=='step'){controls.current--;setControlPending(controls.current>0);}setNow(Date.now());}
    });
    tail.current=task.catch(()=>false);return task;
  },[receive]);
  useEffect(()=>{const tick=()=>{
    setNow(Date.now());const s=ref.current?.trading?.autopilot;
    if(pending.current||document.visibilityState!=='visible'||!s||s.status==='stopped')return;
    if(blockedRef.current&&s.status==='running'){void send('pause');return;}
    if(s.status!=='paused'||s.positions.some(p=>p.status==='open'))void send('step');
  };const timer=window.setInterval(tick,5000);document.addEventListener('visibilitychange',tick);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick);};},[send]);
  const session=profile?.trading?.autopilot??null;
  const streamKey=session&&session.status!=='stopped'&&(session.status!=='paused'||session.positions.some(p=>p.status==='open'))?`${session.id}:${session.positions.filter(p=>p.status==='open').map(p=>p.slug).join(',')}`:'';
  useEffect(()=>{
    if(!streamKey){setQuotes({});setStreamStatus('polling');return;}
    let events:EventSource|null=null,timer:ReturnType<typeof setTimeout>|undefined,ended=false;
    const disconnect=()=>{events?.close();events=null;clearTimeout(timer);setStreamStatus('polling');setQuotes({});};
    const connect=()=>{
      if(ended||document.visibilityState!=='visible'||events)return;
      setStreamStatus('connecting');events=new EventSource('/api/trading/stream?scope=bot');
      events.addEventListener('quote',event=>{try{const q=JSON.parse((event as MessageEvent).data) as StreamQuote;if(q.valid&&q.book){setQuotes(old=>({...old,[q.slug]:q}));setStreamStatus('live');}else {setStreamStatus('polling');setQuotes(old=>{const next={...old};delete next[q.slug];return next;});}}catch{disconnect();timer=setTimeout(connect,15000);}});
      events.addEventListener('status',event=>{try{const h=JSON.parse((event as MessageEvent).data) as StreamHealth;if(h.market.state!=='connected'){setStreamStatus('polling');setQuotes({});}}catch{}});
      events.onerror=()=>{disconnect();if(!ended)timer=setTimeout(connect,15000);};
    };
    const visibility=()=>{if(document.visibilityState==='visible')connect();else disconnect();};
    connect();document.addEventListener('visibilitychange',visibility);
    return()=>{ended=true;disconnect();document.removeEventListener('visibilitychange',visibility);};
  },[streamKey]);
  return {session,busy,controlPending,error,now,streamStatus,quotes,start:(bankroll:number,leagues:League[])=>send('start',{bankroll,leagues}),pause:()=>send('pause'),resume:()=>send('resume'),stop:()=>send('stop'),exit:(positionId:string)=>send('exit',{positionId})};
}
