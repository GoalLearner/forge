/**
 * Run lifecycle coordination — the part of DesktopSession that decides *when*
 * a session may be replaced.
 *
 * This lives in its own Electron-free module for one reason: it is the logic
 * that was previously wrong, and it could not be tested. `DesktopSession` needs
 * `electron`, so anything embedded in it can only be verified by a test that
 * re-implements it — which proves nothing. Everything here is imported and used
 * by the real session, so the tests and production share one implementation.
 *
 * The defect it exists to prevent:
 *
 *   supersede() used to abort the outgoing run and return immediately. The
 *   replacement session was then constructed while the old run was still inside
 *   `await execute(tool)` and had not yet persisted its transcript. Two runs
 *   could hold tools in the same directory at once, and the replacement could
 *   load a pre-run snapshot and later overwrite the outgoing run's work.
 *
 * The rule this module enforces: **cancellation is a request, settlement is a
 * fact.** A session may only be replaced once its run has actually finished
 * unwinding — tools stopped, results appended, transcript written, cleanup done.
 */

import type { PermissionDecision } from '../tools/types.ts';

export type CancelReason = 'user' | 'superseded' | 'shutdown';

/**
 * The outstanding work a session must drop when it is cancelled: prompts the
 * user queued while a run was busy, and approval prompts the run is blocked on.
 *
 * Extracted with the coordinator for the same reason — these two are what
 * "cancellation actually took effect" means, and inside `DesktopSession` they
 * could not be tested without Electron. A run parked on an approval will hang
 * forever unless something force-denies it, so this is load-bearing rather
 * than bookkeeping.
 */
export class SessionWork {
  /** Prompts typed mid-run, dispatched in order once the run finishes. */
  private queue: string[] = [];
  private approvals = new Map<string, (decision: PermissionDecision) => void>();

  get queuedCount(): number {
    return this.queue.length;
  }

  get pendingApprovals(): number {
    return this.approvals.size;
  }

  enqueue(prompt: string): void {
    this.queue.push(prompt);
  }

  dequeue(): string | undefined {
    return this.queue.shift();
  }

  addApproval(id: string, resolve: (decision: PermissionDecision) => void): void {
    this.approvals.set(id, resolve);
  }

  /**
   * Answer one approval. Returns false when the id is unknown — which is how a
   * card left over from a superseded run is rendered harmless: its id is
   * run-scoped, so it matches nothing here.
   */
  resolveApproval(id: string, decision: PermissionDecision): boolean {
    const resolve = this.approvals.get(id);
    if (!resolve) return false;
    this.approvals.delete(id);
    resolve(decision);
    return true;
  }

  /**
   * Drop everything outstanding: queued prompts are discarded (they belong to a
   * session the user has left) and every blocked approval is denied so the run
   * can unwind instead of waiting on an answer that will never come.
   */
  cancelAll(reason: string): void {
    this.queue = [];
    for (const [id, resolve] of this.approvals) {
      this.approvals.delete(id);
      resolve({ type: 'deny', reason });
    }
  }
}

/**
 * Tracks the one run a session is allowed to have in flight, and makes
 * supersession wait for it.
 */
export class RunCoordinator {
  private _superseded = false;
  /**
   * Resolves when the current run has fully settled, including its `finally`.
   * Never rejects — waiters only care that the run is *over*, and the run's own
   * caller already receives and reports any failure.
   */
  private _settled: Promise<void> | null = null;
  /** Memoized so repeated supersede() calls await the same outgoing run. */
  private _supersession: Promise<void> | null = null;

  /** True once this session has been replaced. Never goes back to false. */
  get superseded(): boolean {
    return this._superseded;
  }

  /** True while a run is in flight. */
  get active(): boolean {
    return this._settled !== null;
  }

  /** The in-flight run's settlement promise, or null when idle. */
  get activeRunPromise(): Promise<void> | null {
    return this._settled;
  }

  /** May a new run start? False once superseded or while one is already active. */
  canStart(): boolean {
    return !this._superseded && this._settled === null;
  }

  /**
   * Track a run's COMPLETE lifecycle.
   *
   * `work` must be the whole of `DesktopSession.run` — model loop, tool
   * results, persistence, cleanup and final state emission — not just the
   * generator. The returned promise is the caller's (it rejects on failure);
   * the promise stored for waiters is a non-rejecting view that settles only
   * after `work` and its `finally` are done.
   */
  track(work: () => Promise<void>): Promise<void> {
    if (this._superseded) {
      throw new Error('RunCoordinator: cannot start a run on a superseded session');
    }
    if (this._settled) {
      throw new Error('RunCoordinator: a run is already active');
    }

    const real = work();
    // Clear on settle, not in the caller's finally: a waiter must never observe
    // `active === false` before `work` has actually unwound.
    this._settled = real.then(
      () => {
        this._settled = null;
      },
      () => {
        this._settled = null;
      },
    );
    return real;
  }

  /**
   * Retire this session and wait for its run to actually stop.
   *
   * Order matters and is the whole point:
   *   1. mark superseded  — so no new run can start, and events go quiet
   *   2. cancel           — synchronous: clear the queue, deny approvals,
   *                         finish the AgentRun, abort the controller
   *   3. await settlement — the outgoing run stops touching the filesystem and
   *                         finishes writing its transcript
   *
   * Idempotent: later calls await the same outgoing run rather than starting a
   * second cancellation. Safe when nothing is running — resolves immediately.
   */
  supersede(cancel: (by: CancelReason) => void): Promise<void> {
    if (this._supersession) return this._supersession;

    this._superseded = true;
    cancel('superseded');

    const pending = this._settled;
    this._supersession = pending ? pending.then(() => undefined) : Promise.resolve();
    return this._supersession;
  }
}

/**
 * Replace one session with another, in the only safe order.
 *
 * Extracted so the ordering itself is testable: the bug was never inside
 * `supersede()`, it was that the replacement was constructed before the old run
 * had settled. `construct` is not called until `outgoing.supersede()` resolves,
 * which is what stops a replacement from loading a transcript snapshot that the
 * outgoing run is about to overwrite.
 */
export async function replaceSession<T>(
  outgoing: { supersede(): Promise<void> } | null,
  construct: () => T,
): Promise<T> {
  if (outgoing) await outgoing.supersede();
  return construct();
}
