/**
 * Line-ending tolerance for structured edits.
 *
 * Driven by Daily Dogfood 001: `read_file` hands the model a CRLF file with a
 * carriage return at the end of every line, invisible once rendered. The model
 * copied what it could see, supplied `old_string` with plain `\n`, and the
 * exact `indexOf` found nothing — so Forge rewrote a whole file to make
 * progress. On a 62,000-line file that is not an acceptable recovery.
 *
 * Two properties are load-bearing here and are tested from both directions:
 *
 *   1. A difference that carries no meaning (CRLF vs LF) must not block a
 *      match.
 *   2. Every difference that DOES carry meaning — a space, a tab, case,
 *      punctuation, a different Unicode character — must still block it. This
 *      is not fuzzy matching, and the tests below exist mostly to prove that.
 *
 * The third property, and the one that broke during implementation, is that
 * nothing outside the replaced span may change. A whole-file restyle passes a
 * naive CRLF test and silently flattens a mixed-ending file; the mixed cases
 * here are what caught it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeForMatch,
  findLogicalMatches,
  replacementStyle,
  applyStyle,
  spliceSpans,
} from './edit-match.ts';
import { readFileTool } from './fs-read.ts';
import { editFileTool, multiEditTool } from './fs-write.ts';
import { ConfigSchema } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import type { ToolContext } from './types.ts';

// ---------------------------------------------------------------------------
// Harness — drives the REAL tools against a real temp file
// ---------------------------------------------------------------------------

const config = ConfigSchema.parse({ permissions: { mode: 'yolo' } });

interface EditOutcome {
  ok: boolean;
  error: string | null;
  text: string;
  mutated: boolean;
  tracker: FileTracker;
  path: string;
}

function contextFor(cwd: string): ToolContext {
  return {
    cwd,
    config,
    signal: new AbortController().signal,
    permissions: new PermissionManager('yolo', cwd),
    files: new FileTracker(),
  };
}

/** Write `content`, mark it read, then run edit_file exactly as the loop would. */
async function edit(
  content: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean; skipRead?: boolean } = {},
): Promise<EditOutcome> {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-le-'));
  const path = join(cwd, 'target.txt');
  writeFileSync(path, content, 'utf8');

  const ctx = contextFor(cwd);
  // Mark the file read through the PRODUCTION read tool rather than poking the
  // tracker: read_file records the jail-resolved path, and a hand-built path
  // can differ from it (temp dirs sit under a junction on Windows), which would
  // trip read-before-write for the wrong reason.
  if (!opts.skipRead) await readFileTool.execute({ path: 'target.txt' }, ctx);

  let error: string | null = null;
  try {
    await editFileTool.execute(
      {
        path: 'target.txt',
        old_string: oldString,
        new_string: newString,
        ...(opts.replaceAll ? { replace_all: true } : {}),
      },
      ctx,
    );
  } catch (e) {
    error = (e as Error).message;
  }

  const text = readFileSync(path, 'utf8');
  return { ok: !error, error, text, mutated: text !== content, tracker: ctx.files, path };
}

const CRLF = 'alpha\r\nbeta\r\ngamma\r\n';
const LF = 'alpha\nbeta\ngamma\n';

/** Count physical line endings so preservation can be asserted precisely. */
function endings(s: string): { crlf: number; lf: number } {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/\n/g) ?? []).length - crlf;
  return { crlf, lf };
}

// ---------------------------------------------------------------------------
// Baselines — the four combinations
// ---------------------------------------------------------------------------

test('LF file with an LF old_string still edits', async () => {
  const r = await edit(LF, 'beta\ngamma', 'beta\nDELTA');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\nbeta\nDELTA\n');
});

test('CRLF file with a CRLF old_string still edits', async () => {
  const r = await edit(CRLF, 'beta\r\ngamma', 'beta\r\nDELTA');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\r\nbeta\r\nDELTA\r\n');
});

test('CRLF file with an LF old_string now edits — the dogfood failure', async () => {
  // This is the exact shape that failed in Daily Dogfood 001.
  const r = await edit(CRLF, 'beta\ngamma', 'beta\nDELTA');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\r\nbeta\r\nDELTA\r\n');
});

test('LF file with a CRLF old_string edits when logically identical', async () => {
  const r = await edit(LF, 'beta\r\ngamma', 'beta\r\nDELTA');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\nbeta\nDELTA\n');
});

test('a span with no line break at all still edits', async () => {
  const r = await edit(CRLF, 'beta', 'DELTA');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\r\nDELTA\r\ngamma\r\n');
});

// ---------------------------------------------------------------------------
// Preservation — nothing outside the span may change
// ---------------------------------------------------------------------------

test('a CRLF file stays CRLF outside the edited span', async () => {
  const r = await edit(CRLF, 'beta\ngamma', 'beta\nDELTA');
  // The ok assertion matters: an ending count alone would pass vacuously if the
  // edit had been rejected and the file left untouched.
  assert.ok(r.ok, r.error ?? '');
  assert.deepEqual(endings(r.text), { crlf: 3, lf: 0 });
});

test('an LF file stays LF', async () => {
  const r = await edit(LF, 'beta\ngamma', 'beta\nDELTA');
  assert.ok(r.ok, r.error ?? '');
  assert.deepEqual(endings(r.text), { crlf: 0, lf: 3 });
});

test('a mixed-ending file keeps BOTH styles outside the span', async () => {
  // The case that caught a whole-file restyle during implementation: a naive
  // "detect CRLF, convert everything" approach turns this into all-CRLF.
  const r = await edit('a\r\nb\nc\r\nd\n', 'b\nc', 'b\nZ');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'a\r\nb\nZ\r\nd\n');
  assert.deepEqual(endings(r.text), { crlf: 2, lf: 2 }, 'unrelated endings untouched');
});

test('a mixed-ending file with a CRLF span keeps the LF lines LF', async () => {
  const r = await edit('a\r\nb\r\nc\nd\n', 'a\nb', 'a\nQ');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'a\r\nQ\r\nc\nd\n');
  assert.deepEqual(endings(r.text), { crlf: 2, lf: 2 });
});

test('a trailing newline is preserved', async () => {
  const r = await edit(CRLF, 'gamma', 'ZETA');
  assert.ok(r.text.endsWith('\r\n'), 'file still ends with its newline');
});

test('a missing trailing newline stays missing', async () => {
  const r = await edit('a\r\nb\r\nc', 'b\nc', 'b\nZ');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'a\r\nb\r\nZ');
  assert.ok(!r.text.endsWith('\n'), 'no newline was invented at EOF');
});

test('a UTF-8 BOM survives the edit', async () => {
  const r = await edit('\uFEFFalpha\r\nbeta\r\n', 'beta', 'DELTA');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text.charCodeAt(0), 0xfeff, 'BOM still first');
  assert.equal(r.text, '\uFEFFalpha\r\nDELTA\r\n');
});

test('Unicode content matches and survives', async () => {
  const r = await edit('héllo\r\nwörld\r\n', 'héllo\nwörld', 'héllo\nMUNDO');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'héllo\r\nMUNDO\r\n');
});

// ---------------------------------------------------------------------------
// Replacement style
// ---------------------------------------------------------------------------

test('a multiline replacement adopts CRLF inside a CRLF span', async () => {
  const r = await edit('alpha\r\nbeta\r\ngamma\r\n', 'beta\r\ngamma', 'one\ntwo\nthree');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\r\none\r\ntwo\r\nthree\r\n');
});

test('a multiline replacement adopts LF inside an LF span', async () => {
  const r = await edit('alpha\nbeta\ngamma\n', 'beta\ngamma', 'one\ntwo');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\none\ntwo\n');
});

test('a single-line span in a CRLF file falls back to the file style', async () => {
  // The span carries no evidence of its own, so the dominant style decides.
  const r = await edit('alpha\r\nbeta\r\n', 'beta', 'one\ntwo');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\r\none\r\ntwo\r\n');
});

test('a single-line span in an LF file falls back to LF', async () => {
  const r = await edit('alpha\nbeta\n', 'beta', 'one\ntwo');
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\none\ntwo\n');
});

test('the dominant-style fallback is deterministic in a mixed file', () => {
  // 3 CRLF vs 1 bare LF -> CRLF wins; reversed -> LF wins. Same input, same
  // answer, every time.
  const crlfHeavy = 'a\r\nb\r\nc\r\nd\ne';
  const lfHeavy = 'a\nb\nc\nd\r\ne';
  const span = { start: 0, end: 1 }; // 'a' — no line break inside
  assert.equal(replacementStyle(crlfHeavy, span), '\r\n');
  assert.equal(replacementStyle(lfHeavy, span), '\n');
});

// ---------------------------------------------------------------------------
// Strictness — everything that is NOT a line ending must still block
// ---------------------------------------------------------------------------

const STRICT: Array<[string, string, string]> = [
  ['one extra space', CRLF, 'beta \ngamma'],
  ['a missing space', 'a b\r\nc\r\n', 'ab\nc'],
  ['tab instead of spaces', 'a\r\n\tb\r\n', 'a\n    b'],
  ['different case', CRLF, 'BETA\ngamma'],
  ['different punctuation', 'a;\r\nb\r\n', 'a:\nb'],
  ['a different Unicode character', 'héllo\r\nx\r\n', 'hello\nx'],
];

for (const [label, content, oldString] of STRICT) {
  test(`strictness: ${label} is still not found`, async () => {
    const r = await edit(content, oldString, 'REPLACED');
    assert.ok(!r.ok, 'the edit must be rejected');
    assert.match(r.error ?? '', /was not found/);
    assert.ok(!r.mutated, 'and nothing may be written');
  });
}

test('a lone CR is treated conservatively, not as a line break', async () => {
  // Classic-Mac endings are extinct and a stray CR is more likely to be data.
  // Documented behavior: it does NOT match an LF old_string.
  const r = await edit('a\rb\r', 'a\nb', 'x');
  assert.ok(!r.ok);
  assert.match(r.error ?? '', /was not found/);
  assert.ok(!r.mutated);
});

// ---------------------------------------------------------------------------
// Match counting
// ---------------------------------------------------------------------------

test('zero logical matches is not-found', async () => {
  const r = await edit(CRLF, 'nowhere\nhere', 'x');
  assert.ok(!r.ok);
  assert.match(r.error ?? '', /was not found/);
});

test('exactly one logical match succeeds', async () => {
  const r = await edit(CRLF, 'alpha\nbeta', 'alpha\nBETA');
  assert.ok(r.ok, r.error ?? '');
});

test('two logical matches is an ambiguity error, not a silent first-match edit', async () => {
  const r = await edit('x\r\ny\r\nx\r\ny\r\n', 'x\ny', 'q');
  assert.ok(!r.ok);
  assert.match(r.error ?? '', /appears 2 times/);
  assert.ok(!r.mutated, 'an ambiguous match must never write');
});

test('spans differing only in physical endings count independently', async () => {
  // One CRLF pair, one LF pair — physically different, logically identical.
  // Counting them as one would let a "unique" edit hit the wrong place.
  const spans = findLogicalMatches('x\r\ny\nx\ny\n', 'x\ny');
  assert.equal(spans.length, 2);
  const r = await edit('x\r\ny\nx\ny\n', 'x\ny', 'q');
  assert.ok(!r.ok);
  assert.match(r.error ?? '', /appears 2 times/);
});

test('replace_all changes every logical match and styles each to its own span', async () => {
  const r = await edit('x\r\ny\r\nx\ny\n', 'x\ny', 'p\nq', { replaceAll: true });
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'p\r\nq\r\np\nq\n', 'each span keeps its own style');
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

test('a failed match leaves the file byte-identical', async () => {
  const r = await edit(CRLF, 'not here', 'x');
  assert.ok(!r.ok);
  assert.equal(r.text, CRLF);
});

test('an unread file is still rejected before any write', async () => {
  const r = await edit(CRLF, 'beta', 'x', { skipRead: true });
  assert.ok(!r.ok);
  assert.equal(r.text, CRLF, 'read-before-write still guards the file');
});

test('an external modification after the read still rejects the write', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-le-stale-'));
  const path = join(cwd, 'target.txt');
  writeFileSync(path, CRLF, 'utf8');

  const ctx = contextFor(cwd);
  await readFileTool.execute({ path: 'target.txt' }, ctx);

  // Someone else edits it — including the case of a pure CRLF -> LF rewrite,
  // which is still an external change and must not be waved through.
  await new Promise((r) => setTimeout(r, 12));
  writeFileSync(path, LF, 'utf8');

  let error: string | null = null;
  try {
    await editFileTool.execute(
      { path: 'target.txt', old_string: 'beta\ngamma', new_string: 'beta\nDELTA' },
      ctx,
    );
  } catch (e) {
    error = (e as Error).message;
  }

  assert.ok(error, 'the stale write must be rejected');
  assert.equal(readFileSync(path, 'utf8'), LF, 'the external content survives');
});

// ---------------------------------------------------------------------------
// multi_edit
// ---------------------------------------------------------------------------

async function multi(
  content: string,
  edits: Array<{ old_string: string; new_string: string }>,
): Promise<EditOutcome> {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-le-multi-'));
  const path = join(cwd, 'target.txt');
  writeFileSync(path, content, 'utf8');

  const ctx = contextFor(cwd);
  await readFileTool.execute({ path: 'target.txt' }, ctx);

  let error: string | null = null;
  try {
    await multiEditTool.execute({ path: 'target.txt', edits }, ctx);
  } catch (e) {
    error = (e as Error).message;
  }

  const text = readFileSync(path, 'utf8');
  return { ok: !error, error, text, mutated: text !== content, tracker: ctx.files, path };
}

test('multi_edit is line-ending tolerant too', async () => {
  const r = await multi('alpha\r\nbeta\r\ngamma\r\n', [
    { old_string: 'alpha\nbeta', new_string: 'alpha\nBETA' },
    { old_string: 'gamma', new_string: 'GAMMA' },
  ]);
  assert.ok(r.ok, r.error ?? '');
  assert.equal(r.text, 'alpha\r\nBETA\r\nGAMMA\r\n');
});

test('multi_edit preserves mixed endings across several replacements', async () => {
  const r = await multi('a\r\nb\nc\r\nd\n', [
    { old_string: 'a\nb', new_string: 'a\nB' },
    { old_string: 'c\nd', new_string: 'c\nD' },
  ]);
  assert.ok(r.ok, r.error ?? '');
  assert.deepEqual(endings(r.text), { crlf: 2, lf: 2 });
});

test('an ambiguous replacement fails multi_edit without writing', async () => {
  const r = await multi('x\r\ny\r\nx\r\ny\r\n', [{ old_string: 'x\ny', new_string: 'q' }]);
  assert.ok(!r.ok);
  assert.match(r.error ?? '', /appears 2 times/);
  assert.ok(!r.mutated, 'the whole multi_edit is rejected, leaving no partial result');
});

test('a later failing edit leaves no partial result from the earlier ones', async () => {
  const r = await multi('alpha\r\nbeta\r\n', [
    { old_string: 'alpha', new_string: 'ALPHA' },
    { old_string: 'does not exist', new_string: 'x' },
  ]);
  assert.ok(!r.ok);
  assert.equal(r.text, 'alpha\r\nbeta\r\n', 'the first replacement was not written either');
});

// ---------------------------------------------------------------------------
// The matcher itself
// ---------------------------------------------------------------------------

test('normalization maps every position back to its physical origin', () => {
  const { text, map } = normalizeForMatch('a\r\nb\nc');
  assert.equal(text, 'a\nb\nc');
  // 'a'=0, '\n'(from CRLF)=1, 'b'=3, '\n'=4, 'c'=5, sentinel=6
  assert.deepEqual(map, [0, 1, 3, 4, 5, 6]);
  assert.equal(map.length, text.length + 1, 'end sentinel present');
});

test('a match ending at EOF maps its exclusive end correctly', () => {
  const spans = findLogicalMatches('a\r\nb', 'a\nb');
  assert.deepEqual(spans, [{ start: 0, end: 4 }]);
});

test('splicing copies untouched regions verbatim', () => {
  const original = 'keep\r\nOLD\r\nkeep2\n';
  const spans = findLogicalMatches(original, 'OLD');
  const out = spliceSpans(original, spans, () => 'NEW');
  assert.equal(out, 'keep\r\nNEW\r\nkeep2\n');
});

test('applyStyle only restyles the replacement text', () => {
  assert.equal(applyStyle('one\ntwo', '\r\n'), 'one\r\ntwo');
  assert.equal(applyStyle('one\r\ntwo', '\n'), 'one\ntwo');
  assert.equal(applyStyle('nolines', '\r\n'), 'nolines');
});
