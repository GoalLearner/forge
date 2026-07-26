/**
 * The tool contract.
 *
 * A tool is a pure-ish function with a JSON Schema, plus two pieces of metadata
 * that the harness needs and the model never sees:
 *
 *   readOnly   — safe to run concurrently with other read-only tools, and never
 *                needs permission. The scheduler uses this to parallelize.
 *   permission — what to ask the user before running, or null for "just go".
 *                Returning a request from here (rather than prompting inside
 *                execute) keeps the gate in one place and lets the UI render a
 *                proper confirmation with a diff or the exact command.
 */

import type { Config } from '../config/schema.ts';
import type { PermissionManager } from '../safety/permissions.ts';
import type { FileTracker } from '../safety/file-tracker.ts';

export interface ToolContext {
  /** Project root. Every file path is resolved against and jailed to this. */
  cwd: string;
  config: Config;
  signal: AbortSignal;
  permissions: PermissionManager;
  /** Enforces read-before-write. See safety/file-tracker.ts. */
  files: FileTracker;
  /**
   * Optional pre-write snapshot hook (session/checkpoints.ts). The write tools
   * call this immediately before mutating a file so the UI can offer per-file
   * revert. Absent in the CLI today; the desktop app always provides it.
   */
  checkpoints?: { snapshot(path: string): void };
  /**
   * The deadline the agent loop is enforcing for THIS call, in ms.
   *
   * Set per-invocation by the loop so a tool with its own internal timer
   * (run_shell) uses the same number the loop will act on, instead of the two
   * disagreeing about when the call should end. Absent outside the loop.
   */
  toolTimeoutMs?: number;
}

/** Optional structured payload so the UI can render more than plain text. */
export type ToolDisplay =
  | { kind: 'diff'; path: string; patch: string; added: number; removed: number }
  | { kind: 'file'; path: string; lines: number }
  | { kind: 'list'; items: string[]; total: number }
  | { kind: 'shell'; command: string; exitCode: number };

export interface ToolResult {
  /** What the model sees. Keep it dense — this is billed on every later turn. */
  content: string;
  isError?: boolean;
  /** What the user sees, when a richer rendering is available. */
  display?: ToolDisplay;
}

export interface PermissionRequest {
  /** Short imperative title, e.g. "Run shell command". */
  title: string;
  /** The thing being approved — a command, a path, a diff. */
  detail: string;
  /** Rendered above the prompt when the action is risky. */
  danger?: string;
  /**
   * Stable key for "don't ask again". Two calls with the same key are the same
   * kind of action (e.g. `shell:npm test`), so approval can be remembered.
   */
  scopeKey: string;
  display?: ToolDisplay;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True when the tool cannot mutate anything. Enables parallel execution. */
  readOnly: boolean;
  /** One-line summary for the transcript, e.g. `read src/cli.tsx`. */
  summarize(input: Record<string, unknown>): string;
  /** What to confirm before running, or null. Never called for readOnly tools. */
  permission?(input: Record<string, unknown>, ctx: ToolContext): PermissionRequest | null;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type PermissionDecision =
  | { type: 'allow' }
  /** Allow, and remember this scopeKey for the rest of the session/project. */
  | { type: 'allow_always' }
  | { type: 'deny'; reason?: string };

export class ToolError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ToolError';
    this.hint = hint;
  }
}
