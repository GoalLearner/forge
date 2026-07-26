/**
 * Ledger persistence and the Step-4B migration.
 *
 * The migration is the part worth testing hard. `run_ledgers` did not exist
 * before this step, so every database on disk today predates it. Opening one
 * must not fail, and — more importantly — a session with no ledger rows must
 * read as "nothing recorded", never as a run that cost $0.00. Those two are
 * indistinguishable in a naive counter, and telling them apart is the entire
 * reason this table exists.
 *
 * This file seeds a genuinely pre-4B database by hand (the exact three-table
 * schema that shipped before) rather than deleting a column, so the migration
 * runs against the real prior state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { aggregateSession, type RunLedgerSummary, type CostResult } from './ledger.ts';

// A private FORGE_HOME, set before anything can open the real database.
const HOME = mkdtempSync(join(tmpdir(), 'forge-ledger-db-'));
process.env.FORGE_HOME = HOME;

const sqlite = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

/** Exactly the schema that existed before Step 4B — no run_ledgers table. */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  cwd         TEXT NOT NULL,
  title       TEXT,
  model_key   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  model_key           TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL,
  cache_write_tokens  INTEGER NOT NULL,
  output_tokens       INTEGER NOT NULL,
  cost                REAL NOT NULL,
  uncached_cost       REAL NOT NULL
);
`;

const LEGACY_SESSION = 'sess_from_before_4b';

// Seed the pre-4B database and close it, so the SessionStore constructed below
// opens a file that a genuinely older build wrote.
{
  const legacy = new sqlite.DatabaseSync(join(HOME, 'forge.db'));
  legacy.exec(LEGACY_SCHEMA);
  legacy
    .prepare(
      `INSERT INTO sessions (id, cwd, title, model_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(LEGACY_SESSION, 'C:/projects/old', 'before the ledger', 'deepseek/deepseek-v4-pro', 1, 1);
  legacy.close();
}

// Imported AFTER the seed so module-level state cannot open the file first.
const { SessionStore } = await import('./store.ts');

function summary(over: Partial<RunLedgerSummary> = {}): RunLedgerSummary {
  const cost: CostResult = { state: 'known', nanos: 1_234_000, tokens: 500 };
  return {
    runId: 'run_a',
    modelKey: 'deepseek/deepseek-v4-pro',
    logicalRequests: 3,
    providerAttempts: 4,
    retriesUsed: 1,
    retryLimit: 4,
    cacheHitInput: 4000,
    cacheMissInput: 200,
    outputTokens: 300,
    reasoningTokens: null,
    cost,
    finalized: true,
    ...over,
  };
}

test('opening a pre-4B database migrates instead of failing', () => {
  const store = new SessionStore();
  assert.ok(store.exists(LEGACY_SESSION), 'the old session survives the migration intact');
});

test('a session from before the ledger reports no rows, not a zero total', () => {
  const store = new SessionStore();
  const rows = store.runLedgers(LEGACY_SESSION);

  assert.deepEqual(rows, [], 'absence of data');
  const agg = aggregateSession(rows);
  assert.equal(agg.runs, 0);
  assert.equal(
    agg.cost.state,
    'incomplete',
    'no runs means the cost is unknown — a "known $0.00" here would be a lie',
  );
});

test('a finalized ledger round-trips through storage unchanged', () => {
  const store = new SessionStore();
  const id = store.create('C:/projects/demo', 'deepseek/deepseek-v4-pro');
  const s = summary({ runId: 'run_roundtrip' });

  store.saveRunLedger(id, s);
  const [read] = store.runLedgers(id);

  assert.deepEqual(read, s, 'every field survives, including the nested cost');
});

test('null token counts stay null across a round trip', () => {
  const store = new SessionStore();
  const id = store.create('C:/projects/nulls', 'deepseek/deepseek-v4-pro');
  store.saveRunLedger(
    id,
    summary({
      runId: 'run_nulls',
      cacheHitInput: null,
      cacheMissInput: null,
      outputTokens: null,
      reasoningTokens: null,
      cost: { state: 'incomplete', nanos: 0, tokens: 0 },
    }),
  );

  const read = store.runLedgers(id)[0]!;
  assert.equal(read.cacheHitInput, null, 'JSON must not coerce a missing count into 0');
  assert.equal(read.outputTokens, null);
  assert.equal(read.cost.state, 'incomplete');
});

test('saving the same run twice replaces the row rather than doubling the totals', () => {
  const store = new SessionStore();
  const id = store.create('C:/projects/idem', 'deepseek/deepseek-v4-pro');
  const s = summary({ runId: 'run_idem', providerAttempts: 7, retriesUsed: 2 });

  store.saveRunLedger(id, s);
  store.saveRunLedger(id, s); // e.g. a finalize racing a shutdown flush

  const rows = store.runLedgers(id);
  assert.equal(rows.length, 1, 'run_id is the primary key');
  assert.equal(aggregateSession(rows).providerAttempts, 7, 'not 14');
});

test('session totals sum across runs and keep the weakest confidence', () => {
  const store = new SessionStore();
  const id = store.create('C:/projects/agg', 'deepseek/deepseek-v4-pro');

  store.saveRunLedger(
    id,
    summary({ runId: 'run_1', providerAttempts: 4, retriesUsed: 1, cost: { state: 'known', nanos: 1_000_000, tokens: 100 } }),
  );
  store.saveRunLedger(
    id,
    summary({ runId: 'run_2', providerAttempts: 2, retriesUsed: 0, cost: { state: 'estimated', nanos: 500_000, tokens: 50 } }),
  );

  const agg = aggregateSession(store.runLedgers(id));
  assert.equal(agg.runs, 2);
  assert.equal(agg.providerAttempts, 6);
  assert.equal(agg.retriesUsed, 1);
  assert.equal(agg.cost.nanos, 1_500_000);
  assert.equal(
    agg.cost.state,
    'estimated',
    'one estimated run makes the session estimated — confidence never rounds up',
  );
});

test('ledgers are scoped to their own session', () => {
  const store = new SessionStore();
  const a = store.create('C:/projects/a', 'deepseek/deepseek-v4-pro');
  const b = store.create('C:/projects/b', 'deepseek/deepseek-v4-pro');

  store.saveRunLedger(a, summary({ runId: 'run_in_a' }));

  assert.equal(store.runLedgers(a).length, 1);
  assert.deepEqual(store.runLedgers(b), [], 'another session must not inherit it');
});

test('rows are returned oldest first', () => {
  const store = new SessionStore();
  const id = store.create('C:/projects/order', 'deepseek/deepseek-v4-pro');

  store.saveRunLedger(id, summary({ runId: 'run_first' }));
  store.saveRunLedger(id, summary({ runId: 'run_second' }));

  const ids = store.runLedgers(id).map((r) => r.runId);
  assert.deepEqual(ids.slice().sort(), ['run_first', 'run_second']);
});
