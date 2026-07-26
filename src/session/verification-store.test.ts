/**
 * Persisting the verification verdict.
 *
 * The summary rides inside the run-ledger row's existing JSON payload rather
 * than in new columns, so there is no schema change and no migration: a database
 * written before this feature simply has no `verification` key. The property
 * that matters is what a reader does with that absence — it must read as
 * UNKNOWN, never as "the checks passed". A run whose verdict was never recorded
 * is exactly the run you must not trust.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunLedgerSummary } from './ledger.ts';
import type { VerificationSummary } from '../agent/verification.ts';

process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), 'forge-verify-db-'));

const { SessionStore } = await import('./store.ts');

function ledgerSummary(runId: string): RunLedgerSummary {
  return {
    runId,
    modelKey: 'deepseek/deepseek-v4-pro',
    logicalRequests: 2,
    providerAttempts: 2,
    retriesUsed: 0,
    retryLimit: 4,
    cacheHitInput: 100,
    cacheMissInput: 10,
    outputTokens: 20,
    reasoningTokens: null,
    cost: { state: 'estimated', nanos: 1000, tokens: 130 },
    finalized: true,
  };
}

const verification: VerificationSummary = {
  status: 'passed',
  generation: 2,
  verifiedGeneration: 2,
  repairsUsed: 1,
  repairAllowance: 2,
  changedPaths: ['src/a.ts', 'src/b.ts'],
  checks: [
    {
      name: 'typecheck',
      command: 'npm run typecheck',
      source: 'package_script',
      required: true,
      result: 'passed',
      exitCode: 0,
      durationMs: 120,
    },
  ],
};

/** The stored payload, read back the way a later reader would see it. */
type Stored = RunLedgerSummary & { verification?: VerificationSummary };

test('a verification summary round-trips with the run it describes', () => {
  const store = new SessionStore();
  const id = store.create('C:/p/verified', 'deepseek/deepseek-v4-pro');
  store.saveRunLedger(id, ledgerSummary('run_v1'), verification);

  const [row] = store.runLedgers(id) as Stored[];
  assert.deepEqual(row!.verification, verification);
  assert.equal(row!.providerAttempts, 2, 'the ledger fields are untouched by the addition');
});

test('a run saved without a verdict has none — not a passing one', () => {
  const store = new SessionStore();
  const id = store.create('C:/p/legacy', 'deepseek/deepseek-v4-pro');
  // Exactly what every row written before this feature looks like.
  store.saveRunLedger(id, ledgerSummary('run_legacy'));

  const [row] = store.runLedgers(id) as Stored[];
  assert.equal(row!.verification, undefined, 'absent, so a reader must treat it as unknown');
  assert.notEqual(
    (row!.verification as VerificationSummary | undefined)?.status,
    'passed',
    'silence is never a pass',
  );
});

test('a failed verdict is persisted as failed, with the failing check named', () => {
  const store = new SessionStore();
  const id = store.create('C:/p/failed', 'deepseek/deepseek-v4-pro');
  store.saveRunLedger(id, ledgerSummary('run_failed'), {
    ...verification,
    status: 'failed',
    verifiedGeneration: null,
    repairsUsed: 2,
    checks: [
      {
        name: 'typecheck',
        command: 'npm run typecheck',
        source: 'package_script',
        required: true,
        result: 'failed',
        exitCode: 2,
        durationMs: 90,
      },
    ],
  });

  const [row] = store.runLedgers(id) as Stored[];
  assert.equal(row!.verification!.status, 'failed');
  assert.equal(row!.verification!.verifiedGeneration, null);
  assert.equal(row!.verification!.checks[0]!.exitCode, 2);
  assert.equal(row!.verification!.repairsUsed, 2);
});

test('an unavailable verdict stays distinguishable from a pass and from nothing', () => {
  const store = new SessionStore();
  const id = store.create('C:/p/unavailable', 'deepseek/deepseek-v4-pro');
  store.saveRunLedger(id, ledgerSummary('run_unavail'), {
    ...verification,
    status: 'unavailable',
    verifiedGeneration: null,
    checks: [
      {
        name: 'typecheck',
        command: 'npm run typecheck',
        source: 'package_script',
        required: true,
        result: 'unavailable',
        exitCode: null,
        durationMs: 0,
        reason: 'node_modules is absent',
      },
    ],
  });

  const [row] = store.runLedgers(id) as Stored[];
  assert.equal(row!.verification!.status, 'unavailable');
  assert.equal(row!.verification!.checks[0]!.reason, 'node_modules is absent');
  assert.notEqual(row!.verification!.status, 'passed');
});

test('re-saving a finalized run replaces its verdict rather than adding a second row', () => {
  const store = new SessionStore();
  const id = store.create('C:/p/idem', 'deepseek/deepseek-v4-pro');
  store.saveRunLedger(id, ledgerSummary('run_idem'), verification);
  store.saveRunLedger(id, ledgerSummary('run_idem'), verification);

  const rows = store.runLedgers(id) as Stored[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.verification!.status, 'passed');
});

test('reading a pre-feature database still works', () => {
  // Rows written before the feature and rows written after it coexist in one
  // session; neither breaks the other.
  const store = new SessionStore();
  const id = store.create('C:/p/mixed', 'deepseek/deepseek-v4-pro');
  store.saveRunLedger(id, ledgerSummary('run_old'));
  store.saveRunLedger(id, ledgerSummary('run_new'), verification);

  const rows = store.runLedgers(id) as Stored[];
  assert.equal(rows.length, 2);
  const byId = new Map(rows.map((r) => [r.runId, r]));
  assert.equal(byId.get('run_old')!.verification, undefined);
  assert.equal(byId.get('run_new')!.verification!.status, 'passed');
});
