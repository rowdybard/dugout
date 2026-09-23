'use client';

import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {
  ArrowDownRight, ArrowUpRight, Bookmark, Check, ChevronDown, ChevronRight,
  CircleDot, Flame, FlaskConical, Layers3, Loader2, LockKeyhole, Pencil,
  RefreshCw, Search, SlidersHorizontal, Trophy, X,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import {Dialog, DialogContent, DialogDescription, DialogTitle} from '@/components/ui/dialog';
import {SportsContextPanel} from './sports-context-panel';
import {Sparkline} from './chart';
import {cents, gameTime} from './market-card';
import {useMarketStream} from '@/lib/trading/use-market-stream';
import {streamBookForDisplay} from '@/lib/trading/stream-types';
import {feeFor, sideBook} from '@/lib/market/paper';
import {executePaperCommand} from '@/lib/trading/execution';
import {roundPriceToIncrement} from '@/lib/trading/money';
import type {PaperCommand} from '@/lib/trading/types';
import type {DetailRange, MarketDetailData} from '@/lib/market/detail';
import type {Feed, Market, Point, Position, Profile} from '@/lib/market/types';
import './trading-workspace.css';

type Side = 'YES' | 'NO';
type Settings = {entryPresets: number[]; exitPresets: number[]; maxPriceDrift: number};
type Connection = {
  transport: 'stream' | 'rest';
  state: 'not_configured' | 'ready' | 'reconciling' | 'stale';
  liveEnabled: false;
  message: string;
  updatedAt?: number;
};
type OrderReceipt = {
  commandId: string;
  status?: string;
  state?: string;
  action?: 'BUY' | 'SELL';
  filledQuantity?: number;
  quantity?: number;
  averagePrice?: number;
  fees?: number;
  message?: string;
  reason?: string;
};
type PaperRequest = {commandId: string; action: 'BUY' | 'SELL'; slug: string; side: Side; amount?: number; positionId?: string; percent?: number; limitPrice: number; mode: 'paper'};
type PendingPaperRequest = {body: PaperRequest; outcome: string; createdAt: number};
type TradingData = {profile?: Profile; settings?: Settings; status?: Connection; orders?: OrderReceipt[]};
type Props = {
  feed: Feed | null;
  markets: Market[];
  profile: Profile | null;
  onProfile: (profile: Profile) => void;
  onRefresh: () => void;
  onRetryProfile: () => void;
  loading: boolean;
  error: string;
  profileError: string;
  tab: string;
  onTab: (tab: string) => void;
  onWatch: (market: Market) => void;
  onSettings: () => void;
  beginner: boolean;
  visible: boolean;
  target: {slug:string; side:Side; revision:number;action:'BUY'|'SELL';positionId?:string}|null;
  onPendingOrder:(order:{slug:string;side:Side;commandId:string}|null)=>void;
  onSimulation: () => void;
  onGame: (market:Market) => void;
  onHelp: (concept:string) => void;
};
const DEFAULT_SETTINGS: Settings = {entryPresets: [5, 10, 25], exitPresets: [25, 50, 100], maxPriceDrift: 0.02};
const RANGES: DetailRange[] = ['15m', '1h', '6h', '24h', 'ALL'];
const money = (value: number) => Number.isFinite(value) ? `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}` : '—';
const signedMoney = (value: number) => `${value > 0 ? '+' : ''}${money(value)}`;
const qty = (value: number) => value.toLocaleString(undefined, {maximumFractionDigits: 4});
const time = (value: number) => new Date(value).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit'});
const positionValue = (position: Position) => position.status === 'open'
  ? position.contracts * (position.mark ?? position.entry) - feeFor(position.contracts, position.mark ?? position.entry, position.coefficient)
  : position.payout ?? 0;
const heldMarket = (position:Position):Market => ({slug:position.slug,id:'',title:position.side==='YES'?position.title:`Opposite of ${position.title}`,oppositeTitle:position.side==='NO'?position.title:`Not ${position.title}`,question:position.title,rules:'',gameId:'',game:position.game,league:position.league,start:'',teams:[],kind:'',bid:null,ask:null,price:position.mark==null?null:position.side==='YES'?position.mark:1-position.mark,volume:null,fee:position.coefficient??0,active:false,history:[],signals:[],observedAt:position.markTime??position.time});
const deltaOf = (points: Point[]) => points.length > 1 ? (points.at(-1)!.price - points[0].price) * 100 : null;

function PriceChart({points, positions = [], side = 'YES', moneyChart = false}: {
  points: Point[]; positions?: Position[]; side?: Side; moneyChart?: boolean;
}) {
  const id = useId().replaceAll(':', '');
  const down = (deltaOf(points) ?? 0) < 0;
  const color = down ? '#f08a91' : '#b8f569';
  if (points.length < 2) return <div className="tw-chart-empty"><Layers3 size={22}/><span>{moneyChart ? 'No recorded performance yet' : 'Waiting for recorded price history'}</span><small>{points.length} observations</small></div>;
  const low = Math.min(...points.map(point => point.price));
  const high = Math.max(...points.map(point => point.price));
  const padding = moneyChart ? Math.max(1, (high - low) * .2) : Math.max(.03, (high - low) * .25);
  const domain = moneyChart ? [low - padding, high + padding] : [Math.max(0, low - padding), Math.min(1, high + padding)];
  const first = points[0].time;
  const last = points.at(-1)!.time;
  const markers = positions.filter(position => position.time >= first && position.time <= last);
  return <div className="tw-chart" role="img" aria-label={`${moneyChart ? 'Paper equity' : `${side} market price`} from ${moneyChart ? money(points[0].price) : cents(points[0].price)} to ${moneyChart ? money(points.at(-1)!.price) : cents(points.at(-1)!.price)}`}>
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{top: 24, right: 13, bottom: 4, left: 0}}>
        <defs><linearGradient id={`tw-fill-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={.16}/><stop offset="100%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
        <CartesianGrid vertical={false} stroke="#2a302c" strokeDasharray="2 6"/>
        <XAxis dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={value => new Date(value).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})} minTickGap={60} tick={{fill: '#8f9992', fontSize: 11}} axisLine={false} tickLine={false}/>
        <YAxis domain={domain} tickFormatter={value => moneyChart ? `$${Number(value).toFixed(0)}` : `${Math.round(value * 100)}¢`} tick={{fill: '#8f9992', fontSize: 11}} orientation="right" width={44} axisLine={false} tickLine={false}/>
        <Tooltip contentStyle={{background: '#171d19', border: '1px solid #414b42', borderRadius: 8, color: '#f0f3eb', fontSize: 12}} labelFormatter={value => time(Number(value))} formatter={value => [moneyChart ? money(Number(value)) : cents(Number(value)), moneyChart ? 'Paper equity' : `${side} price`]}/>
        <Area type="linear" dataKey="price" stroke={color} strokeWidth={2.5} fill={`url(#tw-fill-${id})`} isAnimationActive={false}/>
        {!moneyChart && markers.map(position => <ReferenceDot key={position.id} x={position.time} y={position.side === side ? position.entry : 1 - position.entry} r={4} fill="#e9f0e0" stroke="#111612" strokeWidth={2} ifOverflow="extendDomain" label={{value: 'ENTRY', position: 'top', fill: '#b6c1ad', fontSize: 9}}/>)}
      </AreaChart>
    </ResponsiveContainer>
  </div>;
}

function CompactPortfolio({profile, onMarket}: {profile: Profile | null; onMarket: (position: Position) => void}) {
  const [filter, setFilter] = useState('ALL');
  const [view, setView] = useState<'open' | 'closed'>('open');
  if (!profile) return <div className="tw-empty">Paper account unavailable.</div>;
  const signals = Array.from(new Set(profile.positions.map(position => position.signal)));
  const selected = profile.positions.filter(position => filter === 'ALL' || position.signal === filter);
  const closed = selected.filter(position => position.status !== 'open');
  const open = selected.filter(position => position.status === 'open');
  const realized = closed.reduce((sum, position) => sum + positionValue(position) - position.amount, 0);
  const wins = closed.filter(position => positionValue(position) > position.amount).length;
  let balance = 100;
  const chart = filter === 'ALL' ? profile.equity : [
    {time: profile.equity[0]?.time ?? Date.now(), price: 100},
    ...[...closed].sort((a, b) => (a.closedAt ?? a.time) - (b.closedAt ?? b.time)).map(position => ({time: position.closedAt ?? position.time, price: balance += positionValue(position) - position.amount})),
  ];
  return <section className="tw-portfolio">
    <div className="tw-portfolio-header"><div><h2>Paper performance</h2></div><label className="tw-select-label">Signal <select aria-label="Performance signal" value={filter} onChange={event => setFilter(event.target.value)}><option value="ALL">All signals</option>{signals.map(signal => <option key={signal}>{signal}</option>)}</select></label></div>
    <div className="tw-performance-stats"><div><span>REALIZED P/L</span><strong className={realized < 0 ? 'tw-down' : 'tw-up'}>{signedMoney(realized)}</strong></div><div><span>CLOSED / OPEN</span><strong>{closed.length}<small> / {open.length}</small></strong></div><div><span>CLOSED WIN RATE</span><strong>{closed.length ? `${Math.round(wins / closed.length * 100)}%` : '—'}</strong></div><div><span>SAMPLE</span><strong>{selected.length}<small> positions</small></strong></div></div>
    <div className="tw-panel tw-performance-chart"><div className="tw-panel-heading"><h2>{filter === 'ALL' ? 'Paper equity' : 'Realized P/L · $100 reference'}</h2><span>{filter === 'ALL' ? 'Estimated exit fees included' : 'Open positions excluded'}</span></div><PriceChart points={chart} moneyChart/></div>
    <div className="tw-panel tw-signal-results"><div className="tw-panel-heading"><h2>Signal breakdown</h2><span>Paper results · sample sizes shown</span></div><div className="tw-table-scroll"><table><thead><tr><th>Signal</th><th>Closed</th><th>Open</th><th>Realized P/L</th><th>Win rate</th></tr></thead><tbody>{signals.map(signal => {
      const positions = profile.positions.filter(position => position.signal === signal);
      const finished = positions.filter(position => position.status !== 'open');
      const net = finished.reduce((sum, position) => sum + positionValue(position) - position.amount, 0);
      return <tr key={signal}><td>{signal}</td><td>{finished.length}</td><td>{positions.length - finished.length}</td><td className={net < 0 ? 'tw-down' : 'tw-up'}>{signedMoney(net)}</td><td>{finished.length ? `${Math.round(finished.filter(position => positionValue(position) > position.amount).length / finished.length * 100)}%` : '—'}</td></tr>;
    })}</tbody></table>{!signals.length && <div className="tw-table-empty">No paper positions recorded.</div>}</div></div>
    <div className="tw-panel tw-positions"><div className="tw-panel-heading"><div className="tw-mini-tabs"><button className={view === 'open' ? 'active' : ''} onClick={() => setView('open')}>Open · {open.length}</button><button className={view === 'closed' ? 'active' : ''} onClick={() => setView('closed')}>Closed · {closed.length}</button></div></div><PositionTable positions={view === 'open' ? open : closed} onMarket={onMarket}/></div>
  </section>;
}

function PositionTable({positions, onMarket}: {positions: Position[]; onMarket: (position: Position) => void}) {
  return <div className="tw-table-scroll"><table><thead><tr><th>Outcome</th><th>Qty</th><th>Entry</th><th>Value</th><th>Net P/L</th><th/></tr></thead><tbody>{positions.map(position => {
    const value = positionValue(position);
    return <tr key={position.id}><td><button className="tw-position-name" onClick={() => onMarket(position)}><span>{position.league} · {position.side}</span><b>{position.title}</b></button></td><td>{qty(position.contracts)}</td><td>{cents(position.entry)}</td><td>{money(value)}{position.status === 'open' && position.mark == null && <small>Entry fallback</small>}</td><td className={value - position.amount < 0 ? 'tw-down' : 'tw-up'}>{signedMoney(value - position.amount)}</td><td><button className="tw-table-action" onClick={() => onMarket(position)}>{position.status === 'open' ? 'Manage' : 'View'} <ChevronRight size={13}/></button></td></tr>;
  })}</tbody></table>{!positions.length && <div className="tw-table-empty">No positions.</div>}</div>;
}

export function TradingWorkspace({feed, markets, profile, onProfile, onRefresh, onRetryProfile, loading: feedLoading, error: feedError, profileError, tab, onTab, onWatch, onSettings, beginner, visible, target, onSimulation, onGame, onHelp, onPendingOrder}: Props) {
  const [selectedSlug, setSelectedSlug] = useState('');
  const [side, setSide] = useState<Side>('YES');
  const [range, setRange] = useState<DetailRange>('1h');
  const [detail, setDetail] = useState<MarketDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRevision, setDetailRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [draftEntry, setDraftEntry] = useState<string[]>(DEFAULT_SETTINGS.entryPresets.map(String));
  const [draftExit, setDraftExit] = useState<string[]>(DEFAULT_SETTINGS.exitPresets.map(String));
  const [draftDrift, setDraftDrift] = useState('2');
  const [amount, setAmount] = useState(10);
  const [customAmount, setCustomAmount] = useState(false);
  const [exitPercent, setExitPercent] = useState(100);
  const [lotId, setLotId] = useState('');
  const [busy, setBusy] = useState<'BUY' | 'SELL' | null>(null);
  const [receipt, setReceipt] = useState('');
  const [tradeError, setTradeError] = useState('');
  const [uncertainCommand, setUncertainCommand] = useState('');
  const [pendingRequest, setPendingRequest] = useState<PendingPaperRequest | null>(null);
  const [showBook, setShowBook] = useState(false);
  const [tradeAction,setTradeAction] = useState<'BUY'|'SELL'>('BUY');
  const [clock, setClock] = useState(Date.now());
  const [streamPoints, setStreamPoints] = useState<Point[]>([]);
  const submitting = useRef(false);
  const settingsLoaded = useRef(false);
  const requestId = useRef(0);
  const profileCallback = useRef(onProfile);
  profileCallback.current = onProfile;
  const activeTab = ['interesting', 'mlb', 'nfl', 'watchlist', 'portfolio'].includes(tab) ? tab : 'interesting';
  const watched = useCallback((market: Market) => !!profile?.watches.some(watch => watch.kind === 'market' && watch.key === market.slug || watch.kind === 'game' && watch.key === market.gameId || watch.kind === 'team' && market.teams.some(team => String(team.id) === watch.key)), [profile?.watches]);
  const available = useMemo(() => {
    const flagged = markets.filter(market => market.signals.length).sort((a, b) => (b.signals[0]?.score ?? 0) - (a.signals[0]?.score ?? 0));
    const base = activeTab === 'interesting' ? flagged.length ? flagged : markets.filter(market => market.league === 'MLB')
      : activeTab === 'watchlist' ? (feed?.games.flatMap(game => game.markets) ?? []).filter(watched)
      : activeTab === 'portfolio' ? markets : markets.filter(market => market.league === activeTab.toUpperCase());
    return base.filter(market => !query || `${market.game} ${market.title}`.toLowerCase().includes(query.toLowerCase()));
  }, [activeTab, markets, feed, watched, query]);
  const allMarkets = feed?.games.flatMap(game => game.markets) ?? markets;
  const held=profile?.positions.find(position=>position.slug===selectedSlug);
  const selected = selectedSlug ? allMarkets.find(market => market.slug === selectedSlug) ?? (held?heldMarket(held):null) : available[0] ?? null;
  const current = detail?.slug === selected?.slug ? detail : null;
  const streamEnabled = connection?.transport === 'stream' && connection.state === 'ready';
  const {quote: streamQuote, connected: streamConnected} = useMarketStream(selected?.slug ?? '', streamEnabled && visible);
  const streamed = streamQuote && selected && streamQuote.slug === selected.slug && streamQuote.valid && streamConnected ? streamQuote : null;
  const streamBook = streamed ? streamBookForDisplay(streamed) : null;
  const sourceBook = streamBook ?? current?.book;
  const book = sourceBook ? sideBook(sourceBook, side) : null;
  const ask = book?.asks[0]?.price ?? (side === 'YES' ? current?.quote?.ask : current?.quote?.bid == null ? null : 1 - current.quote.bid) ?? null;
  const bid = book?.bids[0]?.price ?? (side === 'YES' ? current?.quote?.bid : current?.quote?.ask == null ? null : 1 - current.quote.ask) ?? null;
  const recordedPoints = current?.range === range ? current.history : [];
  const latestRecorded = recordedPoints.at(-1)?.time ?? 0;
  const rangeWindow = range === '15m' ? 900000 : range === '1h' ? 3600000 : range === '6h' ? 21600000 : range === '24h' ? 86400000 : Infinity;
  const points = [...recordedPoints, ...streamPoints.filter(point => point.time > latestRecorded && point.time >= clock - rangeWindow)].map(point => ({...point, price: side === 'YES' ? point.price : 1 - point.price}));
  const change = deltaOf(points);
  const displayPrice = bid !== null && ask !== null ? (bid + ask) / 2 : points.at(-1)?.price ?? (selected?.price == null ? null : side === 'YES' ? selected.price : 1 - selected.price);
  const spread = bid !== null && ask !== null ? ask - bid : null;
  const outcome = selected ? side === 'YES' ? selected.title : selected.oppositeTitle || `NO · ${selected.title}` : '';
  const openPositions = profile?.positions.filter(position => position.status === 'open') ?? [];
  const selectedPositions = openPositions.filter(position => position.slug === selected?.slug && position.side === side);
  const lot = lotId ? selectedPositions.find(position => position.id === lotId) : selectedPositions[0];
  const equity = profile ? profile.cash + openPositions.reduce((sum, position) => sum + positionValue(position), 0) : null;
  const pnl = equity === null ? null : equity - 100;
  const rules = current?.executionRules;
  const protectedPrice = (price: number | null, action: 'BUY' | 'SELL') => {
    if (price === null || !rules) return null;
    try {return roundPriceToIncrement(action === 'BUY' ? Math.min(.9999, price + settings.maxPriceDrift) : Math.max(.0001, price - settings.maxPriceDrift), rules.priceIncrement, action === 'BUY' ? 'DOWN' : 'UP');} catch {return null;}
  };
  const buyLimit = protectedPrice(ask, 'BUY');
  const sellLimit = protectedPrice(bid, 'SELL');
  const exitQuantity = lot && rules ? Math.round(Math.floor((lot.contracts * exitPercent / 100 + 1e-9) / rules.quantityIncrement) * rules.quantityIncrement * 1e6) / 1e6 : 0;
  const previewOrder = (action: 'BUY' | 'SELL') => {
    const limitPrice = action === 'BUY' ? buyLimit : sellLimit;
    if (!selected || !sourceBook || !profile || !rules || limitPrice === null || action === 'BUY' && (!Number.isFinite(amount) || amount <= 0) || action === 'SELL' && !lot) return null;
    const now = Date.now();
    const command: PaperCommand = {commandId: 'display-preview', marketSlug: selected.slug, action, source: 'MANUAL', side, limitPrice, createdAt: now, ...(action === 'BUY' ? {budget: amount} : {positionId: lot?.id, quantity: exitQuantity})};
    const roundUp = (value: number) => Math.ceil(value * 1e6 - 1e-6) / 1e6;
    return executePaperCommand(command, {
      cash: Math.floor(profile.cash * 1e6 + 1e-6) / 1e6,
      marketExposure: roundUp(openPositions.filter(position => position.slug === selected.slug).reduce((sum, position) => sum + position.amount, 0)),
      totalExposure: roundUp(openPositions.reduce((sum, position) => sum + position.amount, 0)),
      availableQuantity: Math.floor((lot?.contracts ?? 0) * 1e6 + 1e-6) / 1e6,
    }, {slug: selected.slug, league: selected.league, active: sourceBook.state === 'MARKET_STATE_OPEN', ...rules}, sourceBook, {
      now, bookReceivedAt: now, bookSource: 'REST', stateCertain: true, maxBookAgeMs: 15000, maxCommandAgeMs: 20000,
      maxOrderBudget: 10000, maxMarketExposure: 10000, maxTotalExposure: 10000, automation: 'OFF',
    });
  };
  // Display-only previews. Submission independently reloads authoritative market/account data.
  const buyPreview = previewOrder('BUY');
  const sellPreview = previewOrder('SELL');
  const estimate = buyPreview ? {contracts: buyPreview.filledQty, fees: buyPreview.fees, total: -buyPreview.cashDelta} : null;
  const exitEstimate = sellPreview ? {net: sellPreview.cashDelta, complete: sellPreview.remainingQty === 0, filled: sellPreview.filledQty} : null;
  const stale = streamBook ? !streamConnected : !current || !!detailError || clock - (current.bookReceivedAt??current.retrievedAt) > 20_000;
  const commonBlock = feed?.replayAt || current?.replayAt ? 'Recorded capture · current orders unavailable' : busy ? 'Order submitting' : uncertainCommand ? 'Reconcile the pending order first' : !profile ? 'Paper account unavailable' : !selected ? 'Select a market' : stale ? 'Refresh the selected quote' : !rules ? 'Market execution rules unavailable' : !book ? 'Order book unavailable' : book.state !== 'MARKET_STATE_OPEN' ? 'Market closed' : spread !== null && spread < 0 ? 'Inconsistent quote · refresh required' : '';
  const buyBlock = commonBlock || (!Number.isFinite(amount) || amount < 1 ? 'Minimum amount: $1' : amount > (profile?.cash ?? 0) ? 'Insufficient paper cash' : !estimate?.contracts || buyLimit === null ? buyPreview?.reason || 'No offers within price limit' : '');
  const sellBlock = commonBlock || (!lot ? 'No position for this outcome' : sellLimit === null ? 'No buyers available' : !exitEstimate || exitEstimate.net <= 0 ? sellPreview?.reason || 'No buyers within price limit' : '');
  const sidePositions = profile?.positions.filter(position => position.slug === selected?.slug) ?? [];
  const marketWatched = !!profile?.watches.some(watch => watch.kind === 'market' && watch.key === selected?.slug);

  const loadTrading = useCallback(async () => {
    const response = await fetch('/api/trading', {cache: 'no-store', signal: AbortSignal.timeout(20000)});
    const data = await response.json() as TradingData & {error?: string};
    if (!response.ok) throw new Error(data.error || 'Trading account unavailable.');
    if (data.profile) profileCallback.current(data.profile);
    if (data.settings) {
      setSettings(data.settings);
      if(!settingsLoaded.current){setAmount(data.settings.entryPresets[1] ?? data.settings.entryPresets[0] ?? 10);settingsLoaded.current=true;}
    }
    if (data.status) setConnection(data.status);
    return data;
  }, []);

  useEffect(() => {
    void loadTrading().catch(error => setSettingsError(error instanceof Error ? error.message : 'Trading settings unavailable.'));
    try {
      setUncertainCommand(localStorage.getItem('dugout-pending-command') ?? '');
      const stored = JSON.parse(localStorage.getItem('dugout-pending-paper-request') ?? 'null') as PendingPaperRequest | null;
      if (stored?.body?.mode === 'paper' && typeof stored.body.commandId === 'string') setPendingRequest(stored);
    } catch {}
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loadTrading]);

  useEffect(() => {
    let canceled = false;
    const loadStatus = async () => {
      try {
        const response = await fetch('/api/trading/status', {cache: 'no-store', signal: AbortSignal.timeout(15000)});
        const data = await response.json() as Connection;
        if (response.ok && !canceled) setConnection(data);
      } catch { if (!canceled) setConnection(previous => previous ? {...previous, state: 'stale', message: 'Connection status unavailable.'} : null); }
    };
    void loadStatus();
    const timer = setInterval(() => { if (!document.hidden) void loadStatus(); }, 30000);
    return () => {canceled = true; clearInterval(timer);};
  }, []);

  useEffect(() => {setStreamPoints([]);}, [selected?.slug]);
  useEffect(() => {
    if (!streamed || streamed.price === null) return;
    setStreamPoints(previous => [...previous.filter(point => point.time < streamed.receivedAt), {time: streamed.receivedAt, price: streamed.price!}].slice(-5000));
  }, [streamed?.receivedAt, streamed?.slug, streamed?.price]);
  useEffect(()=>{
    if(streamed || !current || current.replayAt || feed?.replayAt || current.book?.asks[0]?.price==null)return;
    const time=current.bookReceivedAt??current.retrievedAt,price=current.book.asks[0].price;
    setStreamPoints(previous=>[...previous.filter(point=>point.time<time),{time,price}].slice(-5000));
  },[current?.bookReceivedAt,current?.retrievedAt,current?.slug,feed?.replayAt,streamed]);

  useEffect(() => {
    if (!selected || !visible || activeTab === 'portfolio') return;
    let canceled = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const slug = selected.slug;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const sequence = ++requestId.current;
      setDetailLoading(true);
      try {
        const response = await fetch(`/api/market?slug=${encodeURIComponent(slug)}&range=${range}`, {cache: 'no-store', signal: controller.signal});
        const data = await response.json() as MarketDetailData & {error?: string};
        if (!response.ok) throw new Error(data.error || 'Market unavailable.');
        if (!canceled && requestId.current === sequence) {setDetail(data); setDetailError(''); setClock(Date.now());}
      } catch (error) {
        if (!canceled && requestId.current === sequence) setDetailError(error instanceof Error ? error.message : 'Market unavailable.');
      } finally {inFlight = false; if (!canceled && requestId.current === sequence) setDetailLoading(false);}
    };
    void load();
    const timer = setInterval(() => {if (!document.hidden) void load();}, streamEnabled ? 30000 : 5000);
    return () => {canceled = true; controller?.abort(); clearInterval(timer);};
  }, [selected?.slug, range, detailRevision, streamEnabled, visible, activeTab]);

  useEffect(()=>{if(target){setSelectedSlug(target.slug);setSide(target.side);setLotId(target.positionId??'');setTradeAction(target.action);setTradeError('');}},[target?.revision]);

  useEffect(()=>{onPendingOrder(uncertainCommand?{slug:pendingRequest?.body.slug??'',side:pendingRequest?.body.side??'YES',commandId:uncertainCommand}:null)},[uncertainCommand,pendingRequest?.body.slug,pendingRequest?.body.side,onPendingOrder]);

  const selectMarket = (market: Market, selectedSide: Side = 'YES', positionId = '') => {
    setSelectedSlug(market.slug); setSide(selectedSide); setLotId(positionId); setTradeError(''); setReceipt('');setTradeAction(positionId?'SELL':'BUY');
  };
  const viewPosition = (position: Position) => {
    const market = allMarkets.find(candidate => candidate.slug === position.slug)??heldMarket(position);
    if (market) {selectMarket(market, position.side, position.id); onTab(position.league.toLowerCase()); setQuery('');}
    else setTradeError('This market is outside the current feed. Refresh markets to retry.');
  };
  const changeTab = (value: string) => {onTab(value); setQuery(''); setSelectedSlug(''); setSide('YES'); setLotId(''); setTradeError('');};
  const openPresets = () => {
    setDraftEntry(settings.entryPresets.map(String)); setDraftExit(settings.exitPresets.map(String)); setDraftDrift(String(settings.maxPriceDrift * 100)); setSettingsError(''); setSettingsOpen(true);
  };
  const saveSettings = async () => {
    const entries = draftEntry.map(Number), exits = draftExit.map(Number), drift = Number(draftDrift) / 100;
    if (entries.some(value => !Number.isFinite(value) || value < 1 || value > 10000) || exits.some(value => !Number.isFinite(value) || value <= 0 || value > 100) || !exits.includes(100) || !Number.isFinite(drift) || drift < 0 || drift > .1) {setSettingsError('Use entry amounts from $1–$10,000, exits from 1–100% including a 100% preset, and price tolerance from 0–10¢.'); return;}
    setSettingsBusy(true); setSettingsError('');
    try {
      const next = {entryPresets: entries, exitPresets: exits, maxPriceDrift: drift};
      const response = await fetch('/api/trading/settings', {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(next)});
      const data = await response.json() as Settings & {settings?: Settings; error?: string};
      if (!response.ok) throw new Error(data.error || 'Could not save presets.');
      if(!customAmount && !entries.includes(amount))setAmount(entries[Math.max(0,settings.entryPresets.indexOf(amount))] ?? entries[0]);
      if(!exits.includes(exitPercent))setExitPercent(100);
      setSettings(data.settings ?? next); setSettingsOpen(false);
    } catch (error) {setSettingsError(error instanceof Error ? error.message : 'Could not save presets.');}
    finally {setSettingsBusy(false);}
  };
  const clearPending = () => {setUncertainCommand(''); setPendingRequest(null); try {localStorage.removeItem('dugout-pending-command'); localStorage.removeItem('dugout-pending-paper-request');} catch {}};
  const reconcile = async () => {
    setTradeError('');
    try {
      const data = await loadTrading();
      const order = data.orders?.find(order => order.commandId === uncertainCommand);
      if (order && !['submitting', 'pending', 'unknown', 'SUBMITTING', 'PENDING', 'UNKNOWN'].includes(order.status ?? order.state ?? 'unknown')) {
        setReceipt(`Paper order ${String(order.status ?? order.state).toLowerCase().replaceAll('_', ' ')}.`); clearPending();
      } else setTradeError('Order status is not confirmed yet. New entries remain blocked.');
    } catch (error) {setTradeError(error instanceof Error ? error.message : 'Could not reconcile order.');}
  };
  const sendPaperRequest = async (request: PendingPaperRequest) => {
    if (submitting.current || request.body.mode !== 'paper') return;
    const {action, commandId} = request.body;
    submitting.current = true; setBusy(action); setTradeError(''); setReceipt(''); setUncertainCommand(commandId); setPendingRequest(request);
    try {localStorage.setItem('dugout-pending-command', commandId); localStorage.setItem('dugout-pending-paper-request', JSON.stringify(request));} catch {}
    let confirmed = false;
    try {
      const response = await fetch('/api/trading/orders', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request.body), signal: AbortSignal.timeout(30000)});
      const data = await response.json() as {profile?: Profile; order?: OrderReceipt; error?: string};
      confirmed = response.status < 500;
      if (!response.ok) throw new Error(data.error || 'Paper order rejected.');
      if (data.profile) onProfile(data.profile);
      const status = data.order?.status ?? data.order?.state ?? 'unknown';
      if (['submitting', 'pending', 'unknown'].includes(status.toLowerCase())) {confirmed = false; throw new Error('Order is awaiting reconciliation.');}
      const filled = data.order?.filledQuantity ?? data.order?.quantity;
      if (['rejected', 'unfilled'].includes(status.toLowerCase())) {
        setTradeError(data.order?.reason || `Paper order ${status}. Nothing filled.`);
      } else {
        setReceipt(`${action === 'BUY' ? 'Entry' : 'Exit'} ${String(status).toLowerCase().replaceAll('_', ' ')}${filled != null ? ` · ${qty(filled)} contracts` : ''}${status.toLowerCase() === 'partial' ? ' · remainder canceled' : ''} · ${request.outcome}`);
      }
      setDetailRevision(value => value + 1);
    } catch (error) {
      setTradeError(confirmed ? error instanceof Error ? error.message : 'Paper order rejected.' : 'Order response interrupted. Reconcile before submitting again.');
    } finally {
      if (confirmed) clearPending();
      submitting.current = false; setBusy(null);
    }
  };
  const submit = async (action: 'BUY' | 'SELL') => {
    if (submitting.current || (action === 'BUY' ? buyBlock : sellBlock) || !selected) return;
    const limitPrice = action === 'BUY' ? buyLimit : sellLimit;
    if (limitPrice === null) return;
    await sendPaperRequest({body: {commandId: crypto.randomUUID(), action, slug: selected.slug, side, ...(action === 'BUY' ? {amount} : {positionId: lot?.id, percent: exitPercent}), limitPrice, mode: 'paper'}, outcome, createdAt: Date.now()});
  };
  const tabItems = [{value: 'mlb', label: 'MLB', icon: CircleDot}, {value: 'nfl', label: 'NFL', icon: Trophy}, {value: 'watchlist', label: 'Watchlist', icon: Bookmark}, {value: 'interesting', label: 'Scanner', icon: Flame}];

  return <main className="trading-workspace" hidden={!visible}>
    <div className="tw-section-heading"><div><h1>{activeTab === 'portfolio' ? 'Your results' : 'Manual trading'}</h1>{beginner && <p>{activeTab === 'portfolio' ? 'All your paper positions, including bot trades.' : 'Choose a game, inspect the chart, then enter or exit.'}</p>}</div>{activeTab === 'portfolio' && <button className="secondary-action" onClick={onSimulation}><FlaskConical size={16}/> $10 MLB experiment</button>}</div>
    {activeTab !== 'portfolio' && <div className="tw-topline">
      <nav aria-label="Trading navigation">{tabItems.map(({value, label, icon: Icon}) => <button key={value} className={activeTab === value ? 'active' : ''} aria-current={activeTab === value ? 'page' : undefined} onClick={() => changeTab(value)}><Icon size={16}/>{label}{value === 'interesting' && markets.filter(market => market.signals.length).length > 0 && <span>{markets.filter(market => market.signals.length).length}</span>}</button>)}</nav>
      <div className="tw-connection" title={connection?.message ?? 'Checking market connection'}><i className={connection?.transport === 'stream' && connection.state === 'ready' ? 'ready' : ''}/>{feed?.replayAt ? 'RECORDED CAPTURE' : connection?.transport === 'stream' && connection.state === 'ready' ? 'Streaming' : connection?.state === 'stale' ? 'Connection stale' : 'REST snapshots'}<button className="tw-icon" aria-label="Refresh markets" disabled={feedLoading} onClick={onRefresh}><RefreshCw size={14} className={feedLoading ? 'spin' : ''}/></button></div>
    </div>}
    <div className="tw-account-bar"><div><span>Equity</span><b>{equity === null ? '—' : money(equity)}</b></div><div><span>Cash</span><b>{profile ? money(profile.cash) : '—'}</b></div><div><span>Net P/L</span><b className={pnl === null ? '' : pnl < 0 ? 'tw-down' : 'tw-up'}>{pnl === null ? '—' : signedMoney(pnl)}</b></div><div className="tw-open-count"><span>Open</span><b>{openPositions.length}</b></div></div>
    {(feedError || profileError) && <div className="tw-notice" role="alert"><span>{feedError || profileError}</span><button onClick={feedError ? onRefresh : onRetryProfile}>Retry</button></div>}
    {tradeError && activeTab === 'portfolio' && <div className="tw-notice" role="alert">{tradeError}</div>}
    {activeTab === 'portfolio' ? <CompactPortfolio profile={profile} onMarket={viewPosition}/> : <div className="tw-grid">
      <aside className="tw-market-rail" aria-label="Market selection">
        <div className="tw-rail-heading"><b>{activeTab === 'interesting' ? markets.some(market => market.signals.length) ? 'Scanner observations' : 'No flags · browsing MLB' : activeTab === 'watchlist' ? 'Watching' : `${activeTab.toUpperCase()} games`} <span>{available.length}</span></b><button className="tw-icon" onClick={onSettings} aria-label="Scanner thresholds"><SlidersHorizontal size={14}/></button></div>
        <label className="tw-search"><Search size={14}/><input aria-label="Search markets" placeholder="Find a team or market" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button onClick={() => setQuery('')} aria-label="Clear market search"><X size={13}/></button>}</label>
        <div className="tw-market-list">
          {available.map(market => {
            const movement = deltaOf(market.history);
            const down = movement !== null && movement < 0;
            return <button className={`tw-market-row ${selected?.slug === market.slug ? 'selected' : ''}`} key={market.slug} onClick={() => selectMarket(market)} aria-pressed={selected?.slug === market.slug}>
              <span className="tw-row-meta">{market.league}<span>{new Date(market.start).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}</span>{watched(market) && <Bookmark size={10} fill="currentColor"/>}</span>
              <b className="tw-row-game">{market.game}</b><span className="tw-row-outcome">{market.title}</span>
              <span className="tw-row-prices"><strong>{cents(market.price)}</strong>{market.history.length > 1 ? <Sparkline points={market.history} down={down}/> : <span className="tw-no-history">No history</span>}<span className={down ? 'tw-down' : 'tw-up'}>{movement === null ? '—' : `${movement >= 0 ? '+' : ''}${movement.toFixed(1)}`}<small>pts</small></span></span>
              {!!market.signals.length && <span className={`tw-row-signal ${down ? 'negative' : ''}`}>{down ? <ArrowDownRight size={11}/> : <ArrowUpRight size={11}/>} {market.signals[0].type}</span>}
            </button>;
          })}
          {!available.length && <div className="tw-rail-empty">{feedLoading && !feed ? 'Loading markets…' : query ? 'No matches.' : activeTab === 'interesting' ? 'No scanner flags.' : activeTab === 'watchlist' ? 'No watched markets.' : 'No markets available.'}{activeTab !== 'mlb' && <button onClick={() => changeTab('mlb')}>Browse MLB <ChevronRight size={13}/></button>}</div>}
        </div>
      </aside>
      <section className="tw-market-main">
        {!selected ? <div className="tw-no-selection"><CircleDot size={32}/><h1>Select a market.</h1><button onClick={() => changeTab('mlb')}>MLB games <ArrowUpRight size={16}/></button></div> : <>
          <div className="tw-market-header"><div><span className="tw-kicker">{selected.league} <i/> {selected.start?gameTime(selected.start):'Recorded position'}</span><h1>{selected.game}</h1>{selected.gameId&&<button className="tw-game-info" onClick={()=>onGame(selected)}>Game details <ChevronRight size={13}/></button>}</div><button onClick={() => onWatch(selected)} className={`tw-watch ${marketWatched ? 'active' : ''}`} aria-label={marketWatched ? 'Unwatch market' : 'Watch market'}><Bookmark size={18} fill={marketWatched ? 'currentColor' : 'none'}/></button></div>
          <div className="tw-outcomes" role="group" aria-label="Select outcome">{(['YES', 'NO'] as const).map(value => <button key={value} className={side === value ? 'active' : ''} aria-pressed={side === value} onClick={() => {setSide(value); setLotId(''); setTradeError('');}}>{!beginner && <span>{value}</span>}{value === 'YES' ? selected.title : selected.oppositeTitle || `Not ${selected.title}`}{side === value && <Check size={15}/>}</button>)}</div>
          {allMarkets.filter(market => market.gameId === selected.gameId).length > 1 && <label className="tw-related">Market <select aria-label="Markets for selected game" value={selected.slug} onChange={event => {const market = allMarkets.find(candidate => candidate.slug === event.target.value); if (market) selectMarket(market);}}>{allMarkets.filter(market => market.gameId === selected.gameId).map(market => <option key={market.slug} value={market.slug}>{market.title}</option>)}</select><ChevronDown size={13}/></label>}
          <div className="tw-chart-top"><div className="tw-hero-price"><strong><span className="tw-price-source">{beginner?"MARKET VIEW":bid !== null && ask !== null ? "MID PRICE" : "PRICE"}</span>{cents(displayPrice)}</strong><div className={change !== null && change < 0 ? 'tw-down' : 'tw-up'}>{change === null ? <span>—</span> : <><span>{change < 0 ? <ArrowDownRight size={17}/> : <ArrowUpRight size={17}/>} {change >= 0 ? '+' : ''}{change.toFixed(1)} pts</span><small>{range === 'ALL' ? 'recorded history' : `last ${range}`}</small></>}</div></div><div className="tw-range" role="group" aria-label="Chart time range">{RANGES.map(value => <button key={value} className={range === value ? 'active' : ''} aria-pressed={range === value} onClick={() => setRange(value)}>{value}</button>)}</div></div>
          <PriceChart points={points} positions={sidePositions} side={side}/>
          <div className="tw-chart-foot"><span><i className={stale ? 'stale' : ''}/>{feed?.replayAt || current?.replayAt ? `Captured ${time(feed?.replayAt ?? current!.replayAt!)}` : streamBook ? `Quote ${time(streamed!.receivedAt)}` : detailLoading && !current ? 'Loading quote' : current ? `Quote ${time(current.bookReceivedAt??current.retrievedAt)}` : 'Awaiting quote'}{feed?.replayAt || current?.replayAt ? ' · RECORDED CAPTURE' : streamBook ? ' · WebSocket' : ' · REST / 5s'}</span><button onClick={() => setDetailRevision(value => value + 1)} disabled={detailLoading} aria-label="Refresh selected market"><RefreshCw size={12}/></button><span>{points.length} observations</span></div>
          {detailError && <div className="tw-inline-error" role="alert">{detailError}</div>}
          <div className="tw-quote-strip"><div><span>{beginner?'Sell price':'BID'}</span><b className="tw-up">{cents(bid)}</b></div><div><span>{beginner?'Buy price':'ASK'}</span><b>{cents(ask)}</b></div><div><span>Spread {beginner&&<button className="tw-help" aria-label="Explain spread" onClick={()=>onHelp('Spread')}>?</button>}</span><b>{cents(spread)}</b></div><div><span>VOLUME</span><b>{current?.quote?.volume == null ? '—' : qty(current.quote.volume)}</b></div></div>
          {!!selected.signals.length && <div className="tw-signals">{selected.signals.map(signal => <span key={signal.type} title={signal.reason}>{signal.type}</span>)}</div>}
          <button className="tw-depth-toggle" aria-expanded={showBook} onClick={() => setShowBook(value => !value)}><Layers3 size={14}/> {beginner?'Show buyers and sellers':'Order book'} <ChevronDown size={14} className={showBook ? 'expanded' : ''}/></button>
          <SportsContextPanel markets={markets} slug={selected.slug} visible={visible && activeTab!=='portfolio'} beginner={beginner} compact/>
          {showBook && <div className="tw-depth">{(['bids', 'asks'] as const).map(bookSide => <div key={bookSide}><div className="tw-depth-heading"><b>{bookSide === 'bids' ? 'BID' : 'ASK'}</b><span>QTY</span></div>{(book?.[bookSide] ?? []).slice(0, 6).map(level => <div key={level.price} className={`tw-depth-row ${bookSide}`}><i style={{width: `${Math.min(100, level.quantity / Math.max(1, ...book![bookSide].slice(0, 6).map(entry => entry.quantity)) * 100)}%`}}/><b>{cents(level.price)}</b><span>{qty(level.quantity)}</span></div>)}{!book?.[bookSide].length && <span className="tw-depth-empty">No levels</span>}</div>)}</div>}
        </>}
      </section>
      <aside className="tw-execution" aria-label="Order controls">
        <div className="tw-order-heading"><span>YOUR ORDER</span><button onClick={openPresets} className="tw-icon" aria-label="Edit trading presets"><Pencil size={14}/></button></div>
        <h2>{outcome || 'Select an outcome'}</h2>
        <div className="tw-action-tabs" role="group" aria-label="Order action"><button className={tradeAction==='BUY'?'active':''} onClick={()=>setTradeAction('BUY')}>Enter</button><button className={tradeAction==='SELL'?'active exit':''} onClick={()=>setTradeAction('SELL')}>Exit{selectedPositions.length>0?` · ${selectedPositions.length}`:''}</button></div>
        {tradeAction==='BUY' ? <><div className="tw-control-label"><span>Amount</span><button onClick={openPresets}>Edit presets</button></div>
        <div className="tw-presets">{settings.entryPresets.map((value, index) => <button key={`${value}-${index}`} className={!customAmount && amount === value ? 'active' : ''} onClick={() => {setAmount(value); setCustomAmount(false);}}>{money(value).replace('.00', '')}</button>)}<button className={customAmount ? 'active' : ''} onClick={() => setCustomAmount(true)}>Custom</button></div>
        {customAmount && <label className="tw-custom-amount">$<input type="number" min="1" step="0.01" aria-label="Custom entry amount" value={Number.isFinite(amount) ? amount : ''} onChange={event => setAmount(event.target.value === '' ? NaN : Number(event.target.value))}/></label>}
        <div className="tw-order-estimates"><div><span>{beginner?'Contracts':'Est. quantity'}</span><b>{estimate?.contracts ? qty(estimate.contracts) : '—'}</b></div><div><span>Est. fees</span><b>{estimate?.contracts ? money(estimate.fees) : '—'}</b></div><div><span>Price limit</span><b>{cents(buyLimit)}</b></div><div><span>Est. spend</span><b>{estimate?.contracts ? money(estimate.total) : '—'}</b></div></div>
        <button className="tw-ape-in" onClick={() => submit('BUY')} disabled={!!buyBlock} title={buyBlock || 'Submit a paper entry with a price limit'}>{busy === 'BUY' ? <Loader2 size={17} className="spin"/> : <ArrowUpRight size={17}/>} {beginner?'Paper buy':'Ape In'} <span>· {Number.isFinite(amount) ? money(amount).replace('.00', '') : '—'}</span></button>
        {!!buyBlock && !busy && <p className="tw-block-reason">{buyBlock}</p>}
        </> : <div className="tw-exit-section"><div className="tw-control-label"><span>EXIT POSITION</span><b>{lot ? `${qty(lot.contracts)} held` : 'No position'}</b></div>
          {(selectedPositions.length > 1 || (lotId && !lot && selectedPositions.length > 0)) && <select className="tw-lot-select" aria-label="Position to exit" value={lot?.id ?? ''} onChange={event => setLotId(event.target.value)}>{!lot&&<option value="" disabled>Choose an open position</option>}{selectedPositions.map(position => <option key={position.id} value={position.id}>{qty(position.contracts)} @ {cents(position.entry)} · {time(position.time)}</option>)}</select>}
          <div className="tw-presets tw-exit-presets">{settings.exitPresets.map((value, index) => <button key={`${value}-${index}`} className={exitPercent === value ? 'active' : ''} onClick={() => setExitPercent(value)}>{value}%</button>)}</div>
          <div className="tw-order-estimates"><div><span>Exit quantity</span><b>{lot ? qty(exitQuantity) : '—'}</b></div><div><span>Min exit price</span><b>{cents(sellLimit)}</b></div><div><span>Est. net proceeds</span><b>{exitEstimate ? money(exitEstimate.net) : '—'}</b></div></div>
          <button className="tw-ape-out" onClick={() => submit('SELL')} disabled={!!sellBlock} title={sellBlock || 'Submit a paper exit with a price limit'}>{busy === 'SELL' ? <Loader2 size={17} className="spin"/> : <ArrowDownRight size={17}/>} {beginner?'Paper sell':'Ape Out'} <span>· {exitPercent}%</span></button>
          {!!sellBlock && !busy && <p className="tw-block-reason">{sellBlock}</p>}
        </div>}
        <div className="tw-execution-note">Paper only · estimates include fees</div>
        {receipt && <div className="tw-receipt" role="status"><Check size={14}/><span>{receipt}</span></div>}
        {tradeError && <div className="tw-inline-error" role="alert">{tradeError}</div>}
        {uncertainCommand && !busy && <div className="tw-recovery"><button className="tw-reconcile" onClick={reconcile}><RefreshCw size={14}/> Reconcile order</button>{pendingRequest?.body.commandId === uncertainCommand && <><p>{pendingRequest.body.action} · {pendingRequest.outcome} · {pendingRequest.body.action === 'BUY' ? money(pendingRequest.body.amount ?? 0) : `${pendingRequest.body.percent}%`} · {time(pendingRequest.createdAt)}</p><button className="tw-reconcile" onClick={() => sendPaperRequest(pendingRequest)}>Retry same paper order</button><small>Same command and price limit. Previously recorded fills cannot be applied twice.</small></>}</div>}
      </aside>
      <details className="tw-panel tw-open-positions"><summary>Open positions <span>{openPositions.length}</span></summary><PositionTable positions={openPositions} onMarket={viewPosition}/><button className="tw-results-link" onClick={()=>changeTab('portfolio')}>All results <ChevronRight size={14}/></button></details>
    </div>}
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent className="tw-settings-dialog"><DialogTitle>Trading presets</DialogTitle><DialogDescription>Saved to your paper account. Changing presets does not submit an order.</DialogDescription><div className="tw-preset-editor"><h3>Entry amounts · $</h3><div>{draftEntry.map((value, index) => <label key={index}><span>Preset {index + 1}</span><input type="number" min="1" step=".01" value={value} aria-label={`Entry preset ${index + 1}`} onChange={event => setDraftEntry(values => values.map((old, at) => at === index ? event.target.value : old))}/></label>)}</div><h3>Exit amounts · %</h3><div>{draftExit.map((value, index) => <label key={index}><span>Preset {index + 1}</span><input type="number" min="1" max="100" step="1" value={value} aria-label={`Exit preset ${index + 1}`} onChange={event => setDraftExit(values => values.map((old, at) => at === index ? event.target.value : old))}/></label>)}</div><h3>Price tolerance · ¢</h3><label className="tw-drift-input"><input type="number" min="0" max="10" step=".1" aria-label="Maximum price tolerance in cents" value={draftDrift} onChange={event => setDraftDrift(event.target.value)}/><span>From the displayed ask / bid</span></label></div>{settingsError && <p className="tw-inline-error" role="alert">{settingsError}</p>}<button className="tw-save-settings" disabled={settingsBusy} onClick={saveSettings}>{settingsBusy ? 'Saving…' : 'Save presets'}</button></DialogContent></Dialog>
  </main>;
}
