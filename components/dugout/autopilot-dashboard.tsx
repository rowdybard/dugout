'use client';
import {useEffect,useState,type ReactNode} from 'react';
import {ArrowUpRight,Pause,Play,Square,ChevronDown,Activity} from 'lucide-react';
import {Area,AreaChart,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {BotModelResearch} from './bot-model-research';
import {useBot} from '@/lib/bot/use-bot';
import {botEquity} from '@/lib/bot/engine';
import type {Feed,League,Profile} from '@/lib/market/types';
import type {CredentialStatus} from '@/lib/trading/credentials';
import './autopilot-dashboard.css';

const money=(n:number)=>`${n<0?'−':''}$${Math.abs(n).toFixed(2)}`;
const signed=(n:number)=>`${n>0?'+':''}${money(n)}`;
type Props={profile:Profile|null;feed:Feed|null;onProfile:(p:Profile)=>void;beginner:boolean;visible:boolean;pendingOrder:boolean;children?:ReactNode;onManual:(slug:string)=>void};
export function AutopilotDashboard({profile,feed,onProfile,beginner,visible,pendingOrder,children,onManual}:Props){
  const bot=useBot(profile,onProfile,pendingOrder),s=bot.session;
  const [bankroll,setBankroll]=useState(10),[leagues,setLeagues]=useState<League[]>(['NFL']);
  const [researchOpen,setResearchOpen]=useState(false),[allActivity,setAllActivity]=useState(false);
  const [credentials,setCredentials]=useState<CredentialStatus|null>(null);
  useEffect(()=>{let mounted=true;fetch('/api/polymarket/status',{cache:'no-store',signal:AbortSignal.timeout(12000)}).then(r=>r.json()).then(data=>{if(mounted)setCredentials(data as CredentialStatus);}).catch(()=>{});return()=>{mounted=false;};},[]);
  const replay=!!feed?.replayAt,open=s?.positions.filter(p=>p.status==='open')??[],closed=s?.positions.filter(p=>p.status!=='open')??[];
  const started=!!s&&s.status!=='stopped',equity=started?botEquity(s):bankroll,pnl=started?equity-s!.config.startingCash:0;
  const stale=started&&!!s?.lastCycleAt&&bot.now-s.lastCycleAt>30000;
  const status=bot.controlPending?'Updating':bot.error?'Connection interrupted':stale?'Waiting for fresh data':s?.status==='running'?(open.length?'Managing a trade':'Scanning'):s?.status==='paused'?'Entries paused':s?.status==='stopping'?'Exiting':'Ready';
  // Collapse duplicate side/reason rows so quiet markets do not bury actual trades.
  const seen=new Set<string>(),decisions=[...(s?.decisions??[])].reverse().filter(d=>{const k=`${d.slug}:${d.action}:${d.reason}`;if(seen.has(k)&&!['BUY','SELL','SETTLE'].includes(d.action))return false;seen.add(k);return true;}).slice(0,allActivity?30:3);
  const valid=Number.isFinite(bankroll)&&bankroll>=5&&bankroll<=100&&leagues.length>0;
  const toggle=(league:League)=>setLeagues(previous=>previous.includes(league)?previous.filter(x=>x!==league):[...previous,league]);
  const liveQuotes=Object.values(bot.quotes).slice(0,4);
  return <main className="auto-home auto-simple" hidden={!visible}>
    <div className="auto-heading"><div><span className="auto-kicker">DUGOUT · PAPER ONLY</span><h1>Let the bot work.</h1></div><span className="auto-status"><Activity size={15}/>{status}</span></div>
    <section className="auto-command" aria-label="Paper bot controls">
      <div className="auto-command-main">
        <div className="auto-section-title"><span>{started?'YOUR BOT':'START A RUN'}</span><span>{started?s!.config.leagues.join(' + '):'Fake money. Real market prices.'}</span></div>
        {!started&&<div className="auto-sport-toggles" role="group" aria-label="Leagues for the bot">{(['NFL','MLB'] as const).map(league=><button key={league} aria-pressed={leagues.includes(league)} onClick={()=>toggle(league)}>{league}<span>{league==='NFL'?'Live games':'Pregame'}</span></button>)}</div>}
        <div className="auto-actions">{!started?<button className="auto-start" disabled={!profile||replay||!valid||bot.busy||pendingOrder} onClick={()=>void bot.start(bankroll,leagues)}><Play size={19}/>{!profile?'Loading account…':bot.busy?'Starting…':`Start ${money(bankroll).replace('.00','')} paper bot`}</button>:<><button className="auto-start" disabled={bot.controlPending||s!.status==='stopping'} onClick={()=>void(s!.status==='paused'?bot.resume():bot.pause())}>{s!.status==='paused'?<Play size={18}/>:<Pause size={18}/>} {s!.status==='paused'?'Resume entries':'Pause entries'}</button><button className="auto-stop" disabled={bot.controlPending} onClick={()=>void bot.stop()}><Square size={15}/>Stop & exit</button></>}</div>
        <p className="auto-current-reason" role={bot.error?'alert':undefined}>{bot.error||(stale?'Reconnecting. The bot will not fill against old prices.':started?s!.lastReason:replay?'Recorded development preview. Live trading simulation is disabled here.':'Chooses a market, paper-buys, manages the exit, and records the result.')}</p>
        <div className="auto-runtime"><span className={bot.streamStatus==='live'?'auto-green':'auto-amber'}/>{bot.streamStatus==='live'?'Live market stream':bot.streamStatus==='connecting'?'Connecting live feed…':'REST price checks'} · Keep this browser tab visible</div>
        {s?.status==='paused'&&open.length>0&&<p className="auto-explanation">Open-position exits are still monitored.</p>}
      </div>
      <div className="auto-command-money">
        <span className="auto-section-title">{started?'PAPER BANKROLL':s?'NEW RUN':'STARTING BANKROLL'}</span>
        <div className="auto-balance">{started?<strong>{money(equity)}</strong>:<label><span>$</span><input aria-label="Starting paper bankroll" type="number" min="5" max="100" step="1" value={bankroll} onChange={e=>setBankroll(Number(e.target.value))}/></label>}<span className={pnl<0?'negative':'positive'}>{started?`${signed(pnl)} since start`:s?`Previous run ended at ${money(botEquity(s))}`:'No deposit needed'}</span></div>
        <div className="auto-config-line"><span><b>{money(started?s!.config.entryBudget:Math.min(2,bankroll/5))}</b> per trade</span><span><b>{money(started?s!.config.maxSessionLoss:bankroll*.2)}</b> loss limit</span></div>
        {started&&<div className="auto-stat-row"><div><span>Cash</span><strong>{money(s!.cash)}</strong></div><div><span>Open</span><strong>{open.length}</strong></div><div><span>Closed</span><strong>{closed.length}</strong></div></div>}
      </div>
    </section>
    {open.length>0&&<section className="auto-open" aria-label="Open paper position">{open.map(p=><div key={p.id}><div><span>{p.league} · OPEN PAPER TRADE</span><strong>{p.title}</strong><small>{money(p.amount)} paid · {p.contracts} contracts · {p.mark===null||p.mark===undefined?'Waiting for exit quote':`${Math.round(p.mark*100)}¢ current selling price`}</small></div><button disabled={bot.controlPending||s?.exitRequests?.includes(p.id)} onClick={()=>void bot.exit(p.id)}>{s?.exitRequests?.includes(p.id)?'Exit requested':'Exit now'} <ArrowUpRight size={16}/></button></div>)}</section>}
    {liveQuotes.length>0&&<section className="auto-live-markets" aria-label="Live markets">{liveQuotes.map(q=>{const m=feed?.markets.find(m=>m.slug===q.slug),decision=[...(s?.decisions??[])].reverse().find(d=>d.slug===q.slug&&d.side==='YES'),history=s?.histories[q.slug]??[];return <button className="auto-live-card" key={q.slug} onClick={()=>onManual(q.slug)}><span>{m?.game??open.find(p=>p.slug===q.slug)?.game??q.league}</span><strong>{m?.title??open.find(p=>p.slug===q.slug)?.title??'Selected market'}</strong><div><b>{q.ask===null?'—':`${(q.ask*100).toFixed(1)}¢`}</b><span>to buy{decision?.forecastProbability!==undefined?` · ${Math.round(decision.forecastProbability*100)}% reference`:''}</span></div>{history.length>1&&<div className="auto-price-line"><ResponsiveContainer width="100%" height="100%"><AreaChart data={history}><YAxis hide domain={['dataMin - 0.02','dataMax + 0.02']}/><Area dataKey="price" type="linear" stroke="#b8f569" fill="#b8f56910" strokeWidth={2} isAnimationActive={false}/></AreaChart></ResponsiveContainer></div>}</button>;})}</section>}
    {s&&s.equity.length>1&&<section className="auto-bankroll-history"><div className="auto-section-title"><span>PAPER BANKROLL OVER TIME</span><span>{closed.length} closed trades</span></div><div className="auto-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={s.equity}><XAxis hide dataKey="time"/><YAxis hide domain={['dataMin - 0.25','dataMax + 0.25']}/><Tooltip labelFormatter={v=>new Date(Number(v)).toLocaleTimeString()} formatter={v=>[money(Number(v)),'Estimated bankroll']} contentStyle={{background:'#171d17',border:'1px solid #46543b'}}/><Area dataKey="price" type="linear" stroke={pnl<0?'#f27d86':'#b8f569'} fill="#b8f56910" strokeWidth={2} isAnimationActive={false}/></AreaChart></ResponsiveContainer></div></section>}
    <section className="auto-decisions" aria-label="Latest bot decisions"><div className="auto-decisions-heading"><div><h2>Latest decisions</h2>{s&&<span>{s.universeSize} markets · {s.scanned} checks</span>}</div>{s&&<button className="auto-quiet-button" onClick={()=>setAllActivity(!allActivity)}>{allActivity?'Show less':'All activity'}</button>}</div>
      {decisions.length?<div className="auto-decision-list">{decisions.map(d=><details key={d.id} className="auto-decision"><summary><span className={`auto-action action-${d.action.toLowerCase()}`}>{d.action}</span><div><strong>{d.title}</strong><span>{d.reason}</span></div><time>{new Date(d.time).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</time><ChevronDown size={14}/></summary><div className="auto-decision-detail">{d.forecastProbability!==undefined&&<span>{d.modelVersion==='espn-live-reference-v1'?'ESPN live reference':'MLB team model'}: {(d.forecastProbability*100).toFixed(1)}%. Unvalidated for trading.</span>}{d.allInEntryPrice!==undefined&&<span>Buying price including fees: {(d.allInEntryPrice*100).toFixed(1)}¢</span>}{d.initialLoss!==undefined&&<span>Immediate round-trip cost: {(d.initialLoss*100).toFixed(1)}%</span>}<button onClick={()=>onManual(d.slug)}>Inspect market <ArrowUpRight size={14}/></button></div></details>)}</div>:<div className="auto-empty">{started?'First check is running.':'Start the bot to see its first decision.'}</div>}
    </section>
    <details className="auto-sports auto-research" onToggle={event=>setResearchOpen(event.currentTarget.open)}><summary>Research & settings<ChevronDown size={17}/></summary>{researchOpen&&<>
      <dl className="auto-facts"><div><dt>NFL experiment</dt><dd>ESPN’s latest-play estimate must exceed buying price + fees by 6 points. Both outcomes considered; one position at a time.</dd></div><div><dt>MLB experiment</dt><dd>Pregame team model plus a confirmed dip and recovery.</dd></div><div><dt>Exits</dt><dd>+8% net target, −15% net stop, or 10 minutes. Fills depend on actual available depth.</dd></div><div><dt>Player changes</dt><dd>NFL pauses on newly observed QB or injury-report changes. Reports can lag; individual player impact is not calculated.</dd></div><div><dt>Connection</dt><dd>{credentials?.message??'Checking Polymarket credentials.'}</dd></div><div><dt>Runtime</dt><dd>Checks every 5 seconds when idle and visible. Live books are used when fresh; REST is the fallback. No real orders.</dd></div></dl>
      <BotModelResearch/>{children}
    </>}</details>
    {beginner&&<p className="auto-footnote">A “WAIT” is a decision too. The bot only spends paper cash when its conditions pass.</p>}
  </main>;
}
