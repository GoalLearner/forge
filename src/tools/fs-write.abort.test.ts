/**
 * Abort-aware writes.
 *
 * supersede() waits for an in-flight tool to return, but it should not have to
 * wait through work that is now pointless — and nothing new should touch the
 * disk after the user hit Stop or switched threads. These assert that a
 * cancelled run starts no further filesystem mutation, and that a rejected
 * write leaves the file exactly as it was.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileTool, editFileTool, multiEditTool } from './fs-write.ts';
import { ConfigSchema } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import { PathJail } from '../safety/paths.ts';
import { AbortedError } from '../providers/types.ts';
import type { ToolContext } from './types.ts';

const ORIGINAL = 'alpha\nbravo\ncharlie\n';

function makeCtx(aborted: boolean): { ctx: ToolContext; cwd: string } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'forge-abort-')));
  writeFileSync(join(cwd, 'notes.txt'), ORIGINAL, 'utf8');

  const controller = new AbortController();
  if (aborted) controller.abort();

  const files = new FileTracker();
  // Satisfy read-before-write so the abort check is what fails, not the guard.
  files.markRead(new PathJail({ root: cwd }).resolve('notes.txt', 'write'));

  return {
    cwd,
    ctx: {
      cwd,
      config: ConfigSchema.parse({ permissions: { mode: 'yolo' } }),
      signal: controller.signal,
      permissions: new PermissionManager('yolo', cwd),
      files,
    },
  };
}

test('write_file refuses to start once the run is aborted', async () => {
  const { ctx, cwd } = makeCtx(true);

  await assert.rejects(
    () => writeFileTool.execute({ path: 'notes.txt', content: 'REPLACED' }, ctx),
    AbortedError,
  );

  assert.equal(readFileSync(join(cwd, 'notes.txt'), 'utf8'), ORIGINAL, 'file must be untouched');
});

test('write_file creates nothing when aborted', async () => {
  const { ctx, cwd } = makeCtx(true);

  await assert.rejects(
    () => writeFileTool.execute({ path: 'brand-new.txt', content: 'hello' }, ctx),
    AbortedError,
  );

  assert.equal(existsSync(join(cwd, 'brand-new.txt')), false, 'no partial file may be left behind');
});

test('edit_file refuses to start once the run is aborted', async () => {
  const { ctx, cwd } = makeCtx(true);

  await assert.rejects(
    () => editFileTool.execute({ path: 'notes.txt', old_string: 'bravo', new_string: 'DELTA' }, ctx),
    AbortedError,
  );

  assert.equal(readFileSync(join(cwd, 'notes.txt'), 'utf8'), ORIGINAL);
});

test('multi_edit stops between edits and writes nothing', async () => {
  const { ctx, cwd } = makeCtx(true);

  await assert.rejects(
    () =>
      multiEditTool.execute(
        {
          path: 'notes.txt',
          edits: [
            { old_string: 'alpha', new_string: 'ONE' },
            { old_string: 'bravo', new_string: 'TWO' },
            { old_string: 'charlie', new_string: 'THREE' },
          ],
        },
        ctx,
      ),
    AbortedError,
  );

  assert.equal(
    readFileSync(join(cwd, 'notes.txt'), 'utf8'),
    ORIGINAL,
    'a partially applied multi-edit is worse than none',
  );
});

test('a mid-batch abort applies none of the edits', async () => {
  // The signal flips after the batch has begun, mimicking a thread switch
  // landing between edits. Nothing has touched disk yet at that point, so the
  // correct outcome is to abandon the whole batch.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'forge-abort-')));
  writeFileSync(join(cwd, 'notes.txt'), ORIGINAL, 'utf8');

  const controller = new AbortController();
  const files = new FileTracker();
  files.markRead(new PathJail({ root: cwd }).resolve('notes.txt', 'write'));

  let checks = 0;
  const signal = new Proxy(controller.signal, {
    get(target, prop, receiver) {
      if (prop === 'aborted') {
        checks += 1;
        // Allow the first edit, then cancel.
        return checks > 1;
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

  const ctx: ToolContext = {
    cwd,
    config: ConfigSchema.parse({ permissions: { mode: 'yolo' } }),
    signal: signal as AbortSignal,
    permissions: new PermissionManager('yolo', cwd),
    files,
  };

  await assert.rejects(
    () =>
      multiEditTool.execute(
        {
          path: 'notes.txt',
          edits: [
            { old_string: 'alpha', new_string: 'ONE' },
            { old_string: 'bravo', new_string: 'TWO' },
          ],
        },
        ctx,
      ),
    AbortedError,
  );

  assert.equal(readFileSync(join(cwd, 'notes.txt'), 'utf8'), ORIGINAL);
});

test('writes still work normally when the run is not aborted', async () => {
  const { ctx, cwd } = makeCtx(false);

  const result = await editFileTool.execute(
    { path: 'notes.txt', old_string: 'bravo', new_string: 'DELTA' },
    ctx,
  );

  assert.equal(result.isError ?? false, false);
  assert.match(readFileSync(join(cwd, 'notes.txt'), 'utf8'), /DELTA/);
});
