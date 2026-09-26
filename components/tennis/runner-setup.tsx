'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import type {TennisRuntime} from '@/lib/tennis/types';

type Status={eligible:boolean;configured:boolean;mode:'browser'|'migrating'|'service';phase:string|null;canPrepare:boolean;revision:number;
  progress:{journalDone:number;journalTotal:number;observationDone:number;observationTotal:number;chunksBuilt:number;chunksUploaded:number}|null;error?:string|null};

export function RunnerSetup({runtime,flat,onComplete}:{runtime:TennisRuntime|null;flat:boolean;onComplete:()=>Promise<void>}) {
  const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const busyRef=useRef(false),mounted=useRef(true),knownMode=useRef(runtime?.mode);
  const request=useCallback(async(action?:'prepare'|'advance'|'activate')=>{
    if(busyRef.current)return;busyRef.current=true;setBusy(true);
    try{
      const response=await fetch('/api/tennis/runner',{cache:'no-store',...(action?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})}:{}),signal:AbortSignal.timeout(25000)});
      const data=await response.json() as Status;
      if(!response.ok)throw new Error(data.error||'Background setup could not finish. Your saved account is retained.');
      if(mounted.current){setStatus(data);setError(data.error??null);}
      if(data.mode!==knownMode.current){knownMode.current=data.mode;await onComplete();}
    }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'Background setup is unavailable.');}
    finally{busyRef.current=false;if(mounted.current)setBusy(false);}
  },[onComplete]);
  useEffect(()=>{mounted.current=true;queueMicrotask(()=>{if(mounted.current)void request();});return()=>{mounted.current=false;};},[request,flat]);
  useEffect(()=>{
    if(status?.mode!=='migrating'||status.phase==='ready'||status.phase==='active'||error||busy)return;
    const timer=setTimeout(()=>void request('advance'),500);return()=>clearTimeout(timer);
  },[status,error,busy,request]);
  if(runtime?.mode==='service'||status?.mode==='service')return null;
  if(status?.eligible===false||!status&&!error)return null;
  const migrating=status?.mode==='migrating';
  return <section className="tennis-rule-summary" aria-label="Background bot setup">
    <b>{migrating?'Moving your saved paper account':'Background bot'}</b>
    <p>{migrating?'New entries are paused while balances and saved history are checked. Setup can resume safely if the connection drops.':status?.configured?'Move the current account to the background runner. Your balance and history carry over; the bot stays paused until you press Start.':'Background setup is being connected. Current checks still require this page to stay open.'}</p>
    {migrating&&status.progress&&<small>{status.progress.journalDone.toLocaleString()} / {status.progress.journalTotal.toLocaleString()} history records · {status.progress.observationDone.toLocaleString()} / {status.progress.observationTotal.toLocaleString()} saved observations · {status.progress.chunksUploaded} / {status.progress.chunksBuilt} parts transferred</small>}
    {error&&<p role="alert">{error}</p>}
    {status?.configured&&!migrating&&<button className="tennis-secondary" disabled={busy||!status.canPrepare} onClick={()=>void request('prepare')}>{busy?'Checking account…':'Set up background bot'}</button>}
    {status?.configured&&!migrating&&!status.canPrepare&&<small>Finish any open position or pending order before moving this account.</small>}
    {migrating&&status.phase==='ready'&&<button className="tennis-primary" disabled={busy} onClick={()=>void request('activate')}>{busy?'Verifying…':'Finish background setup'}</button>}
    {error&&migrating&&<button className="tennis-secondary" disabled={busy} onClick={()=>{setError(null);void request('advance');}}>Retry setup</button>}
    {error&&!migrating&&<button className="tennis-secondary" disabled={busy} onClick={()=>void request()}>Check saved setup</button>}
  </section>;
}
