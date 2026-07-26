/**
 * Headless exit-code mapping.
 *
 * This is the contract a CI script or shell pipeline branches on, and it was
 * the visible symptom of the false-success defect: a run that exhausted its
 * step budget, or whose stream was silently truncated, still exited 0. These
 * assert the mapping directly against the exported function `runHeadless`
 * actually calls, rather than against a manual observation of one run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { exitCodeFor } from './headless.ts';
import { stateForReason, type AgentTerminationReason } from './agent/run.ts';

/** Mirrors how runHeadless accumulates its flags for a terminal `done`. */
function exitFor(reason: AgentTerminationReason): number {
  return exitCodeFor({
    outcome: stateForReason(reason),
    sawError: reason.kind === 'provider_error',
    aborted: reason.kind === 'cancelled',
  });
}

test('only an explicit completion exits 0', () => {
  assert.equal(exitFor({ kind: 'completed' }), 0);
});

test('every limit and abnormal stop exits 1', () => {
  const failures: AgentTerminationReason[] = [
    { kind: 'max_steps', steps: 50 },
    { kind: 'incomplete_stream' },
    { kind: 'unknown_stop', raw: 'weird_reason' },
    { kind: 'refused' },
    { kind: 'output_truncated' },
    { kind: 'max_runtime', elapsedMs: 900_000 },
    { kind: 'tool_timeout', tool: 'run_shell', timeoutMs: 1000 },
    { kind: 'no_progress', steps: 12 },
    { kind: 'duplicate_calls', tool: 'read_file', repeats: 5 },
    { kind: 'provider_error', message: 'boom' },
    { kind: 'setup_error', message: 'no key' },
  ];

  for (const reason of failures) {
    assert.equal(exitFor(reason), 1, `${reason.kind} must exit 1`);
  }
});

test('cancellation exits 1 for every cause', () => {
  for (const by of ['user', 'superseded', 'shutdown'] as const) {
    assert.equal(exitFor({ kind: 'cancelled', by }), 1, `cancelled/${by} must exit 1`);
  }
});

test('a provider error exits 1 even if the outcome were mislabelled', () => {
  // Defence in depth: the error flag alone is enough to fail the process.
  assert.equal(exitCodeFor({ outcome: 'completed', sawError: true, aborted: false }), 1);
});

test('an interruption exits 1 even if the outcome were mislabelled', () => {
  assert.equal(exitCodeFor({ outcome: 'completed', sawError: false, aborted: true }), 1);
});

test('a run that produced no terminal event does not exit 0', () => {
  // runHeadless seeds `outcome` to 'failed' precisely so an abandoned run
  // cannot report success by omission.
  assert.equal(exitCodeFor({ outcome: 'failed', sawError: false, aborted: false }), 1);
});
