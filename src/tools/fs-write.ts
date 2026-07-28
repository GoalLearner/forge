/**
 * Write-side filesystem tools: write_file, edit_file, multi_edit.
 *
 * Three invariants, in order of how much damage they prevent:
 *
 *  1. READ BEFORE WRITE (safety/file-tracker.ts). A file that exists may only
 *     be modified if this session read it and it hasn't changed since. Stops the
 *     agent from silently reverting edits the user made in their editor.
 *
 *  2. UNIQUE MATCH. edit_file replaces an exact string that must appear exactly
 *     once. Ambiguity is an error, never a guess — "replace the first match" is
 *     how an agent edits the wrong function.
 *
 *  3. ATOMIC BATCHES. multi_edit validates every edit against the in-memory
 *     result before touching disk, so a batch either fully applies or doesn't
 *     run. Half-applied refactors are worse than none.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PathJail } from '../safety/paths.ts';
import { AbortedError } from '../providers/types.ts';
import { capPatch, computeDiff } from './diff.ts';
import { applyStyle, findLogicalMatches, replacementStyle, spliceSpans } from './edit-match.ts';
import {
  ToolError,
  type PermissionRequest,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts';

/**
 * Refuse to start a filesystem mutation once the run has been cancelled.
 *
 * Checked immediately before every write, and between the steps of a
 * multi-edit. An OS-level write already in flight cannot be recalled — that is
 * why supersede() waits for the tool to return rather than relying on this —
 * but nothing *new* should touch the disk after the user hit Stop or switched
 * away. Throwing here lands on the loop's normal interrupted-tool path
 * (loop.ts `execute`), which turns AbortedError into an error result rather
 * than a crash, so the transcript stays structurally valid.
 */
function assertNotAborted(ctx: ToolContext): void {
  if (ctx.signal.aborted) throw new AbortedError();
}

function jailFor(ctx: ToolContext): PathJail {
  return new PathJail({
    root: ctx.cwd,
    extraRoots: ctx.config.permissions.extraRoots,
    deny: ctx.config.permissions.deny,
  });
}

/** Preserve the file's existing line endings — never reformat by accident. */
function matchLineEndings(original: string, updated: string): string {
  const originalUsesCrlf = /\r\n/.test(original);
  const normalized = updated.replace(/\r\n/g, '\n');
  return originalUsesCrlf ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Create a new file, or completely replace an existing one. For changes to an existing file prefer edit_file — it is safer and far cheaper in tokens. You must read_file an existing file before overwriting it.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root.' },
      content: { type: 'string', description: 'The complete new contents of the file.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },

  summarize(input) {
    return `write ${String(input.path ?? '')}`;
  },

  permission(input, ctx): PermissionRequest | null {
    if (!ctx.permissions.needsWriteConfirmation()) return null;
    const jail = jailFor(ctx);
    const path = jail.resolve(String(input.path ?? ''), 'write');
    const display = jail.display(path);
    const before = readIfExists(path);
    const after = String(input.content ?? '');
    const diff = before === null ? null : computeDiff(display, before, after);

    return {
      title: before === null ? 'Create file' : 'Overwrite file',
      detail: display,
      scopeKey: `write:${display}`,
      ...(diff?.changed
        ? {
            display: {
              kind: 'diff' as const,
              path: display,
              patch: capPatch(diff.patch),
              added: diff.added,
              removed: diff.removed,
            },
          }
        : {}),
    };
  },

  async execute(input, ctx): Promise<ToolResult> {
    const jail = jailFor(ctx);
    const path = jail.resolve(String(input.path ?? ''), 'write');
    const display = jail.display(path);
    const content = String(input.content ?? '');

    ctx.files.assertWritable(path, display);

    const before = readIfExists(path);
    const finalContent = before === null ? content : matchLineEndings(before, content);

    // Must precede the write: this is the only moment the pre-forge content is
    // still on disk, and per-file revert depends on capturing it.
    assertNotAborted(ctx);
    ctx.checkpoints?.snapshot(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, finalContent, 'utf8');
    ctx.files.markWritten(path);

    if (before === null) {
      const lines = finalContent.split('\n').length;
      return {
        content: `Created ${display} (${lines} lines).`,
        display: { kind: 'file', path: display, lines },
      };
    }

    const diff = computeDiff(display, before, finalContent);
    if (!diff.changed) {
      return { content: `${display} already had exactly this content — no change written.` };
    }
    return {
      // The model gets counts only; the full patch would be re-sent every turn.
      content: `Wrote ${display} (+${diff.added} -${diff.removed}).`,
      display: {
        kind: 'diff',
        path: display,
        patch: capPatch(diff.patch),
        added: diff.added,
        removed: diff.removed,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Apply one exact-string replacement.
 *
 * Rejects both zero matches and (unless replace_all) multiple matches. The
 * multi-match rejection is the important one: silently taking the first match
 * is how an agent edits the wrong occurrence of a common line like `return null`.
 */
function applyEdit(source: string, edit: EditSpec, display: string, index?: number): string {
  const label = index === undefined ? 'edit' : `edit ${index + 1}`;

  if (edit.old_string === edit.new_string) {
    throw new ToolError(`${label}: old_string and new_string are identical — nothing to do.`);
  }
  if (edit.old_string === '') {
    throw new ToolError(
      `${label}: old_string is empty.`,
      'Use write_file to create a file; edit_file replaces existing text.',
    );
  }

  // Matching tolerates CRLF/LF differences and NOTHING else — see
  // edit-match.ts. `read_file` hands the model a CRLF file with invisible
  // carriage returns, so an `old_string` copied faithfully from what was
  // displayed would otherwise never match, and the only way forward would be
  // rewriting the whole file.
  const matches = findLogicalMatches(source, edit.old_string);

  if (matches.length === 0) {
    throw new ToolError(
      `${label}: old_string was not found in ${display}.`,
      'Re-read the file — the text may differ in whitespace or indentation from what you expected. Copy the exact text from the read_file output.',
    );
  }
  if (matches.length > 1 && !edit.replace_all) {
    throw new ToolError(
      `${label}: old_string appears ${matches.length} times in ${display}; the match must be unique.`,
      'Include more surrounding lines to make the match unique, or set replace_all: true to change every occurrence.',
    );
  }

  // Splice at PHYSICAL offsets recovered from the match, so everything outside
  // the replaced span — including unrelated line endings, a BOM and the
  // presence or absence of a trailing newline — survives byte for byte.
  const targets = edit.replace_all ? matches : [matches[0]!];
  return spliceSpans(source, targets, (span) =>
    applyStyle(edit.new_string, replacementStyle(source, span)),
  );
}

function loadForEdit(ctx: ToolContext, rawPath: string): { path: string; display: string; source: string } {
  const jail = jailFor(ctx);
  const path = jail.resolve(rawPath, 'write');
  const display = jail.display(path);

  if (!existsSync(path)) {
    throw new ToolError(`File not found: ${display}`, 'Use write_file to create a new file.');
  }
  ctx.files.assertWritable(path, display);
  return { path, display, source: readFileSync(path, 'utf8') };
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match the file byte-for-byte (copy it from read_file output) and must be unique unless replace_all is set. This is the preferred way to change existing files.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root.' },
      old_string: {
        type: 'string',
        description: 'Exact text to replace, including indentation. Must be unique in the file.',
      },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring a unique match.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },

  summarize(input) {
    return `edit ${String(input.path ?? '')}`;
  },

  permission(input, ctx): PermissionRequest | null {
    if (!ctx.permissions.needsWriteConfirmation()) return null;
    const jail = jailFor(ctx);
    const display = jail.display(jail.resolve(String(input.path ?? ''), 'write'));
    return { title: 'Edit file', detail: display, scopeKey: `write:${display}` };
  },

  async execute(input, ctx): Promise<ToolResult> {
    const { path, display, source } = loadForEdit(ctx, String(input.path ?? ''));

    const updated = applyEdit(source, {
      old_string: String(input.old_string ?? ''),
      new_string: String(input.new_string ?? ''),
      replace_all: Boolean(input.replace_all),
    }, display);

    // NOT `matchLineEndings` — that restyles the WHOLE file to one ending, and
    // `applyEdit` has already styled the replacement to match the span it
    // replaced. Running both would flatten a mixed-ending file's unrelated
    // lines, which is precisely the churn a surgical edit must not cause.
    const finalContent = updated;
    assertNotAborted(ctx);
    ctx.checkpoints?.snapshot(path);
    writeFileSync(path, finalContent, 'utf8');
    ctx.files.markWritten(path);

    const diff = computeDiff(display, source, finalContent);
    return {
      content: `Edited ${display} (+${diff.added} -${diff.removed}).`,
      display: {
        kind: 'diff',
        path: display,
        patch: capPatch(diff.patch),
        added: diff.added,
        removed: diff.removed,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// multi_edit
// ---------------------------------------------------------------------------

export const multiEditTool: Tool = {
  name: 'multi_edit',
  description:
    'Apply several edits to one file in a single atomic operation. Edits apply in order, each against the result of the previous one. If any edit fails, none are written. Use this instead of several edit_file calls on the same file.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root.' },
      edits: {
        type: 'array',
        description: 'Edits to apply in order.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_string', 'new_string'],
          additionalProperties: false,
        },
        minItems: 1,
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  },

  summarize(input) {
    const count = Array.isArray(input.edits) ? input.edits.length : 0;
    return `edit ${String(input.path ?? '')} (${count} change${count === 1 ? '' : 's'})`;
  },

  permission(input, ctx): PermissionRequest | null {
    if (!ctx.permissions.needsWriteConfirmation()) return null;
    const jail = jailFor(ctx);
    const display = jail.display(jail.resolve(String(input.path ?? ''), 'write'));
    return { title: 'Edit file', detail: display, scopeKey: `write:${display}` };
  },

  async execute(input, ctx): Promise<ToolResult> {
    const { path, display, source } = loadForEdit(ctx, String(input.path ?? ''));

    const edits = Array.isArray(input.edits) ? (input.edits as EditSpec[]) : [];
    if (edits.length === 0) throw new ToolError('No edits supplied.');

    // Apply everything in memory first. Any failure throws before we write, so
    // the file on disk is never left half-edited. The abort check sits between
    // edits for the same reason it sits before the write: once cancelled, stop
    // doing work — and since nothing has touched disk yet, aborting here leaves
    // no partial file behind.
    let working = source;
    edits.forEach((edit, index) => {
      assertNotAborted(ctx);
      working = applyEdit(working, edit, display, index);
    });

    // Same reasoning as edit_file: each replacement is already styled to its
    // own matched span, so a whole-file restyle here would undo that.
    const finalContent = working;
    assertNotAborted(ctx);
    ctx.checkpoints?.snapshot(path);
    writeFileSync(path, finalContent, 'utf8');
    ctx.files.markWritten(path);

    const diff = computeDiff(display, source, finalContent);
    return {
      content: `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${display} (+${diff.added} -${diff.removed}).`,
      display: {
        kind: 'diff',
        path: display,
        patch: capPatch(diff.patch),
        added: diff.added,
        removed: diff.removed,
      },
    };
  },
};
