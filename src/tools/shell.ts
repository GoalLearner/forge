/**
 * Shell execution.
 *
 * The most powerful tool and the one that needs the most care. Three layers:
 *
 *   1. The danger classifier (safety/danger.ts) runs on every command. Anything
 *      `dangerous` is confirmed regardless of permission mode — yolo means
 *      "stop nagging me about npm test", not "disable the guardrail".
 *   2. Commands run with cwd pinned to the project root and a hard timeout, so
 *      a runaway process can't wedge the session.
 *   3. Output is capped. An unbounded `npm run build` can emit megabytes, and
 *      every byte would be re-sent on every subsequent turn.
 *
 * Shell selection defaults to PowerShell on Windows and bash elsewhere, because
 * that is what the user's own muscle memory expects. Git Bash is one config
 * line away for people who prefer POSIX syntax on Windows.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { assessCommand } from '../safety/danger.ts';
import {
  ToolError,
  type PermissionRequest,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts';

const IS_WINDOWS = process.platform === 'win32';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

export interface ShellSpec {
  /** Executable to spawn. */
  command: string;
  /** Argv preceding the user's command string. */
  args: string[];
  /** Human-readable name for the system prompt and UI. */
  label: string;
}

/**
 * Resolve which interpreter to use.
 * `auto` picks PowerShell on Windows and bash elsewhere.
 */
export function resolveShell(config: {
  kind: 'auto' | 'powershell' | 'bash' | 'cmd';
  path?: string;
}): ShellSpec {
  const kind = config.kind === 'auto' ? (IS_WINDOWS ? 'powershell' : 'bash') : config.kind;

  switch (kind) {
    case 'powershell':
      return {
        command: config.path ?? 'powershell.exe',
        // -NoProfile keeps startup fast and behavior reproducible across machines;
        // -NonInteractive makes a prompt-for-input command fail fast instead of hanging.
        args: ['-NoProfile', '-NonInteractive', '-Command'],
        label: 'PowerShell',
      };
    case 'cmd':
      return { command: config.path ?? 'cmd.exe', args: ['/d', '/s', '/c'], label: 'cmd.exe' };
    case 'bash': {
      const fallback = IS_WINDOWS && existsSync(GIT_BASH) ? GIT_BASH : 'bash';
      return { command: config.path ?? fallback, args: ['-c'], label: 'bash' };
    }
  }
}

export const shellTool: Tool = {
  name: 'run_shell',
  description:
    'Run a shell command in the project directory and return its output. Prefer the dedicated tools where one exists (read_file, glob, grep, list_dir) — they are faster and produce cleaner output. Keep each command to a single purpose so the user can review it.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute.' },
      description: {
        type: 'string',
        description: 'Short description of what this command does, shown to the user.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Timeout in milliseconds. Defaults to 120000.',
        minimum: 1000,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },

  summarize(input) {
    const command = String(input.command ?? '');
    return command.length > 70 ? `${command.slice(0, 70)}…` : command;
  },

  permission(input, ctx): PermissionRequest | null {
    const command = String(input.command ?? '');
    const risk = assessCommand(command);

    if (!ctx.permissions.needsShellConfirmation(risk.level)) return null;

    return {
      title: risk.level === 'dangerous' ? 'Run DANGEROUS command' : 'Run shell command',
      detail: command,
      ...(risk.reasons.length > 0 ? { danger: risk.reasons.join('; ') } : {}),
      // Only genuinely destructive commands get the type-to-arm gate. Caution
      // still shows its reason, but stays a one-click approval.
      ...(risk.level === 'dangerous' ? { requiresArming: true } : {}),
      // Scope by the full command text: approving `npm test` must not silently
      // approve `npm publish`. Coarser scoping here would be a real footgun.
      scopeKey: `shell:${command.trim()}`,
    };
  },

  async execute(input, ctx): Promise<ToolResult> {
    const command = String(input.command ?? '').trim();
    if (!command) throw new ToolError('A command is required.');

    const shell = resolveShell(ctx.config.shell);
    // The loop resolves the effective deadline — min(explicit, the shell cap,
    // remaining run time) — and enforces it too. Using its number here keeps
    // the message the model reads consistent with when the kill actually
    // happens. Outside the loop (direct tool tests) fall back to config.
    const timeoutMs =
      ctx.toolTimeoutMs ?? Number(input.timeout_ms ?? ctx.config.shell.timeoutMs);

    const result = await runCommand(shell, command, {
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      maxBytes: ctx.config.limits.maxToolOutputBytes,
    });

    const parts: string[] = [];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.timedOut) {
      parts.push(`[timed out after ${timeoutMs}ms — the process was killed]`);
    }
    if (result.tree?.outcome === 'unconfirmed') {
      // Never claim a clean tree kill we did not achieve. The reason is
      // included because "access denied" and "already exited" call for very
      // different follow-up from the user.
      const why = result.tree.detail ? ` (${result.tree.detail})` : '';
      parts.push(
        `[warning: forge stopped the shell but could not confirm every child process was terminated${why} — a background process may still be running]`,
      );
    }
    if (result.truncated) {
      parts.push('[output truncated by forge — redirect to a file and read it if you need all of it]');
    }

    const body = parts.join('\n\n') || '(no output)';
    const failed = result.timedOut || result.code !== 0;

    return {
      // Exit status is stated explicitly: models otherwise assume success when
      // a command fails silently with empty stdout.
      content: failed ? `Exit code ${result.code ?? 'killed'}\n\n${body}` : body,
      isError: failed,
      display: { kind: 'shell', command, exitCode: result.code ?? -1 },
    };
  },
};

// ---------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /**
   * The verdict on terminating the process tree, or null when the command
   * exited on its own. An `unconfirmed` outcome is surfaced to the model rather
   * than hidden — a possible stray descendant is something it should know about
   * before assuming the machine is clean.
   */
  tree: TreeKillResult | null;
}

/**
 * Kill a spawned command AND its descendants.
 *
 * `child.kill()` signals only the process we spawned — which here is the shell
 * wrapper (`powershell -Command …` / `bash -lc …`), not the thing the user
 * actually ran. On POSIX the child is a process-group leader thanks to
 * `detached: true`, so a negative PID reaches the whole group. Windows has no
 * process groups, so we shell out to `taskkill /T` which walks the tree.
 *
 * Without this, cancelling `npm test` killed the wrapper and left node running
 * — the run reported "stopped" while the work continued in the background.
 * taskkill ships with Windows; no dependency is added for this.
 */
/** How long taskkill itself may take before we stop waiting for it. */
const TASKKILL_TIMEOUT_MS = 5_000;

/** Cap on captured taskkill output — diagnostics only, never unbounded. */
const TASKKILL_OUTPUT_CAP = 4_000;

/** Raw evidence from one taskkill attempt. Interpreted by decideTreeKill. */
export interface TaskkillResult {
  exitCode: number | null;
  timedOut: boolean;
  launchError?: string;
  stdout: string;
  stderr: string;
}

/**
 * What we can honestly say about a termination attempt.
 *
 * `tree` is a CLAIM, and it is only ever made on confirmed evidence. Anything
 * ambiguous is `unconfirmed`, which the shell tool surfaces as a visible
 * degraded-safety warning rather than pretending the machine is clean.
 */
export interface TreeKillResult {
  outcome: 'tree' | 'unconfirmed';
  /** Short, safe phrase for the user and model. Never raw system output. */
  detail?: string;
  /** Whether we additionally killed the wrapper directly. */
  fallbackUsed: boolean;
}

/**
 * Is this PID still running?
 *
 * Signal 0 checks existence without touching the process. Only ESRCH proves it
 * is gone — EPERM means it exists but belongs to someone else, and an unknown
 * error tells us nothing. Both are treated as "still alive", because assuming
 * death on any error is exactly how a survivor gets reported as terminated.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ESRCH') return false; // definitively gone
    if (code === 'EPERM') return true; // exists, not ours to signal
    return true; // unknown — stay conservative
  }
}

/**
 * Turn taskkill evidence into an honest verdict.
 *
 * The policy that Stage 0 hinges on: **exit code 128 is never a clean tree
 * kill.** Windows returns 128 both for "process not found" and for "could not
 * be terminated — access is denied" (verified: `taskkill /PID 4 /T /F` exits
 * 128 while PID 4 keeps running). The two are indistinguishable by exit code
 * alone, so 128 always degrades to `unconfirmed`.
 *
 * Note the deliberate asymmetry: a *gone wrapper* does not upgrade 128 to
 * success either. taskkill walks the tree top-down, so it can fail on a
 * protected descendant after the wrapper has already exited — the wrapper's
 * absence says nothing about its children.
 */
export function decideTreeKill(
  evidence: TaskkillResult,
  wrapperAlive: boolean,
): { outcome: 'tree' | 'unconfirmed'; detail?: string; needsFallback: boolean } {
  if (evidence.launchError !== undefined) {
    return { outcome: 'unconfirmed', detail: 'taskkill could not be launched', needsFallback: true };
  }
  if (evidence.timedOut) {
    return { outcome: 'unconfirmed', detail: 'taskkill timed out', needsFallback: true };
  }

  if (evidence.exitCode === 0) {
    // The only path that may claim success — and only if the wrapper really is
    // gone. taskkill reporting success while the wrapper survives means
    // something is still holding on.
    if (!wrapperAlive) return { outcome: 'tree', needsFallback: false };
    return {
      outcome: 'unconfirmed',
      detail: 'taskkill reported success but the shell was still running',
      needsFallback: true,
    };
  }

  if (evidence.exitCode === 128) {
    // Ambiguous by construction. Use the captured text only to say WHY, and
    // only as a short mapped phrase.
    const text = `${evidence.stdout}\n${evidence.stderr}`.toLowerCase();
    const detail = /access is denied|access denied/.test(text)
      ? 'access denied for part of the process tree'
      : /not found|no running instance|could not be found/.test(text)
        ? 'process not found (it may have already exited)'
        : 'taskkill could not confirm termination';
    return { outcome: 'unconfirmed', detail, needsFallback: wrapperAlive };
  }

  return {
    outcome: 'unconfirmed',
    detail: `taskkill exited with code ${String(evidence.exitCode)}`,
    needsFallback: wrapperAlive,
  };
}

/** Injectable pieces, so the decision path is testable without real processes. */
export interface KillDeps {
  runTaskkill: (pid: number, timeoutMs: number) => Promise<TaskkillResult>;
  isAlive: (pid: number) => boolean;
  killWrapper: (child: ChildProcess) => void;
  taskkillTimeoutMs: number;
}

const DEFAULT_KILL_DEPS: KillDeps = {
  runTaskkill,
  isAlive: isProcessAlive,
  killWrapper: (child) => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  },
  taskkillTimeoutMs: TASKKILL_TIMEOUT_MS,
};

export async function killTree(
  child: ChildProcess,
  deps: KillDeps = DEFAULT_KILL_DEPS,
): Promise<TreeKillResult> {
  const pid = child.pid;
  if (pid === undefined) {
    return { outcome: 'unconfirmed', detail: 'the shell process had no pid', fallbackUsed: false };
  }

  if (process.platform === 'win32') {
    // ORDER IS LOAD-BEARING.
    //
    // taskkill /T walks the live parent→child tree. An earlier version killed
    // the wrapper first, which destroyed that tree: descendants were reparented,
    // taskkill had nothing to walk, and a survivor holding the inherited
    // stdout/stderr handles kept the wrapper's 'close' from ever firing — so the
    // tool promise, and the whole AgentRun, hung forever.
    //
    // Leave the tree intact, await taskkill, then judge the evidence.
    const evidence = await deps.runTaskkill(pid, deps.taskkillTimeoutMs);
    const verdict = decideTreeKill(evidence, deps.isAlive(pid));

    if (verdict.needsFallback) {
      // Only ever after taskkill has completed, timed out, or failed. This stops
      // the wrapper but says nothing about its descendants.
      deps.killWrapper(child);
    }

    return {
      outcome: verdict.outcome,
      ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
      fallbackUsed: verdict.needsFallback,
    };
  }

  try {
    // Negative pid = the whole process group (see `detached: true` in spawn).
    process.kill(-pid, 'SIGKILL');
    return { outcome: 'tree', fallbackUsed: false };
  } catch {
    deps.killWrapper(child);
    return {
      outcome: 'unconfirmed',
      detail: 'could not signal the process group',
      fallbackUsed: true,
    };
  }
}

/**
 * Run `taskkill /PID <pid> /T /F` and wait for it, bounded.
 *
 * Resolves true when taskkill exited cleanly (tree terminated), false when it
 * failed, could not launch, or outran its own timeout. taskkill is never
 * allowed to hang the agent: the bounded wait is what guarantees that.
 */
/**
 * Run `taskkill /PID <pid> /T /F` and report what actually happened.
 *
 * Returns EVIDENCE, not a verdict. The previous version returned a boolean and
 * folded exit code 128 into "success", which was wrong: 128 is also what
 * taskkill returns when it could not terminate the tree
 * ("Reason: Access is denied"), verified against the real binary. Interpreting
 * the evidence is `decideTreeKill`'s job, so the policy is testable on its own.
 *
 * Output is captured (previously `stdio: 'ignore'`) purely so "not found" and
 * "access denied" stay distinguishable. It is bounded, and only a short mapped
 * phrase ever reaches the model — never raw system text.
 */
export function runTaskkill(pid: number, timeoutMs: number): Promise<TaskkillResult> {
  return new Promise((resolve) => {
    let settled = false;
    let killer: ChildProcess | undefined;
    let stdout = '';
    let stderr = '';

    const done = (result: TaskkillResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer?.removeAllListeners();
      resolve(result);
    };

    const timer = setTimeout(() => {
      // taskkill itself is wedged. Kill the helper so it cannot linger, then
      // report a timeout — it must never hold the AgentRun open.
      try {
        killer?.kill();
      } catch {
        /* ignore */
      }
      done({ exitCode: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    timer.unref?.();

    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      done({
        exitCode: null,
        timedOut: false,
        launchError: err instanceof Error ? err.message : String(err),
        stdout,
        stderr,
      });
      return;
    }

    killer.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < TASKKILL_OUTPUT_CAP) stdout += c.toString('utf8');
    });
    killer.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < TASKKILL_OUTPUT_CAP) stderr += c.toString('utf8');
    });

    killer.on('error', (err) =>
      done({ exitCode: null, timedOut: false, launchError: err.message, stdout, stderr }),
    );
    killer.on('close', (code) => done({ exitCode: code, timedOut: false, stdout, stderr }));
  });
}

/**
 * `killDeps` is the entire test seam.
 *
 * It exists so the taskkill decision path can be driven deterministically —
 * access-denied, helper timeout, launch failure — without spawning privileged
 * processes. Production passes nothing and gets the real implementations, so
 * tests and production run the same `killTree`/`decideTreeKill` code.
 */
export function runCommand(
  shell: ShellSpec,
  command: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    maxBytes: number;
    killDeps?: KillDeps;
  },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell.command, [...shell.args, command], {
      cwd: opts.cwd,
      // stdin is closed: an interactive prompt should fail immediately rather
      // than hang the agent waiting for input nobody can type.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORGE: '1', GIT_TERMINAL_PROMPT: '0' },
      // POSIX only: makes the shell a process-group leader so killTree() can
      // signal the whole group. Windows has no groups; taskkill /T covers it.
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const cap = opts.maxBytes;
    const append = (target: 'out' | 'err', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (target === 'out') {
        if (stdout.length + text.length > cap) {
          stdout += text.slice(0, Math.max(0, cap - stdout.length));
          truncated = true;
        } else stdout += text;
      } else {
        if (stderr.length + text.length > cap) {
          stderr += text.slice(0, Math.max(0, cap - stderr.length));
          truncated = true;
        } else stderr += text;
      }
    };

    child.stdout.on('data', (c: Buffer) => append('out', c));
    child.stderr.on('data', (c: Buffer) => append('err', c));

    // Exactly one termination sequence, whichever trigger arrives first. The
    // PROMISE is memoized rather than a boolean flag: a second abort must await
    // the same sequence, and — critically — `finish()` must be able to await it
    // too. The previous version floated this promise and assigned the outcome
    // in a `.then`, so a wrapper that closed quickly could produce a result
    // before the outcome was known, silently dropping the degraded-safety
    // warning.
    let terminationPromise: Promise<TreeKillResult> | null = null;
    const terminate = (): Promise<TreeKillResult> => {
      terminationPromise ??= killTree(child, opts.killDeps ?? DEFAULT_KILL_DEPS);
      return terminationPromise;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);

    // Deliberately discards the promise: `finish()` is what awaits it, so the
    // outcome is always known before a result is built.
    const onAbort = (): void => void terminate();
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);

      // 'close' (not 'exit') fires only after stdout AND stderr have ended, so
      // both readers have settled and the captured output is complete. That is
      // also why a descendant holding those handles used to wedge this promise
      // — hence the ordering inside killTree().
      const emit = (tree: TreeKillResult | null): void => {
        resolve({ code, stdout, stderr, timedOut, truncated, tree });
      };

      // If a termination was started, its verdict is part of the result — so
      // wait for it rather than reading a field that may not be assigned yet.
      // No new work is started here; killTree has already run to completion or
      // is about to.
      if (terminationPromise) {
        void terminationPromise.then(emit, () =>
          emit({
            outcome: 'unconfirmed',
            detail: 'the termination attempt itself failed',
            fallbackUsed: false,
          }),
        );
        return;
      }
      emit(null);
    };

    child.on('close', finish);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      reject(
        new ToolError(
          `Could not start ${shell.label}: ${err.message}`,
          `Check that "${shell.command}" exists, or set shell.path in your config.`,
        ),
      );
    });
  });
}
