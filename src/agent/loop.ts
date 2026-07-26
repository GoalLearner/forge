/**
 * The agent loop.
 *
 * Shape (unchanged since the first tool-calling agents — the value is in the
 * details, not the structure):
 *
 *     build request -> stream response -> did it call tools?
 *        no  -> done, hand the text to the user
 *        yes -> repair args, gate on permission, execute, append ALL results
 *               as one message, go again
 *
 * It is provider-agnostic because both adapters normalize to the same
 * StreamEvent union, so nothing below branches on vendor.
 *
 * What makes it survive cheap models — each of these is a specific failure I'd
 * otherwise hit within an hour of real use:
 *
 *   - Malformed tool JSON is repaired (json-repair.ts), and when it truly can't
 *     be salvaged it becomes an error *result* rather than a thrown exception.
 *     The model reads the error and corrects itself on the next turn; the
 *     session survives. Cheap models get this wrong often enough that crashing
 *     would make the tool unusable.
 *
 *   - Parallel results are appended as ONE message. Splitting them teaches the
 *     model to stop calling tools in parallel, which makes everything slower.
 *
 *   - Ctrl-C mid-stream keeps the partial assistant turn and synthesizes error
 *     results for any tool calls that never ran, so the transcript stays
 *     structurally valid and the session is resumable. An assistant message
 *     with an unanswered tool_use is a hard 400 on the next request.
 *
 *   - Retries only fire before the first token is yielded. Retrying mid-stream
 *     would duplicate visible output and desync the transcript from the screen.
 *
 *   - A step cap stops a confused model from looping on a failing tool forever
 *     while spending money.
 */

import { Conversation } from './messages.ts';
import {
  RuntimeBudget,
  RuntimeExpiredError,
  stateForReason,
  type AgentTerminationReason,
  type TerminalState,
} from './run.ts';
import { parseToolArguments } from './json-repair.ts';
import { assessContext, trimTranscript, truncateToolOutput } from './truncate.ts';
import { withRetry } from '../providers/retry.ts';
import {
  AbortedError,
  ProviderError,
  ZERO_USAGE,
  type ContentBlock,
  type NormalizedUsage,
  type StopReason,
  type StreamEvent,
} from '../providers/types.ts';
import type { ResolvedModel } from '../providers/registry.ts';
import type { Config } from '../config/schema.ts';
import { ToolError } from '../tools/types.ts';
import type {
  PermissionDecision,
  PermissionRequest,
  Tool,
  ToolContext,
  ToolResult,
} from '../tools/types.ts';

// ---------------------------------------------------------------------------
// Events the UI renders
// ---------------------------------------------------------------------------

export type LoopEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string; summary: string }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult; durationMs: number }
  | { type: 'usage'; usage: NormalizedUsage; modelKey: string }
  | { type: 'retry'; attempt: number; delayMs: number; message: string }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | { type: 'error'; message: string; hint?: string }
  | { type: 'aborted' }
  /**
   * The single terminal event.
   *
   * `outcome` and `termination` exist because `done` used to be emitted
   * identically whether the model finished the task or gave up at the step cap
   * — so a run that ran out of budget looked exactly like a success, and
   * headless mode returned exit 0. Consumers must branch on `outcome`, never on
   * the mere arrival of `done`.
   */
  | {
      type: 'done';
      stopReason: StopReason;
      steps: number;
      outcome: TerminalState;
      termination: AgentTerminationReason;
    };

export interface RunTurnOptions {
  conversation: Conversation;
  model: ResolvedModel;
  tools: Map<string, Tool>;
  toolContext: ToolContext;
  config: Config;
  signal: AbortSignal;
  /** Prompt the user. Only called for tools that return a PermissionRequest. */
  confirm: (request: PermissionRequest) => Promise<PermissionDecision>;
  /**
   * The run's active-time clock. The desktop passes its `AgentRun.budget` so
   * the enforced deadline and the reported `activeMs()` are literally the same
   * object; the CLI paths let the loop create one from config. Either way there
   * is exactly one clock per run.
   */
  budget?: RuntimeBudget;
}

/**
 * Run one user request to completion, yielding events as they happen.
 *
 * "One request" means: keep going until the model stops calling tools, we hit
 * the step cap, the user interrupts, or something errors.
 */
export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<LoopEvent, void, undefined> {
  const { conversation, model, tools, config } = opts;
  const maxSteps = config.limits.maxSteps;

  /**
   * The run's own controller, chained to the caller's signal.
   *
   * The loop needs to be able to *cause* an abort (when the runtime budget
   * expires), not just observe one, and it is only handed a signal. Everything
   * downstream — provider stream, retry backoff, tools — uses this signal, so a
   * budget expiry stops in-flight work the same way a Ctrl-C does.
   */
  const runController = new AbortController();
  const budget = opts.budget ?? new RuntimeBudget(config.limits.maxRuntimeMs);
  const signal = runController.signal;

  const onParentAbort = (): void => runController.abort(opts.signal.reason);
  if (opts.signal.aborted) runController.abort(opts.signal.reason);
  else opts.signal.addEventListener('abort', onParentAbort, { once: true });

  // Fires mid-stream and mid-tool, not merely between steps — a wedged request
  // is exactly the case a between-steps check would never catch.
  budget.arm(() => runController.abort(new RuntimeExpiredError(budget.activeMs())));

  /** Was this abort the budget rather than a human? */
  const runtimeExpired = (): boolean => signal.reason instanceof RuntimeExpiredError;

  /**
   * The right terminal event for an abort.
   *
   * A budget expiry cancels the provider, which surfaces as a generic
   * AbortError — indistinguishable from Ctrl-C unless we check who asked. Left
   * unchecked the run would be reported as `cancelled/user`, blaming the user
   * for a limit Forge imposed, so the reason on the signal decides.
   */
  const abortEvent = (steps: number): LoopEvent => {
    const reason = signal.reason;
    // Either the budget's own timer fired, or a tool clamped to the remaining
    // budget hit zero first — both mean the run ran out of time, not that a
    // human stopped it.
    if (reason instanceof RuntimeExpiredError || budget.isExhausted()) {
      const elapsedMs =
        reason instanceof RuntimeExpiredError ? reason.elapsedMs : budget.activeMs();
      return {
        type: 'done',
        stopReason: 'aborted',
        steps,
        outcome: 'failed',
        termination: { kind: 'max_runtime', elapsedMs },
      };
    }
    return { type: 'aborted' };
  };

  /** Release every listener and timer this turn installed. */
  const teardown = (): void => {
    opts.signal.removeEventListener('abort', onParentAbort);
    // Only stop a budget the loop created. A caller-owned budget belongs to the
    // AgentRun, which stops it on its own terminal transition.
    if (!opts.budget) budget.stop();
  };


  // Retry notices are produced inside a callback that cannot yield, so they are
  // buffered here and flushed once withRetry returns. Scoped per-turn rather
  // than module-level so concurrent turns can never interleave their notices.
  const pendingRetries: Array<{ attempt: number; delayMs: number; message: string }> = [];

  if (conversation.noteModel(model.key)) {
    yield {
      type: 'notice',
      level: 'info',
      message: `Switched to ${model.key}. Prompt caches are per-model, so this turn re-reads the full context at uncached prices; subsequent turns cache again.`,
    };
  }

  try {
    // Seeded pessimistically. Until a provider actually tells us why it stopped,
    // "we don't know" is the truth — assuming end_turn is how a truncated stream
    // used to be reported as a completed answer.
    let stopReason: StopReason = 'other';
    let stopExplicit = false;
    let stopRaw: string | undefined;

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) {
        yield abortEvent(step + 1);
        return;
      }

      // ---- Context guard ---------------------------------------------------
      // Runs before assembly so a trim is reflected in this request rather than
      // the next one. See truncate.ts for why it is late and batched.
      const status = assessContext(
        [...conversation.messages],
        Math.ceil(conversation.system.length / 3.6),
        model.entry.contextWindow,
        config.limits.contextWarnPct,
        config.limits.contextTrimPct,
      );
      if (status.pressure === 'trim') {
        const report = trimTranscript(
          [...conversation.messages],
          Math.ceil(conversation.system.length / 3.6),
          model.entry.contextWindow,
        );
        conversation.setMessages(report.messages);
        yield {
          type: 'notice',
          level: 'warn',
          message: `Context was at ${Math.round(status.ratio * 100)}% of ${model.entry.contextWindow.toLocaleString()} tokens — elided ${report.elided} old tool result(s). This turn will be a cache miss; later turns re-cache.`,
        };
      } else if (status.pressure === 'warn' && step === 0) {
        yield {
          type: 'notice',
          level: 'info',
          message: `Context at ${Math.round(status.ratio * 100)}% of the window. /clear starts fresh if this task is done.`,
        };
      }

      // ---- Stream one assistant turn --------------------------------------
      const request = conversation.buildRequest(
        model.entry,
        Math.min(model.entry.maxOutput, 32_000),
        signal,
      );

      const text: string[] = [];
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let usage: NormalizedUsage = ZERO_USAGE;

      try {
        // Retry wraps *opening* the stream and pulling its first event, because
        // that is where the HTTP call actually happens. Once an event has been
        // yielded to the UI we are committed.
        const opened = await withRetry(
          async () => {
            const iterator = model.provider.stream(request)[Symbol.asyncIterator]();
            const first = await iterator.next();
            return { iterator, first };
          },
          {
            maxRetries: config.limits.maxRetries,
            signal,
            onRetry: (attempt, delayMs, error) => {
              pendingRetries.push({ attempt, delayMs, message: error.message });
            },
          },
        );

        // Retry notices are collected in the callback (which can't yield) and
        // flushed here, so the user sees "retrying (2/4)" as it happens.
        for (const r of pendingRetries.splice(0)) {
          yield { type: 'retry', attempt: r.attempt, delayMs: r.delayMs, message: r.message };
        }

        let next = opened.first;
        while (!next.done) {
          const event = next.value as StreamEvent;
          switch (event.type) {
            case 'text_delta':
              text.push(event.text);
              yield { type: 'text_delta', text: event.text };
              break;
            case 'reasoning_delta':
              yield { type: 'reasoning_delta', text: event.text };
              break;
            case 'tool_call_start':
              toolCalls.set(event.index, { id: event.id, name: event.name, args: '' });
              break;
            case 'tool_args_delta': {
              const call = toolCalls.get(event.index);
              if (call) call.args += event.delta;
              break;
            }
            case 'usage':
              usage = event.usage;
              break;
            case 'done':
              stopReason = event.stopReason;
              stopExplicit = event.explicit;
              stopRaw = event.raw;
              break;
          }
          next = await opened.iterator.next();
        }
      } catch (err) {
        // Flush buffered retry notices before reporting the failure, so the user
        // sees that forge did try again rather than assuming it gave up at once.
        for (const r of pendingRetries.splice(0)) {
          yield { type: 'retry', attempt: r.attempt, delayMs: r.delayMs, message: r.message };
        }

        if (err instanceof AbortedError || signal.aborted) {
          // Keep whatever text arrived so the transcript reflects what was shown.
          commitAssistantTurn(conversation, text.join(''), []);
          yield abortEvent(step + 1);
          return;
        }
        const pe = err instanceof ProviderError ? err : null;
        yield {
          type: 'error',
          message: pe ? formatProviderError(pe) : (err as Error).message,
          hint: pe?.opts.hint,
        };
        return;
      }

      yield { type: 'usage', usage, modelKey: model.key };

      // ---- No tools? The turn is over. ------------------------------------
      if (toolCalls.size === 0) {
        commitAssistantTurn(conversation, text.join(''), []);
        if (stopReason === 'max_tokens') {
          yield {
            type: 'notice',
            level: 'warn',
            message: 'Response hit the output token limit and was cut off. Ask it to continue, or raise maxOutput for this model in your config.',
          };
        }
        // The verification step: a stop reason is not automatically a success.
        const termination = terminationForStopReason(stopReason, stopExplicit, stopRaw);
        yield {
          type: 'done',
          stopReason,
          steps: step + 1,
          outcome: stateForReason(termination),
          termination,
        };
        return;
      }

      // ---- Parse arguments -------------------------------------------------
      // Order matters for cache stability: iterate by the index the provider
      // assigned, not by Map insertion order.
      const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);

      interface PreparedCall {
        id: string;
        name: string;
        input: Record<string, unknown>;
        tool?: Tool;
        /** Set when the call is already doomed — bad JSON or unknown tool. */
        failure?: string;
      }

      const prepared: PreparedCall[] = ordered.map((call) => {
        const parsed = parseToolArguments(call.args);
        if (!parsed.ok) {
          return { id: call.id, name: call.name, input: {}, failure: parsed.error };
        }
        const tool = tools.get(call.name);
        if (!tool) {
          return {
            id: call.id,
            name: call.name,
            input: parsed.value,
            failure: `Unknown tool "${call.name}". Available tools: ${[...tools.keys()].sort().join(', ')}`,
          };
        }
        return { id: call.id, name: call.name, input: parsed.value, tool };
      });

      // The assistant turn is recorded BEFORE tools run. If anything below throws
      // or the user interrupts, the transcript already contains the tool_use
      // blocks and we can still answer them — an unanswered tool_use is a 400.
      const assistantBlocks: ContentBlock[] = [];
      const joinedText = text.join('');
      if (joinedText.trim().length > 0) assistantBlocks.push({ type: 'text', text: joinedText });
      for (const call of prepared) {
        assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      conversation.addAssistant(assistantBlocks);

      // ---- Permission gate -------------------------------------------------
      const results: ContentBlock[] = [];
      const runnable: PreparedCall[] = [];

      for (const call of prepared) {
        if (call.failure) {
          results.push(errorResult(call.id, call.failure));
          continue;
        }
        const tool = call.tool;
        if (!tool) continue;

        // Read-only tools never prompt: there is nothing to undo.
        if (tool.readOnly) {
          runnable.push(call);
          continue;
        }

        const request = tool.permission?.(call.input, opts.toolContext) ?? null;
        if (!request) {
          runnable.push(call);
          continue;
        }
        if (opts.toolContext.permissions.isPreApproved(request.scopeKey)) {
          runnable.push(call);
          continue;
        }

        let decision: PermissionDecision;
        try {
          decision = await opts.confirm(request);
        } catch {
          decision = { type: 'deny', reason: 'interrupted' };
        }

        if (decision.type === 'deny') {
          results.push(
            errorResult(
              call.id,
              `The user declined this action${decision.reason ? `: ${decision.reason}` : '.'} Do not retry it. Ask what they would prefer, or continue with the rest of the task.`,
            ),
          );
          continue;
        }
        if (decision.type === 'allow_always') {
          opts.toolContext.permissions.approve(request.scopeKey);
        }
        runnable.push(call);
      }

      // ---- Execute ---------------------------------------------------------
      // Read-only calls run concurrently; anything that mutates runs in order, so
      // two edits to the same file can't interleave.
      const parallel = runnable.filter((c) => c.tool?.readOnly);
      const serial = runnable.filter((c) => !c.tool?.readOnly);

      for (const call of [...parallel, ...serial]) {
        yield {
          type: 'tool_start',
          id: call.id,
          name: call.name,
          summary: safeSummarize(call.tool!, call.input),
        };
      }

      /**
       * The first tool to time out ends the run — but only after every
       * announced tool_use has been answered. An unanswered tool_use is a hard
       * 400 on the next request, so termination waits for pairing.
       */
      let timedOutCall: { name: string; timeoutMs: number } | null = null;

      const budgetFor = (
        call: PreparedCall,
      ): { timeoutMs: number; cappedFrom?: number; error?: ToolError } => {
        try {
          const { timeoutMs, cappedFrom } = resolveToolTimeout(
            call.name,
            call.input,
            config.limits,
            budget.remainingMs(),
          );
          return cappedFrom === undefined ? { timeoutMs } : { timeoutMs, cappedFrom };
        } catch (err) {
          return { timeoutMs: 0, error: err as ToolError };
        }
      };

      // Siblings in a concurrent batch share this: when one times out, the rest
      // are aborted rather than left running against a run that is already over.
      const groupController = new AbortController();

      const settled = await Promise.all(
        parallel.map(async (call) => {
          const { timeoutMs, cappedFrom, error } = budgetFor(call);
          if (error) {
            return { call, executed: null, invalid: error, cappedFrom };
          }
          if (timeoutMs <= 0) {
            return { call, executed: null, invalid: null, cappedFrom };
          }
          const executed = await execute(
            call.tool!,
            call.input,
            opts,
            opts.toolContext,
            timeoutMs,
            [signal, groupController.signal],
          );
          if (executed.outcome === 'timeout' && !timedOutCall) {
            timedOutCall = { name: call.name, timeoutMs };
            groupController.abort();
          }
          return { call, executed, invalid: null, cappedFrom };
        }),
      );

      for (const { call, executed, invalid, cappedFrom } of settled) {
        if (cappedFrom !== undefined) yield clampNotice(call.name, cappedFrom, config.limits.maxExplicitShellTimeoutMs);
        if (invalid) {
          results.push(errorResult(call.id, `${invalid.message}\n${invalid.hint ?? ''}`.trim()));
          continue;
        }
        if (!executed) {
          results.push(
            errorResult(call.id, 'Not started: the run had no active time budget left.'),
          );
          continue;
        }
        yield {
          type: 'tool_end',
          id: call.id,
          name: call.name,
          result: executed.result,
          durationMs: executed.durationMs,
        };
        results.push(toResultBlock(call.id, executed.result, config.limits.maxToolOutputBytes));
      }

      for (const call of serial) {
        // Once anything has stopped the run, later mutations must not begin —
        // but they still need a result so the transcript stays paired.
        if (timedOutCall || signal.aborted) {
          results.push(
            errorResult(call.id, 'Not executed: the run stopped before this tool was reached.'),
          );
          continue;
        }
        const { timeoutMs, cappedFrom, error } = budgetFor(call);
        if (cappedFrom !== undefined) {
          yield clampNotice(call.name, cappedFrom, config.limits.maxExplicitShellTimeoutMs);
        }
        if (error) {
          results.push(errorResult(call.id, `${error.message}\n${error.hint ?? ''}`.trim()));
          continue;
        }
        if (timeoutMs <= 0) {
          results.push(errorResult(call.id, 'Not started: the run had no active time budget left.'));
          continue;
        }

        const executed = await execute(call.tool!, call.input, opts, opts.toolContext, timeoutMs, [
          signal,
        ]);
        yield {
          type: 'tool_end',
          id: call.id,
          name: call.name,
          result: executed.result,
          durationMs: executed.durationMs,
        };
        results.push(toResultBlock(call.id, executed.result, config.limits.maxToolOutputBytes));
        if (executed.outcome === 'timeout' && !timedOutCall) {
          timedOutCall = { name: call.name, timeoutMs };
        }
      }

      // Every tool_use must get exactly one tool_result, in the same turn.
      // This happens BEFORE any termination below, so a run that ends on a
      // timeout still leaves a transcript the provider will accept.
      conversation.addToolResults(results);

      if (timedOutCall) {
        const { name, timeoutMs } = timedOutCall as { name: string; timeoutMs: number };
        // FIRST CAUSE WINS. The root controller can only be aborted once, so if
        // it carries a reason, that reason happened before this tool's deadline
        // — a user cancel, a supersession, or the runtime budget. Reporting the
        // tool instead would blame it for a stop somebody else initiated.
        //
        // Runtime also wins a genuine tie: a tool's deadline is clamped to the
        // remaining budget, so an exhausted budget fires both at the same
        // instant, and pointing at the tool would send the user to raise
        // `toolTimeoutMs`, which would change nothing.
        if (signal.aborted || budget.isExhausted()) {
          yield abortEvent(step + 1);
          return;
        }
        yield {
          type: 'done',
          stopReason: 'aborted',
          steps: step + 1,
          outcome: 'failed',
          termination: { kind: 'tool_timeout', tool: name, timeoutMs },
        };
        return;
      }

      if (signal.aborted) {
        yield abortEvent(step + 1);
        return;
      }
    }

    // Falling out of the loop means the step cap was exhausted while the model
    // was still asking for tools — it did NOT finish. This must be reported as a
    // failure: the previous behaviour emitted a plain `done` here, so headless
    // mode exited 0 and the UI looked like the task had completed.
    yield {
      type: 'notice',
      level: 'warn',
      message: `Stopped after ${maxSteps} steps without finishing. Raise limits.maxSteps in your config, or break the task into smaller pieces.`,
    };
    yield {
      type: 'done',
      stopReason: 'other',
      steps: maxSteps,
      outcome: 'failed',
      termination: { kind: 'max_steps', steps: maxSteps },
    };
  } finally {
    // Runs on every exit: normal completion, early return, throw, or the
    // consumer abandoning the generator. Timers and listeners never outlive
    // the turn that created them.
    teardown();
  }
}

/**
 * Map a provider stop reason onto a termination reason.
 *
 * Only a clean `end_turn` is a success. `max_tokens` means the answer was cut
 * off mid-sentence and `refusal` means the model declined — presenting either
 * as a completed run is a lie the user will act on.
 *
 * Success is an ALLOWLIST, not a fallback. The earlier version returned
 * `completed` for anything it did not recognize, and the adapters seeded
 * `stopReason` with `end_turn` — so a stream that closed without ever saying
 * why produced a confident "completed" on a possibly half-written answer. Both
 * halves are fixed: adapters now report `explicit`, and only an explicit
 * `end_turn` counts as success.
 *
 * `tool_use` reaching here is anomalous — the provider signalled tool calls but
 * the loop parsed none — so it is not treated as a clean finish either.
 */
function terminationForStopReason(
  stopReason: StopReason,
  explicit: boolean,
  raw?: string,
): AgentTerminationReason {
  if (!explicit) return { kind: 'incomplete_stream' };

  switch (stopReason) {
    case 'end_turn':
      return { kind: 'completed' };
    case 'max_tokens':
      return { kind: 'output_truncated' };
    case 'refusal':
      return { kind: 'refused' };
    default:
      return raw === undefined ? { kind: 'unknown_stop' } : { kind: 'unknown_stop', raw };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How a tool call ended, so the caller can pair the right result and reason. */
export type ToolOutcome = 'ok' | 'error' | 'timeout' | 'interrupted';

export interface ExecutedTool {
  result: ToolResult;
  outcome: ToolOutcome;
  durationMs: number;
}

/**
 * Decide how long a single tool call may take.
 *
 * Three ceilings, smallest wins:
 *   - the tool's own budget (`toolTimeoutMs`, or an explicit `run_shell`
 *     timeout capped by `maxExplicitShellTimeoutMs`)
 *   - whatever active run time is left
 *
 * The run-time ceiling matters: without it a 2-minute tool started with 5
 * seconds of budget left would blow through the run limit before anyone
 * noticed, and the run would be reported against the wrong limit.
 *
 * Invalid explicit input is REJECTED, not clamped — silently turning
 * `timeout_ms: -1` into two minutes teaches the model that nonsense works.
 */
export function resolveToolTimeout(
  toolName: string,
  input: Record<string, unknown>,
  limits: { toolTimeoutMs: number; maxExplicitShellTimeoutMs: number },
  remainingRuntimeMs: number,
): { timeoutMs: number; cappedFrom?: number } {
  let base = limits.toolTimeoutMs;
  let cappedFrom: number | undefined;

  if (toolName === 'run_shell' && input.timeout_ms !== undefined && input.timeout_ms !== null) {
    const explicit = Number(input.timeout_ms);
    if (!Number.isFinite(explicit) || !Number.isInteger(explicit) || explicit <= 0) {
      throw new ToolError(
        `timeout_ms must be a positive whole number of milliseconds (got ${String(input.timeout_ms)}).`,
        `Omit it to use the default of ${limits.toolTimeoutMs}ms, or pass a value up to ${limits.maxExplicitShellTimeoutMs}.`,
      );
    }
    // Over the cap is clamped rather than rejected: asking for a long build is
    // reasonable, it just cannot be unbounded.
    if (explicit > limits.maxExplicitShellTimeoutMs) {
      cappedFrom = explicit;
      base = limits.maxExplicitShellTimeoutMs;
    } else {
      base = explicit;
    }
  }

  return { timeoutMs: Math.max(0, Math.min(base, remainingRuntimeMs)), ...(cappedFrom ? { cappedFrom } : {}) };
}

/**
 * Run one tool under a deadline, with cancellation linked to the run.
 *
 * Deliberately NOT a `Promise.race`: racing resolves the moment the timer
 * fires while the tool keeps running, which is how orphaned child processes
 * and post-cancellation writes happen. Instead the child signal is aborted and
 * we *await the tool's own settlement*, so by the time this returns the tool
 * has genuinely stopped.
 *
 * The child controller is per-call, so a timeout on one tool aborts only that
 * tool (and, for a parallel batch, its siblings via `groupSignal`) — never a
 * later run.
 */
async function execute(
  tool: Tool,
  input: Record<string, unknown>,
  opts: RunTurnOptions,
  ctx: ToolContext,
  timeoutMs: number,
  parents: AbortSignal[],
): Promise<ExecutedTool> {
  const started = Date.now();
  const child = new AbortController();
  let timedOut = false;

  const onParent = (): void => child.abort();
  for (const parent of parents) {
    if (parent.aborted) child.abort();
    else parent.addEventListener('abort', onParent, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    child.abort();
  }, timeoutMs);
  timer.unref?.();

  const cleanup = (): void => {
    clearTimeout(timer);
    for (const parent of parents) parent.removeEventListener('abort', onParent);
  };

  try {
    const result = await tool.execute(input, {
      ...ctx,
      signal: child.signal,
      toolTimeoutMs: timeoutMs,
    });
    // A tool may report failure rather than throw (run_shell on a non-zero
    // exit). If we asked it to stop, say so honestly regardless.
    if (timedOut) {
      return {
        result: timeoutResult(tool.name, timeoutMs, result.content),
        outcome: 'timeout',
        durationMs: Date.now() - started,
      };
    }
    // A tool that resolves *gracefully* after being aborted was still stopped
    // by us — a sibling cut short because another tool timed out, or a user
    // cancellation. Reporting that as `ok` would tell the model its work
    // succeeded when it was actually cut off mid-way.
    if (child.signal.aborted) {
      return {
        result: {
          content: `Interrupted before this finished.${result.content.trim() ? `\n\n[partial output — incomplete]\n${result.content.trim()}` : ''}`,
          isError: true,
        },
        outcome: 'interrupted',
        durationMs: Date.now() - started,
      };
    }
    return {
      result,
      outcome: result.isError ? 'error' : 'ok',
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (timedOut) {
      return {
        result: timeoutResult(tool.name, timeoutMs),
        outcome: 'timeout',
        durationMs: Date.now() - started,
      };
    }
    if (err instanceof AbortedError || child.signal.aborted) {
      return {
        result: { content: 'Interrupted before this finished.', isError: true },
        outcome: 'interrupted',
        durationMs: Date.now() - started,
      };
    }
    // A tool throwing is normal (file missing, command failed). Surface it as a
    // result the model can react to, never as a crash.
    const message = err instanceof Error ? err.message : String(err);
    const hint = (err as { hint?: string })?.hint;
    return {
      result: { content: hint ? `${message}\n${hint}` : message, isError: true },
      outcome: 'error',
      durationMs: Date.now() - started,
    };
  } finally {
    cleanup();
  }
}

/**
 * Tell the user (and the model) that a requested timeout was not honoured.
 *
 * `resolveToolTimeout` clamps an over-cap `timeout_ms` rather than rejecting it,
 * because asking for a long build is reasonable. But clamping silently would let
 * the model believe it had 60 minutes and then be surprised at 10 — so the
 * reduction is announced before the tool runs.
 */
function clampNotice(toolName: string, requestedMs: number, capMs: number): LoopEvent {
  return {
    type: 'notice',
    level: 'warn',
    message: `${toolName} asked for a ${Math.round(requestedMs / 1000)}s timeout; capped to the ${Math.round(capMs / 1000)}s maximum (limits.maxExplicitShellTimeoutMs).`,
  };
}

/** The model-facing text for a timeout, including any partial output. */
function timeoutResult(toolName: string, timeoutMs: number, partial?: string): ToolResult {
  const seconds = Math.round(timeoutMs / 100) / 10;
  const lines = [
    `${toolName} timed out after ${seconds}s and was stopped. Any work it had already done may be incomplete.`,
  ];
  if (partial && partial.trim()) {
    lines.push('', '[partial output before the timeout — incomplete]', partial.trim());
  }
  return { content: lines.join('\n'), isError: true };
}

function safeSummarize(tool: Tool, input: Record<string, unknown>): string {
  try {
    return tool.summarize(input);
  } catch {
    return tool.name;
  }
}

function toResultBlock(id: string, result: ToolResult, maxBytes: number): ContentBlock {
  const { content } = truncateToolOutput(result.content, maxBytes);
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: content.length > 0 ? content : '(no output)',
    ...(result.isError ? { is_error: true } : {}),
  };
}

function errorResult(id: string, message: string): ContentBlock {
  return { type: 'tool_result', tool_use_id: id, content: message, is_error: true };
}

/**
 * Commit an assistant turn that produced no (surviving) tool calls.
 * Skips empty turns entirely — an assistant message with no content is a 400 on
 * some providers and noise on the rest.
 */
function commitAssistantTurn(
  conversation: Conversation,
  text: string,
  extra: ContentBlock[],
): void {
  const blocks: ContentBlock[] = [];
  if (text.trim().length > 0) blocks.push({ type: 'text', text });
  blocks.push(...extra);
  if (blocks.length > 0) conversation.addAssistant(blocks);
}

function formatProviderError(err: ProviderError): string {
  const status = err.opts.status ? ` (HTTP ${err.opts.status})` : '';
  return `${err.opts.provider}${status}: ${err.message}`;
}
