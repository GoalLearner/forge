/**
 * Unified diff generation for edit previews.
 *
 * Two audiences, two formats:
 *   - the USER sees a colored, context-limited diff in the confirmation prompt
 *     and after each edit (rendered by ui/Diff.tsx from the patch text here)
 *   - the MODEL sees only a one-line summary ("+12 -3"), because replaying the
 *     full diff into the transcript costs tokens on every subsequent turn and
 *     tells it nothing it doesn't already know — it wrote the edit.
 */

import { structuredPatch } from 'diff';

export interface DiffSummary {
  /** Unified-diff text, ready to colorize. Empty when nothing changed. */
  patch: string;
  added: number;
  removed: number;
  changed: boolean;
}

/** Context lines around each hunk. Three is the universal default. */
const CONTEXT_LINES = 3;

export function computeDiff(
  displayPath: string,
  before: string,
  after: string,
  context = CONTEXT_LINES,
): DiffSummary {
  if (before === after) {
    return { patch: '', added: 0, removed: 0, changed: false };
  }

  const result = structuredPatch(displayPath, displayPath, before, after, '', '', { context });

  let added = 0;
  let removed = 0;
  const lines: string[] = [];

  for (const hunk of result.hunks) {
    lines.push(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    );
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
      lines.push(line);
    }
  }

  return { patch: lines.join('\n'), added, removed, changed: true };
}

/**
 * Cap a patch for display. A 4000-line diff scrolls the terminal into
 * uselessness; the counts in the header already convey the scale.
 */
export function capPatch(patch: string, maxLines = 60): string {
  const lines = patch.split('\n');
  if (lines.length <= maxLines) return patch;
  const kept = lines.slice(0, maxLines);
  kept.push(`... ${lines.length - maxLines} more diff lines`);
  return kept.join('\n');
}
