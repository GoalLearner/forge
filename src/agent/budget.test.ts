/**
 * The active-runtime budget.
 *
 * Two properties matter and are easy to get wrong:
 *
 *   1. Approval waits must not consume the budget. A user who steps away from a
 *      permission prompt has not made the run slow, and a limit that punishes
 *      them for it would be worse than no limit.
 *   2. The deadline the timer fires on and the `activeMs()` the UI reports must
 *      come from the SAME clock. Two clocks drift, and then the run dies at a
 *      moment the reported numbers cannot explain.
 *
 * A controllable `now` plus real (very short) timers keeps these deterministic
 * without a fake-timer library.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRun, RuntimeBudget, RuntimeExpiredError, type AgentLimits } from './run.ts';

const LIMITS: AgentLimits = {
  maxSteps: 50,
  maxRetriesPerCall: 4,
  toolTimeoutMs: 120_000,
  maxRuntimeMs: 900_000,
  maxExplicitShellTimeoutMs: 600_000,
};

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- accounting ------------------------------------------------------------

test('active time excludes a single approval wait', () => {
  const clock = { t: 0 };
  const budget = new RuntimeBudget(900_000, () => clock.t);

  clock.t = 1_000;
  budget.pauseForApproval();
  clock.t = 61_000; // 60s parked on a human
  budget.resumeFromApproval();
  clock.t = 63_000;

  assert.equal(budget.elapsedMs(), 63_000);
  assert.equal(budget.activeMs(), 3_000);
  assert.equal(budget.remainingMs(), 897_000);
});

test('repeated approval waits accumulate correctly', () => {
  // work → wait → work → wait → work
  const clock = { t: 0 };
  const budget = new RuntimeBudget(900_000, () => clock.t);

  clock.t = 2_000; // 2s active
  budget.pauseForApproval();
  clock.t = 12_000; // 10s parked
  budget.resumeFromApproval();

  clock.t = 15_000; // +3s active
  budget.pauseForApproval();
  clock.t = 45_000; // 30s parked
  budget.resumeFromApproval();

  clock.t = 46_000; // +1s active

  assert.equal(budget.elapsedMs(), 46_000);
  assert.equal(budget.activeMs(), 6_000, '2s + 3s + 1s of real work');
  assert.equal(budget.remainingMs(), 894_000);
});

test('time still parked counts as parked, not active', () => {
  const clock = { t: 0 };
  const budget = new RuntimeBudget(900_000, () => clock.t);
  clock.t = 500;
  budget.pauseForApproval();
  clock.t = 300_500;

  assert.equal(budget.activeMs(), 500);
});

test('remaining is clamped at zero and never negative', () => {
  const clock = { t: 0 };
  const budget = new RuntimeBudget(1_000, () => clock.t);
  clock.t = 5_000;
  assert.equal(budget.remainingMs(), 0);
  assert.ok(budget.isExhausted());
});

// --- the timer -------------------------------------------------------------

test('the budget fires while work is in flight, not only between steps', async () => {
  const budget = new RuntimeBudget(20);
  let fired = false;
  budget.arm(() => {
    fired = true;
  });

  // Simulates a long-running stream or tool: nothing checks anything.
  await tick(60);
  assert.ok(fired, 'a wedged operation must be interrupted, not waited out');
  budget.stop();
});

test('no timer runs while parked on approval', async () => {
  const budget = new RuntimeBudget(20);
  let fired = false;
  budget.arm(() => {
    fired = true;
  });

  budget.pauseForApproval();
  await tick(60);
  assert.equal(fired, false, 'approval time must not expire the budget');
  assert.equal(budget.timerActive, false);

  budget.resumeFromApproval();
  assert.equal(budget.timerActive, true, 're-armed from the remaining time');
  budget.stop();
});

test('stop() clears the timer so a finished run cannot fire later', async () => {
  const budget = new RuntimeBudget(20);
  let fired = false;
  budget.arm(() => {
    fired = true;
  });

  budget.stop();
  assert.equal(budget.timerActive, false);
  await tick(60);
  assert.equal(fired, false);
});

test("run A's expiry cannot terminate run B", async () => {
  const a = new RuntimeBudget(20);
  const b = new RuntimeBudget(10_000);

  let aFired = 0;
  let bFired = 0;
  a.arm(() => aFired++);
  b.arm(() => bFired++);

  // A ends before its deadline — as a completed run does.
  a.stop();

  await tick(60);
  assert.equal(aFired, 0, "A's timer was cleared with A");
  assert.equal(bFired, 0, "B is nowhere near its own limit");
  b.stop();
});

// --- integration with AgentRun --------------------------------------------

test('AgentRun and its budget are the same clock', () => {
  const clock = { t: 0 };
  const run = new AgentRun({
    sessionId: 's',
    limits: LIMITS,
    abort: new AbortController(),
    now: () => clock.t,
  });

  run.transition('thinking');
  clock.t = 5_000;
  run.transition('awaiting_approval');
  clock.t = 65_000;
  run.transition('running_tool');
  clock.t = 66_000;

  assert.equal(run.activeMs(), 6_000);
  assert.equal(run.activeMs(), run.budget.activeMs(), 'one clock, not two');
  assert.equal(run.remainingRuntimeMs(), LIMITS.maxRuntimeMs - 6_000);
});

test('a terminal transition stops the budget deterministically', () => {
  const run = new AgentRun({ sessionId: 's', limits: LIMITS, abort: new AbortController() });
  run.transition('thinking');
  run.budget.arm(() => {});
  assert.equal(run.budget.timerActive, true);

  run.finish({ kind: 'completed' });
  assert.equal(run.budget.timerActive, false, 'no timer survives a finished run');
});

test('expiry aborts the run controller with a RuntimeExpiredError', async () => {
  const controller = new AbortController();
  const run = new AgentRun({
    sessionId: 's',
    limits: { ...LIMITS, maxRuntimeMs: 20 },
    abort: controller,
  });
  run.transition('thinking');
  run.budget.arm(() => controller.abort(new RuntimeExpiredError(run.activeMs())));

  await tick(60);

  assert.ok(controller.signal.aborted);
  assert.ok(
    controller.signal.reason instanceof RuntimeExpiredError,
    'the reason must identify the budget, not look like a user abort',
  );
  run.budget.stop();
});

// --- first-reason-wins across limit races ---------------------------------

test('user cancellation before expiry stays cancelled/user', () => {
  const run = new AgentRun({ sessionId: 's', limits: LIMITS, abort: new AbortController() });
  run.transition('thinking');

  run.finish({ kind: 'cancelled', by: 'user' });
  run.finish({ kind: 'max_runtime', elapsedMs: 900_000 });

  assert.equal(run.state, 'cancelled');
  assert.deepEqual(run.termination, { kind: 'cancelled', by: 'user' });
});

test('supersession before expiry stays cancelled/superseded', () => {
  const run = new AgentRun({ sessionId: 's', limits: LIMITS, abort: new AbortController() });
  run.transition('thinking');

  run.finish({ kind: 'cancelled', by: 'superseded' });
  run.finish({ kind: 'max_runtime', elapsedMs: 900_000 });

  assert.deepEqual(run.termination, { kind: 'cancelled', by: 'superseded' });
});

test('runtime expiry before a later provider error stays max_runtime', () => {
  const run = new AgentRun({ sessionId: 's', limits: LIMITS, abort: new AbortController() });
  run.transition('thinking');

  run.finish({ kind: 'max_runtime', elapsedMs: 900_000 });
  // Cancelling the provider produces a secondary AbortError; it must not
  // overwrite the real reason.
  run.finish({ kind: 'provider_error', message: 'The operation was aborted' });

  assert.equal(run.state, 'failed');
  assert.deepEqual(run.termination, { kind: 'max_runtime', elapsedMs: 900_000 });
});
