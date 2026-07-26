/**
 * Corpus of malformed tool arguments.
 *
 * Every case here is a shape that cheap models actually emit. This is the test
 * that decides whether forge is usable on GLM/Kimi/DeepSeek or just crashes at
 * them, so new failures observed in real use should be added here first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolArguments } from './json-repair.ts';

test('parses well-formed JSON without repairs', () => {
  const result = parseToolArguments('{"path":"src/index.ts","limit":50}');
  assert.equal(result.ok, true);
  assert.equal(result.repaired, false);
  assert.deepEqual(result.value, { path: 'src/index.ts', limit: 50 });
});

test('treats empty string as no arguments', () => {
  for (const raw of ['', '   ', '{}']) {
    const result = parseToolArguments(raw);
    assert.equal(result.ok, true, `failed on ${JSON.stringify(raw)}`);
    assert.deepEqual(result.value, {});
  }
});

test('strips a markdown code fence', () => {
  const result = parseToolArguments('```json\n{"path":"a.ts"}\n```');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { path: 'a.ts' });
});

test('extracts the object from surrounding prose', () => {
  const result = parseToolArguments('Sure! Here is the call: {"path":"a.ts"} Let me know.');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { path: 'a.ts' });
});

test('removes trailing commas', () => {
  const result = parseToolArguments('{"path":"a.ts","limit":10,}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { path: 'a.ts', limit: 10 });
});

test('converts Python literals', () => {
  const result = parseToolArguments('{"replace_all": True, "extra": None, "off": False}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { replace_all: true, extra: null, off: false });
});

test('does not corrupt Python literals that appear inside strings', () => {
  const result = parseToolArguments('{"content":"if x is None: return True"}');
  assert.equal(result.ok, true);
  assert.equal(result.value.content, 'if x is None: return True');
});

test('escapes raw newlines inside string values', () => {
  // Extremely common when a model inlines file content into `content`.
  const result = parseToolArguments('{"content":"line one\nline two"}');
  assert.equal(result.ok, true);
  assert.equal(result.value.content, 'line one\nline two');
});

test('completes an object truncated mid-string', () => {
  const result = parseToolArguments('{"path":"src/a.ts","content":"function foo() {');
  assert.equal(result.ok, true);
  assert.equal(result.value.path, 'src/a.ts');
});

test('completes a truncated object and drops a dangling key', () => {
  const result = parseToolArguments('{"path":"a.ts","old_string":');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { path: 'a.ts' });
});

test('completes truncated nested structures', () => {
  const result = parseToolArguments('{"edits":[{"old_string":"a","new_string":"b"},{"old_string"');
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.value.edits));
});

test('handles single-quoted payloads as a last resort', () => {
  const result = parseToolArguments("{'path': 'a.ts'}");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { path: 'a.ts' });
});

test('rejects a bare array — tool arguments are always an object', () => {
  const result = parseToolArguments('["a", "b"]');
  assert.equal(result.ok, false);
});

test('fails cleanly on unrecoverable junk, without throwing', () => {
  const result = parseToolArguments('I am not going to call a tool right now.');
  assert.equal(result.ok, false);
  assert.ok(result.error, 'an error message must be provided for the model to react to');
  assert.deepEqual(result.value, {}, 'value must still be a usable object');
});

test('reports which repair strategies were applied', () => {
  const result = parseToolArguments('```json\n{"a":1,}\n```');
  assert.equal(result.ok, true);
  assert.ok(result.strategies.includes('strip-code-fence'));
});

test('preserves unicode and escaped characters', () => {
  const result = parseToolArguments('{"content":"emoji ✅ and \\"quoted\\" text"}');
  assert.equal(result.ok, true);
  assert.equal(result.value.content, 'emoji ✅ and "quoted" text');
});
