import {PolymarketUS} from 'polymarket-us';
import capturedRun from '@/data/mlb-simulation-2026-09-23.json';
import {db} from '@/lib/server/storage';
import {sideBook, simulateSell} from '@/lib/market/paper';
import {simulationView} from '@/lib/simulation/ledger';
import type {Book} from '@/lib/market/types';
import type {SimulationEntry, SimulationObservation, SimulationRun} from '@/lib/simulation/types';

const run = capturedRun as SimulationRun;
const sdk = new PolymarketUS({timeout: 6500});
const TTL = 60000;
type Raw = Record<string, any>;
const numeric = (value: unknown) => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

async function observe(entry: SimulationEntry): Promise<SimulationObservation> {
  const key = `simulation:observation:${entry.id}`;
  const settledKey = `simulation:settlement:${entry.id}`;
  const rows = await db().batch([
    db().prepare('SELECT value,updated FROM cache WHERE key=?').bind(key),
    db().prepare('SELECT value,updated FROM cache WHERE key=?').bind(settledKey),
  ]);
  const old = rows[0].results[0] as {value: string; updated: number} | undefined;
  const final = rows[1].results[0] as {value: string; updated: number} | undefined;
  if (final) return JSON.parse(final.value) as SimulationObservation;
  const previous: SimulationObservation = old ? JSON.parse(old.value) : {
    checkedAt: run.completedAt, settlement: null, settledAt: null,
    mark: entry.entryLiquidation, markedAt: entry.time, error: null,
  };
  if (old && Date.now() - old.updated < TTL) return previous;
  const results = await Promise.allSettled([
    sdk.markets.settlement(entry.slug),
    sdk.markets.book(entry.slug),
  ]);
  const now = Date.now();
  const next: SimulationObservation = {...previous, checkedAt: now, error: null};
  const settlementResponse = results[0];
  if (settlementResponse.status === 'fulfilled') {
    const settlement = numeric((settlementResponse.value as unknown as Raw).settlement);
    if (settlement !== null && settlement >= 0 && settlement <= 1) {
      next.settlement = settlement;
      next.settledAt = now;
      // An immutable result key prevents a concurrent, slower pending response replacing settlement.
      await db().prepare('INSERT OR IGNORE INTO cache(key,value,updated) VALUES(?,?,?)')
        .bind(settledKey, JSON.stringify(next), now).run();
      const saved = await db().prepare('SELECT value FROM cache WHERE key=?').bind(settledKey).first<{value: string}>();
      return saved ? JSON.parse(saved.value) : next;
    }
    next.error = 'The official result is not available yet.';
  } else if ((settlementResponse.reason as {status?: number})?.status !== 404) {
    next.error = 'The latest result check could not reach Polymarket US.';
  }
  const bookResponse = results[1];
  if (bookResponse.status === 'fulfilled') {
    const raw = (bookResponse.value as unknown as Raw).marketData;
    const levels = (values: Raw[]) => (values || [])
      .map(level => ({price: numeric(level.px?.value), quantity: numeric(level.qty)}))
      .filter(level => level.price !== null && level.price > 0 && level.price < 1 && level.quantity !== null && level.quantity > 0)
      .map(level => ({price: level.price!, quantity: level.quantity!}));
    if (raw && raw.state === 'MARKET_STATE_OPEN') {
      const book: Book = {bids: levels(raw.bids), asks: levels(raw.offers), state: raw.state, time: raw.transactTime || ''};
      const value = simulateSell(sideBook(book, entry.side), entry.contracts, entry.coefficient);
      if (value.complete) { next.mark = value.net; next.markedAt = now; }
      else next.error = 'The latest book has too few buyers for a complete exit. Showing the last available estimate.';
    } else next.error = 'The market is paused or closed. Waiting for its official result; the value shown is an earlier estimate.';
  } else next.error = 'Live quotes are unavailable. Showing the last available estimate while results remain pending.';
  await db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated WHERE excluded.updated > cache.updated')
    .bind(key, JSON.stringify(next), now).run();
  return next;
}

export async function GET() {
  if (import.meta.env.DEV) {
    return Response.json(simulationView(run, {}, run.completedAt,
      'Development preview: these are the real entries captured on September 23. Live quotes and results are not checked in this preview; estimates are from the entry snapshot.'),
    {headers: {'Cache-Control': 'private, no-store'}});
  }
  const observations: Record<string, SimulationObservation> = {};
  let failed = false;
  // At most two entries at a time: four public requests, with one-minute caching.
  for (let offset = 0; offset < run.entries.length; offset += 2) {
    await Promise.all(run.entries.slice(offset, offset + 2).map(async entry => {
      try { observations[entry.id] = await observe(entry); }
      catch { failed = true; }
    }));
  }
  const warning = failed
    ? 'Live result updates are temporarily unavailable. Entries are preserved; affected values are the estimates captured when this test started.'
    : Object.values(observations).some(observation => observation.error)
      ? 'Some live updates are unavailable. Check the “value as of” time on each entry.'
      : null;
  return Response.json(simulationView(run, observations, Date.now(), warning), {
    headers: {'Cache-Control': 'private, no-store'},
  });
}
