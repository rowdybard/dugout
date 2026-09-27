'use client';



import {tennisCommandId} from './command-id';

import {useEffect,useState} from 'react';

import Link from 'next/link';

import {Activity,ArrowUpRight,Clock3,FlaskConical,LoaderCircle,Pause,Play,Radio,RefreshCw,RotateCcw,Square,TriangleAlert,X} from 'lucide-react';

import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';

import type {TennisLeague,TennisMarket,TennisSession} from '@/lib/tennis/types';
import {VISIBLE_LEAGUES} from '@/lib/tennis/leagues';

import {useTennis} from './use-tennis';

import {TennisMarketDialog} from './market-dialog';

import {TennisRulesDialog} from './rules-dialog';

import {TennisAdvisor} from './advisor';
import {TennisMatchChart} from './match-chart';
import {GamePicker} from './game-picker';
import {RunnerSetup} from './runner-setup';
import {DecisionCard} from './decision-card';
import {EngineCard} from './engine-card';

import {describeTennisRules} from '@/lib/tennis/rules';
import {focusedEntryRest} from '@/lib/tennis/entry-rest';
import {localMoveUpgradeRules,startPaperBot} from '@/lib/tennis/start-control';

import {TennisPriceChart,TennisSparkline} from './price-chart';

import '@fontsource-variable/inter';
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

    <div className="tennis-card-footer"><span>{state?.phase==='DIP'?'Dip observed':state?.phase==='RECOVERING'?'Recovery observed':spread===null?'No two-sided quote':`Spread ${cents(spread)}`}{stale?' · awaiting book':''}</span><button onClick={onOpen}>{market.league==='NFL'||market.league==='CFB'||market.league==='MLB'?'Teams & chart':'Players & chart'} <ArrowUpRight size={13}/></button></div>

  </article>;

}



export function TennisDashboard() {

  const bot=useTennis();

  const {session,catalog,now}=bot;

  const [filter,setFilter]=useState<'ALL'|TennisLeague>('ALL');

  const [selected,setSelected]=useState<string|null>(null),[resetOpen,setResetOpen]=useState(false),[resetBalance,setResetBalance]=useState(100);

  const [showAll,setShowAll]=useState(false),[activityTab,setActivityTab]=useState<'decisions'|'trades'>('decisions');

  const [advisorOpen,setAdvisorOpen]=useState(false);
  const [followed,setFollowed]=useState<string|null>(null);

  const [settingsOpen,setSettingsOpen]=useState(false);

  const entryBudget=session?.config.entryBudget??5;
  const leagues=session?.config.leagues??[];
  // The view shows only VISIBLE_LEAGUES; an account still set to watch other leagues gets one button to narrow it.
  const onlyVisible=leagues.length>0&&leagues.every(l=>VISIBLE_LEAGUES.includes(l));
  const focus=leagues.some(l=>l==='ATP'||l==='WTA')?'tennis':'football';
  const chooseVisible=async()=>{
    if(!session)return;
    const leagues:TennisLeague[]=[...VISIBLE_LEAGUES];
    const keepFocus=catalog?.markets.find(m=>m.slug===session.config.focusSlug)?.league==='CFB';
    const ok=await bot.perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:tennisCommandId(),rules:{leagues,...(keepFocus?{}:{focusSlug:null})}});
    if(ok){setFilter('ALL');setFollowed(null);setSelected(null);void bot.refresh();}
  };

  const open=session?.positions.filter(position=>position.status==='open')??[];

  const closed=session?.positions.filter(position=>position.status!=='open')??[];

  const liquidCash=(session?.cash??0)+open.reduce((sum,position)=>sum+(position.netLiquidationValue??0),0);

  const incompleteMark=open.some(position=>position.netLiquidationValue===null||position.liquidationQuantity+1e-7<position.quantity||!position.markedAt||now-position.markedAt>15000);

  const pnl=session?liquidCash-session.config.startingCash:0;

  const feedUnavailable=!!bot.feedError||!!catalog?.errors.length;

  const availableMarkets=[...new Map([...(catalog?.markets??[]).filter(m=>VISIBLE_LEAGUES.includes(m.league)&&(!session||session.config.leagues.includes(m.league))),...open.map(p=>catalog?.markets.find(m=>m.slug===p.slug)??p.lastContext??p.market)].map(m=>[m.slug,m])).values()];
  const markets=availableMarkets.filter(market=>filter==='ALL'||market.league===filter);

  const selectedMarket=catalog?.markets.find(market=>market.slug===selected)??session?.positions.find(position=>position.slug===selected)?.market??null;
  const liveMarkets=availableMarkets.filter(m=>m.live&&!m.ended);
  const focusedMarket=availableMarkets.find(m=>m.slug===session?.config.focusSlug);
  const followedMarket=availableMarkets.find(m=>m.slug===followed)??focusedMarket??availableMarkets.find(m=>open.some(p=>p.slug===m.slug))??liveMarkets[0];
  const watchMarket=bot.watchMarket;
  useEffect(()=>{watchMarket(selected??followedMarket?.slug??null);},[selected,followedMarket?.slug,watchMarket]);

  const background=bot.runtime?.mode==='service';
  const migrating=bot.runtime?.mode==='migrating';
  const startBot=()=>startPaperBot(session,bot.runtime,bot.perform,tennisCommandId);
  const setGameFocus=async(slug:string|null)=>{
    if(!session)return;
    if(await bot.perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:tennisCommandId(),rules:{focusSlug:slug}}))setFollowed(slug);
  };

  const isRunning=session?.status==='running',isPaused=session?.status==='paused',isIdle=session?.status==='idle',isStopped=session?.status==='stopped';

  const tickStale=!!session&&(session.status==='running'||session.status==='stopping'||open.length>0||!!session.pending)&&now-(bot.runtime?.lastSuccessfulCheck??session.lastTickAt)>20000;

  const restSeconds=focusedEntryRest(session,now);
  const status=!session?'Connecting':session.status==='stopping'?'Exiting position':isStopped?'Stopped':tickStale?'Waiting for a fresh check':isPaused?'Entries paused':session.pending?'Order pending':isRunning?(open.length?'Managing position':restSeconds!==null?'Resting before next entry':'Scanning'):'Ready';

  const reasonDecision=session?.decisions.findLast(d=>d.reason===session.lastReason);
  const reasonMarket=catalog?.markets.find(m=>m.slug===reasonDecision?.slug)??session?.positions.find(p=>p.slug===reasonDecision?.slug)?.market;
  const namedReason=reasonMarket&&reasonDecision?`${reasonDecision.side==='YES'?reasonMarket.yesName:reasonMarket.noName}: ${session?.lastReason}`:session?.lastReason;
  const reason=!session?'Loading your saved paper session…':!bot.visible&&!background?'Page is hidden. Live checks resume when you return.':tickStale?'The last bot check is older than 20 seconds. Waiting for the runner to report a fresh check.':restSeconds!==null?`${focusedMarket?`${focusedMarket.yesName} vs. ${focusedMarket.noName}: `:''}Next entry check in ${restSeconds}s. The bot resumes automatically and still needs a qualifying setup.`:namedReason;

  const decisions=[...(session?.decisions??[])].reverse().filter(d=>showAll||!['WARMUP','CONFIRMATION','NO_DIP','NO_MOMENTUM'].includes(d.code));

  const seen=new Set<string>();

  const unique=decisions.filter(decision=>{const key=`${decision.slug}:${decision.side}:${decision.code}`;if(seen.has(key)&&['WAIT','SKIP'].includes(decision.action))return false;seen.add(key);return true;}).slice(0,showAll?60:6);

  const ledger=[...(session?.ledger??[])].reverse().slice(0,showAll?60:6);

  const labelFor=(slug:string,side:'YES'|'NO')=>{const market=catalog?.markets.find(item=>item.slug===slug)??session?.positions.find(position=>position.slug===slug)?.market;return market?(side==='YES'?market.yesName:market.noName):slug||'Paper session';};

  const reset=async()=>{const ok=await bot.perform({action:'reset',bankroll:resetBalance,commandId:tennisCommandId()});if(ok)setResetOpen(false);};

  const watchable=[...new Map([...(followedMarket?[followedMarket]:[]),...(focusedMarket?[focusedMarket]:[]),...liveMarkets].map(m=>[m.slug,m] as const)).values()];
  const engineLabel=session?.config.evidenceGate==='evidence-v1'?'Evidence engine':session?.config.decisionEngine==='local-move-v1'?'Local engine':'Legacy rules';

  return <div className="tennis-app">

    <header className="tennis-header"><Link className="tennis-logo" href="/" aria-label="Dugout home"><span className="tennis-logo-mark"><Activity size={20}/></span>dugout<span className="tennis-logo-dot">.</span></Link><div className="tennis-header-actions"><span className="tennis-feed-indicator"><span className={`tennis-dot ${bot.streamStatus==='live'?'is-live':'is-waiting'}`}/>{bot.streamStatus==='live'?'Live stream':bot.streamStatus==='connecting'?'Connecting…':'REST checks'}{catalog&&<span>· {age(catalog.updatedAt,now)}</span>}</span><span className="tennis-paper-pill"><FlaskConical size={12}/>PAPER</span></div></header>

    <main className="tennis-main">

      <h1 className="tennis-visually-hidden">Dugout paper bot</h1>
      {session&&!onlyVisible&&<div className="tennis-tour-choice tennis-sport-choice" role="group" aria-label="Sports the bot watches"><button disabled={bot.busy} onClick={()=>void chooseVisible()}>Watch college football only</button></div>}
      {bot.error&&!selected&&<div className="tennis-error" role="alert"><TriangleAlert size={16}/><span>{bot.error}</span><button aria-label="Dismiss error" onClick={bot.clearError}><X size={15}/></button></div>}
      {bot.connectionIssue&&<div className="tennis-error" role="status"><RefreshCw size={16}/><span>{bot.connectionIssue} Last check {session?age(session.lastTickAt,now):'connecting'}.</span></div>}

      <section className="tennis-bot" aria-label="Paper bot">
        <div className="tennis-bot-head">
          <div className="tennis-bot-game">
            <span className="tennis-label"><span className={`tennis-dot ${isRunning&&!tickStale?'is-live':'is-waiting'}`}/>{status} · {engineLabel}</span>
            <h2>{followedMarket?`${followedMarket.yesName} vs. ${followedMarket.noName}`:'Pick a game below'}</h2>
            <div className="tennis-bot-game-tools">
              {watchable.length>1&&<select aria-label="Game to watch" value={followedMarket?.slug} onChange={event=>setFollowed(event.target.value)}>{watchable.map(m=><option key={m.slug} value={m.slug}>{m.yesName} vs. {m.noName}{m.slug===session?.config.focusSlug?' · bot':m.live?' · live':''}</option>)}</select>}
              {followedMarket&&session?.config.focusSlug===followedMarket.slug?<span className="tennis-tag">Bot’s game</span>:followedMarket&&<button className="tennis-secondary" disabled={bot.busy||!session||migrating} onClick={()=>void setGameFocus(followedMarket.slug)}>Focus bot here</button>}
            </div>
          </div>
          <div className="tennis-bot-money">
            <span className="tennis-label">{incompleteMark?'Cash + priced exits':'Balance'}</span>
            <strong className="tennis-balance">{session?money(liquidCash):'—'}</strong>
            <span className={`tennis-pnl ${pnl<0?'tennis-negative':'tennis-positive'}`}>{session?`${signed(pnl)}${incompleteMark?' · partly unpriced':''}`:'Loading'}</span>
            <span className="tennis-money-meta">Cash {session?money(session.cash):'—'} · Entry {session?money(isIdle?entryBudget:session.config.entryBudget):'—'}</span>
          </div>
        </div>

        <div className="tennis-controls">{isIdle?<button className="tennis-primary" disabled={bot.busy||migrating||!session?.config.focusSlug||entryBudget<1||entryBudget>Math.min(100,(session?.config.startingCash??0)*.2)} onClick={()=>void startBot()}><Play size={17}/>{bot.busy?'Starting…':'Start'}</button>:isStopped?<button className="tennis-primary" disabled={bot.busy||migrating||open.length>0} onClick={()=>{setResetBalance(session?.config.startingCash??100);setResetOpen(true);}}><RotateCcw size={16}/>New run</button>:<button className="tennis-primary" disabled={bot.busy||migrating||!session||session.status==='stopping'||(isPaused&&!session.config.focusSlug)} onClick={()=>{if(isPaused)void startBot();else void bot.perform({action:'pause',commandId:tennisCommandId()});}}>{bot.busy?<LoaderCircle size={17}/>:isPaused?<Play size={17}/>:<Pause size={17}/>} {isPaused?'Start':'Pause'}</button>}
          {!isIdle&&!isStopped&&session&&<button className="tennis-secondary" disabled={bot.busy||session.status==='stopping'} onClick={()=>void bot.perform({action:'stop',commandId:tennisCommandId()})}><Square size={13}/>Stop</button>}
          <button className="tennis-secondary" disabled={!session} onClick={()=>setSettingsOpen(true)}>Rules</button>{bot.advisorEnabled&&<button className="tennis-secondary" onClick={()=>setAdvisorOpen(true)}>Ask Claude</button>}
          {session&&session.config.decisionEngine!=='local-move-v1'&&<button className="tennis-secondary" disabled={bot.busy} onClick={()=>void bot.perform({action:'update-rules',rules:localMoveUpgradeRules(session.config),expectedRulesRevision:session.rulesRevision??0,sessionId:session.id,commandId:tennisCommandId()})}>Use decision engine</button>}
          {!session&&<button className="tennis-secondary" onClick={()=>void bot.reloadAccount()}><RefreshCw size={14}/>Reconnect</button>}
          <button className="tennis-link tennis-reset-link" disabled={!session||bot.busy||open.length>0||!!session?.pending} title={open.length?'Stop the bot and finish its exits before resetting':undefined} onClick={()=>{setResetBalance(session?.config.startingCash??100);setResetOpen(true);}}>Reset balance</button></div>

        {session?<DecisionCard session={session} market={availableMarkets.find(m=>m.slug===(open[0]?.slug??session.config.focusSlug))} runtime={bot.runtime} now={now}/>:<p className="tennis-reason" role="status">{reason}</p>}
        {!!session?.pending&&<div className="tennis-notice" role="status"><Clock3 size={14}/>{session.pending.action==='BUY'?'Entry':'Exit'} queued · fills on the next fresh book</div>}
        {open.length>0&&<div className="tennis-position-list" aria-label="Open paper positions">{open.map(position=>{const marked=position.netLiquidationValue!==null&&!!position.markedAt&&now-position.markedAt<=15000;const returnValue=marked?position.netLiquidationValue!-position.costBasis:null;const partial=position.liquidationQuantity+1e-7<position.quantity;return <article className="tennis-position" key={position.id}><div><span className="tennis-label">{position.league} · {position.side}</span><h3>{position.name}</h3><p>{position.quantity.toFixed(2)} contracts · {money(position.costBasis)} cost</p></div><div className="tennis-position-return"><strong className={returnValue!==null&&returnValue<0?'tennis-negative':'tennis-positive'}>{returnValue===null?'—':signed(returnValue)}</strong><small>{!marked?'Waiting for a price':partial?'Part can sell now':'If sold now'}</small></div><span className="tennis-tag">{session?.pending?.action==='SELL'?'Exiting':position.exitPolicy==='maker'?'Quote fill':position.exitPolicy==='hold-to-settlement'?'Holding to final':position.exitPolicy==='drive'?'Riding the drive':'Managing'}</span></article>;})}</div>}

        <div className="tennis-bot-watch">{followedMarket?<TennisMatchChart key={followedMarket.slug} market={followedMarket} session={session} now={now} contextAssessment={bot.contextAssessments[followedMarket.slug]} contextCheck={bot.contextChecks[followedMarket.slug]}/>:<p className="tennis-order-help">Pick a game below to watch it here.</p>}</div>
        {bot.watchedBookError&&(!followedMarket?.quoteObservedAt||Math.abs(now-followedMarket.quoteObservedAt)>5000)&&<p className="tennis-order-help" role="status">{bot.watchedBookError}</p>}
        {bot.watchedContextError&&<p className="tennis-order-help" role="status">Game report: {bot.watchedContextError}</p>}

        {session&&<EngineCard session={session} market={availableMarkets.find(m=>m.slug===session.config.focusSlug)} sweep={bot.runtime?.sweep??null} now={now}/>}
        <div className="tennis-runtime"><Clock3 size={13}/>{background?'Runs in the cloud, even with this page closed':migrating?'Moving to the cloud · entries paused':'Runs while this page is open'}{isPaused&&open.length>0?' · exits still checked':''}</div>
      </section>

      <RunnerSetup runtime={bot.runtime} flat={open.length===0&&!session?.pending} onComplete={bot.reloadAccount}/>
      <GamePicker markets={availableMarkets} selected={followedMarket?.slug??null} focused={session?.config.focusSlug??null} busy={bot.busy||!session||migrating} loading={catalog?.discovery?.complete===false} now={now} onSelect={setFollowed} onFocus={slug=>void setGameFocus(slug)}/>

      <section className="tennis-activity" aria-label="Paper balance history"><div className="tennis-activity-head"><h2>Balance</h2><span className="tennis-label">After fees</span></div><TennisPriceChart points={session?.equity??[]} currency/><div className="tennis-feed-note"><span>{closed.length} closed</span><span>{session?signed(pnl):'—'} since start</span></div></section>

      {(bot.feedError||catalog?.errors.length!==0&&catalog?.errors.length)&&<div className="tennis-error" role="alert"><TriangleAlert size={16}/><span>{bot.feedError||catalog?.errors.join(' ')}</span></div>}
      <details className="tennis-details tennis-main-details"><summary><strong>More</strong><span>History, markets, diagnostics</span></summary><div className="tennis-details-content">
        <section className="tennis-rule-summary" aria-label="Connection diagnostics"><b>Connection & checks</b><p>{bot.runtime?.description||'Connecting to the saved paper account.'}</p>{background&&<p className="tennis-order-help">Last successful check: {bot.runtime?.lastSuccessfulCheck?age(bot.runtime.lastSuccessfulCheck,now):'waiting'}. {bot.runtime?.usage&&`${bot.runtime.usage.estimatedRowsWritten.toLocaleString()} estimated storage writes today. Free limits can interrupt service.`}</p>}<small>{session?.evaluated??0} quote evaluations · Rules revision {session?.rulesRevision??0}</small></section>
      {session?.testRun&&<section className="tennis-run-progress" aria-label="Observation progress"><div><b>{session.testRun.complete?'Observation finished':`${Math.round((session.testRun.endsAt-session.testRun.startedAt)/60000)}-minute paper watch`}</b><span>{Math.floor(session.testRun.watchedMs/60000)}m {Math.floor(session.testRun.watchedMs/1000)%60}s checked · {session.testRun.liveSlugs.length} live matches observed</span></div><progress max={session.testRun.endsAt-session.testRun.startedAt} value={Math.min(session.testRun.endsAt-session.testRun.startedAt,Math.max(0,now-session.testRun.startedAt))}/><small>{session.testRun.complete?'New entries paused. Existing exits are still managed.':background?'The background runner continues with this page closed.':'Keep this page open and visible. Entries pause automatically when the window ends.'}</small></section>}
      <section className="tennis-activity" aria-label="Paper session results"><div className="tennis-activity-head"><div><h2>History</h2><a className="tennis-link tennis-history-export" href="/api/tennis/session?export=1" download>Download complete saved history</a><div className="tennis-subtabs" role="group" aria-label="Experiment view">{([{id:'decisions',label:'Bot activity'},{id:'trades',label:`Bot orders · ${session?.ledger.length??0}`}] as const).map(tab=><button key={tab.id} aria-pressed={activityTab===tab.id} onClick={()=>setActivityTab(tab.id)}>{tab.label}</button>)}</div></div><button className="tennis-link" onClick={()=>setShowAll(!showAll)}>{showAll?'Show less':'Show all'}</button></div>

      {activityTab==='decisions'&&<div className="tennis-rule-summary"><b>What is happening now</b><p>{reason}</p><small>{Object.values(session?.coverage??{}).filter(c=>c.live&&now-c.time<15000).length} live matches with recent usable quotes · Rules revision {session?.rulesRevision??0}</small></div>}{activityTab==='decisions'?unique.length?<div className="tennis-activity-list">{unique.map(decision=><div className="tennis-activity-row" key={decision.id}><span className={`tennis-action-badge ${decision.action==='BUY'?'is-buy':decision.action==='SELL'?'is-sell':''}`}>{decision.action}</span><div><strong>{labelFor(decision.slug,decision.side)}</strong><p>{decision.reason}</p></div><time>{time(decision.time)}</time></div>)}</div>:<div className="tennis-empty-activity">{isRunning?'No entry or exit has qualified yet. The current status above explains the wait.':'Start a paper run to see exactly what the bot accepts and skips.'}</div>:ledger.length?<div className="tennis-activity-list">{ledger.map(entry=><div className="tennis-activity-row" key={entry.id}><span className={`tennis-action-badge ${entry.action==='BUY'?'is-buy':'is-sell'}`}>{entry.action}</span><div><strong>{labelFor(entry.slug,entry.side)} · {signed(entry.cashDelta)} cash</strong><p>{entry.source==='MANUAL'?'Earlier activity':'Bot'} · {entry.execution?`${entry.execution.filledQty.toFixed(2)} contracts at ${cents(entry.execution.averagePrice)} · ${money(entry.execution.fees)} fees · ${entry.execution.status}`:'Settlement recorded'}{entry.action!=='BUY'?` · realized ${signed(entry.realizedPnl)}`:''}</p>{entry.quotedPrice!==undefined&&<p>Quoted {cents(entry.quotedPrice)} → filled {cents(entry.actualPrice??null)} · {((entry.executionDelayMs??0)/1000).toFixed(1)}s delay</p>}</div><time>{time(entry.time)}</time></div>)}</div>:<div className="tennis-empty-activity">No fills yet. The bot is waiting for a match and a setup that meet your rules.</div>}</section>
      <div className="tennis-feed-heading"><h2>{focus==='tennis'?'On the court':'Live game markets'}<span className="tennis-count">{catalog?`${markets.length} ${markets.length===1?'market':'markets'}`:'Loading matches'}</span></h2><div className="tennis-feed-tools"><div className="tennis-filter" role="group" aria-label="Filter league">{([{value:'ALL',label:'All selected'},{value:'ATP',label:'Men · ATP'},{value:'WTA',label:'Women · WTA'},{value:'NFL',label:'NFL'},{value:'CFB',label:'College'},{value:'MLB',label:'MLB'}] as const).filter(item=>item.value==='ALL'?VISIBLE_LEAGUES.length>1:VISIBLE_LEAGUES.includes(item.value)&&session?.config.leagues.includes(item.value)).map(item=><button key={item.value} aria-pressed={filter===item.value} onClick={()=>setFilter(item.value)}>{item.label}</button>)}</div><button className="tennis-refresh" aria-label="Refresh game markets" title="Refresh game markets" disabled={bot.refreshing} onClick={()=>void bot.refresh()}><RefreshCw size={16} className={bot.refreshing?'spin':''}/></button></div></div>



      <section className="tennis-market-grid" aria-label="Real game markets">{(bot.loading||bot.refreshing&&markets.length===0)?[0,1,2].map(index=><div className="tennis-loading-card" key={index}><LoaderCircle size={15} className="spin"/>Finding real game markets…</div>):markets.length?markets.map(market=><MarketCard market={market} session={session} now={now} key={market.slug} onOpen={()=>setSelected(market.slug)}/>):<div className="tennis-empty"><Radio size={30}/><h3>{feedUnavailable?'Game feed unavailable':'No open markets for the selected sports right now.'}</h3><p>{feedUnavailable?'The feed could not be loaded. Your paper account is saved; retry when the connection returns.':`Polymarket US has no ${filter==='ALL'?(session?.config.leagues.join(' or ')??'selected'):filter} markets in the current response. The bot will wait for real markets.`}</p><button className="tennis-secondary" disabled={bot.refreshing} onClick={()=>void bot.refresh()}><RefreshCw size={13}/>Check again</button></div>}</section>

      <div className="tennis-feed-note"><span>Live games only · listed-market coverage · rotating quote checks</span></div>



      <div className="tennis-rule-summary"><b>Your current rules</b><p>{session?describeTennisRules(session.config):'Loading saved rules…'}</p><button className="tennis-link" disabled={!session} onClick={()=>setSettingsOpen(true)}>Change bot rules</button></div>
      </div></details>



    </main>

    <footer className="tennis-footer"><span>Paper trading · fake money · no real orders</span></footer>

    <TennisMarketDialog key={selected??'none'} market={selectedMarket} session={session} now={now} onClose={()=>setSelected(null)} contextAssessment={selectedMarket?bot.contextAssessments[selectedMarket.slug]:undefined} contextCheck={selectedMarket?bot.contextChecks[selectedMarket.slug]:undefined}/>

    {settingsOpen&&session&&<TennisRulesDialog session={session} busy={bot.busy} error={bot.error} onClose={()=>setSettingsOpen(false)} onAction={bot.perform}/>}

    {advisorOpen&&<TennisAdvisor onClose={()=>setAdvisorOpen(false)}/>}

    <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="tennis-market-dialog"><DialogTitle className="tennis-dialog-title">Start with fake money.</DialogTitle><DialogDescription className="tennis-dialog-description">Choose $5–$1,000 for a new paper run. Reset starts a fresh run and archives the previous balance and history. Stop the bot and let it finish any exits first.</DialogDescription><div className="tennis-reset-form"><label htmlFor="tennis-reset-balance">Starting paper balance</label><input className="tennis-reset-input" id="tennis-reset-balance" type="number" min="5" max="1000" step="1" value={resetBalance} onChange={event=>setResetBalance(Number(event.target.value))}/><div className="tennis-amounts">{[5,10,100].map(value=><button key={value} aria-pressed={resetBalance===value} onClick={()=>setResetBalance(value)}>${value}</button>)}</div>{bot.error&&<div className="tennis-dialog-error" role="alert">{bot.error}</div>}<div className="tennis-reset-actions"><button className="tennis-secondary" onClick={()=>setResetOpen(false)}>Cancel</button><button className="tennis-primary" disabled={bot.busy||resetBalance<5||resetBalance>1000||!Number.isFinite(resetBalance)||open.length>0||!!session?.pending} onClick={()=>void reset()}>{bot.busy?'Resetting…':'Reset paper run'}</button></div></div></DialogContent></Dialog>

  </div>;

}
