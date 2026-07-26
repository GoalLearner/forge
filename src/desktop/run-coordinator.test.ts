/**
 * Supersession lifecycle — against the SAME code DesktopSession uses.
 *
 * This file replaces an earlier test that defined its own `FakeSession` and
 * re-implemented the mute/abort logic. That test passed while the production
 * bug was live, because it never touched production code: it would have kept
 * passing if `ensureSession` had stopped calling `supersede()` altogether.
 *
 * Everything here drives `RunCoordinator` and `replaceSession` from
 * run-coordinator.ts — the exact objects `DesktopSession` holds and
 * `ensureSession` calls. The work functions are fakes (that is the point: they
 * stand in for a slow tool), but the lifecycle algorithm under test is real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RunCoordinator, SessionWork, replaceSession } from './run-coordinator.ts';
import type { PermissionDecision } from '../tools/types.ts';

/** A promise whose settlement the test controls — stands in for a slow tool. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Ordering: replacement must not be constructed until the outgoing run settles
// ---------------------------------------------------------------------------

test('a replacement session is not constructed until the outgoing run has settled', async () => {
  const order: string[] = [];
  const toolDone = deferred();
  const coordinator = new RunCoordinator();
  let aborted = false;

  // Run A: a long mutating tool, then persistence, then cleanup.
  const runA = coordinator.track(async () => {
    order.push('A:tool-start');
    await toolDone.promise;
    order.push('A:tool-end');
    order.push('A:persist');
    order.push('A:cleanup');
  });

  const outgoing = {
    supersede: () =>
      coordinator.supersede(() => {
        aborted = true;
        order.push('A:cancel-requested');
      }),
  };

  // The user switches threads while A's tool is still running.
  const swap = replaceSession(outgoing, () => {
    order.push('B:constructed');
    return { name: 'B' };
  });

  // Give the swap every chance to jump the queue.
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(aborted, 'cancellation is requested immediately');
  assert.ok(!order.includes('B:constructed'), 'B must NOT exist while A is unsettled');

  // A's in-flight filesystem work finishes, then A unwinds.
  toolDone.resolve();
  const b = await swap;
  await runA;

  assert.equal(b.name, 'B');
  assert.deepEqual(order, [
    'A:tool-start',
    'A:cancel-requested',
    'A:tool-end',
    'A:persist',
    'A:cleanup',
    'B:constructed',
  ]);
});

test('supersede resolves only after the run promise settles', async () => {
  const coordinator = new RunCoordinator();
  const gate = deferred();
  let settled = false;

  coordinator.track(async () => {
    await gate.promise;
    settled = true;
  });

  const superseding = coordinator.supersede(() => {});
  let resolvedEarly = true;
  void superseding.then(() => {
    resolvedEarly = !settled;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  gate.resolve();
  await superseding;

  assert.equal(settled, true);
  assert.equal(resolvedEarly, false, 'supersede must not resolve before the run does');
});

test('a run that throws still settles supersede rather than hanging it', async () => {
  const coordinator = new RunCoordinator();
  const gate = deferred();

  const run = coordinator.track(async () => {
    await gate.promise;
    throw new Error('run blew up');
  });
  // The caller owns the rejection; waiters must not see it.
  void run.catch(() => {});

  const superseding = coordinator.supersede(() => {});
  gate.resolve();

  await superseding; // must resolve, not reject
  assert.equal(coordinator.active, false);
});

// ---------------------------------------------------------------------------
// Idempotency and guards
// ---------------------------------------------------------------------------

test('supersede is idempotent and cancels exactly once', async () => {
  const coordinator = new RunCoordinator();
  const gate = deferred();
  let cancels = 0;

  coordinator.track(async () => {
    await gate.promise;
  });

  const first = coordinator.supersede(() => cancels++);
  const second = coordinator.supersede(() => cancels++);
  const third = coordinator.supersede(() => cancels++);

  assert.equal(first, second, 'repeated calls await the same outgoing run');
  assert.equal(second, third);
  assert.equal(cancels, 1, 'a second call must not start a new cancellation path');

  gate.resolve();
  await first;
});

test('supersede with no active run resolves immediately', async () => {
  const coordinator = new RunCoordinator();
  let cancelled = false;
  await coordinator.supersede(() => {
    cancelled = true;
  });
  assert.ok(cancelled);
  assert.ok(coordinator.superseded);
});

test('a superseded coordinator refuses to start new work', async () => {
  const coordinator = new RunCoordinator();
  await coordinator.supersede(() => {});
  assert.equal(coordinator.canStart(), false);
  assert.throws(() => coordinator.track(async () => {}), /superseded/);
});

test('two runs cannot be tracked at once', async () => {
  const coordinator = new RunCoordinator();
  const gate = deferred();
  const first = coordinator.track(async () => {
    await gate.promise;
  });

  assert.equal(coordinator.canStart(), false);
  assert.throws(() => coordinator.track(async () => {}), /already active/);

  gate.resolve();
  await first;
  assert.equal(coordinator.canStart(), true, 'idle again once the run settles');
});

test('active stays true until the run has fully unwound, not merely aborted', async () => {
  const coordinator = new RunCoordinator();
  const gate = deferred();
  const run = coordinator.track(async () => {
    await gate.promise;
  });

  const superseding = coordinator.supersede(() => {});
  assert.equal(coordinator.active, true, 'still active immediately after abort');

  gate.resolve();
  await superseding;
  await run;
  assert.equal(coordinator.active, false);
});

// ---------------------------------------------------------------------------
// The transcript race the ordering exists to prevent
// ---------------------------------------------------------------------------

test('a rebuild of the same session loads only after the outgoing run saved', async () => {
  // Models the real hazard: run A mutates its transcript, the user resumes the
  // SAME thread mid-run, and the replacement must not read a pre-A snapshot
  // (which it would later write back, destroying A's work).
  const db = new Map<string, string[]>([['sess-1', ['msg-0']]]);
  const order: string[] = [];
  const toolDone = deferred();
  const coordinator = new RunCoordinator();

  const aTranscript = ['msg-0', 'msg-1-from-A'];

  coordinator.track(async () => {
    await toolDone.promise;
    order.push('A:save');
    db.set('sess-1', [...aTranscript]);
  });

  const outgoing = { supersede: () => coordinator.supersede(() => {}) };

  const swap = replaceSession(outgoing, () => {
    order.push('B:load');
    return { loaded: [...(db.get('sess-1') ?? [])] };
  });

  await Promise.resolve();
  assert.ok(!order.includes('B:load'), 'B must not read the transcript yet');

  toolDone.resolve();
  const b = await swap;

  assert.deepEqual(order, ['A:save', 'B:load']);
  assert.deepEqual(
    b.loaded,
    ['msg-0', 'msg-1-from-A'],
    "B must load A's saved transcript, not the stale pre-A snapshot",
  );

  // And a later save from B therefore cannot erase A's message.
  db.set('sess-1', [...b.loaded, 'msg-2-from-B']);
  assert.deepEqual(db.get('sess-1'), ['msg-0', 'msg-1-from-A', 'msg-2-from-B']);
});

test('replaceSession constructs immediately when there is no outgoing session', async () => {
  const built = await replaceSession(null, () => ({ name: 'first' }));
  assert.equal(built.name, 'first');
});

// ---------------------------------------------------------------------------
// Outstanding work: queued prompts and blocked approvals
//
// SessionWork is the object DesktopSession actually stores its queue and
// pending approvals in, and `interrupt()` calls `cancelAll` on it.
// ---------------------------------------------------------------------------

test('queued prompts belonging to a cancelled session are dropped and never run', () => {
  const work = new SessionWork();
  work.enqueue('first follow-up');
  work.enqueue('second follow-up');
  assert.equal(work.queuedCount, 2);

  work.cancelAll('interrupted');

  assert.equal(work.queuedCount, 0);
  assert.equal(work.dequeue(), undefined, 'nothing is left to dispatch');
});

test('superseding while parked on approval unblocks the run', async () => {
  const work = new SessionWork();
  let decided: PermissionDecision | null = null;

  // The run is blocked here, exactly as `askPermission` blocks it.
  const blocked = new Promise<PermissionDecision>((resolve) => {
    work.addApproval('perm_run_a_1', (d) => {
      decided = d;
      resolve(d);
    });
  });
  assert.equal(work.pendingApprovals, 1);

  work.cancelAll('interrupted');

  const outcome = await blocked; // must not hang
  assert.deepEqual(outcome, { type: 'deny', reason: 'interrupted' });
  assert.deepEqual(decided, { type: 'deny', reason: 'interrupted' });
  assert.equal(work.pendingApprovals, 0, 'no approval is left outstanding');
});

test('a stale approval card cannot be actioned after cancellation', () => {
  const work = new SessionWork();
  let calls = 0;
  work.addApproval('perm_run_a_1', () => calls++);

  work.cancelAll('interrupted');
  assert.equal(calls, 1, 'the deny fired once');

  // The renderer may still show the card; answering it must do nothing.
  const handled = work.resolveApproval('perm_run_a_1', { type: 'allow' });
  assert.equal(handled, false, 'a superseded run’s approval is unresolvable');
  assert.equal(calls, 1, 'the original resolver is not called again');
});

test('run-scoped ids mean another run cannot answer this run’s prompt', () => {
  const work = new SessionWork();
  let allowed = false;
  work.addApproval('perm_run_A_1', (d) => {
    allowed = d.type === 'allow';
  });

  assert.equal(work.resolveApproval('perm_run_B_1', { type: 'allow' }), false);
  assert.equal(allowed, false);

  assert.equal(work.resolveApproval('perm_run_A_1', { type: 'allow' }), true);
  assert.equal(allowed, true);
});
