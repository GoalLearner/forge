/**
 * Session persistence tests.
 *
 * The subtle requirement being protected here: a resumed transcript must
 * serialize to the SAME BYTES as the in-memory one it replaces. If it doesn't,
 * `--continue` silently starts from a cold prompt cache and the first turn
 * costs up to 50x more than it should, with nothing visible to indicate it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore, repairDanglingToolCalls } from './store.ts';
import { stableStringify } from '../util/stable-json.ts';
import type { Message } from '../providers/types.ts';

// Point the database at a throwaway directory so tests never touch the
// developer's real ~/.forge/forge.db. Safe to do at module scope: nothing opens
// the database until a SessionStore is constructed inside a test.
process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), 'forge-db-'));

const CWD = 'C:/projects/demo';

test('creates and finds the latest session for a directory', () => {
  const store = new SessionStore();
  const first = store.create(CWD, 'deepseek/deepseek-v4-pro');
  const second = store.create(CWD, 'deepseek/deepseek-v4-pro');

  assert.notEqual(first, second);
  assert.equal(store.findLatest(CWD), second, '--continue must resume the most recent session');
  assert.equal(store.findLatest('C:/projects/elsewhere'), null);
  assert.ok(store.exists(first));
  assert.equal(store.exists('not-a-real-id'), false);
});

test('round-trips a transcript byte-for-byte', () => {
  const store = new SessionStore();
  const id = store.create(CWD, 'deepseek/deepseek-v4-pro');

  const original: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'fix the parser' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading it now.' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'edit_file',
          // Deliberately non-alphabetical key order: the serialization must not
          // depend on how the object happened to be built.
          input: { path: 'src/p.ts', old_string: 'a', new_string: 'b' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Edited (+1 -1).' }],
    },
  ];

  store.saveMessages(id, original);
  const loaded = store.loadMessages(id);

  assert.deepEqual(loaded, original);
  assert.equal(
    stableStringify(loaded),
    stableStringify(original),
    'a resumed transcript must serialize identically, or --continue starts from a cold cache',
  );
});

test('saving replaces the transcript rather than appending', () => {
  // The context guard rewrites history in place, so an append-only log would
  // drift out of sync with what is actually being sent.
  const store = new SessionStore();
  const id = store.create(CWD, 'm');

  store.saveMessages(id, [{ role: 'user', content: [{ type: 'text', text: 'one' }] }]);
  store.saveMessages(id, [
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
  ]);

  assert.equal(store.loadMessages(id).length, 2);
});

test('titles are set once from the first message', () => {
  const store = new SessionStore();
  const id = store.create(CWD, 'm');

  store.setTitleIfUnset(id, 'fix the failing parser test');
  store.setTitleIfUnset(id, 'something else entirely');

  const found = store.list(CWD, 10).find((s) => s.id === id);
  assert.equal(found?.title, 'fix the failing parser test', 'a stable name is more findable');
});

test('accumulates usage totals per session and per model', () => {
  const store = new SessionStore();
  const id = store.create(CWD, 'a/one');
  const entry = {
    provider: 'a',
    model: 'one',
    contextWindow: 1000,
    maxOutput: 100,
    pricing: { input: 1, cachedInput: 0.1, output: 2 },
    autoCache: true,
    subscription: false,
    local: false,
  };

  store.recordUsage(
    id,
    { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'a/one',
    entry,
  );
  store.recordUsage(
    id,
    { inputTokens: 0, cachedInputTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 },
    'a/one',
    entry,
  );

  const totals = store.totalsForSession(id);
  assert.equal(totals.requests, 2);
  assert.equal(totals.inputTokens, 1_000_000);
  assert.equal(totals.cachedInputTokens, 1_000_000);
  assert.ok(Math.abs(totals.cost - 1.1) < 1e-6, 'cached input must be priced at its own rate');
  assert.ok(Math.abs(totals.uncachedCost - 2) < 1e-6, 'the saving must be quantifiable');

  const byModel = store.totalsByModel(id);
  assert.equal(byModel.length, 1);
  assert.equal(byModel[0]?.modelKey, 'a/one');
});

test('pruneEmptySessions removes only old, message-less, usage-less rows', () => {
  const store = new SessionStore();
  const cwd = 'C:/projects/prune-test';

  // Old and empty — the launch debris this exists to remove.
  const debris = store.create(cwd, 'm');
  // Old but has a message — a real thread, must survive.
  const realThread = store.create(cwd, 'm');
  store.saveMessages(realThread, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  // Old, no messages, but has usage — money was spent, keep the record.
  const billed = store.create(cwd, 'm');
  store.recordUsage(
    billed,
    { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
    'a/one',
    {
      provider: 'a', model: 'one', contextWindow: 1000, maxOutput: 100,
      pricing: { input: 1, cachedInput: 0.1, output: 2 },
      autoCache: true, subscription: false, local: false,
    },
  );
  // Fresh and empty — could belong to a live frontend; the age guard protects it.
  const fresh = store.create(cwd, 'm');

  // Everything above was created "now"; prune with a zero threshold except we
  // need `fresh` to be newer than the cutoff. Backdate the first three.
  // (touch() sets updated_at to now, so we go through the db directly.)
  const db = (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
  const old = Date.now() - 60 * 60 * 1000;
  for (const id of [debris, realThread, billed]) {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(old, id);
  }

  const removed = store.pruneEmptySessions(10 * 60 * 1000);

  assert.ok(removed >= 1, 'the debris row must be counted');
  assert.equal(store.exists(debris), false, 'old empty row must be gone');
  assert.equal(store.exists(realThread), true, 'a thread with messages must survive');
  assert.equal(store.exists(billed), true, 'a session with recorded spend must survive');
  assert.equal(store.exists(fresh), true, 'a fresh empty row may belong to a live frontend');
});

test('pinned threads sort above more recent unpinned ones', () => {
  const store = new SessionStore();
  const cwd = 'C:/projects/pin-test';

  const older = store.create(cwd, 'm');
  store.saveMessages(older, [{ role: 'user', content: [{ type: 'text', text: 'old' }] }]);
  const newer = store.create(cwd, 'm');
  store.saveMessages(newer, [{ role: 'user', content: [{ type: 'text', text: 'new' }] }]);

  // Unpinned: newest first.
  assert.equal(store.list(cwd, 10)[0]?.id, newer);

  store.setPinned(older, true);
  const listed = store.list(cwd, 10);
  assert.equal(listed[0]?.id, older, 'a pin must outrank recency, not just tie-break it');
  assert.equal(listed[0]?.pinned, true);
  assert.equal(listed[1]?.pinned, false);

  store.setPinned(older, false);
  assert.equal(store.list(cwd, 10)[0]?.id, newer, 'unpinning restores recency order');
});

test('renaming overrides the auto-derived title and survives later messages', () => {
  const store = new SessionStore();
  const cwd = 'C:/projects/rename-test';
  const id = store.create(cwd, 'm');

  store.setTitleIfUnset(id, 'auto title from first message');
  store.renameSession(id, '  Parser   work  ');

  const find = () => store.list(cwd, 10).find((s) => s.id === id);
  assert.equal(find()?.title, 'Parser work', 'whitespace is normalized');

  // A later message must not clobber the explicit name.
  store.setTitleIfUnset(id, 'some other message');
  assert.equal(find()?.title, 'Parser work', 'setTitleIfUnset must not overwrite a rename');

  // Clearing returns the thread to auto-titling.
  store.renameSession(id, '   ');
  assert.equal(find()?.title, null);
  store.setTitleIfUnset(id, 'fresh auto title');
  assert.equal(find()?.title, 'fresh auto title');
});

test('archiving hides a thread from lists and auto-resume, keeping its data', () => {
  const store = new SessionStore();
  const cwd = 'C:/projects/archive-test';
  const id = store.create(cwd, 'm');
  store.saveMessages(id, [{ role: 'user', content: [{ type: 'text', text: 'keep me' }] }]);

  store.archiveSession(id);

  assert.equal(store.list(cwd, 10).some((s) => s.id === id), false, 'hidden from lists');
  assert.equal(store.findLatest(cwd), null, 'must not be silently auto-resumed by --continue');
  assert.equal(store.exists(id), true, 'the row survives');
  assert.equal(store.loadMessages(id).length, 1, 'the transcript survives');
});

test('archived threads are findable and restorable — archive is never a dead end', () => {
  const store = new SessionStore();
  const cwd = 'C:/projects/unarchive-test';
  const kept = store.create(cwd, 'm');
  store.saveMessages(kept, [{ role: 'user', content: [{ type: 'text', text: 'live' }] }]);
  const shelved = store.create(cwd, 'm');
  store.saveMessages(shelved, [{ role: 'user', content: [{ type: 'text', text: 'shelved' }] }]);

  store.archiveSession(shelved);

  // The archived shelf is its own view — the two lists never bleed together.
  const active = store.list(cwd, 10);
  const archived = store.list(cwd, 10, { archived: true });
  assert.deepEqual(active.map((s) => s.id), [kept]);
  assert.deepEqual(archived.map((s) => s.id), [shelved]);
  assert.equal(archived[0]?.archived, true);
  assert.equal(store.countArchived(cwd), 1, 'the count drives the "N archived" affordance');

  store.unarchiveSession(shelved);

  assert.equal(store.list(cwd, 10).length, 2, 'restored thread returns to the live list');
  assert.equal(store.list(cwd, 10, { archived: true }).length, 0);
  assert.equal(store.countArchived(cwd), 0);
  assert.equal(store.loadMessages(shelved).length, 1, 'the transcript came back intact');
});

test('deleting a thread removes its transcript but never its recorded spend', () => {
  const store = new SessionStore();
  const cwd = 'C:/projects/delete-test';
  const id = store.create(cwd, 'm');
  store.saveMessages(id, [{ role: 'user', content: [{ type: 'text', text: 'bye' }] }]);
  const entry = {
    provider: 'a', model: 'one', contextWindow: 1000, maxOutput: 100,
    pricing: { input: 1, cachedInput: 0.1, output: 2 },
    autoCache: true, subscription: false, local: false,
  };
  store.recordUsage(
    id,
    { inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    'a/one',
    entry,
  );
  const allTimeBefore = store.totalsAllTime();

  store.deleteSession(id);

  assert.equal(store.exists(id), false);
  assert.equal(store.loadMessages(id).length, 0, 'transcript gone');
  assert.equal(
    store.totalsAllTime().cost,
    allTimeBefore.cost,
    'deleting a thread must not make the cost report understate real spend',
  );
});

test('an empty session reports zeroes, not NaN', () => {
  const store = new SessionStore();
  const id = store.create(CWD, 'm');
  const totals = store.totalsForSession(id);
  assert.equal(totals.requests, 0);
  assert.equal(totals.cost, 0);
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

test('answers tool calls left dangling by a crash', () => {
  // If forge is killed between issuing tool calls and recording their results,
  // the transcript has a tool_use with no tool_result. Every provider rejects
  // that with a 400, so without this the session would be unresumable forever.
  const broken: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'orphan', name: 'read_file', input: { path: 'a.ts' } }],
    },
  ];

  const repaired = repairDanglingToolCalls(broken);
  const results = repaired.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');

  assert.equal(results.length, 1);
  assert.equal(results[0]?.type === 'tool_result' && results[0].tool_use_id, 'orphan');
  assert.equal(results[0]?.type === 'tool_result' && results[0].is_error, true);
});

test('leaves a well-formed transcript untouched', () => {
  const healthy: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: {} }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
  ];
  assert.equal(repairDanglingToolCalls(healthy), healthy);
});

test('a resumed transcript is always structurally valid', () => {
  const store = new SessionStore();
  const id = store.create(CWD, 'm');

  store.saveMessages(id, [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'orphan', name: 'glob', input: { pattern: '*' } }],
    },
  ]);

  const loaded = store.loadMessages(id);
  const uses = loaded.flatMap((m) => m.content).filter((b) => b.type === 'tool_use');
  const results = loaded.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
  assert.equal(uses.length, results.length, 'every tool_use must have a matching tool_result');
});
