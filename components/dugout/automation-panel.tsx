'use client';
import {useEffect,useState} from 'react';
import {Play,Pause,ChevronDown} from 'lucide-react';
import type {Profile} from '@/lib/market/types';
import type {AutomationSession} from '@/lib/trading/workspace';
type AutomationResponse={automation:AutomationSession|null;profile?:Profile;error?:string};

export function AutomationPanel({slug,side,profile,onProfile}:{slug:string;side:'YES'|'NO';profile:Profile|null;onProfile:(p:Profile)=>void}) {
  const [session,setSession]=useState<AutomationSession|null>(profile?.trading?.automation??null);
  const [expanded,setExpanded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [amount,setAmount]=useState(5),[budget,setBudget]=useState(10),[dip,setDip]=useState(5),[recovery,setRecovery]=useState(1.5),[target,setTarget]=useState(15),[stop,setStop]=useState(10);
  useEffect(()=>{setSession(profile?.trading?.automation??null)},[profile]);
  async function send(body:Record<string,unknown>) {
    setBusy(true);setError('');
    try {
      const r=await fetch('/api/trading/automation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(22000)});
      const d=await r.json() as AutomationResponse;if(!r.ok)throw new Error(d.error||'Paper test unavailable.');
      setSession(d.automation);if(d.profile)onProfile(d.profile);
    }catch(e){setError(e instanceof Error?e.message:'Paper test unavailable.');}
    finally{setBusy(false);}
  }
  useEffect(()=>{
    if(session?.status!=='running')return;
    let active=true,inFlight=false;
    const step=async()=>{
      if(!active||inFlight||document.visibilityState!=='visible')return;
      inFlight=true;
      try {
        const r=await fetch('/api/trading/automation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'step'}),signal:AbortSignal.timeout(22000)});
        const d=await r.json() as AutomationResponse;if(!r.ok)throw new Error(d.error||'Paper test update failed.');
        if(active){setSession(d.automation);if(d.profile)onProfile(d.profile);setError('');}
      }catch(e){if(active)setError(e instanceof Error?e.message:'Paper test update failed.');}
      finally{inFlight=false;}
    };
    const timer=setInterval(step,5000);step();return()=>{active=false;clearInterval(timer)};
  },[session?.id,session?.status,onProfile]);
  const sameMarket=session?.slug===slug&&session.side===side;
  return <section className="automation-panel" style={{borderTop:'1px solid var(--border)',padding:'16px 0',marginTop:12}}>
    <button type="button" onClick={()=>setExpanded(!expanded)} style={{display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',background:'none',border:0,color:'inherit',fontWeight:700,fontSize:14}}>
      <span>Paper strategy · {session?.status==='running'?'Running':'Off'}</span><ChevronDown size={16}/>
    </button>
    {session&&<p style={{fontSize:12,color:'var(--muted-foreground)',margin:'10px 0'}}>{sameMarket?'':`${session.slug} · `}{session.lastReason}</p>}
    {expanded&&<div style={{marginTop:12}}>
      <p style={{fontSize:13,margin:'0 0 12px',color:'var(--muted-foreground)'}}>Dip → recovery · pregame test. Runs while this workspace is open. No validated edge.</p>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        {[
          ['Entry $',amount,setAmount,1,25],['Test budget $',budget,setBudget,1,100],
          ['Dip points',dip,setDip,1,30],['Recovery points',recovery,setRecovery,.5,10],
          ['Net target %',target,setTarget,3,100],['Net stop %',stop,setStop,3,50],
        ].map(([label,value,setter,min,max])=><label key={String(label)} style={{fontSize:12,color:'var(--muted-foreground)'}}>{String(label)}
          <input aria-label={String(label)} type="number" min={Number(min)} max={Number(max)} step="0.5" value={Number(value)} disabled={session?.status==='running'}
            onChange={e=>(setter as (n:number)=>void)(Number(e.target.value))} style={{display:'block',width:'100%',padding:'8px',marginTop:4,border:'1px solid var(--border)',borderRadius:6,background:'var(--background)',color:'var(--foreground)'}}/>
        </label>)}
      </div>
      <div style={{display:'flex',gap:8,marginTop:12}}>
        <button type="button" disabled={busy||!slug||!profile||session?.status==='running'} onClick={()=>send({action:'start',slug,side,entryBudget:amount,budgetLimit:budget,declinePoints:dip,recoveryPoints:recovery,targetReturn:target/100,stopReturn:stop/100})}
          className="button" style={{padding:'9px 12px',border:'1px solid var(--border)',borderRadius:6,display:'flex',gap:6,alignItems:'center'}}><Play size={14}/>Start paper test</button>
        <button type="button" disabled={busy||session?.status!=='running'} onClick={()=>send({action:'pause'})} className="button" style={{padding:'9px 12px',border:'1px solid var(--border)',borderRadius:6,display:'flex',gap:6,alignItems:'center'}}><Pause size={14}/>Pause</button>
      </div>
      {session&&<p style={{fontSize:12,color:'var(--muted-foreground)',marginTop:10}}>{session.observations} observations · {session.orders} orders · ${session.spent.toFixed(2)} / ${session.budgetLimit.toFixed(2)} spent</p>}
    </div>}
    {error&&<p role="alert" style={{fontSize:13,color:'#fb7185',marginTop:8}}>{error}</p>}
  </section>;
}
