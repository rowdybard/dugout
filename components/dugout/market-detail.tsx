'use client';

import {useEffect, useId, useRef, useState} from 'react';
import {
  ArrowDown,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  Info,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {Sheet, SheetContent, SheetTitle, SheetDescription} from '@/components/ui/sheet';
import {Tabs, TabsList, TabsTrigger} from '@/components/ui/tabs';
import {BeliefChart} from './chart';
import {cents, gameTime, number} from './market-card';
import type {Market, Profile} from '@/lib/market/types';
import type {DetailRange, MarketDetailData} from '@/lib/market/detail';
import {simulateBuy, sideBook} from '@/lib/market/paper';
import './market-detail.css';

type MarketDetailProps = {
  market: Market | null;
  close: () => void;
  profile: Profile | null;
  onProfile: (profile: Profile) => void;
  onHelp: (term: string) => void;
  onWatch: () => void;
  beginner: boolean;
  onViewPortfolio?: () => void;
  profileError?: string;
  onRetryProfile?: () => void;
  watched?: boolean;
};

const ranges: DetailRange[] = ['15m', '1h', '6h', '24h', 'ALL'];
const MAX_QUOTE_AGE = 90_000;
const timeLabel = (time: number) => new Date(time).toLocaleTimeString([], {
  hour: 'numeric', minute: '2-digit', second: '2-digit',
});

export function MarketDetail({
  market,
  close,
  profile,
  onProfile,
  onHelp,
  onWatch,
  beginner,
  onViewPortfolio,
  profileError,
  onRetryProfile,
  watched,
}: MarketDetailProps) {
  const [side, setSide] = useState<'YES' | 'NO'>('YES');
  const [range, setRange] = useState<DetailRange>('1h');
  const [data, setData] = useState<MarketDetailData | null>(null);
  const [requestError, setRequestError] = useState('');
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState(10);
  const [custom, setCustom] = useState(false);
  const [showBook, setShowBook] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedOutcome, setSavedOutcome] = useState('');
  const [saveError, setSaveError] = useState('');
  const [uncertainSave, setUncertainSave] = useState(false);
  const [retry, setRetry] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const requestSequence = useRef(0);
  const submitting = useRef(false);
  const currentSlug = useRef(market?.slug);
  const calculator = useRef<HTMLElement>(null);
  const calculatorTitle = useRef<HTMLHeadingElement>(null);
  const statusId = useId();
  currentSlug.current = market?.slug;

  useEffect(() => {
    setData(null);
    setSide('YES');
    setRange('1h');
    setAmount(10);
    setCustom(false);
    setRequestError('');
    setSaveError('');
    setSaved(false);
    setSavedOutcome('');
    setUncertainSave(false);
    setShowBook(false);
  }, [market?.slug]);

  useEffect(() => {
    if (!market) return;
    let canceled = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const slug = market.slug;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const sequence = ++requestSequence.current;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/market?slug=${encodeURIComponent(slug)}&range=${range}`,
          {signal: controller.signal, cache: 'no-store'},
        );
        const result = await response.json() as MarketDetailData & {error?: string};
        if (!response.ok) throw new Error(result.error || 'Market details could not be loaded.');
        if (!canceled && sequence === requestSequence.current) {
          setData(result);
          setRequestError('');
          setClock(Date.now());
        }
      } catch (error) {
        if (!canceled && sequence === requestSequence.current) {
          setRequestError(error instanceof Error ? error.message : 'Market details could not be loaded.');
        }
      } finally {
        inFlight = false;
        if (!canceled && sequence === requestSequence.current) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => {
      setClock(Date.now());
      if (!document.hidden) void load();
    }, 30_000);
    return () => {
      canceled = true;
      controller?.abort();
      clearInterval(timer);
    };
  }, [market?.slug, range, retry]);

  if (!market) return null;
  const m = market;
  const detail = data?.slug === m.slug ? data : null;
  const chartReady = detail?.range === range;
  const points = chartReady ? detail.history : [];
  const price = detail?.quote?.ask ?? null;
  const bid = detail?.quote?.bid ?? null;
  const first = points[0];
  const last = points.at(-1);
  const delta = first && last && points.length > 1 ? (last.price - first.price) * 100 : null;
  const stale = !!detail && (!!requestError || clock - detail.retrievedAt > MAX_QUOTE_AGE);
  const validAmount = Number.isFinite(amount) && amount >= 1;
  const estimate = detail?.book && validAmount
    ? simulateBuy(sideBook(detail.book, side), amount, m.fee)
    : null;
  const selectedOutcome = side === 'YES' ? m.title : m.oppositeTitle || `${m.title}: no`;
  const activity = detail?.activity || [];
  const rates = activity.slice(1).map((point, index) => ({
    time: point.time,
    rate: Math.max(0, point.volume - activity[index].volume)
      / Math.max(1, (point.time - activity[index].time) / 60_000),
  }));
  const largestRate = Math.max(1, ...rates.map(point => point.rate));

  let unavailableReason = '';
  if (uncertainSave) unavailableReason = 'Check your saved picks before trying again. We could not confirm the last save.';
  else if (!detail && loading) unavailableReason = 'Loading the available offers for your practice pick…';
  else if (requestError) unavailableReason = 'Refresh the market before saving a practice pick.';
  else if (stale) unavailableReason = 'These offers need a refresh before you can save a practice pick.';
  else if (!detail?.book) unavailableReason = detail?.warnings.book || 'Current offers are unavailable. Refresh to try again.';
  else if (detail.book.state !== 'MARKET_STATE_OPEN') unavailableReason = 'This market is not currently open for new practice picks.';
  else if (!profile) unavailableReason = profileError || 'Your practice balance has not loaded yet.';
  else if (!validAmount) unavailableReason = 'Enter a budget of at least $1.';
  else if (amount > profile.cash) unavailableReason = `Your available practice balance is $${profile.cash.toFixed(2)}. Choose a smaller amount.`;
  else if (!estimate?.contracts) unavailableReason = 'There are no whole contracts available within this budget for that outcome.';

  const jumpToCalculator = () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    calculator.current?.scrollIntoView({behavior: reduceMotion ? 'auto' : 'smooth', block: 'start'});
    calculatorTitle.current?.focus({preventScroll: true});
  };

  const submit = async () => {
    if (submitting.current || unavailableReason || saved) return;
    submitting.current = true;
    setBusy(true);
    setSaveError('');
    const slug = m.slug;
    let receivedResponse = false;
    try {
      const response = await fetch('/api/portfolio', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'buy', slug, budget: amount, side}),
      });
      const result = await response.json() as Profile & {error?: string};
      receivedResponse = true;
      if (!response.ok) throw new Error(result.error || 'Your practice pick could not be saved.');
      onProfile(result);
      if (currentSlug.current === slug) {
        setSavedOutcome(selectedOutcome);
        setSaved(true);
      }
    } catch (error) {
      if (currentSlug.current === slug) {
        setSaveError(receivedResponse && error instanceof Error
          ? error.message
          : 'The connection was interrupted before we could confirm your save.');
        setUncertainSave(!receivedResponse);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={open => !open && close()}>
      <SheetContent className="market-sheet">
        <div className="sheet-body">
          <div className="eyebrow">{m.league} <span> / </span> MARKET INFORMATION</div>
          <SheetTitle className="detail-title">{m.title}</SheetTitle>
          <SheetDescription className="detail-game">
            {m.game} · {gameTime(m.start)}
          </SheetDescription>

          <div className="detail-guide">
            <p><b>You’re exploring a market.</b> It becomes your pick only when you save a practice pick below.</p>
            <button onClick={jumpToCalculator}>Try a practice pick <ArrowDown size={16}/></button>
          </div>

          <div className="detail-step"><span>1</span><h2>What is the market saying?</h2></div>
          {requestError && (
            <div className="detail-notice detail-notice-error" role="alert">
              <div><b>Some details could not refresh.</b><p>{requestError} {detail && 'Previously retrieved data stays visible below.'}</p></div>
              <button onClick={() => setRetry(value => value + 1)} disabled={loading}>
                <RefreshCw size={15}/> Retry
              </button>
            </div>
          )}
          {!detail && loading && (
            <div className="detail-loading" role="status"><Loader2 className="spin" size={17}/> Loading prices and price history…</div>
          )}
          {detail?.warnings.quote && (
            <div className="detail-notice" role="status">
              <p>{detail.warnings.quote} Any available history is still shown below.</p>
              <button onClick={() => setRetry(value => value + 1)} disabled={loading}>Retry prices</button>
            </div>
          )}

          <div className="detail-score">
            <div>
              <strong>{price === null ? '—' : number(price * 100)}{price !== null && <span>%</span>}</strong>
              <p>{price === null ? 'Current price unavailable' : `Roughly ${number(price * 100)}% implied chance`}
                <button className="help-inline" onClick={() => onHelp('Market belief')} aria-label="Explain implied chance">?</button>
              </p>
              {price !== null && <small>{cents(price)} to buy this outcome {stale ? '· last retrieved price' : ''}</small>}
            </div>
            {delta !== null && (
              <div className={delta < 0 ? 'down' : delta > 0 ? 'up' : 'neutral'}>
                {delta < 0 ? <ArrowDownRight size={22}/> : delta > 0 ? <ArrowUpRight size={22}/> : <ArrowRight size={22}/>}
                <b>{delta > 0 ? '+' : ''}{number(delta)} points</b>
                <small>Chart: {number(first.price * 100)}% → {number(last!.price * 100)}%</small>
              </div>
            )}
          </div>

          <div className="chart-heading">
            <span>HOW THE MARKET’S VIEW CHANGED</span>
            <Tabs value={range} onValueChange={value => setRange(value as DetailRange)}>
              <TabsList className="range-tabs">
                {ranges.map(value => <TabsTrigger key={value} value={value}>{value}</TabsTrigger>)}
              </TabsList>
            </Tabs>
          </div>
          {!chartReady && loading
            ? <div className="detail-chart-loading" role="status"><Loader2 className="spin" size={20}/> Loading {range} history…</div>
            : <BeliefChart points={points}/>}
          <p className="chart-caption">
            This line tracks the price of “{m.title}.” Higher means the market priced it as more likely.
            It is the market’s view, not a prediction from Dugout.
          </p>
          {chartReady && detail?.warnings.history && <p className="detail-small-warning">{detail.warnings.history}</p>}

          <div className="detail-reason">
            <Info size={19}/>
            <div>
              <b>{m.signals[0] ? `WHY THE SCANNER NOTICED IT · ${m.signals[0].type}` : 'NO SCANNER FLAG'}</b>
              <p>{m.signals[0]?.reason || 'You’re browsing this game’s market information. No unusual behavior was flagged in the latest scan.'}</p>
            </div>
          </div>

          <div className="quote-grid">
            <div>
              <span>{beginner ? 'SELLERS CURRENTLY WANT' : 'BEST ASK'} <button onClick={() => onHelp('Buying price')} aria-label="Explain buying price">?</button></span>
              <strong>{cents(price)}</strong>
              <small>Starting price to buy “{m.title}”</small>
            </div>
            <div>
              <span>{beginner ? 'BUYERS ARE OFFERING' : 'BEST BID'} <button onClick={() => onHelp('Selling price')} aria-label="Explain selling price">?</button></span>
              <strong>{cents(bid)}</strong>
              <small>Starting price to sell it back</small>
            </div>
          </div>
          <div className="spread-line">
            <span>Gap between prices <button className="help-inline" onClick={() => onHelp('Spread')} aria-label="Explain the price gap">?</button></span>
            <div className="spread-track"><i style={{width: `${price !== null && bid !== null ? Math.max(0, Math.min(100, (price - bid) * 1000)) : 0}%`}}/></div>
            <b>{price !== null && bid !== null ? cents(price - bid) : '—'}</b>
          </div>

          <section className="calculator" ref={calculator} aria-labelledby={`${statusId}-title`}>
            <div className="detail-step"><span>2</span><h2>Try it with pretend money</h2></div>
            <div className="section-title">
              <h3 id={`${statusId}-title`} ref={calculatorTitle} tabIndex={-1}>What would ${validAmount ? amount : 0} mean?</h3>
              <span className="paper-label">NO REAL MONEY</span>
            </div>
            <p className="practice-instruction">Choose the outcome you want to practice picking.</p>
            <Tabs value={side} onValueChange={value => {setSide(value as 'YES' | 'NO'); setSaveError('');}}>
              <TabsList className="side-tabs" aria-label="Choose your practice outcome">
                <TabsTrigger value="YES" disabled={busy || saved}>{m.title}</TabsTrigger>
                <TabsTrigger value="NO" disabled={busy || saved}>{m.oppositeTitle || `${m.title}: no`}</TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="side-caption">Your choice: <b>{selectedOutcome}</b>. The chart above always tracks “{m.title}.”</p>
            <div className="amount-buttons" aria-label="Practice budget">
              {[5, 10, 25].map(value => (
                <button className={amount === value && !custom ? 'active' : ''} aria-pressed={amount === value && !custom} disabled={busy || saved} key={value} onClick={() => {setAmount(value); setCustom(false); setSaveError('');}}>${value}</button>
              ))}
              <button className={custom ? 'active' : ''} aria-pressed={custom} disabled={busy || saved} onClick={() => setCustom(true)}>Custom</button>
            </div>
            {custom && (
              <label className="custom-budget">Your budget $
                <input type="number" min="1" step="0.01" disabled={busy || saved} value={Number.isFinite(amount) ? amount : ''} onChange={event => {setAmount(Number(event.target.value)); setSaveError('');}}/>
              </label>
            )}
            <div className="calc-stats">
              <div><span>You’re risking</span><strong>${estimate?.total.toFixed(2) ?? '—'}</strong></div>
              <div><span>Contracts you would hold <button onClick={() => onHelp('Contract')} aria-label="Explain a contract">?</button></span><strong>{estimate?.contracts ?? '—'}</strong></div>
            </div>
            <div className="outcome-boxes">
              <div>
                <span>IF YOUR CHOICE WINS</span>
                <b>${estimate?.contracts.toFixed(2) ?? '—'} payout</b>
                <small className="up">+${estimate ? (estimate.contracts - estimate.total).toFixed(2) : '—'} profit</small>
              </div>
              <div>
                <span>IF YOUR CHOICE LOSES</span>
                <b>$0 payout</b>
                <small className="down">−${estimate?.total.toFixed(2) ?? '—'} loss</small>
              </div>
            </div>
            <p className="calc-note">
              {estimate
                ? `Includes estimated fees of $${estimate.fees.toFixed(2)}. $${estimate.unused.toFixed(2)} of your budget stays unspent. Uses available offers, rounded down to whole contracts; prices may change before saving.`
                : 'The estimate needs current seller offers. We won’t invent a buying price.'}
              {' '}Canceled games follow the official settlement rules.
            </p>
            <button
              className="primary-action"
              disabled={busy || saved || !!unavailableReason}
              onClick={() => void submit()}
              aria-describedby={statusId}
            >
              {busy ? <Loader2 className="spin" size={18}/> : saved ? <Check size={18}/> : '＋'}
              {busy ? 'Saving your practice pick…' : saved ? 'Practice pick saved' : 'Save practice pick'}
              <span>Available ${profile?.cash.toFixed(2) ?? '—'}</span>
            </button>
            <div id={statusId} className="practice-status" aria-live="polite">
              {saved ? (
                <div className="practice-saved">
                  <p><Check size={16}/> “{savedOutcome}” is now one of your picks. Track its result in your portfolio.</p>
                  {onViewPortfolio && <button onClick={onViewPortfolio}>See my practice picks <ArrowRight size={16}/></button>}
                  <button className="practice-another" onClick={() => setSaved(false)}>Make another practice pick</button>
                </div>
              ) : unavailableReason && !busy ? (
                <p>{unavailableReason}</p>
              ) : <p>Saving records a simulated purchase. No real order is placed.</p>}
            </div>
            {saveError && <p role="alert" className="error-message">{saveError}</p>}
            {!saved && !busy && (
              <div className="practice-recovery">
                {(!detail?.book || stale || requestError) && <button onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={14}/>{loading ? 'Loading offers…' : 'Retry market data'}</button>}
                {!profile && onRetryProfile && <button onClick={onRetryProfile}><RefreshCw size={14}/> Retry my balance</button>}
                {uncertainSave && onViewPortfolio && <button onClick={onViewPortfolio}>Check my practice picks <ArrowRight size={14}/></button>}
              </div>
            )}
          </section>

          {detail && (
            <div className="market-context">
              <span>Available contracts <button className="help-inline" onClick={() => onHelp('Liquidity')} aria-label="Explain available contracts">?</button><b>{detail.quote?.depth === null || detail.quote?.depth === undefined ? 'Not supplied' : detail.quote.depth.toLocaleString()}</b></span>
              <span>Trading activity <button className="help-inline" onClick={() => onHelp('Activity')} aria-label="Explain trading activity">?</button><b>{detail.warnings.activity ? 'Temporarily unavailable' : rates.length ? 'Observed contracts / minute' : 'Collecting observations'}</b></span>
            </div>
          )}
          {rates.length > 0 && (
            <div className="activity-bars" aria-label="Observed trading activity per minute">
              {rates.map(point => <div key={point.time} title={`${timeLabel(point.time)}: ${point.rate.toFixed(0)} contracts/minute`} style={{height: `${Math.max(2, point.rate / largestRate * 100)}%`}}/>)}
            </div>
          )}
          <button className="book-toggle" onClick={() => setShowBook(value => !value)} aria-expanded={showBook}>
            {showBook ? 'Hide' : 'Show'} available buyer and seller offers <ChevronDown size={18}/>
          </button>
          {showBook && (
            <section className="book">
              <p>This is the order book for “{m.title}.” It shows offers available at each price. Offers can be canceled.</p>
              {!detail?.book ? <p>{loading ? 'Loading available offers…' : detail?.warnings.book || 'Available offers are currently unavailable.'}</p> : (
                <div className="book-columns">
                  {(['bids', 'asks'] as const).map(bookSide => {
                    const levels = detail.book![bookSide];
                    const largest = Math.max(1, ...levels.map(level => level.quantity));
                    return (
                      <div key={bookSide}>
                        <h4>{bookSide === 'bids' ? 'BUYERS ARE OFFERING' : 'SELLERS WANT'}</h4>
                        {levels.slice(0, 8).map((level, index) => (
                          <div key={index} className={`book-level ${bookSide}`}>
                            <i style={{width: `${level.quantity / largest * 100}%`}}/>
                            <span>{cents(level.price)}</span><b>{level.quantity.toLocaleString()} contracts</b>
                          </div>
                        ))}
                        {!levels.length && <p>No displayed offers on this side.</p>}
                      </div>
                    );
                  })}
                </div>
              )}
              <p>The longest bar marks the largest displayed concentration on that side. It does not tell us who is right.</p>
            </section>
          )}
          <details className="rules">
            <summary>Game context & what decides the result</summary>
            <p>{detail?.question || m.question}</p>
            <p>{detail?.rules || m.rules || (loading ? 'Loading official settlement rules…' : 'Official settlement rules are currently unavailable. Retry market data to request them again.')}</p>
            {m.teams.map(team => <p key={team.id}>{team.name}: {team.record || 'Record not supplied'}</p>)}
            <p>Pitchers, lineups, injuries and weather are not connected in V1.</p>
          </details>
          <button className="watch-detail" onClick={onWatch}>
            <Bookmark size={17}/>{watched === undefined ? 'Change my market watchlist' : watched ? 'Stop watching this market' : 'Watch this market'}
          </button>
          <div className="source-note">
            {detail?.replayAt ? `DEVELOPMENT REPLAY · Quotes recorded ${new Date(detail.replayAt).toLocaleString()}` : 'Polymarket US'}
            {' · '}{detail ? `Retrieved ${timeLabel(detail.retrievedAt)}${stale ? ' · refresh needed' : ''}` : 'Waiting for current data'}
            {' · '}Refreshes every 30 seconds while open
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
