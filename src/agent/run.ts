/**
 * The run envelope.
 *
 * `runTurn()` in loop.ts already knows how to drive one user request to
 * completion. What it has never had is a *name for the thing it is doing*:
 * there was no run id, no state, and — the part that actually bit — no reason
 * recorded for why a run stopped. Hitting the step cap emitted the same `done`
 * event as finishing the task, so a run that gave up was indistinguishable from
 * one that succeeded.
 *
 * This module is that missing envelope. It deliberately owns no logic about
 * *how* to talk to a model; it only tracks:
 *
 *   - identity   (`id`, so late events from a superseded run can be filtered)
 *   - state      (a small validated machine, see TRANSITIONS)
 *   - limits     (the bounds a run must respect)
 *   - outcome    (exactly one terminal state, always with a reason)
 *
 * Design notes worth keeping:
 *
 *  - `awaiting_approval` is a real state, not bookkeeping. A run parked on a
 *    permission prompt is blocked on a human and can sit there for an hour.
 *    `activeMs()` therefore subtracts that time, so a future wall-clock budget
 *    can't fire just because someone went to lunch mid-approval.
 *
 *  - There is no `observing` state. Normalizing a tool result and appending it
 *    is synchronous — it can never be observed for longer than a microtask, so
 *    it is a transition, not a state.
 *
 *  - `verifying` earns its place by doing real work: it is where stop reason
 *    and breached limits are mapped to a termination reason. Without it there
 *    is nowhere honest to decide "completed" vs "failed".
 */

import { randomUUID } from 'node:crypto';
import { RetryBudget, RunLedger } from '../session/ledger.ts';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export type AgentRunState =
  | 'idle'
  | 'thinking'
  | 'awaiting_approval'
  | 'running_tool'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** The three states a run can finish in. Mutually exclusive, always reasoned. */
export type TerminalState = 'completed' | 'failed' | 'cancelled';

export const TERMINAL_STATES: readonly AgentRunState[] = ['completed', 'failed', 'cancelled'];

export function isTerminal(state: AgentRunState): state is TerminalState {
  return TERMINAL_STATES.includes(state);
}

/**
 * Legal transitions.
 *
 * Every non-terminal state can go straight to a terminal one, because a
 * provider error or a Ctrl-C can land at any moment. What this table actually
 * prevents is the quiet bug: resurrecting a finished run, or reporting an
 * outcome twice.
 */
const TRANSITIONS: Record<AgentRunState, readonly AgentRunState[]> = {
  idle: ['thinking', 'cancelled', 'failed'],
  thinking: ['running_tool', 'awaiting_approval', 'verifying', 'completed', 'failed', 'cancelled'],
  awaiting_approval: ['running_tool', 'thinking', 'verifying', 'failed', 'cancelled'],
  running_tool: ['thinking', 'awaiting_approval', 'verifying', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

export type AgentTerminationReason =
  /** The model stopped calling tools and produced a final answer. */
  | { kind: 'completed' }
  | { kind: 'max_steps'; steps: number }
  | { kind: 'max_runtime'; elapsedMs: number }
  | { kind: 'max_retries'; attempts: number }
  /**
   * The run's SHARED retry allowance was spent and another retryable failure
   * arrived. Distinct from max_steps/max_runtime/tool_timeout so the user is
   * pointed at `limits.maxRetries` rather than an unrelated limit; `lastError`
   * keeps the provider failure that was actually being retried.
   */
  | { kind: 'retry_limit'; retriesUsed: number; attempts: number; lastError: string }
  | { kind: 'tool_timeout'; tool: string; timeoutMs: number }
  | { kind: 'no_progress'; steps: number }
  | { kind: 'duplicate_calls'; tool: string; repeats: number }
  /** Provider stopped at the output token limit — the answer is cut off. */
  | { kind: 'output_truncated' }
  | { kind: 'refused' }
  /**
   * The stream ended without the provider ever saying why. The answer may be
   * complete or may be cut off mid-sentence — we cannot tell, so we must not
   * claim success. This is the case that used to be silently reported as
   * `end_turn`.
   */
  | { kind: 'incomplete_stream' }
  /** The provider gave a terminal reason we do not recognize. `raw` is theirs. */
  | { kind: 'unknown_stop'; raw?: string }
  | { kind: 'provider_error'; message: string; hint?: string }
  | { kind: 'cancelled'; by: 'user' | 'superseded' | 'shutdown' }
  | { kind: 'setup_error'; message: string };

/** Which terminal state a reason implies. Single source of truth. */
export function stateForReason(reason: AgentTerminationReason): TerminalState {
  if (reason.kind === 'completed') return 'completed';
  if (reason.kind === 'cancelled') return 'cancelled';
  return 'failed';
}

/** Human duration: "45 seconds", "2 minutes", "15 minutes". */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** One-line explanation for the UI and the CLI. */
export function describeTermination(reason: AgentTerminationReason): string {
  switch (reason.kind) {
    case 'completed':
      return 'Completed.';
    case 'max_steps':
      return `Stopped after ${reason.steps} steps without finishing.`;
    case 'max_runtime':
      return `Run stopped after reaching the ${formatDuration(reason.elapsedMs)} active-runtime limit.`;
    case 'max_retries':
      return `Gave up after ${reason.attempts} failed attempts to reach the model.`;
    case 'retry_limit':
      return `Used all ${reason.retriesUsed} available retries for this request and stopped. Last provider error: ${reason.lastError}`;
    case 'tool_timeout':
      return `Tool timed out after ${formatDuration(reason.timeoutMs)}: ${reason.tool}`;
    case 'no_progress':
      return `Stopped after ${reason.steps} steps with no progress.`;
    case 'duplicate_calls':
      return `Stopped: ${reason.tool} was called ${reason.repeats} times with the same failing arguments.`;
    case 'output_truncated':
      return 'The response hit the output token limit and was cut off.';
    case 'refused':
      return 'The model declined to continue.';
    case 'incomplete_stream':
      return 'The model stopped responding without saying why — the answer may be incomplete.';
    case 'unknown_stop':
      return reason.raw
        ? `The model stopped for an unrecognized reason ("${reason.raw}").`
        : 'The model stopped for an unrecognized reason.';
    case 'provider_error':
      return reason.message;
    case 'cancelled':
      return reason.by === 'user'
        ? 'Interrupted.'
        : reason.by === 'superseded'
          ? 'Superseded by another session.'
          : 'Stopped because the app is shutting down.';
    case 'setup_error':
      return reason.message;
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The bounds a run must respect.
 *
 * Only `maxSteps` and `maxRetriesPerCall` are enforced today — they map onto
 * the existing `config.limits`. The rest are declared now so the shape is
 * stable, and are enforced in a later slice (they need config defaults agreed
 * first; a timeout that is too aggressive is worse than none).
 */
export interface AgentLimits {
  maxSteps: number;
  maxRetriesPerCall: number;

  /**
   * Shared automatic-retry allowance for the WHOLE run (Step 4B).
   * Sourced from the existing `limits.maxRetries`, whose meaning changed from
   * per-request to per-run — see the note in config/schema.ts.
   */
  maxRetriesPerRun: number;

  /** Ceiling on any single tool call. Enforced (Step 4A). */
  toolTimeoutMs: number;
  /** Ceiling on ACTIVE run time — approval waits excluded. Enforced (4A). */
  maxRuntimeMs: number;
  /** Hard cap on a caller-supplied run_shell timeout_ms. Enforced (4A). */
  maxExplicitShellTimeoutMs: number;

  /** Declared for later slices; not enforced yet. */
  maxDuplicateFailures?: number;
  maxNoProgressSteps?: number;
  maxCostUsd?: number;
}

/**
 * Why a signal was aborted, when it was the runtime budget rather than a human.
 *
 * Carried as the AbortSignal's `reason` so the loop can tell a budget expiry
 * apart from a Ctrl-C. Without it, cancelling the provider produces a generic
 * AbortError and the run would be reported as `cancelled/user` — blaming the
 * user for a limit Forge imposed.
 */
/**
 * Why a run was cancelled, carried as the AbortSignal's `reason`.
 *
 * Precedence has to be identical in all three front ends, and only the desktop
 * has an `AgentRun` whose `finish()` enforces first-reason-wins. Headless and
 * Ink drive the loop directly, so without a typed cause a user pressing Ctrl-C
 * at the same moment a tool timed out would be told the *tool* failed. An
 * AbortController can only be aborted once, so whatever set this reason is by
 * definition the first cause.
 */
export class RunCancelledError extends Error {
  readonly by: 'user' | 'superseded' | 'shutdown';

  constructor(by: 'user' | 'superseded' | 'shutdown') {
    super(`Run cancelled (${by})`);
    this.name = 'RunCancelledError';
    this.by = by;
  }
}

export class RuntimeExpiredError extends Error {
  readonly elapsedMs: number;

  constructor(elapsedMs: number) {
    super(`Active runtime budget of ${elapsedMs}ms exhausted`);
    this.name = 'RuntimeExpiredError';
    this.elapsedMs = elapsedMs;
  }
}

/**
 * The ONE active-time clock.
 *
 * "Active" excludes time parked on a human approval: a user who walks away
 * mid-prompt must not burn the run's budget. Both the desktop `AgentRun` and
 * the provider-agnostic loop read this same object, so there is never a second
 * clock that could disagree with `activeMs()`.
 *
 * The timer is re-armed from remaining time on every resume rather than run
 * free, which is what keeps the fired deadline consistent with `activeMs()`.
 */
export class RuntimeBudget {
  readonly limitMs: number;
  private now: () => number;
  private startedAt: number;
  private stoppedAt: number | null = null;

  private parkedMs = 0;
  private parkedAt: number | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private onExpire: (() => void) | null = null;
  private expired = false;

  constructor(limitMs: number, now: () => number = Date.now) {
    this.limitMs = limitMs;
    this.now = now;
    this.startedAt = now();
  }

  /** Wall clock since the run began, frozen once stopped. */
  elapsedMs(): number {
    return (this.stoppedAt ?? this.now()) - this.startedAt;
  }

  /** Wall clock minus approval parking — the number the budget enforces. */
  activeMs(): number {
    const parked =
      this.parkedMs + (this.parkedAt !== null ? (this.stoppedAt ?? this.now()) - this.parkedAt : 0);
    return Math.max(0, this.elapsedMs() - parked);
  }

  /** Active time left before the limit, never negative. */
  remainingMs(): number {
    if (!Number.isFinite(this.limitMs)) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.limitMs - this.activeMs());
  }

  /** True once the budget is spent. */
  isExhausted(): boolean {
    return this.expired || this.remainingMs() <= 0;
  }

  /**
   * Start counting a budget expiry. The callback fires once, mid-flight — the
   * whole point is that a stuck model stream or tool is interrupted rather than
   * discovered between steps.
   */
  arm(onExpire: () => void): void {
    this.onExpire = onExpire;
    this.rearm();
  }

  private rearm(): void {
    this.clearTimer();
    if (!this.onExpire || this.expired || this.stoppedAt !== null) return;
    if (!Number.isFinite(this.limitMs)) return;
    // Parked runs hold no timer at all: that is what excludes approval time.
    if (this.parkedAt !== null) return;

    const remaining = this.remainingMs();
    const fire = (): void => {
      this.expired = true;
      this.timer = null;
      this.onExpire?.();
    };
    if (remaining <= 0) {
      // Already spent — fire on the next tick so callers can finish wiring up.
      this.timer = setTimeout(fire, 0);
    } else {
      this.timer = setTimeout(fire, remaining);
    }
    // Never hold the process open just to enforce a limit.
    this.timer.unref?.();
  }

  /** Enter an approval wait: the clock and the timer both pause. */
  pauseForApproval(): void {
    if (this.parkedAt !== null || this.stoppedAt !== null) return;
    this.parkedAt = this.now();
    this.clearTimer();
  }

  /** Leave an approval wait: bank the parked time and re-arm from what is left. */
  resumeFromApproval(): void {
    if (this.parkedAt === null) return;
    this.parkedMs += this.now() - this.parkedAt;
    this.parkedAt = null;
    this.rearm();
  }

  /** Freeze the clock and drop the timer. Safe to call repeatedly. */
  stop(): void {
    if (this.stoppedAt === null) this.stoppedAt = this.now();
    this.clearTimer();
    this.onExpire = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Test seam: is a timer currently pending? */
  get timerActive(): boolean {
    return this.timer !== null;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export class InvalidTransitionError extends Error {
  readonly from: AgentRunState;
  readonly to: AgentRunState;

  constructor(from: AgentRunState, to: AgentRunState) {
    super(`Illegal run transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export interface AgentRunOptions {
  sessionId: string | null;
  limits: AgentLimits;
  /** Injected so the desktop session can own cancellation. */
  abort: AbortController;
  /** Overridable for tests; defaults to Date.now. */
  now?: () => number;
}

export class AgentRun {
  readonly id: string;
  readonly limits: AgentLimits;
  readonly abort: AbortController;
  readonly startedAt: number;

  /**
   * Filled in lazily: a thread's database row is only created when the user
   * actually sends something, so a run can start before its session exists.
   */
  sessionId: string | null;

  state: AgentRunState = 'idle';
  step = 0;
  endedAt: number | null = null;
  termination: AgentTerminationReason | null = null;

  private now: () => number;

  /**
   * The run's active-time clock, shared with the loop.
   *
   * Owning one `RuntimeBudget` — rather than the approval bookkeeping this
   * class used to keep privately — is what guarantees the enforced deadline and
   * the reported `activeMs()` can never disagree. The loop receives this exact
   * object and arms the timer on it.
   */
  readonly budget: RuntimeBudget;

  /**
   * This prompt's accounting, created once and never shared.
   *
   * Owned by the run rather than the loop so that the retry allowance and the
   * attempt records survive across every model turn the prompt produces — and
   * so a superseded run's ledger finalizes with the run that owns it.
   */
  readonly ledger: RunLedger;

  constructor(opts: AgentRunOptions) {
    this.id = newRunId();
    this.sessionId = opts.sessionId;
    this.limits = opts.limits;
    this.abort = opts.abort;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.budget = new RuntimeBudget(opts.limits.maxRuntimeMs, this.now);
    this.ledger = new RunLedger(this.id, new RetryBudget(opts.limits.maxRetriesPerRun));
  }

  get finished(): boolean {
    return isTerminal(this.state);
  }

  /** Total wall clock, including time blocked on a human. */
  elapsedMs(): number {
    return (this.endedAt ?? this.now()) - this.startedAt;
  }

  /**
   * Wall clock minus time parked on a permission prompt.
   *
   * This is the number the runtime budget enforces. A user who walks away
   * mid-approval must not cause a timeout — they were never the slow part.
   */
  activeMs(): number {
    return this.budget.activeMs();
  }

  /** Active time left before `maxRuntimeMs`, used to bound each tool call. */
  remainingRuntimeMs(): number {
    return this.budget.remainingMs();
  }

  /** Move to `to`, or throw if the transition is not legal. */
  transition(to: AgentRunState): void {
    const legal = TRANSITIONS[this.state];
    if (!legal.includes(to)) throw new InvalidTransitionError(this.state, to);

    // Approval parking is measured on the edges in and out of the state, so it
    // stays correct no matter which state follows — and pausing the budget here
    // is what stops the runtime timer while a human is deciding.
    if (to === 'awaiting_approval') {
      this.budget.pauseForApproval();
    } else {
      this.budget.resumeFromApproval();
    }

    this.state = to;
    if (isTerminal(to)) {
      this.endedAt = this.now();
      // Deterministic teardown: a terminal run holds no timer, so a stale
      // deadline from this run can never fire against a later one.
      this.budget.stop();
    }
  }

  /**
   * Finish the run with a reason. Idempotent by design: the loop has several
   * paths that can race to terminate (abort during a tool, provider error while
   * already cancelling), and the first reason to land is the true one.
   */
  finish(reason: AgentTerminationReason): TerminalState {
    if (this.finished) return this.state as TerminalState;
    const target = stateForReason(reason);
    // Route through `verifying` when the current state allows it, so the
    // machine reads the same whether a run ended cleanly or was cut short.
    if (!TRANSITIONS[this.state].includes(target) && TRANSITIONS[this.state].includes('verifying')) {
      this.transition('verifying');
    }
    this.termination = reason;
    this.transition(target);
    return target;
  }

  /** Has this run exceeded its step budget? */
  outOfSteps(): boolean {
    return this.step >= this.limits.maxSteps;
  }

  /** Compact snapshot for IPC and logging. */
  snapshot(): {
    id: string;
    sessionId: string | null;
    state: AgentRunState;
    step: number;
    elapsedMs: number;
    activeMs: number;
    termination: AgentTerminationReason | null;
  } {
    return {
      id: this.id,
      sessionId: this.sessionId,
      state: this.state,
      step: this.step,
      elapsedMs: this.elapsedMs(),
      activeMs: this.activeMs(),
      termination: this.termination,
    };
  }
}
