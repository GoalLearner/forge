/**
 * Checkpoint tests — the backend contract for per-file revert in the UI.
 *
 * The property that matters most: `before` is the state at forge's FIRST
 * touch, so any number of forge edits revert in one step to what the user
 * last had — not to an intermediate forge state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Checkpoints } from './checkpoints.ts';

function makeProject(): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-ckpt-'));
  const file = join(cwd, 'src', 'a.ts');
  writeFileSync(join(cwd, 'plain.txt'), 'root\n');
  return { cwd, file };
}

function write(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
}

test('revert returns a file to its pre-forge state across multiple edits', () => {
  const { cwd } = makeProject();
  const file = join(cwd, 'plain.txt');
  const checkpoints = new Checkpoints(cwd);

  // Simulate three forge edits, each snapshotting before the write.
  checkpoints.snapshot(file);
  write(file, 'edit one\n');
  checkpoints.snapshot(file);
  write(file, 'edit two\n');
  checkpoints.snapshot(file);
  write(file, 'edit three\n');

  checkpoints.revert(file);
  assert.equal(readFileSync(file, 'utf8'), 'root\n', 'must restore the USER state, not edit two');
});

test('restore re-applies the forge content after a revert', () => {
  const { cwd } = makeProject();
  const file = join(cwd, 'plain.txt');
  const checkpoints = new Checkpoints(cwd);

  checkpoints.snapshot(file);
  write(file, 'forge version\n');

  checkpoints.revert(file);
  assert.equal(readFileSync(file, 'utf8'), 'root\n');

  checkpoints.restore(file);
  assert.equal(readFileSync(file, 'utf8'), 'forge version\n');
});

test('reverting a forge-created file deletes it; restore recreates it', () => {
  const { cwd } = makeProject();
  const checkpoints = new Checkpoints(cwd);

  mkdirSync(join(cwd, 'src2'), { recursive: true });
  const created = join(cwd, 'src2', 'new.ts');
  checkpoints.snapshot(created); // does not exist yet -> before = null
  write(created, 'export {};\n');

  checkpoints.revert(created);
  assert.equal(existsSync(created), false, 'a file forge created should not survive its revert');

  checkpoints.restore(created);
  assert.equal(readFileSync(created, 'utf8'), 'export {};\n');
});

test('listChanges reports status, counts, and skips net-unchanged files', () => {
  const { cwd } = makeProject();
  const existing = join(cwd, 'plain.txt');
  const fresh = join(cwd, 'new.txt');
  const untouchedLooking = join(cwd, 'same.txt');
  write(untouchedLooking, 'stable\n');

  const checkpoints = new Checkpoints(cwd);

  checkpoints.snapshot(existing);
  write(existing, 'root\nplus a line\n');

  checkpoints.snapshot(fresh);
  write(fresh, 'hello\n');

  // Touched, then written back to identical content — must not be listed.
  checkpoints.snapshot(untouchedLooking);
  write(untouchedLooking, 'stable\n');

  const changes = checkpoints.listChanges();
  assert.deepEqual(
    changes.map((c) => [c.display, c.status]),
    [
      ['new.txt', 'created'],
      ['plain.txt', 'edited'],
    ],
  );

  const edited = changes.find((c) => c.display === 'plain.txt');
  assert.ok(edited && edited.added >= 1, 'diff counts must be populated');
  assert.match(edited.patch, /plus a line/);

  const totals = checkpoints.totals();
  assert.equal(totals.files, 2);
});

test('a reverted file stays listed with its diff, and revert is idempotent', () => {
  const { cwd } = makeProject();
  const file = join(cwd, 'plain.txt');
  const checkpoints = new Checkpoints(cwd);

  checkpoints.snapshot(file);
  write(file, 'forge content\n');
  checkpoints.revert(file);
  checkpoints.revert(file); // second call must be a no-op, not a stash of the reverted state

  const changes = checkpoints.listChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.status, 'reverted');
  assert.match(changes[0]?.patch ?? '', /forge content/, 'diff kept for reference after revert');

  checkpoints.restore(file);
  assert.equal(readFileSync(file, 'utf8'), 'forge content\n', 'stash must survive the double revert');
});

test('commitablePaths excludes reverted files; clear empties the set', () => {
  const { cwd } = makeProject();
  const keep = join(cwd, 'plain.txt');
  const drop = join(cwd, 'other.txt');
  write(drop, 'orig\n');

  const checkpoints = new Checkpoints(cwd);
  checkpoints.snapshot(keep);
  write(keep, 'keep me\n');
  checkpoints.snapshot(drop);
  write(drop, 'drop me\n');
  checkpoints.revert(drop);

  assert.deepEqual(checkpoints.commitablePaths(), [keep]);

  checkpoints.clear();
  assert.equal(checkpoints.listChanges().length, 0);
});
