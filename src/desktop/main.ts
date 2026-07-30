/**
 * Electron main process.
 *
 * The agent core runs HERE, in the main process, not in a local HTTP server.
 * That's deliberate: a server on localhost is reachable by any page your
 * browser has open and any process on the machine, and this agent can write
 * files and run shell commands. IPC has no port, no origin to spoof, and no
 * CSRF surface — the renderer is the only thing that can talk to it.
 *
 * The renderer is fully sandboxed (no Node integration, context isolation on).
 * Everything it can do goes through the narrow, explicitly-listed API in
 * preload.ts, so a bug in the UI can't reach the filesystem directly.
 *
 * Everything below reuses the same modules the CLI uses — Conversation,
 * runTurn, the tool registry, the safety rails, the session store. This is a
 * second front end, not a second implementation. The pieces that exist only
 * for the desktop redesign are:
 *
 *   - Checkpoints (session/checkpoints.ts): per-file revert for the Changes
 *     panel — capturing pre-write file state the CLI never needed.
 *   - Stored keys (~/.forge/keys.json): Settings can hold a provider key so
 *     the user never has to touch environment variables.
 *   - UI prefs (~/.forge/ui.json): permission mode (incl. read-only) and tier
 *     overrides chosen in Settings, desktop-only.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';

import {
  loadConfig,
  forgeHome,
  readStoredKeys,
  writeStoredKey,
} from '../config/load.ts';
import { BUILTIN_PROVIDERS } from '../config/schema.ts';
import { ProviderRegistry, ConfigurationError, type ResolvedModel } from '../providers/registry.ts';
import { Conversation } from '../agent/messages.ts';
import { runTurn, type LoopEvent } from '../agent/loop.ts';
import { AgentRun, RunCancelledError } from '../agent/run.ts';
import { aggregateSession, formatLedgerCost } from '../session/ledger.ts';
import { RunCoordinator, SessionWork, replaceSession, type CancelReason } from './run-coordinator.ts';
import { buildSystemPrompt } from '../agent/prompt.ts';
import { resolveProjectProfile } from '../agent/project-profile.ts';
import { assessContext } from '../agent/truncate.ts';
import { buildTools, toolSchemas } from '../tools/index.ts';
import { TodoStore } from '../tools/todo.ts';
import { resolveShell } from '../tools/shell.ts';
import { assessCommand } from '../safety/danger.ts';
import { PermissionManager, type PermissionMode } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import { SessionStore } from '../session/store.ts';
import { Checkpoints } from '../session/checkpoints.ts';
import { closeDatabase } from '../session/db.ts';
import { addUsage, cacheHitRate, EMPTY_TOTALS, type UsageTotals } from '../session/cost.ts';
import { buildCostReport } from '../session/report.ts';
import type { Config } from '../config/schema.ts';
import type { PermissionDecision, PermissionRequest, Tool, ToolContext } from '../tools/types.ts';
import { log, logPath } from './log.ts';
import { isInsideDir } from '../util/pathtemp.ts';
import { deriveArmWord } from '../util/arm-word.ts';

/**
 * Directory of this bundle, used to locate preload.cjs and the renderer files.
 *
 * `__dirname`, not `fileURLToPath(import.meta.url)`: this file is bundled as
 * CommonJS for the Electron main process, and esbuild compiles `import.meta`
 * to `undefined` in a CJS output.
 */
declare const __dirname: string;
const here = __dirname;

let mainWindow: BrowserWindow | null = null;
let session: DesktopSession | null = null;
let sessionStore: SessionStore | null = null;

// ---------------------------------------------------------------------------
// Desktop-only preferences (~/.forge/ui.json)
// ---------------------------------------------------------------------------

/** The four permission choices Settings offers; 'ro' has no CLI equivalent. */
type UiPermissionMode = 'ro' | 'ask' | 'edits' | 'all';

interface UiPrefs {
  permissionMode?: UiPermissionMode;
  tiers?: Partial<Record<'fast' | 'cheap' | 'strong', string>>;
}

function uiPrefsPath(): string {
  return join(forgeHome(), 'ui.json');
}

function readUiPrefs(): UiPrefs {
  try {
    if (!existsSync(uiPrefsPath())) return {};
    return JSON.parse(readFileSync(uiPrefsPath(), 'utf8')) as UiPrefs;
  } catch {
    return {};
  }
}

function writeUiPrefs(patch: UiPrefs): void {
  const merged = { ...readUiPrefs(), ...patch, tiers: { ...readUiPrefs().tiers, ...patch.tiers } };
  writeFileSync(uiPrefsPath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

/** ro needs 'safe' underneath (belt and braces), plus the write tools removed. */
function backendMode(ui: UiPermissionMode): PermissionMode {
  switch (ui) {
    case 'ro':
    case 'ask':
      return 'safe';
    case 'edits':
      return 'auto-edit';
    case 'all':
      return 'yolo';
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Everything scoped to one project folder.
 *
 * Switching folders or permission tier builds a whole new instance rather than
 * mutating this one. Not laziness: the system prompt embeds the project path
 * and AGENTS.md, and the tool schemas are frozen at construction, so mutating
 * in place would silently invalidate the prompt cache. See agent/messages.ts.
 */
class DesktopSession {
  readonly conversation: Conversation;
  readonly tools: Map<string, Tool>;
  readonly toolContext: ToolContext;
  readonly todoStore: TodoStore;
  readonly registry: ProviderRegistry;
  readonly store: SessionStore;
  readonly config: Config;
  readonly cwd: string;
  /**
   * Null until the first prompt is actually sent. Sessions are LAZY on
   * purpose: opening the app, clicking "New session", or switching folders
   * must not mint database rows — that is how the sidebar filled up with
   * "(untitled) · 0 msgs" debris. A thread exists once Send has been hit.
   */
  sessionId: string | null = null;
  readonly checkpoints: Checkpoints;
  readonly uiPermissionMode: UiPermissionMode;

  /** Null when the cheap tier has no usable key yet (first-run flow). */
  model: ResolvedModel | null = null;
  setupError: { message: string; hint?: string } | null = null;

  totals: UsageTotals = { ...EMPTY_TOTALS };
  busy = false;
  /** Queued prompts + blocked approvals; cleared together on cancellation. */
  private readonly work = new SessionWork();

  /** The one run allowed to be active on this session. Null when idle. */
  activeRun: AgentRun | null = null;

  /**
   * Owns "is a run in flight, and may this session be replaced yet".
   *
   * Extracted to run-coordinator.ts so the ordering is testable without
   * Electron — this is the logic that previously let a replacement session be
   * built while the outgoing run was still writing files.
   */
  private readonly coordinator = new RunCoordinator();

  private abortController: AbortController | null = null;
  private permissionSeq = 0;

  constructor(cwd: string, store: SessionStore, resumeId?: string) {
    const loaded = loadConfig(cwd);
    const prefs = readUiPrefs();

    // Tier overrides from Settings sit on top of config.toml (desktop only —
    // the CLI keeps reading the file, which stays the source of truth there).
    for (const tier of ['fast', 'cheap', 'strong'] as const) {
      const override = prefs.tiers?.[tier];
      if (override) loaded.config.tiers[tier] = override;
    }

    this.config = loaded.config;
    this.cwd = loaded.cwd;
    this.store = store;
    this.registry = new ProviderRegistry(loaded.config, loaded.catalog);
    this.uiPermissionMode = prefs.permissionMode ?? 'edits';

    try {
      this.model = this.registry.resolve('cheap');
    } catch (err) {
      // No key yet — the app still opens, into the first-run flow.
      this.setupError = describeStartupError(err);
    }

    this.todoStore = new TodoStore();
    this.tools = buildTools({
      todoStore: this.todoStore,
      // Read-only mode removes the mutating tools outright. The tool set is
      // frozen per session (prompt-cache), which is why changing this setting
      // rebuilds the session instead of flipping a flag.
      disabled:
        this.uiPermissionMode === 'ro'
          ? ['write_file', 'edit_file', 'multi_edit', 'run_shell', 'git_commit']
          : [],
    });

    const shellSpec = resolveShell(loaded.config.shell);
    const cwdIsGitRepo = detectGitRepo(this.cwd);
    const system = buildSystemPrompt({
      cwd: this.cwd,
      shell: shellSpec.label,
      isGitRepo: cwdIsGitRepo,
      projectDoc: readProjectDoc(this.cwd),
      projectProfile: resolveProjectProfile(this.cwd, { isGitRepo: cwdIsGitRepo }),
      toolNames: [...this.tools.keys()],
      permissionMode: backendMode(this.uiPermissionMode),
    });

    this.conversation = new Conversation({ system, tools: toolSchemas(this.tools) });

    if (resumeId && store.exists(resumeId)) {
      this.sessionId = resumeId;
      this.conversation.setMessages(store.loadMessages(resumeId));
      this.totals = store.totalsForSession(resumeId);
    }
    // No else: a fresh session gets its database row on the first prompt,
    // not at construction. See the sessionId field comment.

    this.checkpoints = new Checkpoints(this.cwd);
    this.toolContext = {
      cwd: this.cwd,
      config: loaded.config,
      signal: new AbortController().signal,
      permissions: new PermissionManager(backendMode(this.uiPermissionMode), this.cwd),
      files: new FileTracker(),
      checkpoints: this.checkpoints,
    };
  }

  /**
   * Request cancellation. Synchronous and best-effort: it asks the run to stop
   * but does NOT wait for it. Use supersede() when the run must actually be
   * over before continuing.
   */
  interrupt(by: CancelReason = 'user'): void {
    this.work.cancelAll('interrupted');
    // Finish before aborting so the first reason wins: the abort path would
    // otherwise land `cancelled/user` on a run being retired as `superseded`.
    this.activeRun?.finish({ kind: 'cancelled', by });
    // Typed cause, so the loop can tell a human stop apart from a tool deadline
    // that expired in the same tick — headless and Ink rely on this too.
    this.abortController?.abort(new RunCancelledError(by));
  }

  /**
   * Abandon this session because another is taking its place, and WAIT until
   * its run has genuinely stopped.
   *
   * Previously this was synchronous: it aborted and returned, so the caller
   * built the replacement while the outgoing run was still inside
   * `await execute(tool)` and had not persisted its transcript. Two runs could
   * hold tools in the same directory, and the replacement could load a stale
   * snapshot and later overwrite the outgoing run's work.
   *
   * Idempotent, and safe when nothing is running.
   */
  supersede(): Promise<void> {
    return this.coordinator.supersede((by) => this.interrupt(by));
  }

  /** True once this session has been replaced; its events must be dropped. */
  get isSuperseded(): boolean {
    return this.coordinator.superseded;
  }

  /** Resolves when the in-flight run has fully settled; null when idle. */
  get activeRunPromise(): Promise<void> | null {
    return this.coordinator.activeRunPromise;
  }

  /**
   * Answer a permission prompt.
   *
   * Ids are run-scoped, so a card left on screen from a superseded run simply
   * finds nothing to resolve — it cannot approve an action on behalf of a run
   * the user has already moved on from.
   */
  resolvePermission(id: string, decision: PermissionDecision): void {
    this.work.resolveApproval(id, decision);
  }

  /**
   * Run one request. `prompt` is null for a retry — the conversation already
   * ends with the user's message, we just drive the loop again.
   */
  async run(prompt: string | null, send: SendFn): Promise<void> {
    // A superseded session must never start new work, even if a queued prompt
    // or a late IPC call reaches it after the swap.
    if (this.coordinator.superseded) return;

    if (this.busy) {
      if (prompt) {
        this.work.enqueue(prompt);
        send('agent:state', this.state());
      }
      return;
    }
    if (!this.model) {
      send('agent:event', {
        type: 'error',
        message: this.setupError?.message ?? 'No model is configured.',
        hint: this.setupError?.hint,
      });
      return;
    }

    // One tracked lifecycle covers this run AND every queued follow-up, so
    // `supersede()` waits for the whole chain rather than just the first leg.
    // `busy` spans the same window, which is why the queue drain below is a
    // loop and not the old recursive call from inside `finally` — recursion
    // there made the tracked promise resolve before the chain was done.
    this.busy = true;
    try {
      await this.coordinator.track(() => this.drainQueue(prompt, send));
    } finally {
      this.busy = false;
    }
  }

  /** Run `first`, then any prompts queued while it was in flight, in order. */
  private async drainQueue(first: string | null, send: SendFn): Promise<void> {
    let prompt: string | null = first;
    for (;;) {
      await this.runOnce(prompt, send);
      // A superseded session must not dispatch queued work; interrupt() has
      // already emptied the queue, this is the second guard.
      if (this.coordinator.superseded) return;

      const next = this.work.dequeue();
      if (next === undefined) return;
      send('agent:queued-dispatch', { prompt: next });
      prompt = next;
    }
  }

  /** Exactly one model-loop run, from user turn through persistence. */
  private async runOnce(prompt: string | null, send: SendFn): Promise<void> {
    if (!this.model) return;

    const controller = new AbortController();
    this.abortController = controller;

    const run = new AgentRun({
      sessionId: this.sessionId,
      limits: {
        maxSteps: this.config.limits.maxSteps,
        maxRetriesPerCall: this.config.limits.maxRetries,
        maxRetriesPerRun: this.config.limits.maxRetries,
        toolTimeoutMs: this.config.limits.toolTimeoutMs,
        maxRuntimeMs: this.config.limits.maxRuntimeMs,
        maxExplicitShellTimeoutMs: this.config.limits.maxExplicitShellTimeoutMs,
      },
      abort: controller,
    });
    this.activeRun = run;
    run.transition('thinking');

    /**
     * Every event carries its run id, and nothing is emitted once this session
     * has been superseded. Two independent guards on purpose: the mute stops
     * the leak at the source, and the id lets the renderer discard anything
     * already in flight.
     */
    const emit: SendFn = (channel, payload) => {
      if (this.coordinator.superseded) return;
      send(
        channel,
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? { ...(payload as Record<string, unknown>), runId: run.id }
          : payload,
      );
    };

    if (prompt !== null) {
      // The moment a thread becomes real: Send was hit.
      if (!this.sessionId) {
        this.sessionId = this.store.create(this.cwd, this.model.key);
      }
      this.conversation.addUserText(prompt);
      this.store.setTitleIfUnset(this.sessionId, prompt);
      run.sessionId = this.sessionId;
    }
    emit('agent:state', this.state());

    try {
      for await (const event of runTurn({
        conversation: this.conversation,
        model: this.model,
        tools: this.tools,
        toolContext: { ...this.toolContext, signal: controller.signal },
        config: this.config,
        signal: controller.signal,
        confirm: (request) => this.askPermission(request, emit),
        // The run's own clock, so the enforced deadline and the `activeMs()`
        // the UI reports can never drift apart.
        budget: run.budget,
        // One ledger per submitted prompt (Step 4B).
        ledger: run.ledger,
        mutations: run.mutations,
      })) {
        // Keep the run's state in step with what the loop is doing, so the
        // terminal reason below is never guessed.
        trackRunState(run, event);

        if (event.type === 'usage') {
          if (this.sessionId) {
            this.store.recordUsage(this.sessionId, event.usage, this.model.key, this.model.entry);
          }
          this.totals = addUsage(this.totals, event.usage, this.model.entry);
          emit('agent:event', { ...event, totals: this.summary() });
        } else {
          emit('agent:event', event);
        }
      }
      // The generator can finish without a terminal event only if it was
      // abandoned; default to cancelled rather than inventing a success.
      run.finish({ kind: 'cancelled', by: 'shutdown' });
    } catch (err) {
      log('error', 'run failed', err);
      const message = err instanceof Error ? err.message : String(err);
      run.finish({ kind: 'provider_error', message });
      emit('agent:event', { type: 'error', message });
    } finally {
      this.abortController = null;
      // Finalize the ledger with the run that owns it: a superseded run must
      // still record what it spent, and a finalized ledger cannot be mutated
      // by any late event.
      const ledgerSummary = run.ledger.finalize();
      run.mutations.finalize();
      const verificationSummary = run.mutations.summary();
      this.activeRun = null;
      // Persistence happens INSIDE the tracked lifecycle on purpose: supersede()
      // awaits this promise, so a replacement session cannot load the transcript
      // until these writes have landed. That is what stops a rebuild from
      // reading a pre-run snapshot and later overwriting this run's work.
      try {
        if (this.sessionId) {
          this.store.saveMessages(this.sessionId, this.conversation.messages);
          this.store.touch(this.sessionId, this.model.key);
          // Only finalized summaries are persisted, so a row never describes a
          // partially-accounted prompt.
          if (ledgerSummary.providerAttempts > 0) {
            this.store.saveRunLedger(this.sessionId, ledgerSummary, verificationSummary);
          }
        }
      } catch {
        /* persistence is best effort */
      }
      emit('agent:state', this.state());
    }
  }

  /** Retry after a provider error: only valid when the user turn is unanswered. */
  canRetry(): boolean {
    const last = this.conversation.messages[this.conversation.length - 1];
    return !this.busy && last?.role === 'user';
  }

  private askPermission(request: PermissionRequest, send: SendFn): Promise<PermissionDecision> {
    if (this.toolContext.permissions.isPreApproved(request.scopeKey)) {
      return Promise.resolve({ type: 'allow' });
    }
    const run = this.activeRun;
    // Scope the id to the run that asked. A superseded run's approval card must
    // never be actionable: `resolvePermission` rejects ids from any other run,
    // so a stale card cannot resolve a promise nobody is waiting on — or worse,
    // approve an action for a run the user already walked away from.
    const id = `perm_${run?.id ?? 'norun'}_${++this.permissionSeq}`;
    // Parked on a human. Tracked as its own state so a future runtime budget
    // does not count someone's lunch break against the run.
    if (run && !run.finished && run.state !== 'awaiting_approval') {
      run.transition('awaiting_approval');
    }
    return new Promise((resolve) => {
      this.work.addApproval(id, (decision) => {
        if (decision.type === 'allow_always') {
          this.toolContext.permissions.approve(request.scopeKey);
        }
        if (run && !run.finished && run.state === 'awaiting_approval') {
          run.transition('running_tool');
        }
        resolve(decision);
        send('agent:state', this.state());
      });
      send('permission:request', {
        id,
        request,
        // Stamped so the renderer can drop a card belonging to a run that has
        // already been superseded, the same way it filters agent events.
        runId: run?.id ?? null,
        // The renderer's type-to-arm input needs a word to demand. Derived
        // here, next to the danger classifier, not in the UI.
        armWord: request.requiresArming ? deriveArmWord(request.detail) : null,
        pending: this.work.pendingApprovals - 1,
      });
      send('agent:state', this.state());
    });
  }

  summary(): Record<string, unknown> {
    return {
      cost: this.totals.cost,
      uncachedCost: this.totals.uncachedCost,
      requests: this.totals.requests,
      cacheHitRate: cacheHitRate(this.totals),
      inputTokens:
        this.totals.inputTokens + this.totals.cachedInputTokens + this.totals.cacheWriteTokens,
      outputTokens: this.totals.outputTokens,
      cacheRates: this.sessionId ? this.store.recentCacheRates(this.sessionId) : [],
    };
  }

  /**
   * Run + session accounting for the UI.
   *
   * Session totals are derived from FINALIZED run summaries rather than a
   * running counter, so a run that finalizes twice cannot inflate them and the
   * figure can always be recomputed from storage. An empty history reports
   * "no ledger data yet" — never a zero total, which is exactly the conflation
   * this ledger exists to remove.
   */
  ledgerState(): Record<string, unknown> {
    const run = this.activeRun?.ledger.summary() ?? null;
    const finalized = this.sessionId ? this.store.runLedgers(this.sessionId) : [];
    const session = aggregateSession(finalized);

    return {
      run: run
        ? {
            modelKey: run.modelKey,
            logicalRequests: run.logicalRequests,
            providerAttempts: run.providerAttempts,
            retriesUsed: run.retriesUsed,
            retryLimit: run.retryLimit,
            cacheHitInput: run.cacheHitInput,
            cacheMissInput: run.cacheMissInput,
            outputTokens: run.outputTokens,
            reasoningTokens: run.reasoningTokens,
            costState: run.cost.state,
            costText: formatLedgerCost(run.cost),
          }
        : null,
      session: {
        runs: session.runs,
        providerAttempts: session.providerAttempts,
        retriesUsed: session.retriesUsed,
        costState: session.cost.state,
        costText: session.runs === 0 ? 'No ledger data yet' : formatLedgerCost(session.cost),
      },
    };
  }

  state(): Record<string, unknown> {
    const context = this.model
      ? assessContext(
          [...this.conversation.messages],
          Math.ceil(this.conversation.system.length / 3.6),
          this.model.entry.contextWindow,
          this.config.limits.contextWarnPct,
          this.config.limits.contextTrimPct,
        )
      : null;

    const changeTotals = this.checkpoints.totals();
    const todos = this.todoStore.get();

    return {
      cwd: this.cwd,
      projectName: this.cwd.split(/[\\/]/).filter(Boolean).pop() ?? this.cwd,
      isGitRepo: detectGitRepo(this.cwd),
      branch: gitBranch(this.cwd),
      sessionId: this.sessionId,
      needsSetup: this.model === null,
      setupError: this.setupError,
      model: this.model?.key ?? null,
      tier: this.model?.tier ?? null,
      subscription: this.model?.entry.subscription ?? false,
      tiers: this.config.tiers,
      models: this.registry.listModels(),
      permissionMode: this.uiPermissionMode,
      busy: this.busy,
      // The renderer discards agent events whose runId is not this one, so a
      // superseded run that is still unwinding cannot write into a new thread.
      runId: this.activeRun?.id ?? null,
      runState: this.activeRun?.state ?? 'idle',
      queuedCount: this.work.queuedCount,
      pendingPermissions: this.work.pendingApprovals,
      totals: this.summary(),
      ledger: this.ledgerState(),
      contextRatio: context?.ratio ?? 0,
      messageCount: this.conversation.length,
      todos,
      plan: {
        done: todos.filter((t) => t.status === 'completed').length,
        total: todos.length,
        active: todos.find((t) => t.status === 'in_progress')?.content ?? null,
      },
      changes: changeTotals,
      canRetry: this.canRetry(),
    };
  }
}

type SendFn = (channel: string, payload: unknown) => void;

/**
 * Keep an AgentRun's state in step with the loop's event stream.
 *
 * The loop stays deliberately unaware of AgentRun — it is a pure generator and
 * easier to test that way — so the mapping lives here, at the one place that
 * consumes every event in order. `finish()` is idempotent, so the first
 * terminal event wins even when several race (an abort during a provider
 * error, say).
 */
function trackRunState(run: AgentRun, event: LoopEvent): void {
  if (run.finished) return;

  switch (event.type) {
    case 'usage':
      // One usage event per model call — the cheapest reliable step counter.
      run.step += 1;
      break;
    case 'text_delta':
    case 'reasoning_delta':
      if (run.state === 'running_tool') run.transition('thinking');
      break;
    case 'tool_start':
      if (run.state !== 'running_tool') run.transition('running_tool');
      break;
    case 'aborted':
      run.finish({ kind: 'cancelled', by: 'user' });
      break;
    case 'error':
      run.finish({ kind: 'provider_error', message: event.message, hint: event.hint });
      break;
    case 'done':
      run.step = event.steps;
      run.finish(event.termination);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#16191f',
    title: 'Forge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadFile(join(here, 'renderer', 'index.html'));

  // Right-click menu. Chromium supplies no default one in a packaged app, which
  // left the composer with no way to paste but the keyboard. Built from roles so
  // the OS handles the actual clipboard work and the labels stay localized.
  mainWindow.webContents.on('context-menu', (_event, props) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    const { editFlags, isEditable, selectionText } = props;
    const hasSelection = selectionText.trim().length > 0;

    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      );
    } else if (hasSelection) {
      items.push({ role: 'copy', enabled: editFlags.canCopy }, { type: 'separator' }, { role: 'selectAll' });
    } else {
      items.push({ role: 'selectAll' });
    }

    Menu.buildFromTemplate(items).popup({ window: mainWindow ?? undefined });
  });

  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error') {
      log('error', `renderer ${event.level}: ${event.message}`, `${event.sourceId}:${event.lineNumber}`);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('error', 'renderer process gone', details.reason);
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('error', `preload failed: ${preloadPath}`, error);
  });

  // Links open in the real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.FORGE_DEBUG) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

async function ensureSession(
  opts: { cwd?: string; resumeId?: string; forceNew?: boolean } = {},
): Promise<DesktopSession> {
  if (!sessionStore) sessionStore = new SessionStore();
  const store = sessionStore;
  const targetCwd = opts.cwd ?? session?.cwd ?? lastProjectOrHome();
  const mustRebuild =
    !session || opts.forceNew || opts.resumeId || targetCwd !== session.cwd;

  if (mustRebuild) {
    // Retire the outgoing session and WAIT for it, before the new one exists.
    //
    // `replaceSession` will not call the constructor until `supersede()`
    // resolves, which is only once the outgoing run has stopped executing
    // tools and finished persisting. Two things depend on that ordering:
    //   - two runs can never hold tools in the same directory at once
    //   - the replacement reads the transcript AFTER the outgoing run wrote it,
    //     so resuming the same thread mid-run cannot load a stale snapshot and
    //     later overwrite that run's work
    // The global `session` reference is only reassigned after construction.
    session = await replaceSession(
      session,
      () => new DesktopSession(targetCwd, store, opts.resumeId),
    );
  }
  return session!;
}

/**
 * Pick the most recent real project for auto-reopen, skipping temp dirs.
 *
 * The list is sorted by last-used descending, so the first non-temp that
 * still exists on disk wins. When every recent project is a temp (e.g. all
 * benchmark fixtures) or the list is empty, we fall back to the home
 * directory. The temp filter is deliberately filesystem-free: it compares
 * normalized path strings so it can't be fooled by case or slash style on
 * Windows.
 */
function lastProjectOrHome(): string {
  if (!sessionStore) sessionStore = new SessionStore();
  const candidates = sessionStore.listProjects(12);
  const temp = tmpdir();
  for (const p of candidates) {
    if (isInsideDir(p.cwd, temp)) continue;
    if (existsSync(p.cwd)) return p.cwd;
  }
  return app.getPath('home');
}

function registerIpc(): void {
  // ipcMain.handle invokes callbacks as (event, ...args). The event MUST be
  // dropped here: forwarding it as the first argument hands handlers an
  // IpcMainInvokeEvent where they expect their payload — which is how
  // "resume(sessionId)" once received an event object, failed the exists()
  // check, and silently opened a fresh empty session instead of the thread.
  //
  // Handlers are async because ensureSession() must be able to wait for an
  // outgoing run to settle before rebuilding. The result MUST be awaited before
  // spreading — spreading a pending promise yields `{ok:true}` and silently
  // drops every field the handler returned.
  const wrap = <T>(fn: (...args: never[]) => T | Promise<T>) => {
    return async (
      _event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<{ ok: boolean; [k: string]: unknown }> => {
      try {
        const result = await (fn as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args);
        return { ok: true, ...(result ?? {}) };
      } catch (err) {
        log('error', 'ipc failed', err);
        return { ok: false, error: describeStartupError(err) };
      }
    };
  };

  // --- state & transcript -------------------------------------------------

  ipcMain.handle('app:state', wrap(async () => ({ state: (await ensureSession()).state() })));
  ipcMain.handle('app:transcript', wrap(async () => ({ messages: renderTranscript(await ensureSession()) })));
  ipcMain.handle('app:cost', wrap(async () => {
    const active = await ensureSession();
    return { report: buildCostReport(active.store, active.cwd), session: active.summary() };
  }));

  // --- running ------------------------------------------------------------

  ipcMain.handle('app:prompt', async (_e: IpcMainInvokeEvent, text: string) => {
    const active = await ensureSession();
    await active.run(String(text), send);
    return { ok: true };
  });

  ipcMain.handle('app:retry', async () => {
    const active = await ensureSession();
    if (!active.canRetry()) return { ok: false, error: { message: 'Nothing to retry.' } };
    await active.run(null, send);
    return { ok: true };
  });

  ipcMain.handle('app:interrupt', () => {
    session?.interrupt();
    return { ok: true };
  });

  ipcMain.handle('app:permission', (_e, id: string, decision: PermissionDecision) => {
    session?.resolvePermission(String(id), decision);
    return { ok: true };
  });

  // --- model & modes --------------------------------------------------------

  ipcMain.handle('app:setModel', wrap(async (spec: string) => {
    const active = await ensureSession();
    active.model = active.registry.resolve(String(spec));
    active.setupError = null;
    return { state: active.state() };
  }));

  ipcMain.handle('app:setTier', wrap(async (tier: string, modelKey: string) => {
    // Validate before persisting — a typo'd model key would otherwise brick
    // every future session construction.
    const active = await ensureSession();
    active.registry.resolve(String(modelKey));
    if (tier !== 'fast' && tier !== 'cheap' && tier !== 'strong') {
      throw new Error(`Unknown tier "${tier}"`);
    }
    writeUiPrefs({ tiers: { [tier]: String(modelKey) } });
    const rebuilt = await ensureSession({ cwd: active.cwd, resumeId: active.sessionId ?? undefined, forceNew: !active.sessionId });
    return { state: rebuilt.state() };
  }));

  ipcMain.handle('app:setPermissionMode', wrap(async (mode: UiPermissionMode) => {
    if (!['ro', 'ask', 'edits', 'all'].includes(mode)) throw new Error(`Unknown mode "${mode}"`);
    writeUiPrefs({ permissionMode: mode });
    const active = await ensureSession();
    // Tool set changes between ro and the rest, and tools are frozen per
    // session — so this rebuilds, resuming the same transcript.
    const rebuilt = await ensureSession({ cwd: active.cwd, resumeId: active.sessionId ?? undefined, forceNew: !active.sessionId });
    return { state: rebuilt.state(), messages: renderTranscript(rebuilt) };
  }));

  // --- sessions & projects --------------------------------------------------

  ipcMain.handle('app:newSession', wrap(async () => {
    const active = await ensureSession();
    const fresh = await ensureSession({ cwd: active.cwd, forceNew: true });
    return { state: fresh.state() };
  }));

  ipcMain.handle('app:clear', wrap(async () => {
    const active = await ensureSession();
    active.conversation.setMessages([]);
    active.todoStore.clear();
    active.checkpoints.clear();
    active.totals = { ...EMPTY_TOTALS };
    try {
      if (active.sessionId) active.store.saveMessages(active.sessionId, []);
    } catch {
      /* ignore */
    }
    return { state: active.state() };
  }));

  ipcMain.handle('app:sessions', wrap(async (opts?: { archived?: boolean }) => {
    const active = await ensureSession();
    const archived = Boolean(opts?.archived);
    return {
      archived,
      archivedCount: active.store.countArchived(active.cwd),
      sessions: active.store
        .list(active.cwd, 25, { archived })
        // Empty rows are launch debris (pre-lazy-creation builds, or a crash
        // between create and first save) — never worth a sidebar entry.
        .filter((s) => s.messageCount > 0 || s.id === active.sessionId)
        .map((s) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
          cost: s.cost,
          pinned: s.pinned,
          archived: s.archived,
          current: s.id === active.sessionId,
        })),
    };
  }));

  ipcMain.handle('app:unarchiveSession', wrap(async (id: string) => {
    const active = await ensureSession();
    active.store.unarchiveSession(String(id));
    return { state: active.state() };
  }));

  ipcMain.handle('app:pinSession', wrap(async (id: string, pinned: boolean) => {
    const active = await ensureSession();
    active.store.setPinned(String(id), Boolean(pinned));
    return { state: active.state() };
  }));

  ipcMain.handle('app:renameSession', wrap(async (id: string, title: string) => {
    const active = await ensureSession();
    active.store.renameSession(String(id), String(title));
    return { state: active.state() };
  }));

  ipcMain.handle('app:archiveSession', wrap(async (id: string) => {
    const active = await ensureSession();
    active.store.archiveSession(String(id));
    return await finishThreadRemoval(active, String(id));
  }));

  ipcMain.handle('app:deleteSession', wrap(async (id: string) => {
    const active = await ensureSession();
    active.store.deleteSession(String(id));
    return await finishThreadRemoval(active, String(id));
  }));

  ipcMain.handle('app:resume', wrap(async (id: string) => {
    const active = await ensureSession();
    const resumed = await ensureSession({ cwd: active.cwd, resumeId: String(id) });
    return { state: resumed.state(), messages: renderTranscript(resumed) };
  }));

  ipcMain.handle('app:projects', wrap(async () => {
    const active = await ensureSession();
    return {
      current: { cwd: active.cwd, name: active.state().projectName, branch: gitBranch(active.cwd) },
      recent: (sessionStore ?? new SessionStore())
        .listProjects(10)
        .filter((p) => p.cwd !== active.cwd && existsSync(p.cwd))
        .map((p) => ({
          cwd: p.cwd,
          name: p.cwd.split(/[\\/]/).filter(Boolean).pop() ?? p.cwd,
          lastUsed: p.lastUsed,
          sessions: p.sessions,
        })),
    };
  }));

  ipcMain.handle('app:openProjectPath', wrap(async (cwd: string) => {
    if (!existsSync(String(cwd))) throw new Error(`Folder no longer exists: ${cwd}`);
    const opened = await ensureSession({ cwd: String(cwd) });
    // Recents restore the last session in that folder, per the design note.
    const latest = opened.store.findLatest(opened.cwd);
    const active = latest ? await ensureSession({ cwd: opened.cwd, resumeId: latest }) : opened;
    return { state: active.state(), messages: renderTranscript(active) };
  }));

  ipcMain.handle('app:openProject', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a project folder',
      properties: ['openDirectory'],
      defaultPath: session?.cwd,
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    try {
      const active = await ensureSession({ cwd: result.filePaths[0] });
      return { ok: true, state: active.state(), messages: renderTranscript(active) };
    } catch (err) {
      return { ok: false, error: describeStartupError(err) };
    }
  });

  // --- changes: review / revert / commit ------------------------------------

  ipcMain.handle('app:changes', wrap(async () => {
    const active = await ensureSession();
    return { changes: active.checkpoints.listChanges(), totals: active.checkpoints.totals() };
  }));

  ipcMain.handle('app:revertFile', wrap(async (path: string) => {
    const active = await ensureSession();
    active.checkpoints.revert(String(path));
    return { changes: active.checkpoints.listChanges(), totals: active.checkpoints.totals() };
  }));

  ipcMain.handle('app:restoreFile', wrap(async (path: string) => {
    const active = await ensureSession();
    active.checkpoints.restore(String(path));
    return { changes: active.checkpoints.listChanges(), totals: active.checkpoints.totals() };
  }));

  ipcMain.handle('app:revertAll', wrap(async () => {
    const active = await ensureSession();
    active.checkpoints.revertAll();
    return { changes: active.checkpoints.listChanges(), totals: active.checkpoints.totals() };
  }));

  ipcMain.handle('app:commit', async (_e, message: string) => {
    const active = await ensureSession();
    const paths = active.checkpoints.commitablePaths();
    if (paths.length === 0) return { ok: false, error: { message: 'Nothing to commit.' } };
    const text = String(message ?? '').trim();
    if (!text) return { ok: false, error: { message: 'A commit message is required.' } };

    try {
      await git(active.cwd, ['add', '--', ...paths]);
      await git(active.cwd, ['commit', '-m', text]);
      const hash = (await git(active.cwd, ['rev-parse', '--short', 'HEAD'])).trim();
      active.checkpoints.clear();
      return { ok: true, hash, files: paths.length, state: active.state() };
    } catch (err) {
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  });

  // --- keys & setup ----------------------------------------------------------

  ipcMain.handle('app:keyStatus', wrap(async () => {
    const stored = readStoredKeys();
    const rows = Object.entries(BUILTIN_PROVIDERS)
      .filter(([name]) => name !== 'ollama' && name !== 'zai-coding-plan')
      .map(([name, preset]) => {
        const envVar = preset.apiKey?.startsWith('env:') ? preset.apiKey.slice(4) : null;
        const fromEnv = envVar ? Boolean(process.env[envVar]) : false;
        const fromStore = Boolean(stored[name]);
        const active = fromEnv ? process.env[envVar!]! : stored[name];
        return {
          provider: name,
          envVar,
          source: fromEnv ? 'env' : fromStore ? 'stored' : 'none',
          masked: active ? maskKey(active) : null,
        };
      });
    return { keys: rows };
  }));

  ipcMain.handle('app:saveKey', wrap(async (provider: string, key: string) => {
    if (!BUILTIN_PROVIDERS[String(provider)]) throw new Error(`Unknown provider "${provider}"`);
    writeStoredKey(String(provider), String(key));
    // Rebuild so a session stuck in needsSetup picks the key up immediately.
    const current = session;
    const rebuilt = await ensureSession({
      cwd: current?.cwd,
      resumeId: current?.sessionId ?? undefined,
      forceNew: !current?.sessionId,
    });
    return { state: rebuilt.state() };
  }));

  ipcMain.handle('app:testKey', async (_e, provider: string, key: string) => {
    // A real (free) round-trip beats format validation: the models endpoint
    // confirms both the key and the network path without spending tokens.
    const preset = BUILTIN_PROVIDERS[String(provider)];
    if (!preset) return { ok: false, error: { message: `Unknown provider "${provider}"` } };
    if (preset.kind !== 'openai' || !preset.baseURL) {
      return { ok: true, untested: true }; // anthropic-style: save without a probe
    }
    try {
      const response = await fetch(`${preset.baseURL.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${String(key).trim()}` },
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: { message: 'The provider rejected this key.' } };
      }
      return { ok: true, untested: true }; // endpoint quirk — don't block saving
    } catch {
      return {
        ok: false,
        error: { message: 'Could not reach the provider — check your connection and try again.' },
      };
    }
  });

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    const target = String(url);
    if (/^https:\/\//.test(target)) void shell.openExternal(target);
    return { ok: true };
  });

  ipcMain.handle('app:riskOf', wrap(async (command: string) => ({ risk: assessCommand(String(command)) })));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a stored transcript into what the UI replays. Tool results are
 * dropped: the tool row shows the outcome, and replaying raw file contents
 * would flood the view.
 */
function renderTranscript(active: DesktopSession): unknown[] {
  const out: unknown[] = [];
  for (const message of active.conversation.messages) {
    if (message.role === 'user') {
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      if (text.trim()) out.push({ kind: 'user', text });
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) {
        out.push({ kind: 'assistant', text: block.text });
      } else if (block.type === 'tool_use') {
        const tool = active.tools.get(block.name);
        let summary = block.name;
        try {
          summary = tool?.summarize(block.input) ?? block.name;
        } catch {
          /* a bad summary must not break loading a transcript */
        }
        out.push({ kind: 'tool', name: block.name, summary });
      }
    }
  }
  return out;
}

/**
 * Shared tail of archive/delete: if the removed thread is the one on screen,
 * hand the renderer a fresh empty session so it isn't left staring at a
 * transcript that no longer exists.
 */
async function finishThreadRemoval(
  active: DesktopSession,
  removedId: string,
): Promise<Record<string, unknown>> {
  if (active.sessionId === removedId) {
    // Supersede rather than interrupt: the replacement must not be built until
    // the removed thread's run has stopped and finished persisting.
    await active.supersede();
    const fresh = await ensureSession({ cwd: active.cwd, forceNew: true });
    return { state: fresh.state(), cleared: true };
  }
  return { state: active.state(), cleared: false };
}

function describeStartupError(err: unknown): { message: string; hint?: string } {
  log('error', 'startup error', err);
  if (err instanceof ConfigurationError) return { message: err.message, hint: err.hint };
  if (err instanceof Error) {
    return { message: err.message || err.name || 'Unknown error' };
  }
  return { message: String(err) || 'Unknown error' };
}

function maskKey(key: string): string {
  const tail = key.slice(-4);
  return `${key.slice(0, 3)}…${tail}`;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || stdout.trim() || error.message));
        else resolve(stdout);
      },
    );
  });
}

function gitBranch(cwd: string): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString('utf8')
        .trim() || null
    );
  } catch {
    return null;
  }
}

function readProjectDoc(cwd: string): string | undefined {
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.forge/AGENTS.md']) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (text.length > 12_000) {
        return `${text.slice(0, 12_000)}\n\n[truncated — ${name} is longer than forge loads]`;
      }
      if (text) return text;
    } catch {
      /* unreadable project doc is not worth failing over */
    }
  }
  return undefined;
}

function detectGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  process.on('uncaughtException', (err) => log('error', 'uncaught exception', err));
  process.on('unhandledRejection', (reason) => log('error', 'unhandled rejection', reason));

  void app.whenReady().then(() => {
    log('info', `forge desktop starting (electron ${process.versions.electron}, log: ${logPath()})`);

    // Sweep out message-less session rows left by earlier builds (which
    // created sessions eagerly at launch) or by crashes between create and
    // first save. New rows are only minted on Send, so a healthy database
    // stays clean without this — it exists for hygiene, not correctness.
    try {
      if (!sessionStore) sessionStore = new SessionStore();
      const pruned = sessionStore.pruneEmptySessions();
      if (pruned > 0) log('info', `pruned ${pruned} empty session row(s)`);
    } catch (err) {
      log('error', 'prune failed', err);
    }

    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    closeDatabase();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    session?.interrupt();
    closeDatabase();
  });
}
