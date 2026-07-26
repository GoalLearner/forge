/**
 * File checkpoints — the backend for per-file review, revert, and restore.
 *
 * The redesign's Changes panel promises something the agent core didn't have:
 * undo ONE file's edits without losing the rest. That requires knowing what
 * each file looked like *before* forge first touched it, which can only be
 * captured at write time — hence the `snapshot()` hook the write tools call
 * immediately before mutating a file (see tools/fs-write.ts).
 *
 * Model:
 *   - `before` is the content at forge's FIRST touch of the session — not the
 *     previous write. Three edits to one file still revert in one step, to the
 *     state the user last saw. `null` before-content means forge created it.
 *   - Revert stashes the current content, so Restore can undo the undo. One
 *     level is enough; this is not a general undo stack.
 *   - Commit clears the set: committed work is git's to track, and the panel's
 *     "changes" become whatever happens next.
 *
 * Interaction with read-before-write (safety/file-tracker.ts): a revert
 * changes the file on disk, so the tracker's mtime check will force the agent
 * to re-read before editing that file again. That is correct behaviour, not a
 * conflict — the file genuinely changed under it.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { computeDiff } from '../tools/diff.ts';

export type ChangeStatus = 'created' | 'edited' | 'deleted' | 'reverted';

export interface ChangeEntry {
  /** Absolute path. */
  path: string;
  /** Project-relative, forward slashes — what the UI shows. */
  display: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  /** Unified diff of before -> current (or before -> stashed, when reverted). */
  patch: string;
}

interface Record_ {
  /** Content at forge's first touch this session. null = file did not exist. */
  before: string | null;
  /** Set while reverted: the forge-made content, kept so Restore can re-apply. */
  stashed?: string | null;
}

export class Checkpoints {
  private records = new Map<string, Record_>();
  // No parameter property: Node's strip-only TS loader (used by `npm test`)
  // rejects them, so fields are declared explicitly throughout this codebase.
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Record a file's pre-write state. Called by the write tools immediately
   * before they mutate the file; first call per path wins, so `before` always
   * means "what the user had", not "what the previous forge edit left".
   */
  snapshot(path: string): void {
    if (this.records.has(path)) return;
    this.records.set(path, { before: readIfExists(path) });
  }

  /** Files touched this session, with live diffs against the disk state. */
  listChanges(): ChangeEntry[] {
    const out: ChangeEntry[] = [];

    for (const [path, record] of this.records) {
      const display = this.display(path);

      if (record.stashed !== undefined) {
        // Reverted: diff shows what WOULD come back on restore, so the panel
        // can keep the diff visible "for reference" as the design specifies.
        const diff = computeDiff(display, record.before ?? '', record.stashed ?? '');
        out.push({ path, display, status: 'reverted', added: diff.added, removed: diff.removed, patch: diff.patch });
        continue;
      }

      const current = readIfExists(path);
      if (current === record.before) continue; // touched but net-unchanged

      const status: ChangeStatus =
        record.before === null ? 'created' : current === null ? 'deleted' : 'edited';
      const diff = computeDiff(display, record.before ?? '', current ?? '');
      out.push({ path, display, status, added: diff.added, removed: diff.removed, patch: diff.patch });
    }

    return out.sort((a, b) => a.display.localeCompare(b.display));
  }

  /** Total +/- across the set, for the header badge. */
  totals(): { files: number; added: number; removed: number } {
    const changes = this.listChanges();
    return {
      files: changes.length,
      added: changes.reduce((n, c) => n + c.added, 0),
      removed: changes.reduce((n, c) => n + c.removed, 0),
    };
  }

  /**
   * Put a file back to its pre-forge state. The forge-made content is stashed
   * so restore() can bring it back.
   */
  revert(path: string): void {
    const record = this.records.get(path);
    if (!record || record.stashed !== undefined) return;

    record.stashed = readIfExists(path);

    if (record.before === null) {
      // Forge created this file; revert means it should not exist. Only ever
      // deletes a path we recorded creating — never anything pre-existing.
      if (existsSync(path)) unlinkSync(path);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, record.before, 'utf8');
    }
  }

  /** Undo a revert: re-apply the stashed forge content. */
  restore(path: string): void {
    const record = this.records.get(path);
    if (!record || record.stashed === undefined) return;

    if (record.stashed === null) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, record.stashed, 'utf8');
    }
    delete record.stashed;
  }

  /** Revert everything still standing. */
  revertAll(): void {
    for (const path of this.records.keys()) this.revert(path);
  }

  /**
   * Forget the current set — called after a successful commit, when the work
   * has a better home (git), or on /clear.
   */
  clear(): void {
    this.records.clear();
  }

  /** Paths currently changed and not reverted — what a commit should stage. */
  commitablePaths(): string[] {
    return this.listChanges()
      .filter((c) => c.status !== 'reverted' && c.status !== 'deleted')
      .map((c) => c.path);
  }

  private display(path: string): string {
    const rel = relative(this.cwd, path);
    return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : path;
  }
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}
