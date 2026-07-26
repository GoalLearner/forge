/**
 * Permission policy.
 *
 * Three modes, and one rule that overrides all of them: a command classified as
 * `dangerous` is always confirmed, even in yolo. Accepting "run my tests without
 * asking" is not the same as accepting "reformat my disk without asking", and
 * collapsing those two into one setting is how agents damage people's machines.
 *
 *   safe      — confirm every write and every shell command
 *   auto-edit — writes apply immediately; shell confirmed at `caution` and above
 *               (read-only shell like `ls` or `git status` still runs freely,
 *               otherwise the prompt fatigue trains you to stop reading them)
 *   yolo      — nothing prompts except `dangerous`
 *
 * Approvals are remembered by `scopeKey` — `shell:npm test` gets approved once,
 * not on every invocation. Session approvals live in memory; "always" approvals
 * persist to <project>/.forge/permissions.json, which is gitignored because it
 * encodes one machine's trust decisions and shouldn't follow the repo.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RiskLevel } from './danger.ts';

export type PermissionMode = 'safe' | 'auto-edit' | 'yolo';

interface PersistedPermissions {
  version: 1;
  approved: string[];
}

export class PermissionManager {
  private sessionApproved = new Set<string>();
  private persistedApproved = new Set<string>();
  private filePath: string;
  private mode: PermissionMode;

  constructor(mode: PermissionMode, projectRoot: string) {
    this.mode = mode;
    this.filePath = join(projectRoot, '.forge', 'permissions.json');
    this.load();
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /**
   * Does a file write need confirming?
   * Writes are never "dangerous" in the shell sense — the path jail has already
   * confined them, and edits are visible as a diff — so mode alone decides.
   */
  needsWriteConfirmation(): boolean {
    return this.mode === 'safe';
  }

  /**
   * Does a shell command need confirming?
   *
   * `dangerous` short-circuits every mode. That is the whole point of the
   * classifier: yolo means "don't nag me about routine commands", not
   * "disable the guardrail".
   */
  needsShellConfirmation(risk: RiskLevel): boolean {
    if (risk === 'dangerous') return true;
    switch (this.mode) {
      case 'safe':
        return true;
      case 'auto-edit':
        return risk === 'caution';
      case 'yolo':
        return false;
    }
  }

  isPreApproved(scopeKey: string): boolean {
    return this.sessionApproved.has(scopeKey) || this.persistedApproved.has(scopeKey);
  }

  /** Approve for this session only. */
  approveOnce(scopeKey: string): void {
    this.sessionApproved.add(scopeKey);
  }

  /** Approve and persist for this project. */
  approve(scopeKey: string): void {
    this.sessionApproved.add(scopeKey);
    this.persistedApproved.add(scopeKey);
    this.save();
  }

  listApproved(): string[] {
    return [...new Set([...this.persistedApproved, ...this.sessionApproved])].sort();
  }

  revokeAll(): void {
    this.sessionApproved.clear();
    this.persistedApproved.clear();
    this.save();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedPermissions;
      for (const key of parsed.approved ?? []) this.persistedApproved.add(key);
    } catch {
      // A corrupt allowlist must never block startup — it fails closed
      // (nothing pre-approved), which is the safe direction.
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload: PersistedPermissions = {
        version: 1,
        approved: [...this.persistedApproved].sort(),
      };
      writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      // Read-only checkout, permissions problem, whatever — approvals just
      // won't survive the session. Not worth interrupting the user over.
    }
  }
}
