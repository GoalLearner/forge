/**
 * Large-file surgical edit regression.
 *
 * Shaped after the file that motivated this work: awakened-app's `app.js` is
 * ~62,000 CRLF lines. When `edit_file` could not match a CRLF file, Forge's
 * only way forward was rewriting the whole thing — affordable on a 200-line
 * test, unacceptable here.
 *
 * The fixture is generated in a temp directory and never committed. It carries
 * the properties that make a large real file hard: near-miss lines that differ
 * from the target by a single character, Unicode content, uniform CRLF, and one
 * unique target near the END so a naive implementation's cost shows up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFileTool } from './fs-read.ts';
import { editFileTool } from './fs-write.ts';
import { ConfigSchema } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import type { ToolContext } from './types.ts';

const LINES = 60_000;

/** A CRLF file with distractors, Unicode, and one unique span near the end. */
function buildFixture(): { content: string; targetLine: number } {
  const out: string[] = [];
  for (let i = 0; i < LINES; i++) {
    if (i % 997 === 0) {
      // Near-miss distractor: same shape, different index — must not match.
      out.push(`  function handleEvent${i}(payload) { return payload; }`);
    } else if (i % 313 === 0) {
      out.push(`  // note ${i}: café · naïve · 日本語 · emoji 🎯`);
    } else {
      out.push(`  const value${i} = ${i};`);
    }
  }
  // The unique target, deliberately close to EOF.
  const targetLine = LINES - 12;
  out[targetLine] = '  const UNIQUE_TARGET_MARKER = 1;';
  out[targetLine + 1] = '  const UNIQUE_TARGET_NEIGHBOUR = 2;';
  return { content: out.join('\r\n') + '\r\n', targetLine };
}

function contextFor(cwd: string): ToolContext {
  return {
    cwd,
    config: ConfigSchema.parse({ permissions: { mode: 'yolo' } }),
    signal: new AbortController().signal,
    permissions: new PermissionManager('yolo', cwd),
    files: new FileTracker(),
  };
}

test('a surgical edit on a 60k-line CRLF file changes only the target span', async () => {
  const { content } = buildFixture();
  const cwd = mkdtempSync(join(tmpdir(), 'forge-large-'));
  const path = join(cwd, 'big.js');
  writeFileSync(path, content, 'utf8');

  const beforeText = readFileSync(path, 'utf8');
  const beforeLines = beforeText.split('\r\n');
  const beforeCrlf = (beforeText.match(/\r\n/g) ?? []).length;

  const ctx = contextFor(cwd);
  await readFileTool.execute({ path: 'big.js', offset: 1, limit: LINES + 10 }, ctx);

  // LF old_string — exactly what a model copies from the rendered read output.
  const started = Date.now();
  await editFileTool.execute(
    {
      path: 'big.js',
      old_string: '  const UNIQUE_TARGET_MARKER = 1;\n  const UNIQUE_TARGET_NEIGHBOUR = 2;',
      new_string: '  const UNIQUE_TARGET_MARKER = 42;\n  const UNIQUE_TARGET_NEIGHBOUR = 2;',
    },
    ctx,
  );
  const elapsed = Date.now() - started;

  const afterText = readFileSync(path, 'utf8');
  const afterLines = afterText.split('\r\n');
  const afterCrlf = (afterText.match(/\r\n/g) ?? []).length;

  // No whole-file conversion.
  assert.equal(afterCrlf, beforeCrlf, 'CRLF count unchanged — no line-ending churn');
  assert.equal((afterText.match(/(?<!\r)\n/g) ?? []).length, 0, 'no bare LF introduced');
  assert.equal(afterLines.length, beforeLines.length, 'line count stable');

  // Exactly one line differs.
  const changed: number[] = [];
  for (let i = 0; i < beforeLines.length; i++) {
    if (beforeLines[i] !== afterLines[i]) changed.push(i);
  }
  assert.equal(changed.length, 1, `exactly one line changed, got ${changed.length}`);
  assert.equal(afterLines[changed[0]!], '  const UNIQUE_TARGET_MARKER = 42;');

  // Unicode elsewhere survived untouched.
  assert.ok(afterText.includes('café · naïve · 日本語 · emoji 🎯'), 'Unicode preserved');

  // Bounded cost — a quadratic scan on 60k lines would not finish this quickly.
  assert.ok(elapsed < 15_000, `edit took ${elapsed}ms`);
});

test('a distractor line near the target does not become an accidental match', async () => {
  const { content } = buildFixture();
  const cwd = mkdtempSync(join(tmpdir(), 'forge-large-miss-'));
  const path = join(cwd, 'big.js');
  writeFileSync(path, content, 'utf8');

  const ctx = contextFor(cwd);
  await readFileTool.execute({ path: 'big.js', offset: 1, limit: LINES + 10 }, ctx);

  // Differs from any real line by one character — must still be rejected.
  let error: string | null = null;
  try {
    await editFileTool.execute(
      { path: 'big.js', old_string: '  const UNIQUE_TARGET_MARKER = 1 ;', new_string: 'x' },
      ctx,
    );
  } catch (e) {
    error = (e as Error).message;
  }

  assert.ok(error, 'a one-character difference must not match');
  assert.match(error, /was not found/);
  assert.equal(readFileSync(path, 'utf8'), content, 'file untouched');
});
