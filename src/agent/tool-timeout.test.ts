/**
 * Per-tool timeouts: how the deadline is chosen, and what happens when it hits.
 *
 * The timeout path is the one place where "the run stopped" and "the work
 * stopped" can diverge — a `Promise.race` would report a timeout while the tool
 * kept running, orphaning child processes and letting post-cancellation writes
 * land. These tests pin the resolution rules and the pairing guarantees; the
 * end-to-end behaviour through the real loop is covered in
 * loop.integration.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveToolTimeout } from './loop.ts';
import { ToolError } from '../tools/types.ts';

const LIMITS = { toolTimeoutMs: 120_000, maxExplicitShellTimeoutMs: 600_000 };
const PLENTY = 900_000;

// --- resolution rules ------------------------------------------------------

test('an ordinary tool gets the default tool timeout', () => {
  const { timeoutMs } = resolveToolTimeout('read_file', { path: 'a.ts' }, LIMITS, PLENTY);
  assert.equal(timeoutMs, 120_000);
});

test('run_shell without an explicit timeout gets the default too', () => {
  const { timeoutMs } = resolveToolTimeout('run_shell', { command: 'ls' }, LIMITS, PLENTY);
  assert.equal(timeoutMs, 120_000);
});

test('an explicit lower shell timeout wins', () => {
  const { timeoutMs } = resolveToolTimeout(
    'run_shell',
    { command: 'ls', timeout_ms: 5_000 },
    LIMITS,
    PLENTY,
  );
  assert.equal(timeoutMs, 5_000);
});

test('an explicit shell timeout may exceed the default, up to the cap', () => {
  // Long builds are legitimate — that is the whole reason timeout_ms exists.
  const { timeoutMs } = resolveToolTimeout(
    'run_shell',
    { command: 'npm run build', timeout_ms: 300_000 },
    LIMITS,
    PLENTY,
  );
  assert.equal(timeoutMs, 300_000, 'above toolTimeoutMs but below the shell cap');
});

test('an explicit shell timeout above the cap is clamped, and says so', () => {
  // Documented contract: over-cap is CLAMPED (a long build is a reasonable
  // ask), while malformed input is REJECTED (see below).
  const { timeoutMs, cappedFrom } = resolveToolTimeout(
    'run_shell',
    { command: 'sleep 9999', timeout_ms: 3_600_000 },
    LIMITS,
    PLENTY,
  );
  assert.equal(timeoutMs, 600_000);
  assert.equal(cappedFrom, 3_600_000);
});

test('invalid explicit timeouts are rejected, never silently clamped', () => {
  for (const bad of [0, -1, -5_000, Number.NaN, 1.5, 'soon']) {
    assert.throws(
      () =>
        resolveToolTimeout('run_shell', { command: 'ls', timeout_ms: bad }, LIMITS, PLENTY),
      ToolError,
      `timeout_ms: ${String(bad)} must be rejected`,
    );
  }
});

test('the explicit-timeout rule applies only to run_shell', () => {
  // Another tool carrying a timeout_ms-shaped field must not gain a bigger
  // budget by accident.
  const { timeoutMs } = resolveToolTimeout(
    'read_file',
    { path: 'a.ts', timeout_ms: 500_000 },
    LIMITS,
    PLENTY,
  );
  assert.equal(timeoutMs, 120_000);
});

// --- the remaining-runtime ceiling ----------------------------------------

test('remaining run time caps an ordinary tool', () => {
  const { timeoutMs } = resolveToolTimeout('read_file', {}, LIMITS, 9_000);
  assert.equal(timeoutMs, 9_000, 'a tool may not outlive the run budget');
});

test('remaining run time caps an explicit shell timeout', () => {
  const { timeoutMs } = resolveToolTimeout(
    'run_shell',
    { command: 'npm test', timeout_ms: 300_000 },
    LIMITS,
    30_000,
  );
  assert.equal(timeoutMs, 30_000);
});

test('no remaining runtime means the tool must not start', () => {
  const { timeoutMs } = resolveToolTimeout('run_shell', { command: 'ls' }, LIMITS, 0);
  assert.equal(timeoutMs, 0, 'the loop treats <= 0 as "do not start"');
});

test('an unlimited budget falls back to the tool timeout', () => {
  const { timeoutMs } = resolveToolTimeout(
    'read_file',
    {},
    LIMITS,
    Number.POSITIVE_INFINITY,
  );
  assert.equal(timeoutMs, 120_000);
});
