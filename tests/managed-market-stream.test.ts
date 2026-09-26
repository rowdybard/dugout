import test from 'node:test';
import assert from 'node:assert/strict';
import {managedMarketStream, type MarketEventSource} from '../lib/trading/managed-market-stream.ts';

class FakeSource implements MarketEventSource {
  listeners = new Map<string, ((event: Event) => void)[]>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  close() { this.closed = true; }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(new Event(type)); }
  fail() { this.onerror?.(new Event('error')); }
}

test('planned rollover reconnects promptly, but a failed replacement retains ten-second backoff', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const sources: FakeSource[] = [], states: string[] = [];
  const stop = managedMarketStream(() => { const source = new FakeSource(); sources.push(source); return source; }, {}, state => states.push(state));
  t.after(stop);
  sources[0].emit('refresh');
  assert.equal(sources[0].closed, true);
  t.mock.timers.tick(999);
  assert.equal(sources.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sources.length, 2);
  sources[1].fail();
  assert.equal(sources[1].closed, true, 'disable native retries before scheduling our retry');
  t.mock.timers.tick(9999);
  assert.equal(sources.length, 2, 'the fast planned delay must not leak into failed handshakes');
  t.mock.timers.tick(1);
  assert.equal(sources.length, 3);
  assert.deepEqual(states, ['connecting','rest']);
});

test('old stream events and duplicate refreshes cannot create extra reconnects or update quotes', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const sources: FakeSource[] = [];
  let quotes = 0;
  const stop = managedMarketStream(() => { const source = new FakeSource(); sources.push(source); return source; }, {quote:() => quotes++}, () => {});
  t.after(stop);
  const oldError = sources[0].onerror!;
  sources[0].emit('quote');
  sources[0].emit('refresh');
  sources[0].emit('refresh');
  oldError(new Event('error'));
  sources[0].emit('quote');
  t.mock.timers.tick(1000);
  assert.equal(sources.length, 2);
  sources[0].emit('quote');
  sources[1].emit('quote');
  assert.equal(quotes, 2);
  t.mock.timers.tick(10000);
  assert.equal(sources.length, 2);
});

test('visibility/effect cleanup cancels a pending refresh and ignores late source events', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let connections = 0, quotes = 0;
  const source = new FakeSource();
  const stop = managedMarketStream(() => { connections++; return source; }, {quote:() => quotes++}, () => {});
  source.emit('refresh');
  stop();
  source.emit('quote');
  source.emit('refresh');
  t.mock.timers.tick(30000);
  assert.equal(connections, 1);
  assert.equal(quotes, 0);
  assert.equal(source.closed, true);
});

test('a synchronous connection failure retries at ten seconds and cleanup cancels it', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let attempts = 0;
  const states: string[] = [];
  const stop = managedMarketStream(() => { attempts++; throw new Error('connection unavailable'); }, {}, state => states.push(state));
  t.mock.timers.tick(9999);
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  assert.equal(attempts, 2);
  stop();
  t.mock.timers.tick(10000);
  assert.equal(attempts, 2);
  assert.deepEqual(states, ['rest','rest']);
});
