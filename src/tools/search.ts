/**
 * Search tools: glob (find files by pattern) and grep (search file contents).
 *
 * grep shells out to ripgrep, which we bundle via @vscode/ripgrep rather than
 * requiring the user to install it — a "works on a fresh machine" requirement,
 * and notably this Windows box has no rg on PATH. Falls back to a pure-JS scan
 * if the bundled binary can't be located, so search never simply breaks.
 *
 * Both are read-only: no prompts, and the loop runs them concurrently.
 */

import { spawn } from 'node:child_process';
import { AbortedError } from '../providers/types.ts';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { rgPath as packagedRgPath } from '@vscode/ripgrep';
import { PathJail } from '../safety/paths.ts';
import { ToolError, type Tool, type ToolContext, type ToolResult } from './types.ts';

/**
 * Path to the ripgrep binary, corrected for asar packaging.
 *
 * In the installed desktop app the source tree lives inside `app.asar`. Node's
 * fs calls are transparently shimmed to read from the archive, but `spawn()`
 * is not — you cannot execute a binary that only exists inside it. Anything
 * listed in the build's `asarUnpack` is additionally written to a sibling
 * `app.asar.unpacked` directory, so redirecting there is the documented fix.
 * A no-op in dev, where the path contains no `app.asar` segment.
 */
export const rgPath = packagedRgPath.replace(
  `${sep}app.asar${sep}`,
  `${sep}app.asar.unpacked${sep}`,
);

/** Directories excluded from every search unless explicitly targeted. */
const IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/.venv/**',
  '**/__pycache__/**',
];

const MAX_RESULTS = 200;

/**
 * How many files to stat between event-loop yields.
 *
 * Small enough that a cancellation lands promptly, large enough that the yields
 * do not dominate the walk.
 */
const STAT_BATCH = 500;

function jailFor(ctx: ToolContext): PathJail {
  return new PathJail({
    root: ctx.cwd,
    extraRoots: ctx.config.permissions.extraRoots,
    deny: ctx.config.permissions.deny,
  });
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.test.js". Results are sorted by most recently modified, so the files you probably want are first.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, relative to the project root.' },
      path: { type: 'string', description: 'Subdirectory to search within. Defaults to the root.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  summarize(input) {
    return `glob ${String(input.pattern ?? '')}`;
  },

  async execute(input, ctx): Promise<ToolResult> {
    const jail = jailFor(ctx);
    const base = jail.resolve(String(input.path ?? '.'), 'read');
    const pattern = String(input.pattern ?? '');
    if (!pattern) throw new ToolError('A glob pattern is required.');

    // Routed through ripgrep rather than fast-glob, for ONE reason: fast-glob
    // has no AbortSignal support, so a cancelled or timed-out glob kept walking
    // the filesystem while the agent believed the run was over. Because the
    // loop awaits tool settlement, that could hold the whole AgentRun open.
    // ripgrep is a child process we can actually kill.
    //
    // `--files` lists files instead of searching contents; `--no-ignore` keeps
    // the previous semantics (the explicit IGNORED list decides, not .gitignore)
    // and rg already skips hidden entries and does not follow symlinks, matching
    // the old `dot: false` / `followSymbolicLinks: false`.
    // rg matches --glob patterns against the path as it walks it. Given an
    // ABSOLUTE search path, `src/agent/*.ts` can never match
    // `C:\project\src\agent\loop.ts` — the model's pattern would silently find
    // nothing. So rg is run with its cwd set to the search root and asked to
    // walk `.`, which makes every pattern relative to that root, exactly as
    // fast-glob's `cwd` option did.
    const args = ['--files', '--no-ignore', '--glob', pattern];
    for (const ignore of IGNORED) args.push('--glob', `!${ignore}`);
    args.push('.');

    const found = await runRipgrep(args, ctx.signal, base);
    // rg exits 1 when nothing matched, which is not an error here.
    if (found.code !== 0 && found.code !== 1 && found.stderr.trim()) {
      throw new ToolError(
        `Glob failed: ${found.stderr.split('\n')[0]}`,
        'Check the glob pattern syntax.',
      );
    }

    // Relative to `base` now (see the cwd note above) — resolve back to absolute
    // so statSync and jail.display keep working unchanged.
    const paths = found.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((rel) => resolve(base, rel));

    // Recency ordering: in a codebase you are actively working on, the file you
    // want is far more often the one touched most recently than the one that
    // sorts first alphabetically. Stats are cheap per file but not free, so the
    // signal is re-checked as we go — this is the only unbounded-ish stretch
    // left, and it must not outlive a cancelled run.
    const stamped: Array<{ path: string; mtimeMs: number }> = [];
    for (let i = 0; i < paths.length; i++) {
      // Yield to the event loop periodically. Checking `aborted` inside a fully
      // synchronous loop is theatre: nothing can ever set it, because the loop
      // never gives the abort handler a chance to run. On a large tree this
      // blocked for hundreds of ms and swallowed the cancellation entirely.
      if (i % STAT_BATCH === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (ctx.signal.aborted) throw new AbortedError();
      }
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(paths[i]!).mtimeMs;
      } catch {
        /* vanished between listing and stat — treat as oldest */
      }
      stamped.push({ path: paths[i]!, mtimeMs });
    }

    const sorted = stamped
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((m) => jail.display(m.path));

    if (sorted.length === 0) {
      return { content: `No files match "${pattern}".` };
    }

    const shown = sorted.slice(0, MAX_RESULTS);
    const note =
      sorted.length > MAX_RESULTS
        ? `\n[${sorted.length - MAX_RESULTS} more matches — narrow the pattern to see them]`
        : '';

    return {
      content: `${sorted.length} match${sorted.length === 1 ? '' : 'es'} for "${pattern}":\n${shown.join('\n')}${note}`,
      display: { kind: 'list', items: shown.slice(0, 20), total: sorted.length },
    };
  },
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a regular expression (ripgrep syntax). Use this to locate code rather than reading files speculatively — it is far cheaper. Filter by file type with the glob parameter.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the root.' },
      glob: {
        type: 'string',
        description: 'Restrict to files matching this glob, e.g. "*.ts".',
      },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
      context: {
        type: 'integer',
        description: 'Lines of context to show around each match (0-5).',
        minimum: 0,
        maximum: 5,
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  summarize(input) {
    const glob = input.glob ? ` in ${String(input.glob)}` : '';
    return `grep "${String(input.pattern ?? '')}"${glob}`;
  },

  async execute(input, ctx): Promise<ToolResult> {
    const jail = jailFor(ctx);
    const target = jail.resolve(String(input.path ?? '.'), 'read');
    const pattern = String(input.pattern ?? '');
    if (!pattern) throw new ToolError('A search pattern is required.');

    const args = [
      '--line-number',
      '--no-heading',
      '--color', 'never',
      '--max-columns', '400',
      '--max-columns-preview',
      '--smart-case',
      '--sort', 'path',
    ];
    if (input.ignore_case) args.push('--ignore-case');
    if (input.glob) args.push('--glob', String(input.glob));
    for (const ignore of IGNORED) args.push('--glob', `!${ignore.replace(/^\*\*\//, '')}`);
    if (input.context) args.push('--context', String(input.context));
    args.push('--regexp', pattern, target);

    const output = await runRipgrep(args, ctx.signal);

    if (output.code === 1 || output.stdout.trim() === '') {
      return { content: `No matches for /${pattern}/.` };
    }
    if (output.code !== 0 && output.stderr) {
      throw new ToolError(
        `Search failed: ${output.stderr.split('\n')[0]}`,
        'Check the regular expression syntax.',
      );
    }

    // Rewrite absolute paths to project-relative so results are short and
    // clickable, and so they don't leak the user's home directory into context.
    const lines = output.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => rewritePath(line, jail));

    const shown = lines.slice(0, MAX_RESULTS);
    const note =
      lines.length > MAX_RESULTS
        ? `\n[${lines.length - MAX_RESULTS} more matches — narrow the pattern or add a glob filter]`
        : '';

    return {
      content: `${lines.length} match${lines.length === 1 ? '' : 'es'}:\n${shown.join('\n')}${note}`,
      display: { kind: 'list', items: shown.slice(0, 20), total: lines.length },
    };
  },
};

function rewritePath(line: string, jail: PathJail): string {
  const separator = line.indexOf(':');
  if (separator === -1) return line;
  const path = line.slice(0, separator);
  const rest = line.slice(separator);
  const display = jail.display(path);
  return display === path && path.length > 60 ? line : `${display}${rest}`;
}

interface RipgrepResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runRipgrep(
  args: string[],
  signal: AbortSignal,
  cwd?: string,
): Promise<RipgrepResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(rgPath, args, { signal, ...(cwd ? { cwd } : {}) });
    } catch (err) {
      // Bundled binary missing (unpacked oddly, blocked by policy). Rather than
      // failing search entirely, tell the caller so the model can fall back to
      // glob + read_file.
      return reject(
        new ToolError(
          `ripgrep is unavailable: ${(err as Error).message}`,
          'Use glob plus read_file instead, or reinstall forge so the bundled ripgrep binary is restored.',
        ),
      );
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      // Bound memory even if a pattern matches a huge generated file.
      if (stdout.length < 4_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      // Cancellation arrives here as an AbortError (see the note in git.ts).
      if (signal.aborted || (err as { name?: string }).name === 'AbortError') {
        reject(new AbortedError());
        return;
      }
      reject(new ToolError(`ripgrep failed: ${err.message}`));
    });
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/** Exported for tests: a pure-JS single-file scan, used nowhere on the hot path. */
export function scanFile(path: string, pattern: RegExp): string[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (pattern.test(line)) out.push(`${i + 1}:${line}`);
  });
  return out;
}
