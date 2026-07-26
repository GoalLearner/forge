/**
 * CLI entry point.
 *
 * Bootstraps in this order, because each step depends on the previous one:
 *   1. parse args          (may just print help and exit)
 *   2. load config         (may fail loudly on a malformed file)
 *   3. resolve the model   (may fail on a missing API key — with a fix in the message)
 *   4. gather project context, ONCE — see agent/prompt.ts for why "once" matters
 *   5. open/resume the session
 *   6. hand off to the Ink app
 *
 * Everything that can fail with a user-fixable cause fails here, before the UI
 * starts, so the error is a plain readable line rather than something flashing
 * inside a half-rendered TUI.
 */

// Must be first: installs the node:sqlite warning filter before the DB opens.
import './util/quiet.ts';

import React from 'react';
import { render } from 'ink';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import pkg from '../package.json' with { type: 'json' };
import { loadConfig } from './config/load.ts';
import { ProviderRegistry, ConfigurationError } from './providers/registry.ts';
import { Conversation } from './agent/messages.ts';
import { buildSystemPrompt } from './agent/prompt.ts';
import { buildTools, toolSchemas } from './tools/index.ts';
import { TodoStore } from './tools/todo.ts';
import { resolveShell } from './tools/shell.ts';
import { PermissionManager } from './safety/permissions.ts';
import { FileTracker } from './safety/file-tracker.ts';
import { SessionStore } from './session/store.ts';
import { closeDatabase } from './session/db.ts';
import { formatCost } from './session/cost.ts';
import { buildCostReport, formatCostJson, formatCostText } from './session/report.ts';
import { App } from './ui/App.tsx';
import { runHeadless } from './headless.ts';
import type { ToolContext } from './tools/types.ts';

interface Args {
  cwd?: string;
  model?: string;
  permissionMode?: 'safe' | 'auto-edit' | 'yolo';
  resume?: string;
  continue: boolean;
  print?: string;
  help: boolean;
  version: boolean;
  sessions: boolean;
  cost: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    continue: false,
    help: false,
    version: false,
    sessions: false,
    cost: false,
    json: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-c':
      case '--continue':
        args.continue = true;
        break;
      case '--sessions':
        args.sessions = true;
        break;
      case '--cost':
        args.cost = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '-r':
      case '--resume':
        args.resume = argv[++i];
        break;
      case '--cwd':
        args.cwd = argv[++i];
        break;
      case '-m':
      case '--model':
        args.model = argv[++i];
        break;
      case '--permission-mode':
        args.permissionMode = argv[++i] as Args['permissionMode'];
        break;
      case '-p':
      case '--print':
        // Everything after -p is the prompt, so quoting is optional.
        args.print = argv.slice(i + 1).join(' ');
        i = argv.length;
        break;
      default:
        if (!arg.startsWith('-')) positional.push(arg);
    }
  }

  // A bare `forge "do the thing"` is a one-shot prompt too.
  if (!args.print && positional.length > 0) args.print = positional.join(' ');
  return args;
}

const USAGE = `
forge ${pkg.version} — a cheap-first coding agent

Usage
  forge                          start an interactive session
  forge "fix the failing test"   run one request and exit
  forge -p "<prompt>"            same, explicitly
  forge --continue               resume the last session in this directory
  forge --resume <id>            resume a specific session
  forge --sessions               list recent sessions
  forge --cost                   token usage, spend, and cache hit rate
  forge --cost --json            the same, machine-readable

Options
  -m, --model <spec>             cheap | strong | fast | <provider>/<id>
      --permission-mode <mode>   safe | auto-edit | yolo
      --cwd <path>               project directory (default: current)
  -h, --help                     show this
  -v, --version                  show version

Configuration
  Global    ~/.forge/config.toml
  Project   ./.forge/config.toml

  A minimal config only needs an API key in your environment and a tier:

    [tiers]
    cheap = "deepseek/deepseek-v4-pro"

  See the README for GLM, Kimi, DeepSeek, and Ollama setups.
`.trimStart();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  // --- Config ------------------------------------------------------------
  let loaded;
  try {
    loaded = loadConfig(args.cwd);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  const { config, catalog, cwd } = loaded;
  const warnings = [...loaded.warnings];

  if (args.permissionMode) config.permissions.mode = args.permissionMode;

  const store = new SessionStore();

  // Hygiene: drop message-less session rows (a session opened and abandoned
  // without ever sending) so --sessions and the desktop sidebar stay clean.
  try {
    store.pruneEmptySessions();
  } catch {
    /* never block startup over cleanup */
  }

  // Reporting commands run before any model is resolved — checking your spend
  // must not require a working API key.
  if (args.cost) {
    const report = buildCostReport(store, cwd);
    process.stdout.write(args.json ? formatCostJson(report) : formatCostText(report));
    closeDatabase();
    return;
  }

  if (args.sessions) {
    const sessions = store.list(cwd, 25);
    if (sessions.length === 0) {
      process.stdout.write('No sessions recorded for this directory yet.\n');
    } else {
      for (const s of sessions) {
        process.stdout.write(
          `${s.id.slice(0, 8)}  ${new Date(s.updatedAt).toLocaleString()}  ${formatCost(s.cost).padStart(9)}  ${s.title ?? '(untitled)'}\n`,
        );
      }
    }
    closeDatabase();
    return;
  }

  // --- Model -------------------------------------------------------------
  const registry = new ProviderRegistry(config, catalog);
  let model;
  try {
    model = registry.resolve(args.model ?? 'cheap');
  } catch (err) {
    if (err instanceof ConfigurationError) {
      fail(`${err.message}${err.hint ? `\n\n${err.hint}` : ''}`);
    } else {
      fail(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // --- Project context (gathered ONCE — see agent/prompt.ts) --------------
  const projectDoc = readProjectDoc(cwd);
  const isGitRepo = detectGitRepo(cwd);
  const shell = resolveShell(config.shell);

  const todoStore = new TodoStore();
  const tools = buildTools({ todoStore });

  const system = buildSystemPrompt({
    cwd,
    shell: shell.label,
    isGitRepo,
    projectDoc,
    toolNames: [...tools.keys()],
    permissionMode: config.permissions.mode,
  });

  const conversation = new Conversation({ system, tools: toolSchemas(tools) });

  // --- Session -----------------------------------------------------------
  let sessionId: string;
  if (args.resume) {
    if (!store.exists(args.resume)) {
      fail(`No session with id ${args.resume}. Run \`forge --sessions\` to list them.`);
      return;
    }
    sessionId = args.resume;
    conversation.setMessages(store.loadMessages(sessionId));
    warnings.push(`Resumed session ${sessionId.slice(0, 8)} (${conversation.length} messages).`);
  } else if (args.continue) {
    const latest = store.findLatest(cwd);
    if (latest) {
      sessionId = latest;
      conversation.setMessages(store.loadMessages(sessionId));
      warnings.push(`Continuing session ${sessionId.slice(0, 8)} (${conversation.length} messages).`);
    } else {
      sessionId = store.create(cwd, model.key);
      warnings.push('No previous session in this directory — starting a new one.');
    }
  } else {
    sessionId = store.create(cwd, model.key);
  }

  // --- Tool context ------------------------------------------------------
  const permissions = new PermissionManager(config.permissions.mode, cwd);
  const toolContext: ToolContext = {
    cwd,
    config,
    // Replaced per-turn by App with a live AbortController; this placeholder
    // just satisfies the type before the first turn starts.
    signal: new AbortController().signal,
    permissions,
    files: new FileTracker(),
  };

  // --- Go ----------------------------------------------------------------
  // Non-interactive mode takes a completely separate path. Ink requires a TTY
  // in raw mode; piped to a file or another process it throws outright, and its
  // cursor-control escape codes would corrupt the output either way.
  if (args.print) {
    process.exitCode = await runHeadless({
      prompt: args.print,
      conversation,
      model,
      tools,
      toolContext,
      config,
      store,
      sessionId,
      warnings,
      showCost: !process.env.FORGE_QUIET,
    });
    closeDatabase();
    return;
  }

  if (!process.stdin.isTTY) {
    fail(
      'Interactive mode needs a terminal.\n\nRun `forge -p "<prompt>"` for a one-shot request that works in pipes and scripts.',
    );
    return;
  }

  const { waitUntilExit } = render(
    <App
      config={config}
      registry={registry}
      conversation={conversation}
      model={model}
      tools={tools}
      toolContext={toolContext}
      store={store}
      sessionId={sessionId}
      todoStore={todoStore}
      startupWarnings={warnings}
    />,
    // Ctrl-C is handled inside App: first press interrupts the turn, second exits.
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  closeDatabase();
}

// ---------------------------------------------------------------------------

/**
 * Load the project's agent instructions.
 *
 * Read once at startup and frozen into the system prompt. Re-reading per turn
 * would be more "correct" but would rewrite the cached prefix on every request
 * — the tradeoff is explained in agent/messages.ts. Restart forge to pick up
 * edits to these files.
 */
function readProjectDoc(cwd: string): string | undefined {
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.forge/AGENTS.md']) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8').trim();
      // Cap it: an enormous conventions file would dominate the context window
      // on every request.
      if (text.length > 12_000) {
        return `${text.slice(0, 12_000)}\n\n[truncated — ${name} is longer than forge loads]`;
      }
      if (text) return text;
    } catch {
      // Unreadable project doc is not worth failing startup over.
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

function fail(message: string): void {
  process.stderr.write(`\nforge: ${message}\n\n`);
  process.exitCode = 1;
  closeDatabase();
}

main().catch((err: unknown) => {
  process.stderr.write(`\nforge: unexpected error\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
  closeDatabase();
});
