'use client';

import {useEffect, useState} from 'react';
import {FlaskConical, RefreshCw, ArrowUpRight, ArrowDownRight, Clock3} from 'lucide-react';
import type {SimulationView} from '@/lib/simulation/types';
import './mlb-simulation.css';

const dollars = (value: number) => `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
const signed = (value: number) => `${value > 0 ? '+' : ''}${dollars(value)}`;
const easternTime = (value: number | string) => new Date(value).toLocaleTimeString('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const easternDate = (value: number | string) => new Date(value).toLocaleDateString('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
});

export default function MlbSimulation() {
  const [data, setData] = useState<SimulationView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/simulation');
      if (!response.ok) throw new Error('The test could not be loaded. Please retry.');
      setData(await response.json() as SimulationView);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'The test could not be loaded. Please retry.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, []);

  if (!data) return <section className="mlb-test mlb-test-loading" aria-live="polite">
    <FlaskConical size={30}/><h1>The $10 MLB test</h1>
    <p>{error || 'Loading the actual entries and checking official results…'}</p>
    {error && <button onClick={() => void refresh()} disabled={busy}>Retry</button>}
  </section>;

  const {run, positions, summary} = data;
  const fullySettled = positions.length > 0 && summary.pending === 0;
  return <section className="mlb-test">
    <div className="mlb-test-intro">
      <div><span className="eyebrow"><FlaskConical size={15}/> A SEPARATE PAPER EXPERIMENT</span>
        <h1>The $10 MLB test<span>.</span></h1>
        <p>The app chose these test entries using one fixed rule. They are separate from the practice picks you choose.</p>
      </div>
      <span className="mlb-test-date">{easternDate(run.startedAt)}<small>Games dated in New York time</small></span>
    </div>

    <div className="mlb-test-recipe">
      <strong>The rule: follow the biggest recent moves.</strong>
      <p>Up to five games. At most $2 per game, including estimated fees. A rise in a market’s YES price tests its named team; a fall tests the opponent. Hold until the official result.</p>
      <small>Each contract pays $1 if its team wins, $0 if it loses. This tests a simple rule; it is not a recommendation or evidence that the rule works.</small>
    </div>

    <div className="mlb-test-stats">
      <div><span>STARTED WITH</span><strong>{dollars(run.bankroll)}</strong><small>Play money</small></div>
      <div><span>{fullySettled ? 'FINAL TOTAL' : 'LAST ESTIMATED TOTAL'}</span><strong>{summary.value === null ? 'Unavailable' : dollars(summary.value)}</strong><small>{dollars(summary.cash)} cash {fullySettled ? 'after results' : '+ open entries'}</small></div>
      <div><span>{fullySettled ? 'FINAL PROFIT / LOSS' : 'ESTIMATED PROFIT / LOSS'}</span><strong className={summary.pnl === null ? '' : summary.pnl >= 0 ? 'up' : 'down'}>{summary.pnl === null ? '—' : signed(summary.pnl)}</strong><small>{summary.settled} settled · {summary.pending} waiting for results</small></div>
    </div>

    {!fullySettled && <p className="mlb-test-value-note">This estimates what selling now would return. The price gap and fees can put it below $10 before any game ends.</p>}

    <div className="mlb-test-status">
      <div><Clock3 size={17}/><p>{fullySettled ? 'All entries have official results.' : 'Results are pending until Polymarket US settles each market.'}<small>Entries captured at {easternTime(run.completedAt)} · {dollars(run.spent)} used · {dollars(run.cash)} left unspent</small></p></div>
      <button disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} className={busy ? 'mlb-test-spin' : ''}/>{busy ? 'Checking…' : 'Check results'}</button>
    </div>
    {(error || data.warning) && <p className="mlb-test-warning" role="status">{error || data.warning}</p>}

    <div className="mlb-test-entries">
      {positions.map((position, index) => <article className="mlb-test-entry" key={position.id}>
        <div className="mlb-test-entry-top"><span>TEST {index + 1} · {easternTime(position.start)}</span><span className={position.status === 'settled' ? 'settled' : 'pending'}>{position.status === 'settled' ? 'Official result' : 'Result pending'}</span></div>
        <h2>{position.game}</h2>
        <p className="mlb-test-choice">Testing: <strong>{position.outcome} to win</strong></p>
        <p className="mlb-test-reason">{position.movePoints > 0 ? <ArrowUpRight size={17}/> : <ArrowDownRight size={17}/>}<span>{position.reason}</span></p>
        <div className="mlb-test-entry-numbers">
          <div><span>SIMULATED COST</span><strong>{dollars(position.amount)}</strong><small>{position.contracts} contracts at {(position.average * 100).toFixed(1)}¢</small></div>
          <div><span>{position.status === 'settled' ? 'FINAL PAYOUT' : 'IF THIS TEAM WINS'}</span><strong>{dollars(position.status === 'settled' ? position.payout ?? 0 : position.contracts)}</strong><small>{position.status === 'settled' ? `${signed((position.payout ?? 0) - position.amount)} final P/L` : `${signed(position.contracts - position.amount)} profit; lose ${dollars(position.amount)} if wrong`}</small></div>
        </div>
        <details><summary>Entry details & current estimate</summary><dl>
          <div><dt>Entry captured</dt><dd>{easternDate(position.time)}, {easternTime(position.time)}</dd></div>
          <div><dt>Estimated buying fee</dt><dd>{dollars(position.fee)} included in cost</dd></div>
          <div><dt>{position.status === 'settled' ? 'Final value' : 'Last estimated selling value'}</dt><dd>{position.currentValue === null ? 'No full exit estimate available' : dollars(position.currentValue)}</dd></div>
          <div><dt>Value as of</dt><dd>{position.valueAsOf ? `${easternDate(position.valueAsOf)}, ${easternTime(position.valueAsOf)}` : 'Unavailable'}</dd></div>
          <div><dt>Market side</dt><dd>{position.side} · {position.outcome}</dd></div>
          <div><dt>US market identifier</dt><dd className="mlb-test-slug">{position.slug}</dd></div>
        </dl>{position.quoteError && <p className="mlb-test-warning">{position.quoteError}</p>}</details>
      </article>)}
      {!positions.length && <div className="mlb-test-empty"><h2>No entries met the rule.</h2><p>The full $10 stays in cash. Missing data never becomes an invented pick.</p></div>}
    </div>

    <details className="mlb-test-method"><summary>See the full rule, coverage & skipped games</summary>
      <p>{run.rule}</p>
      <p>This separate movement test ranks any nonzero change, including changes smaller than the scanner’s usual alert threshold. An opposite team’s actual buying price also depends on the gap between buyers and sellers.</p>
      <p><strong>{run.coverage.todayGames} games</strong> were listed for {run.date} in New York time. <strong>{run.coverage.eligibleGames}</strong> had eligible movement history. <strong>{positions.length}</strong> were entered.</p>
      <p>Scanned {run.coverage.eventsFetched} official league events.{run.coverage.capReached ? ' The 100-event cap was reached; coverage may be incomplete.' : ''} A game’s date comes from its event start time; a rescheduled market can retain an older date in its identifier.</p>
      <p>Whole contracts are filled against real captured order-book prices and available quantities. Fees are estimates using each market’s coefficient; per-fill rounding, queue changes, and execution latency can differ in real trading. Cash is not reinvested. Unsettled selling values include estimated exit fees, so the total can start below $10.</p>
      <p><strong>{positions.length} entries is a tiny sample.</strong> One day cannot show that a scanner rule is useful. Prices describe what traders are offering, not a forecast the app independently verified.</p>
      {run.skipped.length > 0 && <ul>{run.skipped.map((item, index) => <li key={`${item.slug}-${index}`}><strong>{item.game}</strong> — {item.reason}</li>)}</ul>}
      {run.coverage.errors.length > 0 && <p>Some listing requests failed; the run may not cover the entire slate.</p>}
      <p>Source: <a href="https://docs.polymarket.us/api-reference/introduction" target="_blank" rel="noreferrer">official Polymarket US public API</a>. Entries are a dated real-data capture, never presented as live quotes. “Check results” updates valuations and settlement; it does not choose new entries.</p>
    </details>
  </section>;
}
