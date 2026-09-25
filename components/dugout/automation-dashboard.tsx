'use client';

import {useId, useMemo, useState, type ReactNode} from 'react';
import {ArrowRight, Bot, Check, ChevronDown, CircleDollarSign, Clock3, Loader2, Pause, Play, SlidersHorizontal, TrendingUp} from 'lucide-react';
import {Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis} from 'recharts';
import {Dialog, DialogContent, DialogDescription, DialogTitle} from '@/components/ui/dialog';
import {usePaperAutomation, type PaperBotSetup} from '@/lib/trading/use-paper-automation';
import {DEFAULT_DIP_CONFIG} from '@/lib/trading/strategy';
import {feeFor} from '@/lib/market/paper';
import type {Feed, Market, Position, Profile} from '@/lib/market/types';
import type {AutomationSession, WorkspaceOrder} from '@/lib/trading/workspace';
import {Sparkline} from './chart';
import {cents, gameTime} from './market-card';
import './automation-dashboard.css';

type Props = {
  feed: Feed | null;
  markets: Market[];
  profile: Profile | null;
  onProfile: (profile: Profile) => void;
  beginner: boolean;
  onManualMarket: (slug: string, side?: 'YES' | 'NO', action?: 'BUY' | 'SELL', positionId?:string) => void;
  onResults: () => void;
  onSimulation: () => void;
  visible: boolean;
  children?: ReactNode;
  pendingOrder?:boolean;
};
const money = (amount: number) => `${amount < 0 ? '−' : ''}$${Math.abs(amount).toFixed(2)}`;
const signedMoney = (amount: number) => `${amount > 0 ? '+' : ''}${money(amount)}`;
const shortTime = (time: number) => new Date(time).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
const outcome = (market: Market, side: 'YES' | 'NO') => side === 'YES' ? market.title : market.oppositeTitle || `NO · ${market.title}`;

function setupFor(session: AutomationSession | null, slug: string): PaperBotSetup {
  const config = session?.config ?? DEFAULT_DIP_CONFIG;
  return {
    slug: session?.slug ?? slug, side: session?.side ?? 'YES',
    entryBudget: config.entryBudget, budgetLimit: session?.budgetLimit ?? 10,
    declinePoints: config.declinePoints, recoveryPoints: config.recoveryPoints,
    targetReturn: config.targetReturn, stopReturn: config.stopReturn,
  };
}

/** A manual position or a scanner flag is never evidence that the bot entered. */
function botHistory(orders: WorkspaceOrder[], positions: Position[]) {
  const entries = orders.filter(order => order.source === 'AUTOMATIC' && order.action === 'BUY' && order.filledQuantity > 0 && order.positionId);
  const owned = new Set(entries.map(order => order.positionId!));
  const linked = new Set(owned);
  // Partial exits produce a new ledger row whose ID is the sell command ID.
  // Keep its original bot attribution, including a later manual exit.
  for (const order of orders) if (order.action === 'SELL' && order.filledQuantity > 0 && order.positionId && owned.has(order.positionId)) linked.add(order.commandId);
  // DIP_REVERSION is set by the automatic execution engine and survives
  // settlements and partial/manual exits, unlike the 60-command recent log.
  return {entries, positions: positions.filter(position => position.signal === 'DIP_REVERSION' || linked.has(position.id)), activity: orders.filter(order => order.source === 'AUTOMATIC')};
}

function ProfitChart({positions}: {positions: Position[]}) {
  const id = useId().replaceAll(':', '');
  const closed = [...positions].filter(position => position.status !== 'open' && position.payout !== undefined)
    .sort((a, b) => (a.closedAt ?? a.time) - (b.closedAt ?? b.time));
  if (!closed.length) return <div className="ad-chart-empty"><TrendingUp size={27}/><strong>No completed bot trades yet</strong><span>The results chart appears after a bot position closes.</span></div>;
  let total = 0;
  const points = [{time: Math.min(...positions.map(position => position.time)), profit: 0}, ...closed.map(position => ({
    time: position.closedAt ?? position.time, profit: total += (position.payout ?? 0) - position.amount,
  }))];
  const color = total < 0 ? '#f27d86' : '#b8f569';
  return <div className="ad-profit-chart" role="img" aria-label={`Realized paper bot profit after ${closed.length} closed positions: ${signedMoney(total)}`}>
    <ResponsiveContainer width="100%" height="100%"><AreaChart data={points} margin={{top: 15, right: 6, left: 0, bottom: 0}}>
      <defs><linearGradient id={`bot-profit-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={.16}/><stop offset="100%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
      <CartesianGrid vertical={false} stroke="#2b332b" strokeDasharray="2 6"/>
      <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={shortTime} minTickGap={60} tick={{fill: '#939e92', fontSize: 12}} axisLine={false} tickLine={false}/>
      <YAxis tickFormatter={value => `$${Number(value).toFixed(0)}`} width={38} tick={{fill: '#939e92', fontSize: 12}} axisLine={false} tickLine={false}/>
      <Tooltip contentStyle={{background: '#1b221b', border: '1px solid #3d473b', borderRadius: 8, color: '#f0f3eb', fontSize: 12}} labelFormatter={value => new Date(Number(value)).toLocaleString()} formatter={value => [signedMoney(Number(value)), 'Realized bot P/L']}/>
      <Area type="linear" dataKey="profit" stroke={color} strokeWidth={2.5} fill={`url(#bot-profit-${id})`} isAnimationActive={false}/>
    </AreaChart></ResponsiveContainer>
  </div>;
}

export function AutomationDashboard({feed, markets, profile, onProfile, beginner, onManualMarket, onResults, onSimulation, visible, children, pendingOrder=false}: Props) {
  const bot = usePaperAutomation(profile, onProfile, visible, pendingOrder);
  const [setupOpen, setSetupOpen] = useState(false);
  const [draft, setDraft] = useState<PaperBotSetup>(() => setupFor(null, ''));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const running = bot.session?.status === 'running';
  const replay = !!feed?.replayAt;
  const available = useMemo(() => markets.filter(market => market.active).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), [markets]);
  const pregame = available.filter(market => Date.parse(market.start) > (feed?.replayAt ?? Date.now()));
  const draftMarket = markets.find(market => market.slug === draft.slug);
  const watching = markets.find(market => market.slug === bot.session?.slug);
  const watchedPosition = profile?.positions.find(position => position.id === bot.session?.positionId);
  const history = useMemo(() => botHistory(bot.orders, profile?.positions ?? []), [bot.orders, profile?.positions]);
  const open = history.positions.filter(position => position.status === 'open');
  const closed = history.positions.filter(position => position.status !== 'open' && position.payout !== undefined);
  const realized = closed.reduce((sum, position) => sum + (position.payout ?? 0) - position.amount, 0);
  const candidates = useMemo(() => [...pregame].sort((a, b) => Number(b.signals.length > 0) - Number(a.signals.length > 0)).slice(0, 3), [pregame]);
  const status = pendingOrder ? 'Order check required' : !bot.ready ? 'Loading' : bot.error ? 'Needs attention' : replay && !running ? 'Blocked' : running ? 'Running' : bot.session ? 'Paused' : 'Off';
  const reason = (pendingOrder?'Resolve the pending paper order before automated entries resume.':'') || bot.error || (replay ? 'Recorded development data. Start requires current market quotes.' : bot.session?.lastReason) || 'Choose one outcome. The bot can enter and exit when its rules trigger.';
  const watchingTitle = watching && bot.session ? outcome(watching, bot.session.side) : watchedPosition?.title || (bot.session ? bot.session.slug : 'Choose the market it watches');
  const validateSetup = () => {
    if(pendingOrder)return 'Resolve the pending paper order first.';
    if (!bot.ready || !profile) return 'Waiting for your paper account.';
    if (running) return 'Pause the current test before changing its rules.';
    if (replay) return 'Recorded development data: current quotes are required to start.';
    if (!draftMarket) return 'Choose an available market.';
    if (!draftMarket.active || !draftMarket.start || Date.parse(draftMarket.start) <= Date.now()) return 'Choose an open pregame market.';
    if (bot.session?.positionId && profile.positions.some(position => position.id === bot.session!.positionId && position.status === 'open')) return 'Close the existing bot position before starting another test.';
    if (!Number.isFinite(draft.entryBudget) || draft.entryBudget < 1 || draft.entryBudget > 25) return 'Use $1–$25 per entry.';
    if (!Number.isFinite(draft.budgetLimit) || draft.budgetLimit < 1 || draft.budgetLimit > 100) return 'Use a $1–$100 total spending limit.';
    if (draft.entryBudget > draft.budgetLimit || draft.entryBudget > profile.cash) return 'Your entry must fit the spending limit and available paper cash.';
    if (!Number.isFinite(draft.declinePoints) || draft.declinePoints < 1 || draft.declinePoints > 30) return 'Dip threshold must be 1–30 points.';
    if (!Number.isFinite(draft.recoveryPoints) || draft.recoveryPoints < .5 || draft.recoveryPoints > 10 || draft.recoveryPoints >= draft.declinePoints) return 'Recovery must be 0.5–10 points and smaller than the dip.';
    if (!Number.isFinite(draft.targetReturn) || draft.targetReturn < .03 || draft.targetReturn > 1) return 'Profit target must be 3–100%.';
    if (!Number.isFinite(draft.stopReturn) || draft.stopReturn < .03 || draft.stopReturn > .5) return 'Loss exit must be 3–50%.';
    return '';
  };
  const setupBlock = validateSetup();
  const openSetup = (market?: Market) => {
    const next = setupFor(bot.session, pregame[0]?.slug ?? markets[0]?.slug ?? '');
    setDraft(market ? {...next, slug: market.slug, side: 'YES'} : next);
    setAdvancedOpen(false);
    setSetupOpen(true);
  };
  const update = <K extends keyof PaperBotSetup>(key: K, value: PaperBotSetup[K]) => setDraft(previous => ({...previous, [key]: value}));
  const start = async () => { if (!setupBlock && await bot.start(draft)) setSetupOpen(false); };

  return <section className="automation-dashboard" hidden={!visible} aria-label="Automated trading">
    <div className="ad-page-heading"><div><span className="ad-eyebrow">AUTOMATED TRADING</span><h1>Bot overview</h1></div><span className="ad-mode"><span/>Paper mode</span></div>
    {beginner && <p className="ad-intro">This is your bot’s home. It shows what the bot is watching, what it actually bought, and how those trades worked out.</p>}

    <div className="ad-main-grid">
      <section className="ad-card ad-control">
        <div className="ad-card-heading"><div className="ad-control-title"><span className="ad-bot-icon"><Bot size={21}/></span><div><h2>Paper bot</h2><span className="ad-meta">Dip → recovery test</span></div></div><span className={`ad-status ${running && !bot.error ? 'running' : ''} ${status === 'Blocked' || bot.error ? 'blocked' : ''}`}><i/>{status}</span></div>
        <div className="ad-watching"><span className="ad-eyebrow">{bot.session ? 'WATCHING' : 'ONE MARKET AT A TIME'}</span><h3>{watchingTitle}</h3>{watching && <span className="ad-meta">{watching.league} · {watching.game} · {gameTime(watching.start)}</span>}</div>
        <p className="ad-reason" role={bot.error ? 'alert' : undefined}>{reason}</p>
        {bot.session && <div className="ad-rule-summary"><span><b>{money(bot.session.config.entryBudget)}</b> per entry</span><span><b>{money(bot.session.spent)} / {money(bot.session.budgetLimit)}</b> spent</span><span><b>+{Math.round(bot.session.config.targetReturn * 100)}% / −{Math.round(bot.session.config.stopReturn * 100)}%</b> exit rules</span></div>}
        <div className="ad-control-actions">
          {running ? <button className="ad-primary ad-pause" onClick={() => void bot.pause()} disabled={!!bot.busy}>{bot.busy === 'pause' ? <Loader2 size={17} className="ad-spin"/> : <Pause size={17}/>}Pause bot</button> : <button className="ad-primary" onClick={() => openSetup()} disabled={!profile || !bot.ready}><SlidersHorizontal size={17}/>{bot.session ? 'Review & restart' : 'Set up paper bot'}<ArrowRight size={17}/></button>}
          {bot.session && <button className="ad-text-button" onClick={() => openSetup()}>View rules</button>}
          {bot.error && <button className="ad-text-button" onClick={() => void bot.refresh()}>Retry status</button>}
        </div>
        <div className="ad-operation"><Clock3 size={14}/><span>Pregame · checks every 5 seconds while this app is open</span></div>
        <p className="ad-limitation">Automatic game selection and real-money trading aren’t connected.</p>
      </section>

      <section className="ad-card ad-performance">
        <div className="ad-card-heading"><h2>Bot results</h2><button className="ad-text-button" onClick={onResults}>All results <ArrowRight size={14}/></button></div>
        <div className="ad-performance-number"><span className="ad-eyebrow">REALIZED PAPER P/L</span><strong className={realized < 0 ? 'ad-negative' : realized > 0 ? 'ad-positive' : ''}>{bot.ready ? signedMoney(realized) : '—'}</strong><span className="ad-meta">{closed.length} closed lots · {open.length} open positions</span></div>
        <ProfitChart positions={history.positions}/>
        <div className="ad-performance-note">All bot-origin positions, including manual exits. Sample: {closed.length} closed lots.</div>
      </section>
    </div>
    <div className="ad-readiness"><span>QUOTES <b>{replay ? 'Recorded capture' : 'REST polling'}</b></span><span>GAME PREDICTION <b>No model connected</b></span><span>REAL ORDERS <b>Unavailable</b></span></div>
    {children}

    <section className="ad-card ad-positions">
      <div className="ad-card-heading"><div className="ad-title-with-count"><h2>Bot positions</h2><span>{open.length}</span></div><span className="ad-meta">Actual paper entries</span></div>
      {open.length ? <div className="ad-position-list">{open.map(position => {
        const value = position.mark == null ? null : position.contracts * position.mark - feeFor(position.contracts, position.mark, position.coefficient);
        return <div className="ad-position" key={position.id}><div><span className="ad-meta">{position.league} · {position.game}</span><h3>{position.title}</h3></div><div className="ad-position-value"><span>{money(position.amount)} entered</span><b className={value !== null && value < position.amount ? 'ad-negative' : 'ad-positive'}>{value === null ? 'Value unavailable' : `${signedMoney(value - position.amount)} estimated`}</b></div><button className="ad-secondary" onClick={() => onManualMarket(position.slug, position.side, 'SELL', position.id)}>Manage / exit <ArrowRight size={14}/></button></div>;
      })}</div> : <div className="ad-empty-positions"><CircleDollarSign size={25}/><div><strong>No open bot positions</strong><p>{running ? 'The bot is watching. A position appears only after an entry fills.' : 'Start a paper test to let the bot make its first rule-based entry.'}</p></div></div>}
      {history.activity.length > 0 && <details className="ad-activity"><summary>Recent bot activity <ChevronDown size={15}/></summary><div>{history.activity.slice(0, 5).map(order => <div className="ad-activity-row" key={order.commandId}><span>{shortTime(order.createdAt)}</span><b>{order.action === 'BUY' ? 'Entry' : 'Exit'} · {order.status}</b><span>{order.filledQuantity > 0 ? `${order.filledQuantity.toLocaleString()} at ${cents(order.averagePrice)}` : order.reason}</span></div>)}</div></details>}
    </section>

    <details className="ad-candidates ad-candidates-collapsed"><summary>Browse markets for a paper test <ChevronDown size={16}/></summary>
      <div className="ad-candidate-heading"><div><h2>Market candidates</h2><p>Observed markets · the bot has not picked these</p></div><button className="ad-text-button" onClick={() => onManualMarket(candidates[0]?.slug ?? '')}>Browse markets <ArrowRight size={14}/></button></div>
      {candidates.length ? <div className="ad-candidate-grid">{candidates.map(market => <article className="ad-candidate" key={market.slug}><div className="ad-candidate-top"><span className="ad-meta">{market.league} · {gameTime(market.start)}</span><span className="ad-candidate-price">{cents(market.price)}</span></div><h3>{market.title}</h3><span className="ad-meta">{market.game}</span><div className="ad-candidate-spark"><Sparkline points={market.history} down={market.history.length > 1 && market.history.at(-1)!.price < market.history[0].price}/></div><div className="ad-candidate-footer"><span>{market.signals[0]?.type.replaceAll('_', ' ') || 'No scanner flag'}</span><button className="ad-text-button" onClick={() => running ? onManualMarket(market.slug) : openSetup(market)}>{running ? 'Review' : 'Use for test'} <ArrowRight size={14}/></button></div></article>)}</div> : <div className="ad-no-candidates">{feed ? 'No open pregame markets available. You can still review existing positions.' : 'Loading available MLB and NFL markets…'}</div>}
    </details>


    <Dialog open={setupOpen && visible} onOpenChange={setSetupOpen}><DialogContent className="ad-setup-dialog">
      <div className="ad-setup-title"><span className="ad-eyebrow">PAPER BOT</span><DialogTitle>{running ? 'Your current rules' : 'Set up your test'}</DialogTitle><DialogDescription>One pregame outcome. Automatic entries and exits when your rules trigger.</DialogDescription></div>
      <div className="ad-setup-fields">
        <label>Market<select aria-label="Bot market" value={draft.slug} onChange={event => update('slug', event.target.value)} disabled={running}><option value="">Choose a market</option>{bot.session && !available.some(market => market.slug === bot.session?.slug) && <option value={bot.session.slug}>{watchedPosition?.title || bot.session.slug}</option>}{available.map(market => <option key={market.slug} value={market.slug}>{market.league} · {market.game} · {market.title}</option>)}</select></label>
        <fieldset className="ad-outcomes" disabled={running}><legend>Outcome to watch</legend><button type="button" className={draft.side === 'YES' ? 'selected' : ''} onClick={() => update('side', 'YES')}>{draft.side === 'YES' && <Check size={15}/>}<span>{draftMarket?.title || 'YES'}</span></button><button type="button" className={draft.side === 'NO' ? 'selected' : ''} onClick={() => update('side', 'NO')}>{draft.side === 'NO' && <Check size={15}/>}<span>{draftMarket?.oppositeTitle || 'NO'}</span></button></fieldset>
        <div className="ad-budget-fields"><label>Total spending limit<div className="ad-money-input"><span>$</span><input aria-label="Total bot spending limit" type="number" min="1" max="100" step="1" value={draft.budgetLimit} disabled={running} onChange={event => update('budgetLimit', Number(event.target.value))}/></div></label><label>Per entry<div className="ad-money-input"><span>$</span><input aria-label="Bot amount per entry" type="number" min="1" max="25" step="1" value={draft.entryBudget} disabled={running} onChange={event => update('entryBudget', Number(event.target.value))}/></div></label></div>
        <span className="ad-meta">Available paper cash: {profile ? money(profile.cash) : '—'} · spending limit includes estimated fees</span>
        <div className="ad-setup-recipe"><span>WATCH A DIP</span><ArrowRight size={14}/><span>BUY RECOVERY</span><ArrowRight size={14}/><span>EXIT BY RULE</span></div>
        {beginner && <p className="ad-setup-help">A falling price only starts the watch. The bot waits for a recovery, then tries to sell at your target, loss limit, or maximum holding time.</p>}
        <button className="ad-rules-toggle" onClick={() => setAdvancedOpen(!advancedOpen)} aria-expanded={advancedOpen}><span><SlidersHorizontal size={15}/>Entry & exit rules</span><ChevronDown size={16} className={advancedOpen ? 'open' : ''}/></button>
        {advancedOpen && <div className="ad-rule-fields">
          <label>Dip (points)<input aria-label="Bot dip points" type="number" min="1" max="30" step="0.5" value={draft.declinePoints} disabled={running} onChange={event => update('declinePoints', Number(event.target.value))}/></label>
          <label>Recovery (points)<input aria-label="Bot recovery points" type="number" min="0.5" max="10" step="0.5" value={draft.recoveryPoints} disabled={running} onChange={event => update('recoveryPoints', Number(event.target.value))}/></label>
          <label>Profit target (%)<input aria-label="Bot profit target percent" type="number" min="3" max="100" step="1" value={Math.round(draft.targetReturn * 10000) / 100} disabled={running} onChange={event => update('targetReturn', Number(event.target.value) / 100)}/></label>
          <label>Loss exit (%)<input aria-label="Bot loss exit percent" type="number" min="3" max="50" step="1" value={Math.round(draft.stopReturn * 10000) / 100} disabled={running} onChange={event => update('stopReturn', Number(event.target.value) / 100)}/></label>
          <p>Targets use estimated proceeds after fees. Maximum hold: {(bot.session?.config.maxHoldMs ?? DEFAULT_DIP_CONFIG.maxHoldMs) / 60000} minutes. Exit prices aren’t guaranteed.</p>
        </div>}
      </div>
      <div className="ad-setup-footer">{setupBlock && <p className="ad-setup-block">{setupBlock}</p>}{bot.error && <p className="ad-error" role="alert">{bot.error}</p>}{!running && <button className="ad-primary" disabled={!!setupBlock || !!bot.busy} onClick={() => void start()}>{bot.busy === 'start' ? <Loader2 size={17} className="ad-spin"/> : <Play size={16}/>}Start paper bot</button>}<p className="ad-meta">Keep this app open. A pause leaves any open position available for manual exit.</p></div>
    </DialogContent></Dialog>
  </section>;
}
