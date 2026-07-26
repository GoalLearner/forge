/**
 * Git tools.
 *
 * These exist as dedicated tools rather than leaving git to run_shell for one
 * reason: the harness can then tell a read from a write. `git status` is
 * read-only and parallel-safe; `git commit` creates a durable artifact with the
 * user's name on it. As an opaque shell string those are indistinguishable, so
 * every git call would have to be treated as the riskier of the two.
 *
 * Deliberately NOT included: push, force-push, rebase, reset. Those stay in
 * run_shell, where the danger classifier gives them a loud confirmation. An
 * agent should not have a frictionless path to rewriting shared history.
 */

import { spawn } from 'node:child_process';
import { AbortedError } from '../providers/types.ts';
import {
  ToolError,
  type PermissionRequest,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts';

const MAX_OUTPUT = 60_000;

function git(args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Stop git from opening an editor or a credential prompt — either would
      // hang the agent forever with no visible cause.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
      signal,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      // `spawn({signal})` reports cancellation through 'error' as an AbortError.
      // Reporting that as "git is not available" would blame the environment
      // for a stop the run itself asked for, so it is surfaced as an abort and
      // normalized by the loop into an interrupted/timeout result.
      if (signal.aborted || (err as { name?: string }).name === 'AbortError') {
        reject(new AbortedError());
        return;
      }
      reject(
        new ToolError(`git is not available: ${err.message}`, 'Install git, or use run_shell.'),
      );
    });
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function requireRepo(ctx: ToolContext): Promise<void> {
  const { code } = await git(['rev-parse', '--git-dir'], ctx.cwd, ctx.signal);
  if (code !== 0) {
    throw new ToolError(
      'This directory is not a git repository.',
      'Run `git init` first if you want version control here.',
    );
  }
}

export const gitStatusTool: Tool = {
  name: 'git_status',
  description:
    'Show the working tree status: staged, unstaged, and untracked files, plus the current branch.',
  readOnly: true,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  summarize: () => 'git status',

  async execute(_input, ctx): Promise<ToolResult> {
    await requireRepo(ctx);
    const [status, branch] = await Promise.all([
      git(['status', '--porcelain=v1'], ctx.cwd, ctx.signal),
      git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.cwd, ctx.signal),
    ]);

    const current = branch.stdout.trim() || '(detached)';
    if (!status.stdout.trim()) {
      return { content: `On branch ${current}. Working tree clean.` };
    }
    return { content: `On branch ${current}\n\n${status.stdout.trimEnd()}` };
  },
};

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description:
    'Show changes in the working tree. Set staged: true for the staged diff. Pass a path to limit the diff to one file or directory.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      staged: { type: 'boolean', description: 'Diff the staging area instead of the working tree.' },
      path: { type: 'string', description: 'Limit the diff to this path.' },
    },
    additionalProperties: false,
  },
  summarize: (input) => `git diff${input.staged ? ' --staged' : ''}`,

  async execute(input, ctx): Promise<ToolResult> {
    await requireRepo(ctx);
    const args = ['diff', '--no-color'];
    if (input.staged) args.push('--staged');
    if (input.path) args.push('--', String(input.path));

    const { stdout } = await git(args, ctx.cwd, ctx.signal);
    return {
      content: stdout.trim()
        ? stdout.trimEnd()
        : input.staged
          ? 'Nothing staged.'
          : 'No unstaged changes.',
    };
  },
};

export const gitLogTool: Tool = {
  name: 'git_log',
  description: 'Show recent commits, most recent first.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many commits to show (default 15).', minimum: 1, maximum: 100 },
      path: { type: 'string', description: 'Only commits touching this path.' },
    },
    additionalProperties: false,
  },
  summarize: () => 'git log',

  async execute(input, ctx): Promise<ToolResult> {
    await requireRepo(ctx);
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 15)));
    const args = ['log', `-${limit}`, '--pretty=format:%h %ad %an: %s', '--date=short'];
    if (input.path) args.push('--', String(input.path));

    const { stdout } = await git(args, ctx.cwd, ctx.signal);
    return { content: stdout.trim() || 'No commits yet.' };
  },
};

export const gitCommitTool: Tool = {
  name: 'git_commit',
  description:
    'Stage files and create a commit. Always confirmed with the user, showing the exact message and file list. Does not push.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Commit message. First line under ~72 characters.' },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files to stage. Omit to commit what is already staged.',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  summarize: (input) => `git commit -m "${truncate(String(input.message ?? ''), 50)}"`,

  // Always confirmed, in every permission mode. A commit carries the user's
  // name and email; it is their statement about their own work, not ours.
  permission(input): PermissionRequest {
    const paths = Array.isArray(input.paths) ? (input.paths as string[]) : [];
    const files = paths.length ? `\n\nStaging:\n${paths.map((p) => `  ${p}`).join('\n')}` : '\n\n(committing already-staged changes)';
    return {
      title: 'Create commit',
      detail: `${String(input.message ?? '')}${files}`,
      scopeKey: 'git:commit',
    };
  },

  async execute(input, ctx): Promise<ToolResult> {
    await requireRepo(ctx);
    const message = String(input.message ?? '').trim();
    if (!message) throw new ToolError('A commit message is required.');

    const paths = Array.isArray(input.paths) ? (input.paths as string[]) : [];
    if (paths.length > 0) {
      const add = await git(['add', '--', ...paths], ctx.cwd, ctx.signal);
      if (add.code !== 0) {
        throw new ToolError(`Could not stage files: ${add.stderr.trim() || 'unknown error'}`);
      }
    }

    const staged = await git(['diff', '--staged', '--name-only'], ctx.cwd, ctx.signal);
    if (!staged.stdout.trim()) {
      throw new ToolError(
        'Nothing is staged, so there is nothing to commit.',
        'Pass `paths` to stage files, or check git_status.',
      );
    }

    const commit = await git(['commit', '-m', message], ctx.cwd, ctx.signal);
    if (commit.code !== 0) {
      // A failing pre-commit hook lands here. Surface its output verbatim —
      // that is exactly what the user needs to see, and never bypass it.
      throw new ToolError(
        `Commit failed: ${(commit.stderr || commit.stdout).trim()}`,
        'If a hook rejected the commit, fix the underlying problem rather than skipping the hook.',
      );
    }

    const head = await git(['rev-parse', '--short', 'HEAD'], ctx.cwd, ctx.signal);
    const files = staged.stdout.trim().split('\n').length;
    return {
      content: `Committed ${head.stdout.trim()} (${files} file${files === 1 ? '' : 's'}): ${message.split('\n')[0]}`,
    };
  },
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
