import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceLeagueDiscovery, visibleLeagueMarkets} from '../lib/tennis/catalog-discovery.ts';
import type {DiscoveryDependencies, LeagueDiscoveryState} from '../lib/tennis/catalog-discovery.ts';

type Market = {slug: string; observedAt: number; league: string};
function harness(initialEvents = Array.from({length: 67}, (_, i) => `event-${i}`)) {
  let time = 1000;
  let events = initialEvents;
  const calls: {league: string; offset: number; limit: number}[] = [];
  const deps: DiscoveryDependencies<Market> = {
    now: () => time,
    eventKey: event => String(event),
    normalize: (event, league, observedAt) => [{slug: String(event), league, observedAt}],
    fetchPage: async (league, {offset, limit}) => {
      calls.push({league, offset, limit});
      time += 100;
      return events.slice(offset, offset + limit);
    },
  };
  return {deps, calls, now: () => time, setTime: (value: number) => {time = value;}, setEvents: (value: string[]) => {events = value;}};
}

test('discovers all pages beyond the former eight-event limit and only completes on exhaustion', async () => {
  const h = harness();
  const state = await advanceLeagueDiscovery(undefined, 'CFB', h.deps, {deadlineAt: h.now() + 12000});
  assert.equal(state.status, 'complete');
  assert.equal(visibleLeagueMarkets(state).length, 67);
  assert.deepEqual(h.calls.map(call => [call.offset, call.limit]), [[0,20],[20,20],[40,20],[60,20]]);
  assert.equal(state.nextAttemptAt, state.completedAt! + 30000);
});

test('a full terminal page requires one further empty page', async () => {
  const h = harness(Array.from({length: 40}, (_, i) => `event-${i}`));
  const state = await advanceLeagueDiscovery(undefined, 'ATP', h.deps, {deadlineAt: h.now() + 12000});
  assert.equal(state.status, 'complete');
  assert.deepEqual(h.calls.map(call => call.offset), [0,20,40]);
  assert.equal(visibleLeagueMarkets(state).length, 40);
});

test('deadline checkpoints survive JSON serialization and resume the unaccepted page', async () => {
  const h = harness();
  const first = await advanceLeagueDiscovery(undefined, 'WTA', h.deps, {deadlineAt: 1250});
  assert.equal(first.status, 'scanning');
  assert.equal(first.interrupted, 'deadline');
  assert.equal(first.nextOffset, 40);
  assert.equal(visibleLeagueMarkets(first).length, 40);
  const saved = JSON.parse(JSON.stringify(first)) as LeagueDiscoveryState<Market>;
  const second = await advanceLeagueDiscovery(saved, 'WTA', h.deps, {deadlineAt: h.now() + 12000});
  assert.equal(second.status, 'complete');
  assert.equal(visibleLeagueMarkets(second).length, 67);
  assert.deepEqual(h.calls.map(call => call.offset), [0,20,40,40,60]);
  assert.equal(first.nextOffset, 40, 'the prior checkpoint is not mutated');
});

test('moving pages deduplicate overlapping events while preserving each actual observation time', async () => {
  const h = harness();
  h.deps.fetchPage = async (_league, {offset}) => {
    h.setTime(h.now() + 100);
    if (offset === 0) return Array.from({length: 20}, (_, i) => `event-${i}`);
    if (offset === 20) return Array.from({length: 20}, (_, i) => `event-${i + 15}`);
    return ['event-35'];
  };
  const state = await advanceLeagueDiscovery(undefined, 'CFB', h.deps, {deadlineAt: 13000});
  assert.equal(visibleLeagueMarkets(state).length, 36);
  assert.equal(state.complete['event-0'].observedAt, 1100);
  assert.equal(state.complete['event-15'].observedAt, 1200);
});

test('a repeated full page in a different order is an explicit error with a retained cursor', async () => {
  const h = harness(Array.from({length: 20}, (_, i) => `event-${i}`));
  h.deps.fetchPage = async (_league, {offset}) => {
    h.setTime(h.now() + 100);
    const page = Array.from({length: 20}, (_, i) => `event-${i}`);
    return offset ? page.reverse() : page;
  };
  const state = await advanceLeagueDiscovery(undefined, 'NFL', h.deps, {deadlineAt: 13000});
  assert.equal(state.status, 'error');
  assert.match(state.error!, /repeated a page at offset 20/);
  assert.equal(state.nextOffset, 20);
  assert.equal(visibleLeagueMarkets(state).length, 20);
  assert.equal(state.nextAttemptAt, h.now() + 5000);
});

test('source failure backs off and resumes, retaining the prior complete list and original freshness', async () => {
  const h = harness(['old-only', 'shared']);
  const complete = await advanceLeagueDiscovery(undefined, 'CFB', h.deps, {deadlineAt: 13000});
  const original = complete.complete['old-only'].observedAt;
  h.setTime(complete.nextAttemptAt);
  h.setEvents(Array.from({length: 25}, (_, i) => `new-${i}`));
  const realFetch = h.deps.fetchPage;
  h.deps.fetchPage = async (league, page) => {
    if (page.offset === 20) throw new Error('Source returned HTTP 429');
    return realFetch(league, page);
  };
  const failed = await advanceLeagueDiscovery(complete, 'CFB', h.deps, {deadlineAt: h.now() + 12000});
  assert.equal(failed.status, 'error');
  assert.equal(failed.nextOffset, 20);
  assert.equal(visibleLeagueMarkets(failed).length, 22);
  assert.equal(failed.complete['old-only'].observedAt, original);
  assert.equal(failed.completedAt, complete.completedAt);
  const callsBefore = h.calls.length;
  const waiting = await advanceLeagueDiscovery(failed, 'CFB', h.deps, {deadlineAt: h.now() + 12000});
  assert.equal(h.calls.length, callsBefore);
  assert.equal(waiting.error, failed.error);
  h.setTime(failed.nextAttemptAt);
  h.deps.fetchPage = realFetch;
  const recovered = await advanceLeagueDiscovery(failed, 'CFB', h.deps, {deadlineAt: h.now() + 12000});
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.error, null);
  assert.equal(visibleLeagueMarkets(recovered).length, 25);
  assert.equal(recovered.complete['old-only'], undefined, 'only a complete wave retires old unseen entries');
});

test('completed waves stay untouched for 30 seconds, then restart at page zero', async () => {
  const h = harness(['a']);
  const first = await advanceLeagueDiscovery(undefined, 'ATP', h.deps, {deadlineAt: 13000});
  h.setTime(first.nextAttemptAt - 1);
  const cached = await advanceLeagueDiscovery(first, 'ATP', h.deps, {deadlineAt: h.now() + 12000});
  assert.deepEqual(cached, first);
  assert.equal(h.calls.length, 1);
  h.setTime(first.nextAttemptAt);
  h.setEvents(['b']);
  const next = await advanceLeagueDiscovery(first, 'ATP', h.deps, {deadlineAt: h.now() + 12000});
  assert.deepEqual(visibleLeagueMarkets(next).map(market => market.slug), ['b']);
  assert.deepEqual(h.calls.map(call => call.offset), [0,0]);
});

test('one league error does not block another league completing its catalog', async () => {
  const h = harness(['healthy']);
  const realFetch = h.deps.fetchPage;
  h.deps.fetchPage = async (league, page) => {
    if (league === 'ATP') throw new Error('ATP unavailable');
    return realFetch(league, page);
  };
  const [failed, healthy] = await Promise.all(['ATP','WTA'].map(league =>
    advanceLeagueDiscovery(undefined, league, h.deps, {deadlineAt: 13000})));
  assert.equal(failed.status, 'error');
  assert.equal(healthy.status, 'complete');
  assert.equal(visibleLeagueMarkets(healthy)[0].league, 'WTA');
});

test('normalizer failures do not commit half a page or advance its cursor', async () => {
  const h = harness(['good', 'bad']);
  h.deps.normalize = (event, league, observedAt) => {
    if (event === 'bad') throw new Error('Invalid event');
    return [{slug: String(event), league, observedAt}];
  };
  const state = await advanceLeagueDiscovery(undefined, 'CFB', h.deps, {deadlineAt: 13000});
  assert.equal(state.status, 'error');
  assert.equal(state.nextOffset, 0);
  assert.equal(visibleLeagueMarkets(state).length, 0);
});

test('deadline aborts even a fetch that ignores its signal; late results cannot mutate the checkpoint', async () => {
  let finish: (events: unknown[]) => void = () => {};
  let requestSignal: AbortSignal | undefined;
  const deps: DiscoveryDependencies<Market> = {
    now: Date.now, eventKey: String,
    normalize: (event, league, observedAt) => [{slug: String(event), league, observedAt}],
    fetchPage: async (_league, {signal}) => {
      requestSignal = signal;
      return new Promise(resolve => {finish = resolve;});
    },
  };
  const state = await advanceLeagueDiscovery(undefined, 'CFB', deps, {deadlineAt: Date.now() + 20});
  assert.equal(state.interrupted, 'deadline');
  assert.equal(requestSignal?.aborted, true);
  finish(['late']);
  await Promise.resolve();
  assert.equal(visibleLeagueMarkets(state).length, 0);
  assert.equal(state.nextOffset, 0);
});

test('external cancellation preserves the exact pending cursor', async () => {
  const h = harness();
  const controller = new AbortController();
  h.deps.fetchPage = async () => {controller.abort(); return ['ignored'];};
  const state = await advanceLeagueDiscovery(undefined, 'NFL', h.deps, {deadlineAt: 13000, signal: controller.signal});
  assert.equal(state.interrupted, 'cancelled');
  assert.equal(state.nextOffset, 0);
  assert.equal(visibleLeagueMarkets(state).length, 0);
});
