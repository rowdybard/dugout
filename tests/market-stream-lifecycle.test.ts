import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {StreamState} from '../services/trading/state.ts';
import type {StreamSelection} from '../lib/trading/stream-types.ts';

const START = Date.parse('2026-09-26T12:00:00.000Z');
const selection: StreamSelection = {slug: 'synthetic-cfb-market', league: 'CFB', detail: 'book'};
const book = (at: number) => ({
  requestId: 'synthetic-subscription', subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA',
  marketData: {
    marketSlug: selection.slug, state: 'MARKET_STATE_OPEN',
    bids: [{px: {value: '0.52', currency: 'USD'}, qty: '100'}],
    offers: [{px: {value: '0.54', currency: 'USD'}, qty: '100'}],
    stats: {lastTradePx: {value: '0.53', currency: 'USD'}},
    transactTime: new Date(at).toISOString(),
  },
});

function harness() {
  let now = START, nextTimer = 0;
  const scheduled = new Map<number, {at: number; interval: number | null; run: () => void}>();
  const schedule = (run: () => void, delay: number, interval: number | null) => {
    const id = ++nextTimer;
    scheduled.set(id, {at: now + delay, interval, run});
    return id;
  };
  const setTimeoutFake = (run: () => void, delay: number) => schedule(run, delay, null);
  const setIntervalFake = (run: () => void, delay: number) => schedule(run, delay, delay);
  const clearFake = (id: number) => {scheduled.delete(id);};
  const settle = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
  const advance = async (duration: number) => {
    const until = now + duration;
    while (true) {
      const due = [...scheduled.entries()].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.interval === null) scheduled.delete(id);
      else scheduled.set(id, {...timer, at: now + timer.interval});
      timer.run();
      await settle();
    }
    now = until;
    await settle();
  };
  class TestState extends StreamState {
    constructor(configured: boolean) {super(configured, () => now);}
    // Transport health is covered elsewhere; keep the synthetic upstream alive until its planned refresh.
    override checkHealth() {return [] as ('market' | 'private')[];}
  }
  class FakeDate extends Date {static override now() {return now;}}
  type Listener = (event: {data?: string}) => void;
  const listeners = new Map<string, Listener[]>();
  const socket = {
    binaryType: '', accepted: false, closed: false, subscriptions: [] as string[],
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    accept() {this.accepted = true;},
    send(payload: string) {this.subscriptions.push(payload);},
    close() {this.closed = true;},
    dispatch(type: string, data?: string) {
      for (const listener of listeners.get(type) ?? []) listener({data});
    },
  };
  type Save = {connection: {id: string; active: boolean; updatedAt: number}; quotes: unknown[]};
  const saves: Save[] = [];
  let holdNextSave: Promise<void> | undefined;
  const saveStreamBooks = async (connection: Save['connection'], quotes: unknown[]) => {
    saves.push({connection, quotes});
    if (holdNextSave) {
      const held = holdNextSave;
      holdNextSave = undefined;
      await held;
    }
  };
  const script = ts.transpileModule(readFileSync(new URL('../lib/server/polymarket-market-stream.ts', import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const loadedModule = {exports: {} as Record<string, unknown>};
  runInNewContext(script, {
    module: loadedModule, exports: loadedModule.exports, crypto, Date: FakeDate, TextEncoder, TextDecoder,
    Response, ReadableStream, AbortController, AbortSignal,
    setTimeout: setTimeoutFake, clearTimeout: clearFake,
    setInterval: setIntervalFake, clearInterval: clearFake,
    fetch: async () => ({status: 101, webSocket: socket}),
    require: (name: string) => ({
      'cloudflare:workers': {env: {}},
      '../trading/credentials': {polymarketSecrets: () => ({keyId: 'test', secretKey: 'test'})},
      '../trading/us-signature': {marketSocketHeaders: async () => ({})},
      '../../services/trading/state': {StreamState: TestState},
      './stream-books': {saveStreamBooks},
    })[name] ?? {},
  });
  const marketStream = loadedModule.exports.marketStream as (request: Request, selections: StreamSelection[]) => Promise<Response>;
  const controller = new AbortController();
  const request = new Request('https://dugout.test/api/tennis/stream', {signal: controller.signal});
  const open = async () => {
    const response = await marketStream(request, [selection]);
    assert.equal(response.status, 200);
    const chunks: string[] = [];
    const reader = response.body!.getReader();
    const reading = (async () => {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
    })();
    await settle();
    return {chunks, reading};
  };
  return {open, socket, saves, scheduled, advance, settle, controller,
    now: () => now,
    holdNextSave(promise: Promise<void>) {holdNextSave = promise;},
  };
}

test('first valid provider book persists immediately, then batches further books', async () => {
  const h = harness();
  const {chunks, reading} = await h.open();
  assert.equal(h.socket.accepted, true);
  assert.match(chunks.join(''), /^retry: 10000\n\n/);
  h.socket.dispatch('message', JSON.stringify(book(h.now() - 1000)));
  await h.settle();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].quotes.length, 1);
  assert.equal(h.saves[0].connection.active, true);
  h.socket.dispatch('message', JSON.stringify(book(h.now() - 500)));
  await h.settle();
  assert.equal(h.saves.length, 1, 'later updates stay in the 3-second batch');
  await h.advance(3000);
  assert.equal(h.saves.length, 2);
  assert.equal(h.saves[1].quotes.length, 1);
  h.socket.dispatch('error');
  await h.settle();
  await reading;
  assert.equal(chunks.join('').includes('event: refresh\n'), false);
});

test('first book arriving during an empty periodic write flushes after that write', async () => {
  const h = harness();
  const {reading} = await h.open();
  let release!: () => void;
  h.holdNextSave(new Promise<void>(resolve => {release = resolve;}));
  await h.advance(3000);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].quotes.length, 0);
  h.socket.dispatch('message', JSON.stringify(book(h.now() - 1000)));
  await h.settle();
  assert.equal(h.saves.length, 1);
  release();
  await h.settle();
  assert.equal(h.saves.length, 2, 'queued first book does not wait until the 6-second tick');
  assert.equal(h.saves[1].quotes.length, 1);
  h.controller.abort();
  await h.settle();
  await reading;
});

test('planned refresh announces itself before EOF and closes the generation once', async () => {
  const h = harness();
  const {chunks, reading} = await h.open();
  await h.advance(180000);
  await reading;
  const body = chunks.join('');
  assert.match(body, /event: refresh\ndata: \{"reason":"Refreshing selected markets\."\}\n\n/);
  assert.match(body, /^retry: 10000\n\n/);
  assert.equal(body.includes('retry: 1000\n'), false);
  assert.equal(h.socket.closed, true);
  assert.equal(h.saves.at(-1)?.connection.active, false);
  assert.equal(h.scheduled.size, 1, 'only the bounded storage-settle timeout remains');
  const saved = h.saves.length;
  h.socket.dispatch('message', JSON.stringify(book(h.now() - 1000)));
  await h.advance(5000);
  assert.equal(h.saves.length, saved, 'closed generation does not write again');
  assert.equal(h.scheduled.size, 0);
});
