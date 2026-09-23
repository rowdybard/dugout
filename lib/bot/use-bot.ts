'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {Profile,League} from '../market/types';
import {shouldAcceptProfile} from '../trading/profile-version';

export function useBot(profile:Profile|null,onProfile:(p:Profile)=>void,blocked=false){
  const ref=useRef(profile),onChange=useRef(onProfile),pending=useRef(0),blockedRef=useRef(blocked);
  const tail=useRef<Promise<unknown>>(Promise.resolve()),controls=useRef(0);
  const [controlPending,setControlPending]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
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
      const response=await fetch('/api/bot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...(action==='start'?{}:{sessionId}),...extra}),signal:AbortSignal.timeout(45000)});
      const data=await response.json() as {error?:string;profile:Profile};if(!response.ok)throw new Error(data.error??'Bot request failed.');receive(data.profile);setError('');return true;
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
  return {session,busy,controlPending,error,now,start:(bankroll:number,leagues:League[])=>send('start',{bankroll,leagues}),pause:()=>send('pause'),resume:()=>send('resume'),stop:()=>send('stop'),exit:(positionId:string)=>send('exit',{positionId})};
}
