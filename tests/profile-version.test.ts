import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {shouldAcceptProfile} from '../lib/trading/profile-version.ts';
import {DEFAULT_DIP_CONFIG} from '../lib/trading/strategy.ts';
import type {Profile} from '../lib/market/types';
import type {WorkspaceOrder} from '../lib/trading/workspace';

const makeProfile = (revision?: number, cash = 100): Profile => ({
  ...(revision === undefined ? {} : {revision}), cash, positions: [], watches: [], equity: [],
  config: {move: 5, wide: 5, spreadChange: 3, activity: 3, thin: 10, stale: 60},
});

test('late pre-entry responses cannot roll back paper cash or a newer automation session', () => {
  const initial = makeProfile(8);
  const entered: Profile = {...makeProfile(9, 95), trading: {
    settings: {entryPresets: [5], exitPresets: [100], maxPriceDrift: .02},
    automation: {id: 'synthetic-session', mode: 'paper', status: 'running', slug: 'synthetic-mlb', side: 'YES',
      config: DEFAULT_DIP_CONFIG, state: {version: DEFAULT_DIP_CONFIG.version, phase: 'WAITING'},
      startedAt: 1000, lastStepAt: 0, lastReason: 'Synthetic version race', manualTakeover: false,
      observations: 0, orders: 0, budgetLimit: 10, spent: 0},
  }};
  let visible: Profile | null = initial;
  const receive = (candidate: Profile) => {if (shouldAcceptProfile(visible, candidate)) visible = candidate;};
  receive(entered);
  receive(initial);
  assert.equal(visible, entered);
  assert.equal(visible?.cash, 95);
  assert.equal(visible?.trading?.automation?.status, 'running');
  receive({...entered});
  assert.equal(visible, entered, 'equal revisions retain the current object');
  const paused: Profile = {...entered, revision: 10, trading: {
    ...entered.trading!, automation: {...entered.trading!.automation!, status: 'paused'},
  }};
  receive(paused);
  receive(entered);
  assert.equal(visible, paused, 'a late running snapshot cannot undo a pause');
});

test('versioned accounts reject legacy and malformed revisions, including after reload at revision zero', () => {
  const current = makeProfile(0);
  assert.equal(shouldAcceptProfile(null, current), true);
  assert.equal(shouldAcceptProfile(current, makeProfile()), false);
  for (const revision of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(shouldAcceptProfile(current, makeProfile(revision)), false);
    assert.equal(shouldAcceptProfile(null, makeProfile(revision)), false);
  }
  assert.equal(shouldAcceptProfile(makeProfile(), makeProfile()), true, 'legacy fixtures remain usable');
  assert.equal(shouldAcceptProfile(makeProfile(), makeProfile(0)), true, 'first server revision replaces legacy data');
  assert.equal(shouldAcceptProfile(makeProfile(11), makeProfile(12)), true);
});

// Execute the actual server functions with a SQLite-backed D1 adapter. This
// exercises real CAS SQL and transaction outcomes without Cloudflare bindings.
const require = createRequire(import.meta.url);
function loadServerModule(relative: string, modules: Record<string, unknown>) {
  const script = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const module = {exports: {} as Record<string, unknown>};
  runInNewContext(script, {
    module, exports: module.exports, crypto, Date,
    require: (name: string) => name in modules ? modules[name] : name === 'zod' ? require(name) : {},
  });
  return module.exports;
}

function databaseHarness() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE profiles(id TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE trading_commands(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,command_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,value TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  type Bound = {run: () => Promise<{meta: {changes: number}}> ; first: () => Promise<unknown>};
  let rejectBatch = false;
  const d1 = {
    prepare(sql: string) {
      return {bind(...values: (string | number)[]): Bound {
        return {
          async run() {const result = sqlite.prepare(sql).run(...values); return {meta: {changes: Number(result.changes)}};},
          async first() {return sqlite.prepare(sql).get(...values) ?? null;},
        };
      }};
    },
    async batch(statements: Bound[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const [index, statement] of statements.entries()) {
          if (rejectBatch && index === 1) throw new Error('Synthetic failure before account update');
          results.push(await statement.run());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {sqlite.exec('ROLLBACK'); throw error;}
    },
  };
  const storage = loadServerModule('../lib/server/storage.ts', {
    'cloudflare:workers': {env: {DB: d1}}, '@/lib/market/scanner': {DEFAULT_CONFIG: makeProfile().config},
  }) as unknown as {
    profile: (req: Request) => Promise<{id: string; data: Profile; version: number}>;
    saveProfile: (p: {id: string; data: Profile; version: number}) => Promise<void>;
    db: () => typeof d1;
  };
  const trading = loadServerModule('../lib/server/trading.ts', {'./storage': storage}) as unknown as {
    commitOrder: (p: {id: string; data: Profile; version: number}, body: Record<string, unknown>, order: WorkspaceOrder) => Promise<WorkspaceOrder>;
  };
  return {sqlite, storage, trading, failBatch: () => {rejectBatch = true;}};
}

const request = () => new Request('https://example.test/api/trading', {headers: {'oai-authenticated-user-id': 'synthetic-user'}});
const commandId = 'd6ea70bc-59ea-4e92-a81f-9175c123f920';
const body = {commandId, action: 'BUY', slug: 'synthetic-mlb', side: 'YES', amount: 5, limitPrice: .5, mode: 'paper'};
const order: WorkspaceOrder = {
  id: commandId, commandId, slug: 'synthetic-mlb', side: 'YES', action: 'BUY', source: 'AUTOMATIC',
  status: 'filled', filledQuantity: 10, requestedQuantity: 10, averagePrice: .5, fees: 0, gross: 5,
  cashDelta: -5, reason: 'Synthetic storage test', createdAt: 1000, positionId: commandId,
  execution: {commandId, fingerprint: 'synthetic', status: 'filled', reason: 'Synthetic storage test',
    fills: [{price: .5, quantity: 10, gross: 5, fee: 0}], requestedQty: 10, filledQty: 10, remainingQty: 0,
    gross: 5, fees: 0, cashDelta: -5, averagePrice: .5, unusedBudget: 0, at: 1000, replayed: false,
    apply: true, feeModel: 'AGGREGATED_DEPTH_ESTIMATE'},
};

test('profile reads trust the SQL revision and successful saves update both returned revisions', async () => {
  const h = databaseHarness();
  try {
    h.sqlite.prepare('INSERT INTO profiles VALUES(?,?,?)').run('synthetic-user', JSON.stringify(makeProfile(999)), 4);
    const p = await h.storage.profile(request());
    assert.equal(p.version, 4);
    assert.equal(p.data.revision, 4);
    p.data.cash = 95;
    await h.storage.saveProfile(p);
    assert.equal(p.version, 5);
    assert.equal(p.data.revision, 5);
    const stored = await h.storage.profile(request());
    assert.equal(stored.version, 5);
    assert.equal(stored.data.revision, 5);
    assert.equal(stored.data.cash, 95);
  } finally {h.sqlite.close();}
});

test('a losing compare-and-swap does not advance the caller revision or overwrite cash', async () => {
  const h = databaseHarness();
  try {
    const winner = await h.storage.profile(request());
    const stale = await h.storage.profile(request());
    winner.data.cash = 95;
    await h.storage.saveProfile(winner);
    stale.data.cash = 90;
    await assert.rejects(h.storage.saveProfile(stale), /Another update just finished/);
    assert.equal(stale.version, 0);
    assert.equal(stale.data.revision, 0);
    assert.equal((await h.storage.profile(request())).data.cash, 95);
  } finally {h.sqlite.close();}
});

test('atomic order commit advances revision once; journal replay never increments it again', async () => {
  const h = databaseHarness();
  try {
    const p = await h.storage.profile(request());
    p.data.cash = 95;
    await h.trading.commitOrder(p, body, order);
    assert.equal(p.version, 1);
    assert.equal(p.data.revision, 1);
    const fresh = await h.storage.profile(request());
    fresh.data.cash = 90;
    const replayed = await h.trading.commitOrder(fresh, body, order);
    assert.equal(replayed.commandId, commandId);
    assert.equal(fresh.version, 1);
    assert.equal(fresh.data.revision, 1);
    const stored = await h.storage.profile(request());
    assert.equal(stored.version, 1);
    assert.equal(stored.data.cash, 95);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM trading_commands').get()?.count, 1);
  } finally {h.sqlite.close();}
});

test('failed atomic order write rolls back the journal and leaves all revisions unchanged', async () => {
  const h = databaseHarness();
  try {
    const p = await h.storage.profile(request());
    p.data.cash = 95;
    h.failBatch();
    await assert.rejects(h.trading.commitOrder(p, body, order), /Synthetic failure/);
    assert.equal(p.version, 0);
    assert.equal(p.data.revision, 0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM trading_commands').get()?.count, 0);
    const stored = await h.storage.profile(request());
    assert.equal(stored.version, 0);
    assert.equal(stored.data.cash, 100);
  } finally {h.sqlite.close();}
});
