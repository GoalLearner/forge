/**
 * Read-side filesystem tools: read_file and list_dir.
 *
 * Both are read-only, so they never prompt and the loop runs them concurrently.
 *
 * The design pressure here is token cost. Every byte a read returns is re-sent
 * on every subsequent turn of the task, so these tools are aggressive about
 * bounding output and about telling the model how to ask for less.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PathJail } from '../safety/paths.ts';
import { ToolError, type Tool, type ToolContext, type ToolResult } from './types.ts';

/** Files above this size are refused outright rather than truncated. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function jailFor(ctx: ToolContext): PathJail {
  return new PathJail({
    root: ctx.cwd,
    extraRoots: ctx.config.permissions.extraRoots,
    deny: ctx.config.permissions.deny,
  });
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a file from the project. Returns the contents with line numbers. Use offset/limit to page through large files instead of reading them whole. You must read a file before you may edit or overwrite it.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root.' },
      offset: { type: 'integer', description: '1-based line number to start at.', minimum: 1 },
      limit: { type: 'integer', description: 'Maximum number of lines to return.', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },

  summarize(input) {
    const path = String(input.path ?? '');
    const offset = input.offset ? ` from line ${input.offset}` : '';
    return `read ${path}${offset}`;
  },

  async execute(input, ctx): Promise<ToolResult> {
    const jail = jailFor(ctx);
    const path = jail.resolve(String(input.path ?? ''), 'read');
    const display = jail.display(path);

    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new ToolError(
        `File not found: ${display}`,
        'Use glob or list_dir to find the correct path.',
      );
    }

    if (stat.isDirectory()) {
      throw new ToolError(`${display} is a directory.`, 'Use list_dir to see what is inside it.');
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new ToolError(
        `${display} is ${formatBytes(stat.size)}, too large to read in full.`,
        'Use grep to find the relevant region, then read_file with offset and limit.',
      );
    }

    const raw = readFileSync(path);
    if (isProbablyBinary(raw)) {
      throw new ToolError(
        `${display} looks like a binary file (${formatBytes(stat.size)}).`,
        'forge can only read text files.',
      );
    }

    const allLines = raw.toString('utf8').split('\n');
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.max(1, Number(input.limit ?? ctx.config.limits.maxFileReadLines));
    const slice = allLines.slice(offset - 1, offset - 1 + limit);

    // Record the read so edit_file/write_file will accept this path.
    ctx.files.markRead(path);

    if (slice.length === 0) {
      return {
        content: `${display} has ${allLines.length} lines; offset ${offset} is past the end.`,
        display: { kind: 'file', path: display, lines: 0 },
      };
    }

    // Line numbers make edit_file targeting and `file.ts:42` references possible.
    const width = String(offset + slice.length - 1).length;
    const body = slice
      .map((line, i) => `${String(offset + i).padStart(width, ' ')}\t${line}`)
      .join('\n');

    const shown = offset + slice.length - 1;
    const footer =
      shown < allLines.length
        ? `\n\n[showing lines ${offset}-${shown} of ${allLines.length}. Read further with offset=${shown + 1}.]`
        : '';

    return {
      content: `${display}\n${body}${footer}`,
      display: { kind: 'file', path: display, lines: slice.length },
    };
  },
};

export const listDirTool: Tool = {
  name: 'list_dir',
  description:
    'List the entries in a directory (non-recursive). Use glob for recursive or pattern-based search.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to the project root. Defaults to the root.',
      },
    },
    additionalProperties: false,
  },

  summarize(input) {
    return `list ${String(input.path ?? '.')}`;
  },

  async execute(input, ctx): Promise<ToolResult> {
    const jail = jailFor(ctx);
    const path = jail.resolve(String(input.path ?? '.'), 'read');
    const display = jail.display(path) || '.';

    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      throw new ToolError(`Not a directory or not found: ${display}`);
    }

    // Skip the directories nobody wants listed — they bury the signal and are
    // enormous. The model can still read inside them by explicit path.
    const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__']);

    const items = entries
      .filter((e) => !skip.has(e.name))
      .map((e) => {
        if (e.isDirectory()) return `${e.name}/`;
        try {
          return `${e.name}  (${formatBytes(statSync(join(path, e.name)).size)})`;
        } catch {
          return e.name;
        }
      })
      .sort();

    const hidden = entries.length - items.length;
    const note = hidden > 0 ? `\n[${hidden} entries hidden: ${[...skip].join(', ')}]` : '';

    return {
      content: items.length
        ? `${display}/\n${items.map((i) => `  ${i}`).join('\n')}${note}`
        : `${display}/ is empty`,
      display: { kind: 'list', items: items.slice(0, 50), total: items.length },
    };
  },
};

// ---------------------------------------------------------------------------

/**
 * Heuristic binary sniff: a NUL byte in the first 8KB. Same approach git uses,
 * and it costs nothing compared to reading the whole file first.
 */
function isProbablyBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8192);
  return window.includes(0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
