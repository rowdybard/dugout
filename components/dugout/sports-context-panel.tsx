'use client';
import {useEffect,useState} from 'react';
import {Activity,ArrowRight,ChevronDown,RefreshCw} from 'lucide-react';
import type {Market} from '@/lib/market/types';
import type {SportsContext} from '@/lib/sports-context/types';
import './sports-context-panel.css';

const stamp=(value:string|number)=>new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
export function SportsContextPanel({markets,slug,visible,beginner,compact=false}:{markets:Market[];slug?:string;visible:boolean;beginner:boolean;compact?:boolean}){
 const [chosen,setChosen]=useState('');
 const [data,setData]=useState<SportsContext|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [revision,setRevision]=useState(0);
 const selected=slug || (markets.some(m=>m.slug===chosen)?chosen:markets[0]?.slug)||'';
 const games=markets.filter((m,i,all)=>all.findIndex(g=>g.gameId===m.gameId)===i);
 useEffect(()=>{
  if(!visible||!selected)return;
  let canceled=false,inFlight=false;let controller:AbortController|null=null;
  const load=async()=>{
   if(inFlight||document.hidden)return;inFlight=true;setBusy(true);controller=new AbortController();
   const timer=setTimeout(()=>controller?.abort(),25000);
   try{const r=await fetch(`/api/sports-context?slug=${encodeURIComponent(selected)}`,{signal:controller.signal,cache:'no-store'});if(!r.headers.get('content-type')?.includes('application/json'))throw new Error('Sports context is temporarily unavailable.');const d=await r.json() as SportsContext&{error?:string};if(!r.ok)throw new Error(d.error||'Sports feed unavailable');if(!canceled){setData(d);setError('')}}
   catch(e){if(!canceled)setError(e instanceof Error?e.message:'Sports feed unavailable')}
   finally{clearTimeout(timer);inFlight=false;if(!canceled)setBusy(false)}
  };void load();const timer=setInterval(load,30000);return()=>{canceled=true;controller?.abort();clearInterval(timer)}
 },[selected,visible,revision]);
 const context=data?.slug===selected?data:null;
 const injuries=context?.injuries??[];
 const content=<>
  {!compact&&<div className="sc-heading"><div><h2>Game & player intel</h2>{beginner&&<p>Who’s playing, who changed, and what the source actually reports.</p>}</div><span className="sc-source-label">Free sources</span></div>}
  {!slug&&<label className="sc-game-select"><span>Follow a game</span><select aria-label="Sports intelligence game" value={selected} onChange={e=>setChosen(e.target.value)}>{!games.length&&<option value="">Waiting for markets</option>}{games.map(m=><option key={m.gameId} value={m.slug}>{m.league} · {m.game}</option>)}</select></label>}
  {error&&<div className="sc-error" role="alert">{error}<button onClick={()=>setRevision(x=>x+1)}>Retry</button></div>}
  {!context&&!error&&<div className="sc-loading">{selected?'Loading player and game context…':'Choose a game to load context.'}</div>}
  {context&&<>
   {context.replayAt&&<div className="sc-capture">RECORDED SPORTS CAPTURE · {stamp(context.replayAt)} · Not live updates</div>}
   {context.status!=='available'&&<p className="sc-error">{context.limitations[0]||'Game context unavailable.'}</p>}
   {context.game&&<div className="sc-score"><span><b>{context.game.away.abbreviation||context.game.away.name}</b><strong>{context.game.away.score??'—'}</strong></span><div><i className={context.game.state==='live'&&!context.replayAt?'live':''}/>{context.game.statusText}{context.game.period&&<small>{context.game.period}{context.game.clock?` · ${context.game.clock}`:''}</small>}</div><span><strong>{context.game.home.score??'—'}</strong><b>{context.game.home.abbreviation||context.game.home.name}</b></span></div>}
   {!!context.players.length&&<div className="sc-players">{context.players.map(p=><article key={p.id+p.team}><span className="sc-meta">{p.team} · {p.role==='current_pitcher'?'Pitcher':p.role==='probable_pitcher'?'Probable pitcher':'Last observed passer'}</span><h3>{p.name}</h3><div className="sc-player-stats">{p.stats.slice(0,4).map(s=><span key={s.label}><b>{s.value}</b>{s.label}</span>)}</div></article>)}</div>}
   <div className="sc-change-header"><h3>{context.league==='MLB'?'Pitcher changes':'QB / passer changes'} <span>{context.changes.length}</span></h3><span className="sc-meta">Observed game events</span></div>
   {context.changes.length?<div className="sc-changes">{context.changes.slice(0,4).map(change=><details key={change.id} className="sc-change"><summary><Activity size={15}/><span><b>{change.previous.name}<ArrowRight size={13}/>{change.replacement.name}</b><small>{change.team} · {change.sourceEventTime?stamp(change.sourceEventTime):`Detected ${stamp(change.detectedAt)}`}</small></span><ChevronDown size={15}/></summary><div><p>{change.description}</p>{change.implications.map((line,i)=><p key={i}>{line}</p>)}<span className="sc-impact">Outcome impact: not modeled. No trade triggered by this change.</span></div></details>)}</div>:<p className="sc-quiet">{context.status==='available'?'No confirmed change in the available observations.':'Game events are unavailable for this matchup.'}</p>}
   <details className="sc-injuries"><summary>Reported availability <span>{injuries.length?`${injuries.length} reports`:'No reports returned'}</span><ChevronDown size={15}/></summary><div>{injuries.length?injuries.map((injury,i)=><article key={injury.name+injury.reportedAt+i}><div><b>{injury.name}</b><span>{injury.position} · {injury.team}</span><p>{injury.detail}</p>{injury.reportedAt&&<small><a href={injury.sourceUrl} target="_blank" rel="noreferrer">ESPN report ↗</a> · {stamp(injury.reportedAt)}</small>}</div><strong>{injury.status}</strong></article>):<p>No injury confirmation supplied. Missing reports do not establish that a player is healthy.</p>}</div></details>
   <div className="sc-impact-note">Player changes inform research. A validated win-probability model is still required before they can drive automated picks.</div>
   <details className="sc-provenance"><summary>Source & freshness <ChevronDown size={13}/></summary><p><a href={context.source.url} target="_blank" rel="noreferrer">{context.source.name} ↗</a> · {context.replayAt?'Captured':'Retrieved'} {stamp(context.replayAt??context.receivedAt)}{context.source.support==='public-undocumented'?' · Public, undocumented feed':''}</p>{context.limitations.map((line,i)=><p key={i}>{line}</p>)}</details>
   <button className="sc-refresh" disabled={busy} onClick={()=>setRevision(x=>x+1)}><RefreshCw size={13} className={busy?'spin':''}/>{busy?'Checking…':'Refresh context'}</button>
  </>}
 </>;
 return compact?<details className="sc-panel sc-compact"><summary>Game, players & changes <ChevronDown size={15}/></summary><div>{content}</div></details>:<section className="sc-panel" aria-label="Game and player intelligence">{content}</section>;
}
