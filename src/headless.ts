/**
 * Non-interactive mode (`forge -p "..."` or `forge "..."`).
 *
 * This deliberately does NOT render the Ink UI. Ink needs a TTY in raw mode;
 * piped into a file or another process it throws outright, and even when it
 * doesn't, the output is full of cursor-control escape codes that no script
 * wants to parse.
 *
 * Stream split, so the tool composes properly in a shell:
 *
 *   stdout — the assistant's answer, and nothing else.
 *            `forge -p "summarize this" > notes.md` gives you exactly the answer.
 *   stderr — tool activity, notices, errors. Visible when you're watching,
 *            invisible when you're redirecting.
 *
 * Permission prompts are auto-denied here, because nobody is present to answer
 * one and silently blocking forever is the worst possible behavior. The denial
 * message names the flag that changes it, and the model is told so it can adapt
 * rather than retrying the same blocked call.
 */

import { runTurn } from './agent/loop.ts';
import { describeTermination, RunCancelledError } from './agent/run.ts';
import { RetryBudget, RunLedger, formatLedgerCost, type TokenCount } from './session/ledger.ts';
import { MutationState, describeVerification, MAX_VERIFICATION_REPAIRS } from './agent/verification.ts';

import type { Conversation } from './agent/messages.ts';
import type { ResolvedModel } from './providers/registry.ts';
import type { Config } from './config/schema.ts';
import type { SessionStore } from './session/store.ts';
import { cacheHitRate, formatCost, addUsage, EMPTY_TOTALS } from './session/cost.ts';
import type { PermissionDecision, Tool, ToolContext } from './tools/types.ts';

export interface HeadlessOptions {
  prompt: string;
  conversation: Conversation;
  model: ResolvedModel;
  tools: Map<string, Tool>;
  toolContext: ToolContext;
  config: Config;
  store: SessionStore;
  sessionId: string;
  warnings: string[];
  /** Print a one-line cost summary to stderr when finished. */
  showCost: boolean;
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const out = (text: string): void => void process.stdout.write(text);
  const log = (text: string): void => void process.stderr.write(`${text}\n`);

  for (const warning of opts.warnings) log(`! ${warning}`);

  // Ctrl-C in a pipeline should stop the model promptly, not wait for the
  // current turn to finish.
  const controller = new AbortController();
  // Typed cause so a Ctrl-C landing beside a tool deadline is still reported
  // as a cancellation rather than as the tool's failure.
  const onSigint = (): void => controller.abort(new RunCancelledError('user'));
  process.on('SIGINT', onSigint);

  opts.conversation.addUserText(opts.prompt);
  opts.store.setTitleIfUnset(opts.sessionId, opts.prompt);

  // One ledger per submitted prompt, with the shared retry allowance.
  const ledger = new RunLedger(`run_headless_${Date.now().toString(36)}`, new RetryBudget(opts.config.limits.maxRetries));
  const mutations = new MutationState(MAX_VERIFICATION_REPAIRS);

  let totals = { ...EMPTY_TOTALS };
  let sawError = false;
  let aborted = false;
  /**
   * Default to failure. A run that produces no terminal `done` at all (the
   * generator threw, the process was torn down) must not report success — and
   * a `done` that says "failed" must not either. Exit 0 is earned, not assumed.
   */
  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';

  try {
    for await (const event of runTurn({
      conversation: opts.conversation,
      model: opts.model,
      tools: opts.tools,
      toolContext: { ...opts.toolContext, signal: controller.signal },
      config: opts.config,
      signal: controller.signal,
      ledger,
      mutations,
      confirm: async (request): Promise<PermissionDecision> => {
        log(
          `! Auto-denied "${request.title}: ${request.detail}" — nothing can answer a prompt in non-interactive mode.`,
        );
        log('  Re-run with --permission-mode yolo to allow it, or use interactive mode.');
        return {
          type: 'deny',
          reason: 'forge is running non-interactively and cannot ask for approval',
        };
      },
    })) {
      switch (event.type) {
        case 'text_delta':
          out(event.text);
          break;
        case 'tool_start':
          log(`● ${event.name} ${event.summary}`);
          break;
        case 'tool_end':
          if (event.result.isError) {
            log(`  ✗ ${firstLine(event.result.content)}`);
          }
          break;
        case 'usage':
          totals = addUsage(totals, event.usage, opts.model.entry);
          opts.store.recordUsage(opts.sessionId, event.usage, opts.model.key, opts.model.entry);
          break;
        case 'retry':
          log(`! retry ${event.attempt}: ${event.message}`);
          break;
        case 'notice':
          log(`! ${event.message}`);
          break;
        case 'error':
          sawError = true;
          log(`✗ ${event.message}`);
          if (event.hint) log(`  ${event.hint}`);
          break;
        case 'aborted':
          aborted = true;
          outcome = 'cancelled';
          log('! Interrupted.');
          break;
        case 'done':
          outcome = event.outcome;
          // The warning text already explained *why* (see the notice above);
          // this line is what makes the failure unmissable in a log.
          if (event.outcome !== 'completed') {
            log(`✗ Run ${event.outcome}: ${describeTermination(event.termination)}`);
          }
          break;
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    // Persist before the caller closes the database. A failure here must not
    // mask the real result — the answer has already been printed.
    try {
      opts.store.saveMessages(opts.sessionId, opts.conversation.messages);
      opts.store.touch(opts.sessionId, opts.model.key);
    } catch {
      /* best effort */
    }
  }

  out('\n');

  if (opts.showCost && totals.requests > 0) {
    const hitRate = Math.round(cacheHitRate(totals) * 100);
    log(
      `${opts.model.key}  ${formatCost(totals.cost)}  ${totals.requests} request(s)  cache ${hitRate}%`,
    );
  }

  // Step 4B: the honest line. Printed whenever anything was actually attempted,
  // including runs that failed — those are exactly the ones whose spend used to
  // vanish. `formatLedgerCost` refuses to render an unknown total as $0.00.
  // Finalize and persist UNCONDITIONALLY. Gating this on --cost would mean a
  // run's accounting existed only when someone thought to ask for it, and the
  // session totals the desktop reads back would silently omit every headless
  // run. Whether it is PRINTED is a display choice; whether it is RECORDED is
  // not.
  const s = ledger.finalize();
  mutations.finalize();
  const verification = mutations.summary();

  // Printed unconditionally, unlike cost: whether the change was verified is a
  // correctness fact, not a display preference.
  if (verification.status !== 'not_required') {
    log(`  ${describeVerification(verification)}`);
    // Required and advisory are listed separately so a failing advisory can
    // never be mistaken for the thing that decided the run.
    const required = verification.checks.filter((c) => c.required);
    const advisory = verification.checks.filter((c) => !c.required);
    for (const c of required) {
      log(
        `    ${c.result === 'passed' ? 'ok  ' : 'FAIL'} ${c.name} — ${c.command} (exit ${c.exitCode ?? 'none'})`,
      );
    }
    for (const c of advisory) {
      log(
        `    ${c.result === 'passed' ? 'ok  ' : 'warn'} ${c.name} — ${c.command} (exit ${c.exitCode ?? 'none'}) [advisory]`,
      );
    }
    if (advisory.some((c) => c.result !== 'passed')) {
      log('    advisory checks report on the whole working tree and are not attributed to this run');
    }
    log(`    repair rounds used: ${verification.repairsUsed}/${verification.repairAllowance}`);
    if (verification.changedPaths.length > 0) {
      log(`    files changed: ${verification.changedPaths.join(', ')}`);
    }
  }

  try {
    opts.store.saveRunLedger(opts.sessionId, s, verification);
  } catch {
    // Best-effort, same as the transcript save above: a closed database during
    // shutdown must not turn into an unhandled rejection.
  }

  if (opts.showCost) {
    if (s.providerAttempts > 0) {
      log(
        `  ${s.logicalRequests} model request(s), ${s.providerAttempts} provider attempt(s), ` +
          `${s.retriesUsed}/${s.retryLimit} retries used`,
      );
      log(
        `  cache-hit ${fmtTokens(s.cacheHitInput)} · cache-miss ${fmtTokens(s.cacheMissInput)} · ` +
          `output ${fmtTokens(s.outputTokens)}${s.reasoningTokens === null ? '' : ` · reasoning ${fmtTokens(s.reasoningTokens)}`}`,
      );
      log(`  ${formatLedgerCost(s.cost)}`);
    }
  }

  return exitCodeFor({ outcome, sawError, aborted });
}

/**
 * Map a run's result to a process exit code.
 *
 * Exported so the mapping is directly testable — it is what a CI script or a
 * shell pipeline actually branches on, and it used to return 0 for a run that
 * hit the step cap or was silently truncated.
 *
 * Zero is earned, never assumed: only an explicit `completed` outcome with no
 * error and no interruption succeeds. Every limit, refusal, truncation,
 * unknown stop and cancellation is a failure.
 */
export function exitCodeFor(result: {
  outcome: 'completed' | 'failed' | 'cancelled';
  sawError: boolean;
  aborted: boolean;
}): number {
  return result.outcome === 'completed' && !result.sawError && !result.aborted ? 0 : 1;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 200) ?? '';
}

/** Unknown token counts print as "unknown", never as 0. */
function fmtTokens(v: TokenCount): string {
  return v === null ? 'unknown' : v.toLocaleString();
}
