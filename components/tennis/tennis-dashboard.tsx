'use client';



import {tennisCommandId} from './command-id';

import {useEffect,useState} from 'react';

import Link from 'next/link';

import {Activity,ArrowUpRight,Clock3,FlaskConical,LoaderCircle,Pause,Play,Radio,RefreshCw,RotateCcw,Square,TriangleAlert,X} from 'lucide-react';

import {Switch} from '@/components/ui/switch';

import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';

import type {TennisLeague,TennisMarket,TennisSession} from '@/lib/tennis/types';

import {useTennis} from './use-tennis';

import {TennisMarketDialog} from './market-dialog';

import {TennisRulesDialog} from './rules-dialog';

import {TennisAdvisor} from './advisor';
import {TennisMatchChart} from './match-chart';
import {GamePicker} from './game-picker';

import {describeTennisRules} from '@/lib/tennis/rules';
import {focusedEntryRest} from '@/lib/tennis/entry-rest';

import {TennisPriceChart,TennisSparkline} from './price-chart';

import './tennis.css';



const money=(value:number)=>`${value<0?'−':''}$${Math.abs(value).toFixed(2)}`;

const signed=(value:number)=>`${value>0?'+':''}${money(value)}`;

const cents=(value:number|null)=>value===null?'—':`${(value*100).toFixed(value*100%1<.01?0:1)}¢`;

const age=(time:number,now:number)=>time<=0?'not observed':now-time<10000?'just now':now-time<60000?`${Math.floor((now-time)/1000)}s ago`:`${Math.floor((now-time)/60000)}m ago`;

const time=(value:number)=>new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});



function marketPoints(market:TennisMarket,session:TennisSession|null) {

  return market.history.length>=2?market.history:session?.histories[`${market.slug}:YES`]??market.history;

}



function MarketCard({market,session,now,onOpen}:{market:TennisMarket;session:TennisSession|null;now:number;onOpen:()=>void}) {

  const points=marketPoints(market,session),first=points[0],last=points[points.length-1];

  const delta=first&&last?(last.price-first.price)*100:null;

  const spread=market.ask!==null&&market.bid!==null?market.ask-market.bid:null;

  const price=market.price,quoteTime=market.quoteObservedAt??market.observedAt,isBook=market.quoteSource==='REST'||market.quoteSource==='WEBSOCKET',stale=isBook&&now-quoteTime>(session?.config.maxBookAgeMs??5000);

  const state=session?.signals[`${market.slug}:YES`];

  const start=new Date(market.startTime);

  const suspended=/sus|suspend|delay|interrupt/i.test(market.period??'');

  return <article className="tennis-card">

    <div className="tennis-card-meta"><span className="tennis-tour">{market.league}</span><span className={`tennis-dot ${market.live?'is-live':''}`}/><span>{suspended?'SUSPENDED':market.live?'IN PLAY':market.ended?'ENDED':'UPCOMING'}</span><time>{market.live&&market.score?market.score:Number.isNaN(start.getTime())?'Time unavailable':start.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</time></div>

    <button className="tennis-matchup" onClick={onOpen} aria-label={`Open ${market.yesName} versus ${market.noName}`}><strong>{market.yesName}</strong><span>vs.</span><strong>{market.noName}</strong></button>

    <div className="tennis-card-prices"><div><div className="tennis-main-price">{price===null?'—':(price*100).toFixed(price*100%1<.01?0:1)}{price!==null&&<small>¢</small>}</div><p>{market.yesName.split(' ').at(-1)} · market price</p></div><div><b>{cents(market.ask)}</b><p>entry quote</p></div></div>

    <TennisSparkline points={points}/>

    <div className="tennis-movement"><span className={delta!==null&&delta<0?'tennis-negative':delta!==null&&delta>0?'tennis-positive':''}>{delta===null||points.length<2?'History building':`${delta>0?'↗ +':delta<0?'↘ ':'→ '}${delta.toFixed(1)} points`}</span><span>{isBook?'Book':'Listing'} · {age(quoteTime,now)}</span></div>

    <div className="tennis-card-footer"><span>{state?.phase==='DIP'?'Dip observed':state?.phase==='RECOVERING'?'Recovery observed':spread===null?'No two-sided quote':`Spread ${cents(spread)}`}{stale?' · awaiting book':''}</span><button onClick={onOpen}>{market.league==='NFL'||market.league==='CFB'?'Teams & chart':'Players & chart'} <ArrowUpRight size={13}/></button></div>

  </article>;

}



export function TennisDashboard() {

  const bot=useTennis();

  const {session,catalog,now}=bot;

  const [beginner,setBeginner]=useState(true),[filter,setFilter]=useState<'ALL'|TennisLeague>('ALL');

  const [selected,setSelected]=useState<string|null>(null),[resetOpen,setResetOpen]=useState(false),[resetBalance,setResetBalance]=useState(100);

  const [showAll,setShowAll]=useState(false),[activityTab,setActivityTab]=useState<'decisions'|'trades'|'balance'>('balance');

  const [advisorOpen,setAdvisorOpen]=useState(false);
  const [followed,setFollowed]=useState<string|null>(null);

  const [settingsOpen,setSettingsOpen]=useState(false);

  useEffect(()=>{queueMicrotask(()=>{try{setBeginner(localStorage.getItem('dugout-tennis-beginner')!=='false');}catch{/* Optional preference. */}});},[]);

  const entryBudget=session?.config.entryBudget??5;
  const hasFootball=!!session?.config.leagues.some(l=>l==='NFL'||l==='CFB'),hasTennis=!!session?.config.leagues.some(l=>l==='ATP'||l==='WTA');
  const focus=hasFootball?(hasTennis?'both':'football'):'tennis';
  const chooseSport=async(value:'tennis'|'football'|'both')=>{
    if(!session)return;
    const leagues:TennisLeague[]=value==='football'?['NFL','CFB']:value==='tennis'?['ATP','WTA']:['ATP','WTA','NFL','CFB'];
    const ok=await bot.perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:tennisCommandId(),rules:{leagues,focusSlug:null}});
    if(ok){setFilter('ALL');setFollowed(null);setSelected(null);void bot.refresh();}
  };

  const open=session?.positions.filter(position=>position.status==='open')??[];

  const closed=session?.positions.filter(position=>position.status!=='open')??[];

  const liquidCash=(session?.cash??0)+open.reduce((sum,position)=>sum+(position.netLiquidationValue??0),0);

  const incompleteMark=open.some(position=>position.netLiquidationValue===null||position.liquidationQuantity+1e-7<position.quantity||!position.markedAt||now-position.markedAt>15000);

  const pnl=session?liquidCash-session.config.startingCash:0;

  const feedUnavailable=!!bot.feedError||!!catalog?.errors.length;

  const availableMarkets=[...new Map([...(catalog?.markets??[]).filter(m=>!session||session.config.leagues.includes(m.league)),...open.filter(p=>!catalog?.markets.some(m=>m.slug===p.slug)).map(p=>p.lastContext??p.market)].map(m=>[m.slug,m])).values()];
  const markets=availableMarkets.filter(market=>filter==='ALL'||market.league===filter);

  const selectedMarket=catalog?.markets.find(market=>market.slug===selected)??session?.positions.find(position=>position.slug===selected)?.market??null;
  const liveMarkets=availableMarkets.filter(m=>m.live&&!m.ended);
  const focusedMarket=availableMarkets.find(m=>m.slug===session?.config.focusSlug);
  const followedMarket=availableMarkets.find(m=>m.slug===followed)??focusedMarket??availableMarkets.find(m=>open.some(p=>p.slug===m.slug))??liveMarkets[0];
  const watchMarket=bot.watchMarket;
  useEffect(()=>{watchMarket(selected??followedMarket?.slug??null);},[selected,followedMarket?.slug,watchMarket]);

  const watchDuration=hasFootball?10_800_000:1_800_000;
  const setGameFocus=async(slug:string|null)=>{
    if(!session)return;
    if(await bot.perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:tennisCommandId(),rules:{focusSlug:slug}}))setFollowed(slug);
  };

  const isRunning=session?.status==='running',isPaused=session?.status==='paused',isIdle=session?.status==='idle',isStopped=session?.status==='stopped';

  const tickStale=!!session&&['running','paused','stopping'].includes(session.status)&&now-session.lastTickAt>20000;

  const restSeconds=focusedEntryRest(session,now);
  const status=!session?'Connecting':session.status==='stopping'?'Exiting position':isStopped?'Stopped':tickStale?'Waiting for a fresh check':isPaused?'Entries paused':session.pending?'Order pending':isRunning?(open.length?'Managing position':restSeconds!==null?'Resting before next entry':'Scanning'):'Ready';

  const reasonDecision=session?.decisions.findLast(d=>d.reason===session.lastReason);
  const reasonMarket=catalog?.markets.find(m=>m.slug===reasonDecision?.slug)??session?.positions.find(p=>p.slug===reasonDecision?.slug)?.market;
  const namedReason=reasonMarket&&reasonDecision?`${reasonDecision.side==='YES'?reasonMarket.yesName:reasonMarket.noName}: ${session?.lastReason}`:session?.lastReason;
  const reason=!session?'Loading your saved paper session…':!bot.visible?'Page is hidden. Live checks resume when you return.':tickStale?'The last bot check is older than 20 seconds. No fills are made using stale data.':restSeconds!==null?`${focusedMarket?`${focusedMarket.yesName} vs. ${focusedMarket.noName}: `:''}Next entry check in ${restSeconds}s. The bot resumes automatically and still needs a qualifying setup.`:namedReason;

  const decisions=[...(session?.decisions??[])].reverse().filter(d=>showAll||!['WARMUP','CONFIRMATION','NO_DIP','NO_MOMENTUM'].includes(d.code));

  const seen=new Set<string>();

  const unique=decisions.filter(decision=>{const key=`${decision.slug}:${decision.side}:${decision.code}`;if(seen.has(key)&&['WAIT','SKIP'].includes(decision.action))return false;seen.add(key);return true;}).slice(0,showAll?60:6);

  const ledger=[...(session?.ledger??[])].reverse().slice(0,showAll?60:6);

  const labelFor=(slug:string,side:'YES'|'NO')=>{const market=catalog?.markets.find(item=>item.slug===slug)??session?.positions.find(position=>position.slug===slug)?.market;return market?(side==='YES'?market.yesName:market.noName):slug||'Paper session';};

  const reset=async()=>{const ok=await bot.perform({action:'reset',bankroll:resetBalance,commandId:tennisCommandId()});if(ok)setResetOpen(false);};

  return <div className="tennis-app">

    <header className="tennis-header"><Link className="tennis-logo" href="/" aria-label="Dugout home"><span className="tennis-logo-mark"><Activity size={20}/></span>dugout<span style={{color:'#c2f477',marginLeft:-8}}>.</span></Link><div className="tennis-header-actions"><span className="tennis-paper-pill"><FlaskConical size={12}/>PAPER TRADING</span><label className="tennis-mode" htmlFor="tennis-beginner">Beginner mode<Switch id="tennis-beginner" checked={beginner} onCheckedChange={value=>{setBeginner(value);try{localStorage.setItem('dugout-tennis-beginner',String(value));}catch{/* Optional preference. */}}}/></label></div></header>

    <main className="tennis-main">

      <div className="tennis-heading"><div><span className="tennis-kicker">{focus==='football'?'FOOTBALL · NFL & COLLEGE':focus==='both'?'TENNIS & FOOTBALL · LIVE MARKETS':'TENNIS · ATP & WTA'}</span><h1>Let the bot watch.</h1>{beginner&&<p>Real sports markets. A fake balance. Set your budget and limits. Auto handles the setups.</p>}</div><div className="tennis-feed-indicator"><span className={`tennis-dot ${bot.streamStatus==='live'?'is-live':'is-waiting'}`}/>{bot.streamStatus==='live'?'Live Polymarket US stream':bot.streamStatus==='connecting'?'Connecting live stream…':'Polymarket US · REST checks'}{catalog&&<span>· {age(catalog.updatedAt,now)}</span>}</div></div>

      <div className="tennis-tour-choice tennis-sport-choice" role="group" aria-label="Sports the bot watches">{(['tennis','football','both'] as const).map(value=><button key={value} aria-pressed={focus===value} disabled={!session||bot.busy||focus===value} onClick={()=>void chooseSport(value)}>{value==='tennis'?'Tennis':value==='football'?'Football':'Both sports'}</button>)}</div>
      {bot.error&&!selected&&<div className="tennis-error" role="alert"><TriangleAlert size={16}/><span>{bot.error}</span><button aria-label="Dismiss error" onClick={bot.clearError}><X size={15}/></button></div>}
      {bot.connectionIssue&&<div className="tennis-error" role="status"><RefreshCw size={16}/><span>{bot.connectionIssue} Last saved check: {session?age(session.lastTickAt,now):'connecting'}.</span></div>}

      <section className="tennis-command" aria-label="Paper bot controls">

        <div className="tennis-command-left"><div className="tennis-status-row"><span className="tennis-section-label">{session?.config.strategy==='auto'?'AUTO DECISION ENGINE':session?.config.strategy==='momentum'?'FOLLOW A RISE':'WAIT FOR A RECOVERY'} · PAPER BOT</span><span className="tennis-status"><span className={`tennis-dot ${isRunning&&!tickStale?'is-live':'is-waiting'}`}/>{status}</span></div>

          <div className="tennis-controls">{isIdle?<button className="tennis-primary" disabled={bot.busy||!session||entryBudget<1||entryBudget>Math.min(100,session.config.startingCash*.2)} onClick={()=>void bot.perform({action:'start',runForMs:watchDuration,commandId:tennisCommandId()})}><Play size={17}/>{bot.busy?'Starting…':'Start paper bot'}</button>:isStopped?<button className="tennis-primary" disabled={bot.busy||open.length>0} onClick={()=>{setResetBalance(session?.config.startingCash??100);setResetOpen(true);}}><RotateCcw size={16}/>New paper run</button>:<button className="tennis-primary" disabled={bot.busy||!session||session.status==='stopping'} onClick={()=>void bot.perform({action:isPaused?'resume':'pause',...(isPaused&&(!session.testRun||session.testRun.complete||now>=session.testRun.endsAt)?{runForMs:watchDuration}:{}),commandId:tennisCommandId()})}>{bot.busy?<LoaderCircle size={17}/>:isPaused?<Play size={17}/>:<Pause size={17}/>} {isPaused?'Resume bot':'Pause bot'}</button>}

          {!isIdle&&!isStopped&&session&&<button className="tennis-secondary" disabled={bot.busy||session.status==='stopping'} onClick={()=>void bot.perform({action:'stop',commandId:tennisCommandId()})}><Square size={13}/>Stop bot</button>}

          <button className="tennis-secondary" disabled={!session} onClick={()=>setSettingsOpen(true)}>Bot rules</button><button className="tennis-secondary" onClick={()=>setAdvisorOpen(true)}>Ask Claude</button>
          {session&&session.config.strategy!=='auto'&&<button className="tennis-secondary" disabled={bot.busy} onClick={()=>void bot.perform({action:'update-rules',rules:{strategy:'auto'},expectedRulesRevision:session.rulesRevision??0,sessionId:session.id,commandId:tennisCommandId()})}>Use Auto</button>}

          {!session&&<button className="tennis-secondary" onClick={()=>void bot.reloadAccount()}><RefreshCw size={14}/>Reconnect</button>}</div>

          <p className="tennis-reason" role="status">{reason}</p><div className="tennis-runtime"><Clock3 size={12}/>Runs while this page is open and visible · paper only</div>{beginner&&isPaused&&open.length>0&&<p className="tennis-order-help">Exits are still checked. Pause only blocks new entries.</p>}
          {session?.config.strategy==='auto'&&<p className="tennis-order-help">Compares recoveries and sustained rises, adjusts move sizes, and checks costs automatically. Your budget and exit limits stay fixed. No AI API calls.</p>}

        </div>

        <div className="tennis-command-right"><span className="tennis-section-label">{incompleteMark?'CASH + PRICED EXIT SIZE':'PAPER BALANCE'}</span><strong className="tennis-balance">{session?money(liquidCash):'—'}</strong><span className={`tennis-pnl ${pnl<0?'tennis-negative':'tennis-positive'}`}>{session?`${signed(pnl)} ${incompleteMark?'· some holdings unpriced':'since start'}`:'Loading fake balance'}</span><div className="tennis-money-meta"><div>Available cash<strong>{session?money(session.cash):'—'}</strong></div><div>Bot entry<strong>{session?money(isIdle?entryBudget:session.config.entryBudget):'—'}</strong></div><button className="tennis-link" disabled={!session||bot.busy||open.length>0||!!session?.pending} title={open.length?'Stop the bot and finish its exits before resetting':undefined} onClick={()=>{setResetBalance(session?.config.startingCash??100);setResetOpen(true);}}>Reset balance</button></div></div>

      </section>

      <section className="tennis-rule-summary" aria-label="Bot game focus"><b>{session?.config.focusSlug?`Bot focus: ${focusedMarket?`${focusedMarket.yesName} vs. ${focusedMarket.noName}`:'Saved game'}`:'Bot scans all selected leagues'}</b><p>{session?.config.focusSlug?'New entries are limited to this game. Both teams are evaluated; existing positions still receive exit checks.':'The chart is for watching. Focus a game below to restrict new bot entries.'}</p>{session?.config.focusSlug&&<button className="tennis-link" disabled={bot.busy} onClick={()=>void setGameFocus(null)}>Watch all selected games</button>}{followedMarket&&session?.config.focusSlug!==followedMarket.slug&&<button className="tennis-secondary" disabled={bot.busy||!session} onClick={()=>void setGameFocus(followedMarket.slug)}>Focus bot on {followedMarket.yesName} vs. {followedMarket.noName}</button>}</section>

      <GamePicker markets={availableMarkets} selected={followedMarket?.slug??null} focused={session?.config.focusSlug??null} busy={bot.busy||!session} loading={catalog?.discovery?.complete===false} now={now} onSelect={setFollowed} onFocus={slug=>void setGameFocus(slug)}/>

      <section className="tennis-live-panel" aria-label="Follow a live match"><div className="tennis-live-panel-head"><div><span className="tennis-kicker">LIVE MATCH WATCH</span><h2>{followedMarket?`${followedMarket.yesName} vs. ${followedMarket.noName}`:'Waiting for a live match'}</h2></div>{liveMarkets.length>1&&<label>Match<select aria-label="Match to follow" value={followedMarket?.slug} onChange={event=>setFollowed(event.target.value)}>{liveMarkets.map(m=><option key={m.slug} value={m.slug}>{m.yesName} vs. {m.noName}</option>)}</select></label>}</div>{followedMarket?<TennisMatchChart key={followedMarket.slug} market={followedMarket} session={session} now={now}/>:<p className="tennis-order-help">The live chart appears when the feed confirms a match is in play. Upcoming matches are listed below.</p>}</section>

      {session?.testRun&&<section className="tennis-run-progress" aria-label="Observation progress"><div><b>{session.testRun.complete?'Observation finished':`${Math.round((session.testRun.endsAt-session.testRun.startedAt)/60000)}-minute paper watch`}</b><span>{Math.floor(session.testRun.watchedMs/60000)}m {Math.floor(session.testRun.watchedMs/1000)%60}s checked · {session.testRun.liveSlugs.length} live matches observed</span></div><progress max={session.testRun.endsAt-session.testRun.startedAt} value={Math.min(session.testRun.endsAt-session.testRun.startedAt,Math.max(0,now-session.testRun.startedAt))}/><small>{session.testRun.complete?'New entries paused. Existing exits are still managed.':'Keep this page open and visible. Entries pause automatically when the window ends.'}</small></section>}

      {!!session?.pending&&<div className="tennis-notice" role="status"><Clock3 size={14}/>{session.pending.action==='BUY'?'Paper entry':'Paper exit'} queued · waiting for a fresh book after {session.config.executionDelayMs/1000}s execution delay.</div>}

      {open.length>0&&<section className="tennis-position-list" aria-label="Open paper positions"><h2 className="tennis-open-title">The bot’s open trade</h2>{open.map(position=>{const marked=position.netLiquidationValue!==null&&!!position.markedAt&&now-position.markedAt<=15000;const returnValue=marked?position.netLiquidationValue!-position.costBasis:null;const partial=position.liquidationQuantity+1e-7<position.quantity;return <article className="tennis-position" key={position.id}><div><span className="tennis-section-label">{position.league} · {position.side} · PAPER</span><h3>{position.name}</h3><p>{position.quantity.toFixed(2)} contracts · {money(position.costBasis)} remaining cost</p></div><div className="tennis-position-return"><strong className={returnValue!==null&&returnValue<0?'tennis-negative':'tennis-positive'}>{returnValue===null?'—':signed(returnValue)}</strong><small>{!marked?'Waiting for fresh exit value':partial?'Only part can sell now':'Net P/L if filled now'}</small></div><span className="tennis-status">{session?.pending?.action==='SELL'?'Bot is exiting':'Bot is managing'}</span></article>;})}</section>}

      <section className="tennis-activity" aria-label="Paper session results"><div className="tennis-activity-head"><div><h2>Watch your bot</h2><div className="tennis-subtabs" role="group" aria-label="Experiment view">{([{id:'decisions',label:'Bot activity'},{id:'trades',label:`Bot orders · ${session?.ledger.length??0}`},{id:'balance',label:'Balance'}] as const).map(tab=><button key={tab.id} aria-pressed={activityTab===tab.id} onClick={()=>setActivityTab(tab.id)}>{tab.label}</button>)}</div></div>{activityTab!=='balance'&&<button className="tennis-link" onClick={()=>setShowAll(!showAll)}>{showAll?'Show less':'Show all'}</button>}</div>

      {activityTab==='decisions'&&<div className="tennis-rule-summary"><b>What is happening now</b><p>{reason}</p><small>{Object.values(session?.coverage??{}).filter(c=>c.live&&now-c.time<15000).length} live matches with recent usable quotes · Rules revision {session?.rulesRevision??0}</small></div>}{activityTab==='balance'?<><TennisPriceChart points={session?.equity??[]} currency/><div className="tennis-feed-note"><span>{closed.length} closed positions · {session?.evaluated??0} quote evaluations</span><span>Fees included in simulated fills</span></div></>:activityTab==='decisions'?unique.length?<div className="tennis-activity-list">{unique.map(decision=><div className="tennis-activity-row" key={decision.id}><span className={`tennis-action-badge ${decision.action==='BUY'?'is-buy':decision.action==='SELL'?'is-sell':''}`}>{decision.action}</span><div><strong>{labelFor(decision.slug,decision.side)}</strong><p>{decision.reason}</p></div><time>{time(decision.time)}</time></div>)}</div>:<div className="tennis-empty-activity">{isRunning?'No entry or exit has qualified yet. The current status above explains the wait.':'Start a paper run to see exactly what the bot accepts and skips.'}</div>:ledger.length?<div className="tennis-activity-list">{ledger.map(entry=><div className="tennis-activity-row" key={entry.id}><span className={`tennis-action-badge ${entry.action==='BUY'?'is-buy':'is-sell'}`}>{entry.action}</span><div><strong>{labelFor(entry.slug,entry.side)} · {signed(entry.cashDelta)} cash</strong><p>{entry.source==='MANUAL'?'Earlier activity':'Bot'} · {entry.execution?`${entry.execution.filledQty.toFixed(2)} contracts at ${cents(entry.execution.averagePrice)} · ${money(entry.execution.fees)} fees · ${entry.execution.status}`:'Settlement recorded'}{entry.action!=='BUY'?` · realized ${signed(entry.realizedPnl)}`:''}</p>{!beginner&&entry.quotedPrice!==undefined&&<p>Quoted {cents(entry.quotedPrice)} → filled {cents(entry.actualPrice??null)} · {((entry.executionDelayMs??0)/1000).toFixed(1)}s delay</p>}</div><time>{time(entry.time)}</time></div>)}</div>:<div className="tennis-empty-activity">No fills yet. The bot is waiting for a match and a setup that meet your rules.</div>}</section>
      <div className="tennis-feed-heading"><h2>{focus==='tennis'?'On the court':'Live game markets'}<span className="tennis-count">{catalog?`${markets.length} ${markets.length===1?'market':'markets'}`:'Loading matches'}</span></h2><div className="tennis-feed-tools"><div className="tennis-filter" role="group" aria-label="Filter league">{([{value:'ALL',label:'All selected'},{value:'ATP',label:'Men · ATP'},{value:'WTA',label:'Women · WTA'},{value:'NFL',label:'NFL'},{value:'CFB',label:'College'}] as const).filter(item=>item.value==='ALL'||session?.config.leagues.includes(item.value)).map(item=><button key={item.value} aria-pressed={filter===item.value} onClick={()=>setFilter(item.value)}>{item.label}</button>)}</div><button className="tennis-refresh" aria-label="Refresh game markets" title="Refresh game markets" disabled={bot.refreshing} onClick={()=>void bot.refresh()}><RefreshCw size={16} className={bot.refreshing?'spin':''}/></button></div></div>

      {(bot.feedError||catalog?.errors.length!==0&&catalog?.errors.length)&&<div className="tennis-error" role="alert"><TriangleAlert size={16}/><span>{bot.feedError||catalog?.errors.join(' ')}</span></div>}

      <section className="tennis-market-grid" aria-label="Real game markets">{(bot.loading||bot.refreshing&&markets.length===0)?[0,1,2].map(index=><div className="tennis-loading-card" key={index}><LoaderCircle size={15} className="spin"/>Finding real game markets…</div>):markets.length?markets.map(market=><MarketCard market={market} session={session} now={now} key={market.slug} onOpen={()=>setSelected(market.slug)}/>):<div className="tennis-empty"><Radio size={30}/><h3>{feedUnavailable?'Game feed unavailable':'No open markets for the selected sports right now.'}</h3><p>{feedUnavailable?'The feed could not be loaded. Your paper account is saved; retry when the connection returns.':`Polymarket US has no ${filter==='ALL'?(session?.config.leagues.join(' or ')??'selected'):filter} markets in the current response. The bot will wait for real markets.`}</p><button className="tennis-secondary" disabled={bot.refreshing} onClick={()=>void bot.refresh()}><RefreshCw size={13}/>Check again</button></div>}</section>

      <div className="tennis-feed-note"><span>{beginner?'These are markets to inspect, not picks or recommendations.':''}</span><span>Live games only · listed-market coverage · rotating quote checks</span></div>



      <div className="tennis-rule-summary"><b>Your current rules</b><p>{session?describeTennisRules(session.config):'Loading saved rules…'}</p><button className="tennis-link" disabled={!session} onClick={()=>setSettingsOpen(true)}>Change bot rules</button><a className="tennis-link" href="/api/tennis/session?export=1" download style={{marginLeft:18}}>Export saved history</a></div>



    </main>

    <footer className="tennis-footer"><span>Paper research. Fills and fees are estimates. Exits depend on available buyers.</span><span>Bot only · fake money · no real orders</span></footer>

    <TennisMarketDialog key={selected??'none'} market={selectedMarket} session={session} now={now} onClose={()=>setSelected(null)}/>

    {settingsOpen&&session&&<TennisRulesDialog session={session} busy={bot.busy} error={bot.error} onClose={()=>setSettingsOpen(false)} onAction={bot.perform}/>}

    {advisorOpen&&<TennisAdvisor onClose={()=>setAdvisorOpen(false)}/>}

    <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="tennis-market-dialog"><DialogTitle className="tennis-dialog-title">Start with fake money.</DialogTitle><DialogDescription className="tennis-dialog-description">Choose $5–$1,000 for a new paper run. Reset starts a fresh run and archives the previous balance and history. Stop the bot and let it finish any exits first.</DialogDescription><div className="tennis-reset-form"><label htmlFor="tennis-reset-balance">Starting paper balance</label><input className="tennis-reset-input" id="tennis-reset-balance" type="number" min="5" max="1000" step="1" value={resetBalance} onChange={event=>setResetBalance(Number(event.target.value))}/><div className="tennis-amounts">{[5,10,100].map(value=><button key={value} aria-pressed={resetBalance===value} onClick={()=>setResetBalance(value)}>${value}</button>)}</div>{bot.error&&<div className="tennis-dialog-error" role="alert">{bot.error}</div>}<div className="tennis-reset-actions"><button className="tennis-secondary" onClick={()=>setResetOpen(false)}>Cancel</button><button className="tennis-primary" disabled={bot.busy||resetBalance<5||resetBalance>1000||!Number.isFinite(resetBalance)||open.length>0||!!session?.pending} onClick={()=>void reset()}>{bot.busy?'Resetting…':'Reset paper run'}</button></div></div></DialogContent></Dialog>

  </div>;

}
