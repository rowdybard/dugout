'use client';



import {tennisCommandId} from './command-id';

import {useEffect,useState} from 'react';

import Link from 'next/link';

import {Activity,Clock3,FlaskConical,LoaderCircle,Pause,Play,RefreshCw,RotateCcw,Square,TriangleAlert,X} from 'lucide-react';

import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';

import type {TennisLeague} from '@/lib/tennis/types';
import {VISIBLE_LEAGUES} from '@/lib/tennis/leagues';

import {useTennis} from './use-tennis';

import {TennisRulesDialog} from './rules-dialog';

import {TennisAdvisor} from './advisor';
import {TennisMatchChart} from './match-chart';
import {GameSearch} from './game-picker';
import {RunnerSetup} from './runner-setup';
import {FeedKey} from './feed-key';
import {DecisionCard} from './decision-card';
import {EngineCard} from './engine-card';
import {OpenBook,SellEverything} from './open-book';
import {accountValue} from '@/lib/tennis/open-book';
import {OctopusPanel,downloadOctopusLog,type OctopusRules} from './octopus-panel';
import {octopusSlugs} from '@/lib/tennis/octopus';
import {boldSize,choiceOf,modeRules,steadySize,tradeMode,type ModeChoice} from '@/lib/tennis/modes';

import {describeTennisRules,MAX_BALANCE} from '@/lib/tennis/rules';
import {focusedEntryRest} from '@/lib/tennis/entry-rest';
import {CHECK_STALE_MS} from '@/lib/tennis/decision-view';
import {localMoveUpgradeRules,startPaperBot} from '@/lib/tennis/start-control';

import {TennisPriceChart} from './price-chart';

import '@fontsource-variable/inter';
import './tennis.css';



const money=(value:number)=>`${value<0?'−':''}$${Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

const signed=(value:number)=>`${value>0?'+':''}${money(value)}`;

const cents=(value:number|null)=>value===null?'—':`${(value*100).toFixed(value*100%1<.01?0:1)}¢`;

const age=(time:number,now:number)=>time<=0?'not observed':now-time<10000?'just now':now-time<60000?`${Math.floor((now-time)/1000)}s ago`:`${Math.floor((now-time)/60000)}m ago`;

const time=(value:number)=>new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});



export function TennisDashboard() {

  const bot=useTennis();

  const {session,catalog,now}=bot;


  const [resetOpen,setResetOpen]=useState(false),[resetText,setResetText]=useState('100');

  const [showAll,setShowAll]=useState(false);

  const [advisorOpen,setAdvisorOpen]=useState(false);
  const [followed,setFollowed]=useState<string|null>(null);

  const [settingsOpen,setSettingsOpen]=useState(false);

  const entryBudget=session?.config.entryBudget??5;
  const leagues=session?.config.leagues??[];
  // The view shows only VISIBLE_LEAGUES; an account still set to watch other leagues gets one button to narrow it.
  const onlyVisible=leagues.length>0&&leagues.every(l=>VISIBLE_LEAGUES.includes(l));
  const chooseVisible=async()=>{
    if(!session)return;
    const leagues:TennisLeague[]=[...VISIBLE_LEAGUES];
    const keepFocus=catalog?.markets.find(m=>m.slug===session.config.focusSlug)?.league==='CFB';
    const ok=await bot.perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:tennisCommandId(),rules:{leagues,...(keepFocus?{}:{focusSlug:null})}});
    if(ok){setFollowed(null);void bot.refresh();}
  };

  const open=session?.positions.filter(position=>position.status==='open')??[];

  // One valuation for the balance, the holdings list and "Sell everything" (lib/tennis/open-book.ts accountValue).
  const valuation=session?accountValue(session,now):null;
  const liquidCash=valuation?.value??0,incompleteMark=!!valuation&&!valuation.complete,pnl=valuation?.pnl??0;

  const availableMarkets=[...new Map([...(catalog?.markets??[]).filter(m=>VISIBLE_LEAGUES.includes(m.league)),...open.map(p=>catalog?.markets.find(m=>m.slug===p.slug)??p.lastContext??p.market)].map(m=>[m.slug,m])).values()];

  const liveMarkets=availableMarkets.filter(m=>m.live&&!m.ended);
  const focusedMarket=availableMarkets.find(m=>m.slug===session?.config.focusSlug);
  const followedMarket=availableMarkets.find(m=>m.slug===followed)??focusedMarket??availableMarkets.find(m=>open.some(p=>p.slug===m.slug))??liveMarkets[0];
  const watchMarket=bot.watchMarket;
  useEffect(()=>{watchMarket(followedMarket?.slug??null);},[followedMarket?.slug,watchMarket]);

  const background=bot.runtime?.mode==='service';
  const migrating=bot.runtime?.mode==='migrating';
  const startBot=()=>startPaperBot(session,bot.runtime,bot.perform,tennisCommandId);

  const isRunning=session?.status==='running',isPaused=session?.status==='paused',isIdle=session?.status==='idle',isStopped=session?.status==='stopped';

  const tickStale=!!session&&(session.status==='running'||session.status==='stopping'||open.length>0||!!session.pending)&&now-(bot.runtime?.lastSuccessfulCheck??session.lastTickAt)>(background?CHECK_STALE_MS.service:CHECK_STALE_MS.browser);

  const restSeconds=focusedEntryRest(session,now);
  const status=!session?'Connecting':session.status==='stopping'?'Exiting position':isStopped?'Stopped':tickStale?'Bot is behind':isPaused?'Entries paused':session.pending?'Order pending':isRunning?(open.length?'Managing position':restSeconds!==null?'Resting before next entry':'Scanning'):'Ready';

  const reasonDecision=session?.decisions.findLast(d=>d.reason===session.lastReason);
  const reasonMarket=catalog?.markets.find(m=>m.slug===reasonDecision?.slug)??session?.positions.find(p=>p.slug===reasonDecision?.slug)?.market;
  const namedReason=reasonMarket&&reasonDecision?`${reasonDecision.side==='YES'?reasonMarket.yesName:reasonMarket.noName}: ${session?.lastReason}`:session?.lastReason;
  const reason=!session?'Loading your saved paper session…':!bot.visible&&!background?'Page is hidden. Live checks resume when you return.':tickStale?'The bot has not reported a check in a while. It normally checks every few seconds; if this lasts more than a minute, reload the page.':restSeconds!==null?`${focusedMarket?`${focusedMarket.yesName} vs. ${focusedMarket.noName}: `:''}Next entry check in ${restSeconds}s. The bot resumes automatically and still needs a qualifying setup.`:namedReason;

  const decisions=[...(session?.decisions??[])].reverse().filter(d=>showAll||!['WARMUP','CONFIRMATION','NO_DIP','NO_MOMENTUM'].includes(d.code));

  const seen=new Set<string>();

  const unique=decisions.filter(decision=>{const key=`${decision.slug}:${decision.side}:${decision.code}`;if(seen.has(key)&&['WAIT','SKIP'].includes(decision.action))return false;seen.add(key);return true;}).slice(0,showAll?60:6);

  const ledger=[...(session?.ledger??[])].reverse().slice(0,showAll?60:6);

  const labelFor=(slug:string,side:'YES'|'NO')=>{const market=catalog?.markets.find(item=>item.slug===slug)??session?.positions.find(position=>position.slug===slug)?.market;return market?(side==='YES'?market.yesName:market.noName):slug||'Paper session';};

  // Paper only: a reset with an open trade or order drops it along with the old run (fake money), so nobody gets stuck.
  const tradesOpen=open.length>0||!!session?.pending;
  // The balance field is text so it can be emptied and retyped; it is checked only when sent.
  const resetBalance=resetText.trim()===''?NaN:Number(resetText),resetValid=Number.isFinite(resetBalance)&&resetBalance>=5&&resetBalance<=MAX_BALANCE;
  const reset=async()=>{if(!resetValid)return;const ok=await bot.perform({action:'reset',bankroll:Math.round(resetBalance*100)/100,commandId:tennisCommandId(),...(tradesOpen?{abandon:true as const}:{})});if(ok)setResetOpen(false);};
  const openReset=()=>{setResetText(String(session?.config.startingCash??100));setResetOpen(true);};

  // Choosing a game points the bot at it (and narrows the account to college football). Shares held on the old game
  // stay managed there (sold or settled as before); new orders go to the new game.
  const chooseGame=async(slug:string)=>{
    setFollowed(slug);
    if(!session||session.config.focusSlug===slug)return;
    await bot.perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:tennisCommandId(),
      rules:{focusSlug:slug,...(onlyVisible?{}:{leagues:[...VISIBLE_LEAGUES]}),...(session.config.chaosSlugs?.includes(slug)?{chaosSlugs:session.config.chaosSlugs.filter(item=>item!==slug)}:{})}});
  };
  // Steady: small resting orders only. Bold: bigger orders plus hold-to-final bets. Auto: the bot picks (lib/tennis/modes.ts).
  // The tapped button lights up at once; the change is built from the latest saved rules when it is sent.
  const [modeTap,setModeTap]=useState<ModeChoice|null>(null);
  const shownMode=modeTap??(session?choiceOf(session.config):null);
  const setMode=async(mode:ModeChoice)=>{
    if(!session||modeTap)return;
    setModeTap(mode);
    try{await bot.perform(latest=>{
      if(!latest)return null;const rules=modeRules(latest.config,mode);
      if(choiceOf(latest.config)===mode&&rules.entryBudget===latest.config.entryBudget&&(rules.explore??[]).join()===(latest.config.explore??[]).join())return null;
      return {action:'update-rules',sessionId:latest.id,expectedRulesRevision:latest.rulesRevision??0,commandId:tennisCommandId(),rules};
    });}finally{setModeTap(null);}
  };
  // Octopus rule changes are built from the latest saved rules when sent (like the mode buttons).
  const setOctopus=(build:(config:NonNullable<typeof session>['config'])=>Partial<OctopusRules>)=>{if(session)void bot.perform(latest=>{
    if(!latest)return null;const rules=build(latest.config);if(!Object.keys(rules).length)return null;
    return {action:'update-rules',sessionId:latest.id,expectedRulesRevision:latest.rulesRevision??0,commandId:tennisCommandId(),rules};});};
  const arms=session?octopusSlugs(session).length:0;
  const botGame=focusedMarket??null;
  // "Still loading more games" is not a problem worth a banner; the search box says it is checking.
  const feedErrors=(catalog?.errors??[]).filter(error=>!/still loading/i.test(error));

  return <div className="tennis-app">

    <header className="tennis-header"><Link className="tennis-logo" href="/" aria-label="Dugout home"><span className="tennis-logo-mark"><Activity size={20}/></span>dugout<span className="tennis-logo-dot">.</span></Link><div className="tennis-header-actions"><span className="tennis-feed-indicator"><span className={`tennis-dot ${bot.streamStatus==='live'?'is-live':'is-waiting'}`}/>{bot.streamStatus==='live'?'Live':bot.streamStatus==='connecting'?'Connecting…':'Checking'}{catalog&&<span>· {age(catalog.updatedAt,now)}</span>}</span><span className="tennis-paper-pill"><FlaskConical size={12}/>PAPER</span></div></header>

    <main className="tennis-main tennis-simple">

      <h1 className="tennis-visually-hidden">Dugout paper bot</h1>
      {bot.error&&<div className="tennis-error" role="alert"><TriangleAlert size={16}/><span>{bot.error}</span><button aria-label="Dismiss error" onClick={bot.clearError}><X size={15}/></button></div>}
      {bot.connectionIssue&&<div className="tennis-error" role="status"><RefreshCw size={16}/><span>{bot.connectionIssue} Last check {session?age(session.lastTickAt,now):'connecting'}.</span></div>}
      {(bot.feedError||!!feedErrors.length)&&<div className="tennis-error" role="alert"><TriangleAlert size={16}/><span>{bot.feedError||feedErrors.join(' ')}</span></div>}

      {session&&!onlyVisible&&<div className="tennis-notice" role="status"><span>This account is still set to other sports.</span><button className="tennis-secondary" disabled={bot.busy||migrating||open.length>0||!!session.pending} onClick={()=>void chooseVisible()}>Show college football games</button></div>}
      <GameSearch markets={availableMarkets} current={botGame} focused={session?.config.focusSlug??null} busy={bot.busy||!session||migrating} loading={catalog?.discovery?.complete===false} now={now} onChoose={slug=>void chooseGame(slug)}/>

      <section className="tennis-bot" aria-label="Paper bot">
        <div className="tennis-bot-head">
          <div className="tennis-bot-game">
            <span className="tennis-label"><span className={`tennis-dot ${isRunning&&!tickStale?'is-live':'is-waiting'}`}/>{status}</span>
            <h2>{botGame?`${botGame.yesName} vs. ${botGame.noName}`:'Pick a game above'}</h2>
            <div className="tennis-mode-choice" role="group" aria-label="How the bot trades">
              <button aria-pressed={shownMode==='steady'} disabled={!session||!!modeTap} onClick={()=>void setMode('steady')}>Steady</button>
              <button aria-pressed={shownMode==='bold'} disabled={!session||!!modeTap} onClick={()=>void setMode('bold')}>Bold</button>
              <button aria-pressed={shownMode==='auto'} disabled={!session||!!modeTap||session.config.evidenceGate!=='evidence-v1'} onClick={()=>void setMode('auto')}>Auto</button>
              <span>{modeTap?'Saving…':shownMode==='steady'?`Small resting orders (${money(entryBudget)} each): many small wins and losses.`
                :shownMode==='auto'&&session?`${session.autoMode?`${tradeMode(session)==='bold'?'Bold':'Steady'} now: ${session.autoMode.reason}.`:'Steady until the first check.'} Auto picks Steady (${money(steadySize(session.config.startingCash))} orders) or Bold (${money(boldSize(session.config.startingCash))} orders, bets the research allows) on every check.`
                :`Bigger orders (${money(entryBudget)} each) plus hold-to-final bets the research allows: bigger wins, bigger losses.`}</span>
            </div>
          </div>
          <div className="tennis-bot-money">
            <span className="tennis-label">{incompleteMark?'Cash + priced exits':'Balance'}</span>
            <strong className="tennis-balance">{session?money(liquidCash):'—'}</strong>
            <span className={`tennis-pnl ${pnl<0?'tennis-negative':'tennis-positive'}`}>{session?`${signed(pnl)}${incompleteMark?` · ${valuation!.note}`:''}`:'Loading'}</span>
            <button className="tennis-link tennis-reset-link" disabled={!session||bot.busy||migrating} onClick={openReset}>Reset balance</button>
          </div>
        </div>

        <div className="tennis-controls">
          {/* Pause keeps the run (balance, trades, held positions); End run sells what is held and closes it; New run starts over. */}
          {isStopped?<button className="tennis-primary tennis-big" disabled={bot.busy||migrating} onClick={openReset}><RotateCcw size={16}/>New run</button>
            :session?.status==='stopping'?<button className="tennis-primary tennis-big is-stop" disabled><LoaderCircle size={17}/>Ending run…</button>
            :isRunning?<button className="tennis-primary tennis-big is-stop" disabled={bot.busy||migrating} onClick={()=>void bot.perform({action:'pause',commandId:tennisCommandId()})}>{bot.busy?<LoaderCircle size={17}/>:<Pause size={17}/>}Pause</button>
            :<button className="tennis-primary tennis-big" disabled={bot.busy||migrating||!session?.config.focusSlug||(isIdle&&(entryBudget<1||entryBudget>Math.min(100,(session?.config.startingCash??0)*.2)))} onClick={()=>void startBot()}>{bot.busy?<LoaderCircle size={17}/>:<Play size={17}/>}{bot.busy?'Starting…':isPaused?'Resume':'Start bot'}</button>}
          {(isRunning||isPaused)&&<button className="tennis-secondary" disabled={bot.busy||migrating} onClick={()=>void bot.perform({action:'stop',commandId:tennisCommandId()})}><Square size={13}/>End run</button>}
          {!session&&<button className="tennis-secondary" onClick={()=>void bot.reloadAccount()}><RefreshCw size={14}/>Reconnect</button>}
          {session&&!isIdle&&!isStopped&&<p className="tennis-order-help tennis-control-help"><b>Pause</b> stops new offers and bets; shares already held stay, and their exits still run. <b>End run</b> sells what is held at the best bids, then stops. {open.length>0&&<><b>Sell everything</b> sells all shares on the next fresh price check and pauses. </>}<b>Reset balance</b> starts a new run and drops open paper trades.</p>}
          <span className="tennis-runtime"><Clock3 size={13}/>{background?'Keeps running with this page closed':migrating?'Moving to the cloud · entries paused':'Runs while this page is open'}{isPaused&&open.length>0?' · exits still managed':''}</span>
        </div>

        {session&&<details className="tennis-chaos-details" open={arms>0||!!session.config.octopusAuto}><summary>Octopus <span className="tennis-tag tennis-experimental">Experimental</span> · {arms?`${arms} arm${arms>1?'s':''}`:session.config.octopusAuto?'looking for games':'off'}</summary>
          <OctopusPanel session={session} markets={availableMarkets} busy={bot.busy||migrating} now={now} onChange={setOctopus}/></details>}
        {session?<DecisionCard session={session} market={availableMarkets.find(m=>m.slug===(open[0]?.slug??session.config.focusSlug))} runtime={bot.runtime} now={now}/>:<p className="tennis-reason" role="status">{reason}</p>}
        {session&&<SellEverything session={session} markets={availableMarkets} now={now} busy={bot.busy||migrating} onSell={()=>void bot.perform({action:'exit-now',commandId:tennisCommandId()})}/>}
        {session&&<OpenBook session={session} markets={availableMarkets} now={now}/>}
      </section>

      <section className="tennis-tracker" aria-label="Game tracker">
        {followedMarket?<TennisMatchChart key={followedMarket.slug} market={followedMarket} session={session} now={now} contextAssessment={bot.contextAssessments[followedMarket.slug]} contextCheck={bot.contextChecks[followedMarket.slug]}/>:<p className="tennis-order-help">Pick a game to follow it here.</p>}
        {followedMarket&&botGame&&followedMarket.slug!==botGame.slug&&<p className="tennis-order-help">Following {followedMarket.yesName} vs. {followedMarket.noName}; the bot is on {botGame.yesName} vs. {botGame.noName}.</p>}
        {bot.watchedBookError&&(!followedMarket?.quoteObservedAt||Math.abs(now-followedMarket.quoteObservedAt)>5000)&&<p className="tennis-order-help" role="status">{bot.watchedBookError}</p>}
        {bot.watchedContextError&&<p className="tennis-order-help" role="status">Game report: {bot.watchedContextError}</p>}
      </section>

      <section className="tennis-activity" aria-label="Trades and balance">
        <div className="tennis-activity-head"><h2>Trades &amp; balance</h2><span className="tennis-label">{session?`${signed(pnl)} since start · after fees`:''}</span></div>
        <TennisPriceChart points={session?.equity??[]} currency/>
        {ledger.length?<div className="tennis-activity-list">{ledger.map(entry=><div className="tennis-activity-row" key={entry.id}><span className={`tennis-action-badge ${entry.action==='BUY'?'is-buy':'is-sell'}`}>{entry.action}</span><div><strong>{labelFor(entry.slug,entry.side)} · {signed(entry.cashDelta)}</strong><p>{entry.execution?`${entry.execution.filledQty.toFixed(2)} at ${cents(entry.execution.averagePrice)} · ${money(entry.execution.fees)} fees`:'Settled'}{entry.action!=='BUY'?` · result ${signed(entry.realizedPnl)}`:''}</p></div><time>{time(entry.time)}</time></div>)}</div>
          :<div className="tennis-empty-activity">{isRunning?'No fills yet. Resting orders fill when someone trades into them.':'No trades yet. Pick a game and press Start bot.'}</div>}
        {(session?.ledger.length??0)>6&&<button className="tennis-link" onClick={()=>setShowAll(!showAll)}>{showAll?'Show fewer':`Show all ${session?.ledger.length}`}</button>}
      </section>

      <details className="tennis-details tennis-main-details"><summary><strong>Settings &amp; history</strong><span>Rules, reset, engine, diagnostics</span></summary><div className="tennis-details-content">
        <div className="tennis-controls">
          <button className="tennis-secondary" disabled={!session} onClick={()=>setSettingsOpen(true)}>Rules</button>
          {bot.advisorEnabled&&<button className="tennis-secondary" onClick={()=>setAdvisorOpen(true)}>Ask Claude</button>}
          {session&&!onlyVisible&&<button className="tennis-secondary" disabled={bot.busy} onClick={()=>void chooseVisible()}>Watch college football only</button>}
          {session&&session.config.decisionEngine!=='local-move-v1'&&<button className="tennis-secondary" disabled={bot.busy} onClick={()=>void bot.perform({action:'update-rules',rules:localMoveUpgradeRules(session.config),expectedRulesRevision:session.rulesRevision??0,sessionId:session.id,commandId:tennisCommandId()})}>Use decision engine</button>}
        </div>
        {session&&<EngineCard session={session} market={availableMarkets.find(m=>m.slug===session.config.focusSlug)} sweep={bot.runtime?.sweep??null} now={now}/>}
        <RunnerSetup runtime={bot.runtime} flat={open.length===0&&!session?.pending} onComplete={bot.reloadAccount}/>
        <FeedKey runtime={bot.runtime} onChange={bot.reloadAccount}/>
        <section className="tennis-rule-summary" aria-label="Connection diagnostics"><b>Connection &amp; checks</b><p>{bot.runtime?.description||'Connecting to the saved paper account.'}</p>{background&&<p className="tennis-order-help">Last successful check: {bot.runtime?.lastSuccessfulCheck?age(bot.runtime.lastSuccessfulCheck,now):'waiting'}. {bot.runtime?.usage&&`${bot.runtime.usage.estimatedRowsWritten.toLocaleString()} estimated storage writes today.`}</p>}<small>{session?.evaluated??0} price checks · Rules revision {session?.rulesRevision??0} · Entry {session?money(isIdle?entryBudget:session.config.entryBudget):'—'} · Cash {session?money(session.cash):'—'}</small></section>
        {session?.testRun&&<section className="tennis-run-progress" aria-label="Observation progress"><div><b>{session.testRun.complete?'Observation finished':`${Math.round((session.testRun.endsAt-session.testRun.startedAt)/60000)}-minute paper watch`}</b><span>{Math.floor(session.testRun.watchedMs/60000)}m {Math.floor(session.testRun.watchedMs/1000)%60}s checked</span></div><progress max={session.testRun.endsAt-session.testRun.startedAt} value={Math.min(session.testRun.endsAt-session.testRun.startedAt,Math.max(0,now-session.testRun.startedAt))}/></section>}
        <section className="tennis-activity" aria-label="Bot activity"><div className="tennis-activity-head"><h2>Bot activity</h2><a className="tennis-link tennis-history-export" href="/api/tennis/session?export=1" download>Download complete saved history</a>{session&&<button className="tennis-link" onClick={()=>downloadOctopusLog(session)}>Download Octopus log</button>}</div>
          <div className="tennis-rule-summary"><b>What is happening now</b><p>{reason}</p></div>
          {unique.length?<div className="tennis-activity-list">{unique.map(decision=><div className="tennis-activity-row" key={decision.id}><span className={`tennis-action-badge ${decision.action==='BUY'?'is-buy':decision.action==='SELL'?'is-sell':''}`}>{decision.action}</span><div><strong>{labelFor(decision.slug,decision.side)}</strong><p>{decision.reason}</p></div><time>{time(decision.time)}</time></div>)}</div>:<div className="tennis-empty-activity">Nothing yet.</div>}</section>
        <div className="tennis-rule-summary"><b>Your current rules</b><p>{session?describeTennisRules(session.config):'Loading saved rules…'}</p></div>
      </div></details>

    </main>

    <footer className="tennis-footer"><span>Paper trading · fake money · no real orders</span></footer>

    {settingsOpen&&session&&<TennisRulesDialog session={session} busy={bot.busy} error={bot.error} onClose={()=>setSettingsOpen(false)} onAction={bot.perform}/>}

    {advisorOpen&&<TennisAdvisor onClose={()=>setAdvisorOpen(false)}/>}

    <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="tennis-market-dialog"><DialogTitle className="tennis-dialog-title">Reset your balance.</DialogTitle><DialogDescription className="tennis-dialog-description">Starts a fresh paper run with the amount you choose, up to $10,000. The bot stops, and your Steady, Bold or Auto choice is kept.{tradesOpen?' Your open paper trade is dropped with the old run. It is fake money, so nothing is lost.':''}</DialogDescription><div className="tennis-reset-form"><label htmlFor="tennis-reset-balance">Starting paper balance</label><input className="tennis-reset-input" id="tennis-reset-balance" type="text" inputMode="decimal" autoComplete="off" placeholder="100" value={resetText} onChange={event=>setResetText(event.target.value.replace(/[^0-9.]/g,''))} onKeyDown={event=>{if(event.key==='Enter')void reset();}}/><div className="tennis-amounts">{[100,1000,10000].map(value=><button key={value} aria-pressed={resetBalance===value} onClick={()=>setResetText(String(value))}>${value.toLocaleString()}</button>)}</div>{resetText.trim()!==''&&!resetValid&&<p className="tennis-order-help" role="status">Choose $5 to ${MAX_BALANCE.toLocaleString()}.</p>}{bot.error&&<div className="tennis-dialog-error" role="alert">{bot.error}</div>}<div className="tennis-reset-actions"><button className="tennis-secondary" onClick={()=>setResetOpen(false)}>Cancel</button><button className="tennis-primary" disabled={bot.busy||!resetValid} onClick={()=>void reset()}>{bot.busy?'Resetting…':tradesOpen?'Drop the trade and reset':'Reset balance'}</button></div></div></DialogContent></Dialog>

  </div>;

}
