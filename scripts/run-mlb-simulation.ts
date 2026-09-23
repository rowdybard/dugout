/**
 * One deliberate, immutable run. Public Polymarket US reads only; no account or order API.
 * NODE_USE_ENV_PROXY=1 node --experimental-strip-types scripts/run-mlb-simulation.ts
 * Refuses to overwrite a run. Date uses America/New_York and official event startTime.
 */
import {mkdir, writeFile, access} from 'node:fs/promises';
import {PolymarketUS} from 'polymarket-us';
import {simulateBuy, simulateSell, sideBook, DEFAULT_FEE} from '../lib/market/paper.ts';
import type {Book, Point} from '../lib/market/types.ts';
import type {SimulationRun} from '../lib/simulation/types.ts';

type Raw = Record<string, any>;
const BASE = 'https://gateway.polymarket.us';
const sdk = new PolymarketUS({timeout: 20000});
const timezone = 'America/New_York';
const dateKey = (time: number | string) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(time));
const startedAt = Date.now();
const date = dateKey(startedAt);
const output = new URL(`../data/mlb-simulation-${date}.json`, import.meta.url);
try { await access(output); throw new Error(`Run already exists: ${output.pathname}. Entries are immutable.`); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const num = (value: unknown) => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const pause = () => new Promise(resolve => setTimeout(resolve, 120));
async function get(path: string): Promise<Raw> {
  await pause();
  const response = await fetch(BASE + path, {signal: AbortSignal.timeout(25000)});
  if (!response.ok) throw new Error(`Official US API returned HTTP ${response.status}`);
  return response.json() as Promise<Raw>;
}
const run: SimulationRun = {
  id: `mlb-${date}-ten-dollar-movement-v1`, date, timezone, startedAt, completedAt: startedAt,
  bankroll: 10, maxBudget: 2, maxPositions: 5,
  rule: 'Before first pitch, rank today’s available full-game-winner markets by absolute YES-price change over the last hour. Follow the direction: YES after an increase, NO after a decrease. Ties use earlier start time, then market slug. Buy up to five games with a maximum $2 each, including estimated fees. Skip flat, missing, stale, or unfillable markets. Hold until official settlement.',
  source: BASE,
  coverage: {eventsFetched: 0, todayGames: 0, eligibleGames: 0, capReached: false, errors: []},
  entries: [], skipped: [], cash: 10, fees: 0, spent: 0,
};
const events = new Map<string, Raw>();
let finishedPages = false;
for (let offset = 0; offset < 100; offset += 20) {
  try {
    const response = await get(`/v2/leagues/mlb/events?type=sport&limit=20&offset=${offset}`);
    if (!Array.isArray(response.events)) throw new Error('Official league response has no events array.');
    let added = 0;
    for (const event of response.events) {
      if (!events.has(String(event.id))) { events.set(String(event.id), event); added++; }
    }
    console.log(`Read page ${offset}: ${response.events.length} events.`);
    if (response.events.length < 20 || !added) { finishedPages = true; break; }
  } catch (error) { run.coverage.errors.push(String(error)); break; }
}
run.coverage.capReached = !finishedPages && events.size >= 100;
run.coverage.eventsFetched = events.size;
const today = [...events.values()].filter(event => {
  const time = Date.parse(event.startTime);
  return Number.isFinite(time) && dateKey(time) === date;
});
run.coverage.todayGames = today.length;
const candidates: {event: Raw; market: Raw; points: Point[]; delta: number}[] = [];
for (const event of today) {
  const market = (event.markets || []).find((item: Raw) => item.sportsMarketType === 'baseball_team_full_game_winner' && item.active === true && !item.closed && !item.hidden);
  const skip = (reason: string) => run.skipped.push({game: event.title, slug: market?.slug, reason});
  if (Date.parse(event.startTime) <= Date.now() || event.closed || event.ended) { skip('Already started or closed before the run.'); continue; }
  if (!market?.slug) { skip('No active full-game-winner market was returned.'); continue; }
  if (!(market.marketSides || []).some((side: Raw) => side.long === true && side.description) || !(market.marketSides || []).some((side: Raw) => side.long === false && side.description)) { skip('The official YES/NO outcome labels are missing.'); continue; }
  try {
    const history = await get(`/v1/price-history?${new URLSearchParams({symbol: market.slug, fixedInterval: 'INTERVAL_1H', fidelity: '1'})}`);
    const now = Date.now();
    const points: Point[] = (history.history || []).map((point: Raw) => ({time: Number(point.timestamp) * 1000, price: num(point.longPrice)}))
      .filter((point: Point) => Number.isFinite(point.time) && point.time >= now - 65 * 60000 && point.time <= now + 60000 && point.price !== null && point.price >= 0 && point.price <= 1)
      .sort((a: Point, b: Point) => a.time - b.time);
    if (points.length < 2 || points.at(-1)!.time - points[0].time < 45 * 60000) { skip('Fewer than 45 minutes of valid recent price history.'); continue; }
    if (now - points.at(-1)!.time > 5 * 60000) { skip('Latest history observation is more than five minutes old.'); continue; }
    const delta = points.at(-1)!.price - points[0].price;
    if (Math.abs(delta) < 0.000001) { skip('The observed price did not change over this window.'); continue; }
    candidates.push({event, market, points, delta});
    console.log(`${event.title}: ${(delta * 100).toFixed(2)} points over ${Math.round((points.at(-1)!.time - points[0].time) / 60000)} min.`);
  } catch (error) { skip(`History unavailable: ${String(error)}`); }
}
run.coverage.eligibleGames = candidates.length;
candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || Date.parse(a.event.startTime) - Date.parse(b.event.startTime) || a.market.slug.localeCompare(b.market.slug));
for (const candidate of candidates) {
  const {event, market, points, delta} = candidate;
  const skip = (reason: string) => run.skipped.push({game: event.title, slug: market.slug, reason});
  if (run.entries.length >= run.maxPositions) { skip('Outside the top five fillable markets under the stated rule.'); continue; }
  try {
    await pause();
    const response = await sdk.markets.book(market.slug) as unknown as Raw;
    const raw = response.marketData;
    const time = Date.now();
    if (time >= Date.parse(event.startTime)) { skip('First pitch passed before an entry could be captured.'); continue; }
    if (!raw || raw.state !== 'MARKET_STATE_OPEN') { skip('The official order book was not open.'); continue; }
    const levels = (values: Raw[]) => (values || []).map(level => ({price: num(level.px?.value), quantity: num(level.qty)}))
      .filter(level => level.price !== null && level.price > 0 && level.price < 1 && level.quantity !== null && level.quantity > 0)
      .map(level => ({price: level.price!, quantity: level.quantity!}));
    const book: Book = {bids: levels(raw.bids), asks: levels(raw.offers), state: raw.state, time: raw.transactTime || ''};
    const side = delta > 0 ? 'YES' as const : 'NO' as const;
    const outcome = market.marketSides.find((value: Raw) => value.long === (side === 'YES')).description;
    const coefficient = num(market.feeCoefficient) ?? DEFAULT_FEE;
    if (coefficient < 0 || coefficient > 1) { skip('The market fee coefficient is outside the expected range.'); continue; }
    const chosenBook = sideBook(book, side);
    const fill = simulateBuy(chosenBook, Math.min(run.maxBudget, run.cash), coefficient);
    if (!fill.contracts) { skip('The available asks could not fill one whole contract within the $2 budget.'); continue; }
    const liquidation = simulateSell(chosenBook, fill.contracts, coefficient);
    const minutes = Math.round((points.at(-1)!.time - points[0].time) / 60000);
    run.entries.push({
      id: `${run.id}:${market.slug}`, gameId: String(event.id), slug: market.slug, game: event.title,
      start: event.startTime, outcome, side, signal: delta > 0 ? 'PRICE MOVING' : 'PRICE DROPPING',
      reason: `${market.marketSides.find((value: Raw) => value.long === true).description}’s YES display price ${delta > 0 ? 'rose' : 'fell'} from ${(points[0].price * 100).toFixed(1)}¢ to ${(points.at(-1)!.price * 100).toFixed(1)}¢ over ${minutes} minutes. The rule follows that direction.`,
      time, budget: Math.min(run.maxBudget, run.cash), contracts: fill.contracts, cost: fill.cost,
      fee: fill.fees, amount: fill.total, average: fill.average, coefficient, movePoints: delta * 100,
      history: points, book, entryLiquidation: liquidation.complete ? liquidation.net : null,
    });
    run.cash -= fill.total;
    run.fees += fill.fees;
    run.spent += fill.total;
    console.log(`SIMULATED ${outcome}: ${fill.contracts} ${side} contracts, $${fill.total.toFixed(4)} incl. estimated fees.`);
  } catch (error) { skip(`Order book unavailable: ${String(error)}`); }
}
run.completedAt = Date.now();
await mkdir(new URL('../data/', import.meta.url), {recursive: true});
await writeFile(output, JSON.stringify(run, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({file: output.pathname, entries: run.entries.length, spent: run.spent, fees: run.fees, cash: run.cash, coverage: run.coverage}, null, 2));
