'use client';



import {tennisCommandId} from './command-id';

import {useEffect,useState} from 'react';

import Link from 'next/link';

import {Activity,Clock3,FlaskConical,LoaderCircle,Pause,Play,RefreshCw,Square,TriangleAlert,X} from 'lucide-react';

import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';

import type {BotId,TennisLeague} from '@/lib/tennis/types';

import {VISIBLE_LEAGUES} from '@/lib/tennis/leagues';

import {useTennis} from './use-tennis';

import {TennisRulesDialog} from './rules-dialog';

import {TennisAdvisor} from './advisor';

import {TennisMatchChart} from './match-chart';

import {GameSearch} from './game-picker';

import {RunnerSetup} from './runner-setup';

import {FeedKey} from './feed-key';

import {supportsBot,tennisBetOptions,tennisStrategyRules,walletHasOrders} from './bot-controls';

import {DecisionCard} from './decision-card';

import {EngineCard} from './engine-card';

import {OpenBook,SellEverything} from './open-book';
import {ActivityList} from './activity-list';

import {OctopusPanel,downloadOctopusLog,type OctopusRules} from './octopus-panel';

import {octopusSlugs} from '@/lib/tennis/octopus';

import {boldSize,choiceOf,modeRules,steadySize,tradeMode,type ModeChoice} from '@/lib/tennis/modes';

import {describeTennisRules,MAX_BALANCE} from '@/lib/tennis/rules';

import {focusedEntryRest} from '@/lib/tennis/entry-rest';

import {CHECK_STALE_MS,decisionView} from '@/lib/tennis/decision-view';

import {localMoveUpgradeRules,startPaperBot} from '@/lib/tennis/start-control';

import {canAcknowledgeLoss,lossAllowance,lossFloor,lossLimitReached} from '@/lib/tennis/loss-limit';

import {TennisPriceChart} from './price-chart';

import '@fontsource-variable/inter';

import './tennis.css';



const money=(value:number)=>`${value<0?'−':''}$${Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

const signed=(value:number)=>`${value>0?'+':''}${money(value)}`;

const cents=(value:number|null)=>value===null?'—':`${(value*100).toFixed(value*100%1<.01?0:1)}¢`;

const age=(time:number,now:number)=>time<=0?'not observed':now-time<10000?'just now':now-time<60000?`${Math.floor((now-time)/1000)}s ago`:`${Math.floor((now-time)/60000)}m ago`;

const time=(value:number)=>new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});



export function TennisDashboard({botId='football',onBotChange}:{botId?:BotId;onBotChange?:(botId:BotId)=>void}) {

  const bot=useTennis(botId);

  const {session,account,catalog,now}=bot;

  const tennis=botId==='tennis';

  const visibleLeagues:TennisLeague[]=tennis?['ATP','WTA']:[...VISIBLE_LEAGUES];

  const controlsSupported=supportsBot(bot.runtime,botId);

  const controlsBusy=bot.busy||!controlsSupported;



  const [resetOpen,setResetOpen]=useState(false),[resetText,setResetText]=useState('100');

  const [showAll,setShowAll]=useState(false);
  const [showAllActivity,setShowAllActivity]=useState(false);

  const [advisorOpen,setAdvisorOpen]=useState(false);

  const [followed,setFollowed]=useState<string|null>(null);

  const [settingsOpen,setSettingsOpen]=useState(false);

  const entryBudget=session?.config.entryBudget??(tennis?10:5);

  const betOptions=tennisBetOptions(session?.config.startingCash??100);

  const leagues=session?.config.leagues??[];

  // The view shows only VISIBLE_LEAGUES; an account still set to watch other leagues gets one button to narrow it.

  const onlyVisible=leagues.length>0&&leagues.every(l=>visibleLeagues.includes(l));

  const chooseVisible=async()=>{

    if(!session)return;

    const leagues:TennisLeague[]=[...visibleLeagues];

    const keepFocus=catalog?.markets.find(m=>m.slug===session.config.focusSlug)?.league;

    const focusIsVisible=!!keepFocus&&visibleLeagues.includes(keepFocus);

    const ok=await bot.perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:tennisCommandId(),rules:{leagues,...(focusIsVisible?{}:{focusSlug:null})}});

    if(ok){setFollowed(null);void bot.refresh();}

  };

  const open=session?.positions.filter(position=>position.status==='open')??[];

  const allOpen=account?.positions.filter(position=>position.status==='open')??[];

  const liquidCash=(account?.cash??0)+allOpen.reduce((sum,position)=>sum+(position.netLiquidationValue??0),0);

  const incompleteMark=allOpen.some(position=>position.netLiquidationValue===null||position.liquidationQuantity+1e-7<position.quantity||!position.markedAt||now-position.markedAt>15000);

  const pnl=account?liquidCash-account.config.startingCash:0;

  const availableMarkets=[...new Map([...(catalog?.markets??[]).filter(m=>visibleLeagues.includes(m.league)),...open.map(p=>catalog?.markets.find(m=>m.slug===p.slug)??p.lastContext??p.market)].map(m=>[m.slug,m])).values()];

  const walletMarkets=[...new Map([...(catalog?.markets??[]),...allOpen.map(p=>p.lastContext??p.market)].map(m=>[m.slug,m])).values()];

  const liveMarkets=availableMarkets.filter(m=>m.live&&!m.ended);

  const focusedMarket=availableMarkets.find(m=>m.slug===session?.config.focusSlug);

  const followedMarket=availableMarkets.find(m=>m.slug===followed)??focusedMarket??availableMarkets.find(m=>open.some(p=>p.slug===m.slug))??liveMarkets[0];

  const watchMarket=bot.watchMarket;

  useEffect(()=>{watchMarket(followedMarket?.slug??null);},[followedMarket?.slug,watchMarket]);

  const background=bot.runtime?.mode==='service';

  const migrating=bot.runtime?.mode==='migrating';

  const startBot=()=>tennis||session?.status==='stopped'?bot.perform(latest=>!latest||!latest.config.focusSlug?null:{action:latest.status==='paused'?'resume':'start',commandId:tennisCommandId(),...(background?{}:{runForMs:tennis?1_800_000:10_800_000})}):startPaperBot(session,bot.runtime,bot.perform,tennisCommandId);

  const isRunning=session?.status==='running',isPaused=session?.status==='paused',isIdle=session?.status==='idle',isStopped=session?.status==='stopped';

  const walletFlat=!!account&&!allOpen.length&&!walletHasOrders(account);

  const lossStopped=!!session&&!!account&&isStopped&&(account.accountLossStops?account.accountLossStops.includes(botId):lossLimitReached(account,account.cash));

  const acknowledgeReady=!!session&&!!account&&lossStopped&&walletFlat&&canAcknowledgeLoss({...account,status:session.status});

  const acknowledgeLoss=()=>{

    // Consent belongs to the loss period shown when clicked, even if a queued check loads a newer period.

    const shownSessionId=session?.id,expectedLossAcknowledgement=session?.lossCheckpoint?.commandId??null;

    return bot.perform((latest,latestAccount)=>{

      if(!latest||!latestAccount||latest.id!==shownSessionId||walletHasOrders(latestAccount)||!canAcknowledgeLoss({...latestAccount,status:latest.status})||!latest.config.focusSlug||migrating)return null;

      const runForMs=latest.config.leagues.some(league=>league==='NFL'||league==='CFB'||league==='MLB')?10_800_000:1_800_000;

      return {action:'acknowledge-loss',sessionId:latest.id,commandId:tennisCommandId(),expectedLossAcknowledgement,...(background?{}:{runForMs})};

    });

  };

  const tickStale=!!session&&(session.status==='running'||session.status==='stopping'||open.length>0||!!session.pending)&&now-(bot.runtime?.lastSuccessfulCheck??session.lastTickAt)>(background?CHECK_STALE_MS.service:CHECK_STALE_MS.browser);

  const restSeconds=focusedEntryRest(session,now);

  const status=!session?'Connecting':session.status==='stopping'?'Exiting position':lossStopped?'Loss limit hit':isStopped?'Stopped':tickStale?'Bot is behind':isPaused?'Entries paused':session.pending?'Order pending':isRunning?(open.length?'Managing position':restSeconds!==null?'Resting before next entry':'Scanning'):'Ready';

  const reasonDecision=session?.decisions.findLast(d=>d.reason===session.lastReason);

  const reasonMarket=catalog?.markets.find(m=>m.slug===reasonDecision?.slug)??session?.positions.find(p=>p.slug===reasonDecision?.slug)?.market;

  const namedReason=reasonMarket&&reasonDecision?`${reasonDecision.side==='YES'?reasonMarket.yesName:reasonMarket.noName}: ${session?.lastReason}`:session?.lastReason;

  const reason=!session?'Loading your saved paper session…':!bot.visible&&!background?'Page is hidden. Live checks resume when you return.':tickStale?'The bot has not reported a check in a while. It normally checks every few seconds; if this lasts more than a minute, reload the page.':restSeconds!==null?`${focusedMarket?`${focusedMarket.yesName} vs. ${focusedMarket.noName}: `:''}Next entry check in ${restSeconds}s. The bot resumes automatically and still needs a qualifying setup.`:namedReason;

  const decisions=[...(session?.decisions??[])].reverse().filter(d=>showAllActivity||!['WARMUP','CONFIRMATION','NO_DIP','NO_MOMENTUM'].includes(d.code));

  const seen=new Set<string>();

  const unique=decisions.filter(decision=>{const key=`${decision.slug}:${decision.side}:${decision.code}`;if(seen.has(key)&&['WAIT','SKIP'].includes(decision.action))return false;seen.add(key);return true;}).slice(0,showAllActivity?60:6);

  const ledger=[...(account?.ledger??[])].reverse().slice(0,showAll?60:6);

  const labelFor=(slug:string,side:'YES'|'NO')=>{const market=catalog?.markets.find(item=>item.slug===slug)??account?.positions.find(position=>position.slug===slug)?.market;return market?(side==='YES'?market.yesName:market.noName):slug||'Paper session';};

  // Paper only: a reset with an open trade or order drops it along with the old run (fake money), so nobody gets stuck.

  const tradesOpen=allOpen.length>0||!!account&&walletHasOrders(account);

  // The balance field is text so it can be emptied and retyped; it is checked only when sent.

  const resetBalance=resetText.trim()===''?NaN:Number(resetText),resetValid=Number.isFinite(resetBalance)&&resetBalance>=5&&resetBalance<=MAX_BALANCE;

  const reset=async()=>{if(!resetValid)return;const ok=await bot.perform({action:'reset',bankroll:Math.round(resetBalance*100)/100,commandId:tennisCommandId(),...(tradesOpen?{abandon:true as const}:{})});if(ok)setResetOpen(false);};

  const openReset=()=>{setResetText(String(account?.config.startingCash??100));setResetOpen(true);};

  // Choosing a game points the bot at it (and narrows the account to college football). Shares held on the old game

  // stay managed there (sold or settled as before); new orders go to the new game.

  const chooseGame=async(slug:string)=>{

    setFollowed(slug);

    if(!session||session.config.focusSlug===slug)return;

    await bot.perform({action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:tennisCommandId(),

      rules:{focusSlug:slug,...(onlyVisible?{}:{leagues:[...visibleLeagues]}),...(session.config.chaosSlugs?.includes(slug)?{chaosSlugs:session.config.chaosSlugs.filter(item=>item!==slug)}:{})}});

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

  const [strategyTap,setStrategyTap]=useState<'auto'|'recovery'|'momentum'|null>(null);

  const shownStrategy=strategyTap??session?.config.tennisStrategy??session?.config.strategy??'auto';

  const setStrategy=async(strategy:'auto'|'recovery'|'momentum')=>{

    if(!session||strategyTap||!controlsSupported)return;

    setStrategyTap(strategy);

    try{await bot.perform(latest=>{
      if(!latest)return null;
      const rules=tennisStrategyRules(strategy);
      if(latest.config.tennisStrategy===strategy&&latest.config.tennisTradeStyle===rules.tennisTradeStyle)return null;
      return {action:'update-rules',sessionId:latest.id,expectedRulesRevision:latest.rulesRevision??0,commandId:tennisCommandId(),rules};
    });}finally{setStrategyTap(null);}

  };

  const setTennisBet=(budget:number)=>{if(session)void bot.perform(latest=>!latest||latest.config.entryBudget===budget?null:{action:'update-rules',sessionId:latest.id,expectedRulesRevision:latest.rulesRevision??0,commandId:tennisCommandId(),rules:{entryBudget:budget}});};

  // Octopus rule changes are built from the latest saved rules when sent (like the mode buttons).

  const setOctopus=(build:(config:NonNullable<typeof session>['config'])=>Partial<OctopusRules>)=>{if(session)void bot.perform(latest=>{

    if(!latest)return null;const rules=build(latest.config);if(!Object.keys(rules).length)return null;

    return {action:'update-rules',sessionId:latest.id,expectedRulesRevision:latest.rulesRevision??0,commandId:tennisCommandId(),rules};});};

  const arms=session?octopusSlugs(session).length:0;

  const botGame=focusedMarket??null;
  const decisionFocus=session?decisionView(session,botGame??undefined,bot.runtime,now).focus:null;
  const decisionMarket=availableMarkets.find(m=>m.slug===decisionFocus);
  const decisionActive=!!session&&(session.status==='running'||session.status==='stopping'||open.length>0||!!session.pending);

  // "Still loading more games" is not a problem worth a banner; the search box says it is checking.

  const feedErrors=(catalog?.errors??[]).filter(error=>!/still loading/i.test(error));

  return <div className="tennis-app">

    <header className="tennis-header"><Link className="tennis-logo" href="/" aria-label="Dugout home"><span className="tennis-logo-mark"><Activity size={20}/></span>dugout<span className="tennis-logo-dot">.</span></Link><div className="tennis-header-actions"><span className="tennis-feed-indicator"><span className={`tennis-dot ${bot.streamStatus==='live'?'is-live':'is-waiting'}`}/>{bot.streamStatus==='live'?'Live':bot.streamStatus==='connecting'?'Connecting…':'Checking'}{catalog&&<span>· {age(catalog.updatedAt,now)}</span>}</span><span className="tennis-paper-pill"><FlaskConical size={12}/>PAPER</span></div></header>

    <nav className="tennis-bot-tabs" role="tablist" aria-label="Sports bots">{(['football','tennis'] as const).map(id=><button key={id} id={`bot-tab-${id}`} role="tab" aria-selected={id===botId} aria-controls={`bot-panel-${id}`} onClick={()=>onBotChange?.(id)}>{id==='football'?'Football':'Tennis'}<span>{id==='football'?'College football':'ATP · WTA'}</span></button>)}</nav>

    <main className="tennis-main tennis-simple" id={`bot-panel-${botId}`} role="tabpanel" aria-labelledby={`bot-tab-${botId}`}>

      <h1 className="tennis-visually-hidden">Dugout {tennis?'tennis':'football'} paper bot</h1>

      {bot.error&&<div className="tennis-error" role="alert"><TriangleAlert size={16}/><span>{bot.error}</span><button aria-label="Dismiss error" onClick={bot.clearError}><X size={15}/></button></div>}

      {bot.connectionIssue&&<div className="tennis-error" role="status"><RefreshCw size={16}/><span>{bot.connectionIssue} Last check {session?age(session.lastTickAt,now):'connecting'}.</span></div>}

      {(bot.feedError||!!feedErrors.length)&&<div className="tennis-error" role="alert"><TriangleAlert size={16}/><span>{bot.feedError||feedErrors.join(' ')}</span></div>}

      {session&&!onlyVisible&&<div className="tennis-notice" role="status"><span>This bot is still set to other sports.</span><button className="tennis-secondary" disabled={controlsBusy||migrating||open.length>0||!!session.pending} onClick={()=>void chooseVisible()}>{tennis?'Show tennis matches':'Show college football games'}</button></div>}

      {tennis&&session&&!controlsSupported&&<div className="tennis-notice" role="status">The cloud runner is being updated for Tennis. Your shared wallet is available; Tennis controls will unlock when it is ready.</div>}

      <GameSearch markets={availableMarkets} current={botGame} focused={session?.config.focusSlug??null} busy={controlsBusy||!session||migrating} label={tennis?'Search a tennis match':'Search a college football game'} emptyLabel={tennis?'No live or upcoming ATP or WTA matches right now.':undefined} loading={catalog?.discovery?.complete===false} now={now} onChoose={slug=>void chooseGame(slug)}/>

      <section className="tennis-bot" aria-label="Paper bot">

        <div className="tennis-bot-head">

          <div className="tennis-bot-game">

            <span className="tennis-label"><span className={`tennis-dot ${isRunning&&!tickStale?'is-live':'is-waiting'}`}/>{status}</span>

            <h2>{botGame?`${botGame.yesName} vs. ${botGame.noName}`:'Pick a game above'}</h2>

            {tennis?<div className="tennis-mode-choice" role="group" aria-label="Tennis strategy">

              {(['auto','recovery','momentum'] as const).map(strategy=><button key={strategy} aria-pressed={shownStrategy===strategy} disabled={!session||!!strategyTap||controlsBusy} onClick={()=>void setStrategy(strategy)}>{strategy==='auto'?'Auto':strategy==='recovery'?'Recovery':'Momentum'}</button>)}

              <span>{strategyTap?'Saving…':shownStrategy==='auto'?(session?.config.tennisTradeStyle==='adaptive-v2'?'Auto follows confirmed moves, protects gains on a reversal, and can add once at a lower price.': 'This run uses the original quick-trade Auto. Tap Auto to use adaptive entries and exits.') :shownStrategy==='recovery'?'Recovery waits for a drop and a confirmed rebound.':'Momentum waits for a confirmed rise.'} Paper experiments; no measured tennis edge yet.</span>

            </div>:<div className="tennis-mode-choice" role="group" aria-label="How the bot trades">

              <button aria-pressed={shownMode==='steady'} disabled={!session||!!modeTap||controlsBusy} onClick={()=>void setMode('steady')}>Steady</button>

              <button aria-pressed={shownMode==='bold'} disabled={!session||!!modeTap||controlsBusy} onClick={()=>void setMode('bold')}>Bold</button>

              <button aria-pressed={shownMode==='auto'} disabled={!session||!!modeTap||controlsBusy||session.config.evidenceGate!=='evidence-v1'} onClick={()=>void setMode('auto')}>Auto</button>

              <span>{modeTap?'Saving…':shownMode==='steady'?`Small resting orders (${money(entryBudget)} each): many small wins and losses.`

                :shownMode==='auto'&&session?`${session.autoMode?`${tradeMode(session)==='bold'?'Bold':'Steady'} now: ${session.autoMode.reason}.`:'Steady until the first check.'} Auto picks Steady (${money(steadySize(session.config.startingCash))} orders) or Bold (${money(boldSize(session.config.startingCash))} orders, bets the research allows) on every check.`

                :`Bigger orders (${money(entryBudget)} each) plus hold-to-final bets the research allows: bigger wins, bigger losses.`}</span>

            </div>}

            {tennis&&<div className="tennis-mode-choice" role="group" aria-label="Tennis bet size">
              {betOptions.map(option=><button key={option.label} aria-pressed={entryBudget===option.budget} disabled={!session||controlsBusy||migrating} onClick={()=>setTennisBet(option.budget)}>{option.label} {money(option.budget)}</button>)}
              <span>Up to {money(entryBudget)} per new bet, including fees. Default targets 10% of the starting balance, within the per-bet limits.</span>
              {session?.config.tennisTradeStyle==='adaptive-v2'&&<span>Auto tries to exit near {money(entryBudget*session.config.stopReturn)} loss on the initial bet. An extra buy does not move that stop.</span>}
            </div>}

          </div>

          <div className="tennis-bot-money">

            <span className="tennis-label">{incompleteMark?'Shared cash + priced exits':'Shared balance'}</span>

            <strong className="tennis-balance">{account?money(liquidCash):'—'}</strong>

            <span className={`tennis-pnl ${pnl<0?'tennis-negative':'tennis-positive'}`}>{account?`${signed(pnl)}${incompleteMark?' · partly unpriced':''}`:'Loading'}</span>

            <button className="tennis-link tennis-reset-link" disabled={!account||controlsBusy||migrating} onClick={openReset}>Reset balance</button>

          </div>

        </div>

        <div className="tennis-controls">

          {/* Shared loss consent resumes this bot; ordinary stops preserve the wallet. */}

          {acknowledgeReady?<button className="tennis-primary tennis-big" disabled={controlsBusy||migrating||!session?.config.focusSlug} onClick={()=>void acknowledgeLoss()}>{bot.busy?<LoaderCircle size={17}/>:<Play size={17}/>}<span>{bot.busy?'Resuming…':'Acknowledge loss and resume'}</span></button>

            :lossStopped?<button className="tennis-primary tennis-big" disabled><Square size={16}/>Loss limit hit</button>

            :session?.status==='stopping'?<button className="tennis-primary tennis-big is-stop" disabled><LoaderCircle size={17}/>Ending run…</button>

            :isRunning?<button className="tennis-primary tennis-big is-stop" disabled={controlsBusy||migrating} onClick={()=>void bot.perform({action:'pause',commandId:tennisCommandId()})}>{bot.busy?<LoaderCircle size={17}/>:<Pause size={17}/>}Pause</button>

            :<button className="tennis-primary tennis-big" disabled={controlsBusy||migrating||!session?.config.focusSlug||((isIdle||isStopped)&&(entryBudget<1||entryBudget>Math.min(100,(session?.config.startingCash??0)*.2)))} onClick={()=>void startBot()}>{bot.busy?<LoaderCircle size={17}/>:<Play size={17}/>}{bot.busy?'Starting…':isPaused?'Resume':'Start bot'}</button>}

          {(isRunning||isPaused)&&<button className="tennis-secondary" disabled={controlsBusy||migrating} onClick={()=>void bot.perform({action:'stop',commandId:tennisCommandId()})}><Square size={13}/>End run</button>}

          {!session&&<button className="tennis-secondary" onClick={()=>void bot.reloadAccount()}><RefreshCw size={14}/>Reconnect</button>}

          <span className="tennis-runtime"><Clock3 size={13}/>{background?'Keeps running with this page closed':migrating?'Moving to the cloud · entries paused':'Runs while this page is open'}{isPaused&&open.length>0?' · exits still managed':''}</span>

        </div>

        {acknowledgeReady&&session&&<p className="tennis-order-help" role="status">Keep this run, balance and history. Acknowledging allows another {money(lossAllowance(session))} of loss{session.cash>=lossAllowance(session)?`, with the next stop at ${money(session.cash-lossAllowance(session))}`:''}.{!session.config.focusSlug?' Choose a game before resuming.':''}</p>}

        {lossStopped&&!walletFlat&&<p className="tennis-order-help" role="status">Both bots share this loss stop. Existing exits must finish before the loss can be acknowledged.</p>}

        {session?.lossCheckpoint&&!isStopped&&<p className="tennis-order-help">Loss acknowledged at {time(session.lossCheckpoint.acknowledgedAt)} · {money(lossAllowance(session))} allowance{lossFloor(session)>=0?` · next balance threshold ${money(lossFloor(session))}`:''}. Profit/loss above still covers the whole run.</p>}

        {session&&!tennis&&<details className="tennis-chaos-details" open={arms>0||!!session.config.octopusAuto}><summary>Octopus <span className="tennis-tag tennis-experimental">Experimental</span> · {arms?`${arms} arm${arms>1?'s':''}`:session.config.octopusAuto?'looking for games':'off'}</summary>

          <OctopusPanel session={session} markets={availableMarkets} busy={controlsBusy||migrating} now={now} onChange={setOctopus}/></details>}

        {session?<DecisionCard session={session} market={decisionMarket} runtime={bot.runtime} now={now} contextAssessment={decisionFocus?bot.contextAssessments[decisionFocus]:undefined} contextCheck={decisionFocus?bot.contextChecks[decisionFocus]:undefined}/>:<p className="tennis-reason" role="status">{reason}</p>}

        {account&&<SellEverything session={account} markets={walletMarkets} now={now} busy={controlsBusy||migrating} onSell={()=>void bot.perform({action:'exit-now',commandId:tennisCommandId()})}/>}

        {account&&<OpenBook session={account} markets={walletMarkets} now={now}/>}

      </section>

      <section className="tennis-tracker" aria-label="Game tracker">

        {followedMarket?<TennisMatchChart key={followedMarket.slug} market={followedMarket} session={session} now={now} contextAssessment={bot.contextAssessments[followedMarket.slug]} contextCheck={bot.contextChecks[followedMarket.slug]} showFreshnessNotice={followedMarket.slug!==decisionFocus||!decisionActive}/>:<p className="tennis-order-help">Pick a game to follow it here.</p>}

        {followedMarket&&botGame&&followedMarket.slug!==botGame.slug&&<p className="tennis-order-help">Following {followedMarket.yesName} vs. {followedMarket.noName}; the bot is on {botGame.yesName} vs. {botGame.noName}.</p>}

        {bot.watchedBookError&&(!followedMarket?.quoteObservedAt||Math.abs(now-followedMarket.quoteObservedAt)>5000)&&<p className="tennis-order-help" role="status">{bot.watchedBookError}</p>}


      </section>

      <section className="tennis-activity" aria-label="Trades and balance">

        <div className="tennis-activity-head"><h2>Trades &amp; balance</h2><span className="tennis-label">{account?`${signed(pnl)} since start · after fees`:''}</span></div>

        <TennisPriceChart points={account?.equity??[]} currency/>

        {ledger.length?<ActivityList key={`trades:${account?.id}:${showAll}`} label="Trade history" rows={ledger.map(entry=>({id:entry.id,action:entry.action,time:entry.time,
          title:`${account?.bots?.tennis?`${entry.botId==='tennis'?'Tennis':'Football'} · `:''}${labelFor(entry.slug,entry.side)}`,
          detail:entry.execution?entry.execution.filledQty>0?`${entry.execution.filledQty.toFixed(2)} shares filled at ${cents(entry.execution.averagePrice)} · ${money(entry.execution.fees)} fees${entry.execution.remainingQty>0?` · ${entry.execution.remainingQty.toFixed(2)} unfilled`:''}`:`No shares filled · ${money(entry.execution.fees)} fees`:'Settled',
          summary:`Cash change ${signed(entry.cashDelta)}${entry.action!=='BUY'&&(!entry.execution||entry.execution.filledQty>0)?` · Net result ${signed(entry.realizedPnl)} after fees`:''}`,reason:entry.reason}))}/>

          :<div className="tennis-empty-activity">{isRunning?tennis?'No fills yet. The bot is waiting for a qualifying tennis setup.':'No fills yet. Resting orders fill when someone trades into them.':'No trades yet. Pick a game and press Start bot.'}</div>}

        {(account?.ledger.length??0)>6&&<button className="tennis-link" onClick={()=>setShowAll(!showAll)}>{showAll?'Show recent trades':`Show latest ${Math.min(60,account?.ledger.length??0)} trades`}</button>}

      </section>

      <details className="tennis-details tennis-main-details"><summary><strong>Bot activity</strong><span>Decisions and execution reasons</span></summary><div className="tennis-details-content">
        <section aria-label="Bot activity history"><div className="tennis-activity-head"><a className="tennis-link tennis-history-export" href="/api/tennis/session?export=1" download>Download complete saved history</a>{session&&!tennis&&<button className="tennis-link" onClick={()=>downloadOctopusLog(session)}>Download Octopus log</button>}</div>
          {unique.length?<ActivityList key={`activity:${account?.id}:${showAllActivity}`} label="Bot decision history" rows={unique.map(decision=>({id:decision.id,action:decision.action,time:decision.time,title:labelFor(decision.slug,decision.side),detail:decision.reason}))}/>:<div className="tennis-empty-activity">Nothing yet.</div>}
          {(session?.decisions.length??0)>6&&<button className="tennis-link" type="button" onClick={()=>setShowAllActivity(!showAllActivity)}>{showAllActivity?'Show fewer checks':'More activity'}</button>}
        </section>
      </div></details>

      <details className="tennis-details tennis-main-details"><summary><strong>Settings &amp; history</strong><span>Rules, reset, engine, diagnostics</span></summary><div className="tennis-details-content">

        <div className="tennis-controls">

          <button className="tennis-secondary" disabled={!session||!controlsSupported} onClick={()=>setSettingsOpen(true)}>Rules</button>

          {!tennis&&bot.advisorEnabled&&<button className="tennis-secondary" onClick={()=>setAdvisorOpen(true)}>Ask Claude</button>}

          {session&&!onlyVisible&&<button className="tennis-secondary" disabled={controlsBusy} onClick={()=>void chooseVisible()}>{tennis?'Watch ATP and WTA':'Watch college football only'}</button>}

          {session&&!tennis&&session.config.decisionEngine!=='local-move-v1'&&<button className="tennis-secondary" disabled={controlsBusy} onClick={()=>void bot.perform({action:'update-rules',rules:localMoveUpgradeRules(session.config),expectedRulesRevision:session.rulesRevision??0,sessionId:session.id,commandId:tennisCommandId()})}>Use decision engine</button>}

        </div>

        {session&&!tennis&&<EngineCard session={session} market={availableMarkets.find(m=>m.slug===session.config.focusSlug)} sweep={bot.runtime?.sweep??null} now={now}/>}

        <RunnerSetup runtime={bot.runtime} flat={walletFlat} onComplete={bot.reloadAccount}/>

        <FeedKey runtime={bot.runtime} onChange={bot.reloadAccount}/>

        <section className="tennis-rule-summary" aria-label="Connection diagnostics"><b>Connection &amp; checks</b><p>{bot.runtime?.description||'Connecting to the saved paper account.'}</p>{background&&<p className="tennis-order-help">Last successful check: {bot.runtime?.lastSuccessfulCheck?age(bot.runtime.lastSuccessfulCheck,now):'waiting'}. {bot.runtime?.usage&&`${bot.runtime.usage.estimatedRowsWritten.toLocaleString()} estimated storage writes today.`}</p>}<small>{session?.evaluated??0} price checks · Rules revision {session?.rulesRevision??0} · Entry {session?money(isIdle?entryBudget:session.config.entryBudget):'—'} · Shared cash {account?money(account.cash):'—'}</small></section>

        {session?.testRun&&<section className="tennis-run-progress" aria-label="Observation progress"><div><b>{session.testRun.complete?'Observation finished':`${Math.round((session.testRun.endsAt-session.testRun.startedAt)/60000)}-minute paper watch`}</b><span>{Math.floor(session.testRun.watchedMs/60000)}m {Math.floor(session.testRun.watchedMs/1000)%60}s checked</span></div><progress max={session.testRun.endsAt-session.testRun.startedAt} value={Math.min(session.testRun.endsAt-session.testRun.startedAt,Math.max(0,now-session.testRun.startedAt))}/></section>}

        <div className="tennis-rule-summary"><b>Your current rules</b><p>{session?describeTennisRules(session.config):'Loading saved rules…'}</p></div>

      </div></details>

    </main>

    <footer className="tennis-footer"><span>Paper trading · fake money · no real orders</span></footer>

    {settingsOpen&&session&&<TennisRulesDialog botId={botId} session={session} busy={controlsBusy} error={bot.error} onClose={()=>setSettingsOpen(false)} onAction={bot.perform}/>}

    {advisorOpen&&<TennisAdvisor onClose={()=>setAdvisorOpen(false)}/>}

    <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="tennis-market-dialog"><DialogTitle className="tennis-dialog-title">Reset the shared balance.</DialogTitle><DialogDescription className="tennis-dialog-description">Starts a fresh shared paper wallet with the amount you choose, up to $10,000. Both bots stop. Their strategy choices are kept, and the balance and trade history reset for both bots.{tradesOpen?' All open paper trades and orders are dropped with the old wallet. It is fake money, so nothing is lost.':''}</DialogDescription><div className="tennis-reset-form"><label htmlFor="tennis-reset-balance">Starting paper balance</label><input className="tennis-reset-input" id="tennis-reset-balance" type="text" inputMode="decimal" autoComplete="off" placeholder="100" value={resetText} onChange={event=>setResetText(event.target.value.replace(/[^0-9.]/g,''))} onKeyDown={event=>{if(event.key==='Enter')void reset();}}/><div className="tennis-amounts">{[100,1000,10000].map(value=><button key={value} aria-pressed={resetBalance===value} onClick={()=>setResetText(String(value))}>${value.toLocaleString()}</button>)}</div>{resetText.trim()!==''&&!resetValid&&<p className="tennis-order-help" role="status">Choose $5 to ${MAX_BALANCE.toLocaleString()}.</p>}{bot.error&&<div className="tennis-dialog-error" role="alert">{bot.error}</div>}<div className="tennis-reset-actions"><button className="tennis-secondary" onClick={()=>setResetOpen(false)}>Cancel</button><button className="tennis-primary" disabled={controlsBusy||!resetValid} onClick={()=>void reset()}>{bot.busy?'Resetting…':tradesOpen?'Drop all trades and reset':'Reset balance'}</button></div></div></DialogContent></Dialog>

  </div>;

}
