"use client";
import {useCallback, useEffect, useRef, useState} from 'react';
import {Activity, Bot, ChartNoAxesCombined, Check, ChevronRight, FlaskConical, HelpCircle, MousePointer2, Bookmark} from 'lucide-react';
import {Switch} from '@/components/ui/switch';
import {Dialog, DialogContent, DialogTitle, DialogDescription} from '@/components/ui/dialog';
import {SportsContextPanel} from '@/components/dugout/sports-context-panel';
import {TradingWorkspace} from '@/components/dugout/trading-workspace';
import {AutomationDashboard} from '@/components/dugout/automation-dashboard';
import {AutopilotDashboard} from '@/components/dugout/autopilot-dashboard';
import {BotResults} from '@/components/dugout/bot-results';
import MlbSimulation from '@/components/dugout/mlb-simulation';
import {gameTime} from '@/components/dugout/market-card';
import {shouldAcceptProfile} from '@/lib/trading/profile-version';
import {glossary} from '@/lib/market/explain';
import {scan, activitySignals, DEFAULT_CONFIG} from '@/lib/market/scanner';
import type {Config, Feed, Game, Profile, Watch} from '@/lib/market/types';
import {sourceError} from '@/lib/server/request-budget';
import './workspace-shell.css';

type View = 'automation' | 'manual' | 'results' | 'simulation';
export default function Home() {
  const [view,setView]=useState<View>('automation');
  const [manualTab,setManualTab]=useState('mlb');
  const [resultsTab,setResultsTab]=useState<'bot'|'manual'>('bot');
  const [target,setTarget]=useState<{slug:string;side:'YES'|'NO';revision:number;action:'BUY'|'SELL';positionId?:string}|null>(null);
  const [beginner,setBeginner]=useState(true);
  const [feed,setFeed]=useState<Feed|null>(null);
  const [profile,commitProfile]=useState<Profile|null>(null);
  const setProfile=useCallback((next:Profile)=>commitProfile(current=>shouldAcceptProfile(current,next)?next:current),[]);
  const [error,setError]=useState('');
  const [profileError,setProfileError]=useState('');
  const [loading,setLoading]=useState(true);
  const feedPending=useRef(false);
  const [settings,setSettings]=useState(false);
  const [config,setConfig]=useState<Config>(DEFAULT_CONFIG);
  const [settingsBusy,setSettingsBusy]=useState(false);
  const [settingsError,setSettingsError]=useState('');
  const [help,setHelp]=useState<string|null>(null);
  const [game,setGame]=useState<Game|null>(null);
  const [toast,setToast]=useState('');
  const [pendingOrder,setPendingOrder]=useState<{slug:string;side:'YES'|'NO';commandId:string}|null>(null);
  const loadProfile=useCallback(async()=>{
    // Reading saved cash must never wait for pricing/settling old manual positions.
    try {const r=await fetch('/api/bot',{cache:'no-store',signal:AbortSignal.timeout(10000)});const d=await r.json() as {profile:Profile;error?:string};if(!r.ok||!d.profile)throw new Error(d.error||'Paper account unavailable.');setProfile(d.profile);setProfileError('');}
    catch{setProfileError('Your paper account could not load.');}
  },[]);
  const load=useCallback(async()=>{
    if(feedPending.current)return;feedPending.current=true;
    setLoading(true);
    try {const r=await fetch('/api/feed',{signal:AbortSignal.timeout(25000)});const d=await r.json() as Feed&{error?:string};if(!r.ok)throw new Error(d.error||'Market feed unavailable.');setFeed(d);setError('');}
    catch(e){setError(sourceError(e,'Market feed unavailable.'));}
    finally{feedPending.current=false;setLoading(false);}
  },[]);
  useEffect(()=>{void load();void loadProfile();const timer=setInterval(()=>{if(!document.hidden){void load();void loadProfile();}},60000);return()=>clearInterval(timer)},[load,loadProfile]);
  useEffect(()=>{
    if(view!=='manual'&&!(view==='results'&&resultsTab==='manual'))return;
    let pending=false,cancelled=false;const controller=new AbortController();
    const refresh=async()=>{if(pending||document.hidden)return;pending=true;
      try{const response=await fetch('/api/portfolio',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});if(response.ok){const next=await response.json() as Profile;if(!cancelled)setProfile(next);}}
      catch{/* Keep saved cash and visibly dated marks while this optional refresh is unavailable. */}
      finally{pending=false;}
    };
    void refresh();const timer=setInterval(refresh,60000);return()=>{cancelled=true;controller.abort();clearInterval(timer);};
  },[view,resultsTab,setProfile]);
  useEffect(()=>{if(!settings&&profile?.config)setConfig(profile.config)},[settings,profile?.config]);
  useEffect(()=>{try{setBeginner(localStorage.getItem('dugout-beginner')!=='false')}catch{}if(new URLSearchParams(window.location.search).get('view')==='simulation')setView('simulation')},[]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(timer)},[toast]);
  const markets=feed?.markets.map(m=>({...m,signals:[...scan(m,config),...activitySignals(m.activityHistory||[],config)]}))||[];
  const openManual=(slug:string,side:'YES'|'NO'='YES',action:'BUY'|'SELL'='BUY',positionId?:string)=>{
    const market=feed?.games.flatMap(g=>g.markets).find(m=>m.slug===slug);
    const position=profile?.positions.find(p=>p.id===positionId||p.slug===slug);
    if(market||position)setManualTab((market?.league??position!.league).toLowerCase());
    setTarget({slug,side,action,positionId,revision:Date.now()});setView('manual');setGame(null);
  };
  const watch=async(kind:Watch['kind'],key:string,label:string,price:number|null=null)=>{
    try{const r=await fetch('/api/watch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,key,label,price})});const p=await r.json() as Profile&{error?:string};if(!r.ok)throw new Error(p.error);setProfile(p);setToast(p.watches.some(w=>w.key===key&&w.kind===kind)?'Saved to watchlist':'Removed from watchlist')}
    catch(e){setToast(e instanceof Error?e.message:'Could not save watch')}
  };
  const saveSettings=async()=>{
    setSettingsBusy(true);setSettingsError('');
    try{const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});const p=await r.json() as Profile&{error?:string};if(!r.ok)throw new Error(p.error);setProfile(p);setSettings(false);setToast('Scanner thresholds saved')}
    catch(e){setSettingsError(e instanceof Error?e.message:'Could not save settings')}
    finally{setSettingsBusy(false)}
  };
  return <div className={`app-shell dugout-shell ${beginner?'is-beginner':'is-advanced'}`}>
    {feed?.replayAt&&<div className="development-banner">DEVELOPMENT REPLAY · Recorded {new Date(feed.replayAt).toLocaleString()} · Not live prices</div>}
    <header className="dugout-header">
      <button className="brand" onClick={()=>setView('automation')} aria-label="Dugout home"><span className="brand-symbol"><Activity size={20}/></span>DUGOUT<span className="brand-period">.</span></button>
      <span className="dugout-mode"><FlaskConical size={14}/>Paper only</span>
      <div className="dugout-header-actions"><div className="beginner-switch"><span>Beginner</span><Switch checked={beginner} onCheckedChange={v=>{setBeginner(v);try{localStorage.setItem('dugout-beginner',String(v))}catch{}}} aria-label="Beginner mode"/></div>{beginner&&<button className="icon-button" onClick={()=>setHelp('glossary')} aria-label="Trading glossary"><HelpCircle size={18}/></button>}</div>
    </header>
    <nav className="dugout-nav" aria-label="Main navigation">
      {([{id:'automation',label:'Bot',Icon:Bot},{id:'manual',label:'Manual trade',Icon:MousePointer2},{id:'results',label:'Results',Icon:ChartNoAxesCombined}] as const).map(({id,label,Icon})=><button key={id} className={(view==='simulation'?'results':view)===id?'active':''} aria-current={(view==='simulation'?'results':view)===id?'page':undefined} onClick={()=>setView(id)}><Icon size={18}/>{label}</button>)}
      <span className="dugout-scope">MLB + NFL</span>
    </nav>
    {(error||profileError)&&<div className="dugout-alert" role="alert"><span>{error||profileError}</span><button onClick={()=>{void load();void loadProfile()}}>Retry</button></div>}
    {pendingOrder&&<div className="dugout-alert" role="alert"><span>A paper order needs checking. New bot entries are paused.</span><button onClick={()=>openManual(pendingOrder.slug,pendingOrder.side)}>Review order</button></div>}
    <AutopilotDashboard feed={feed} profile={profile} onProfile={setProfile} beginner={beginner} onManual={openManual} visible={view==='automation'} pendingOrder={!!pendingOrder}><SportsContextPanel markets={markets} visible={view==='automation'} beginner={beginner}/></AutopilotDashboard>
    {profile?.trading?.automation&&<details className="legacy-test" hidden={view!=='automation'}><summary>Previous single-market test</summary><AutomationDashboard feed={feed} markets={markets} profile={profile} onProfile={setProfile} beginner={beginner} onManualMarket={openManual} onResults={()=>setView('results')} onSimulation={()=>setView('simulation')} visible={view==='automation'} pendingOrder={!!pendingOrder||!!profile.trading?.autopilot&&profile.trading.autopilot.status!=='stopped'}/></details>}
    {view==='results'&&<><div className="auto-results-tabs" role="group" aria-label="Results account"><button aria-pressed={resultsTab==='bot'} onClick={()=>setResultsTab('bot')}>Bot results</button><button aria-pressed={resultsTab==='manual'} onClick={()=>setResultsTab('manual')}>Manual results</button></div>{resultsTab==='bot'&&<BotResults profile={profile} onSimulation={()=>setView('simulation')}/>}</>}
    <TradingWorkspace feed={feed} markets={markets} profile={profile} onProfile={setProfile} onRefresh={load} onRetryProfile={loadProfile} loading={loading} error={error} profileError={profileError} tab={view==='results'?'portfolio':manualTab} onTab={v=>{if(v==='portfolio'){setResultsTab('manual');setView('results');}else{setManualTab(v);setView('manual')}}} onWatch={m=>watch('market',m.slug,m.title,m.price)} onSettings={()=>setSettings(true)} beginner={beginner} visible={view==='manual'||view==='results'&&resultsTab==='manual'} target={target} onPendingOrder={setPendingOrder} onSimulation={()=>setView('simulation')} onGame={m=>setGame(feed?.games.find(g=>g.id===m.gameId)||null)} onHelp={setHelp}/>
    {view==='simulation'&&<main className="dugout-simulation"><button className="back-to-picks" onClick={()=>setView('results')}>← Results</button><MlbSimulation/></main>}
    <Dialog open={!!help} onOpenChange={v=>!v&&setHelp(null)}><DialogContent className="help-dialog"><DialogTitle>{help==='glossary'?'Plain English':help}</DialogTitle><DialogDescription>{help==='glossary'?'Short answers when you need them.':glossary[help||'']}</DialogDescription>{help==='glossary'&&<div className="glossary-grid">{Object.keys(glossary).map(k=><button key={k} onClick={()=>setHelp(k)}>{k}<ChevronRight size={16}/></button>)}</div>}</DialogContent></Dialog>
    <Dialog open={settings} onOpenChange={setSettings}><DialogContent className="settings-dialog"><DialogTitle>Scanner thresholds</DialogTitle><DialogDescription>These control market observations, not the bot’s trading rules.</DialogDescription>{([['move','Price move in the observed hour','points'],['wide','Wide spread','cents'],['spreadChange','Spread change','cents'],['thin','Low available depth','contracts'],['activity','Activity above baseline','times normal']] as const).map(([key,label,unit])=><label className="setting-row" key={key}><span>{label}<small>{unit}</small></span><input type="number" min=".1" step=".5" value={config[key]} onChange={e=>setConfig({...config,[key]:Number(e.target.value)})}/></label>)}{settingsError&&<p role="alert">{settingsError}</p>}<button className="primary-action" onClick={saveSettings} disabled={settingsBusy}>{settingsBusy?'Saving…':'Save thresholds'}</button></DialogContent></Dialog>
    <Dialog open={!!game} onOpenChange={v=>!v&&setGame(null)}><DialogContent className="game-dialog"><DialogTitle>{game?.title}</DialogTitle><DialogDescription>{game&&gameTime(game.start)} · {game?.league}</DialogDescription><div className="game-watch-actions"><button onClick={()=>game&&watch('game',game.id,game.title)}><Bookmark size={15}/>{profile?.watches.some(w=>w.kind==='game'&&w.key===game?.id)?'Unwatch game':'Watch game'}</button>{game?.teams.map(t=><button key={t.id} onClick={()=>watch('team',String(t.id),t.name)}><Bookmark size={15}/>{profile?.watches.some(w=>w.kind==='team'&&w.key===String(t.id))?'Unwatch':'Watch'} {t.abbreviation}</button>)}</div>{game?.teams.map(t=><p className="team-record" key={t.id}>{t.name} · {t.record||'Record not supplied'}</p>)}<div className="game-market-list">{game?.markets.map(m=><button key={m.slug} onClick={()=>openManual(m.slug)}><span>{m.title}</span><b>{m.ask===null?'—':`${(m.ask*100).toFixed(1)}¢`}<ChevronRight size={15}/></b></button>)}</div></DialogContent></Dialog>
    {toast&&<div className="toast" role="status"><Check size={17}/>{toast}</div>}
  </div>
}
