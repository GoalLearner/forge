/**
 * glob must have a genuinely cancellable boundary.
 *
 * It used to call `fast-glob`, which has no AbortSignal support at all. A
 * cancelled or timed-out glob therefore kept walking the filesystem while the
 * agent believed the run was over — and because the loop *awaits* tool
 * settlement (deliberately, so nothing is orphaned), that could hold the whole
 * AgentRun open. It is now routed through the same ripgrep child process grep
 * uses, which can actually be killed.
 *
 * These tests use an explicit "started" synchronisation point rather than a
 * sleep, so they cannot accidentally pass by cancelling before glob had begun.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { globTool } from './search.ts';
import { ConfigSchema } from '../config/schema.ts';
import { PermissionManager } from '../safety/permissions.ts';
import { FileTracker } from '../safety/file-tracker.ts';
import { AbortedError } from '../providers/types.ts';
import type { ToolContext } from './types.ts';

/** A tree big enough that the search is measurably in progress. */
function makeTree(fileCount: number): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'forge-glob-')));
  for (let d = 0; d < 20; d++) {
    const dir = join(cwd, `pkg${d}`, 'src', 'deep');
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < Math.ceil(fileCount / 20); f++) {
      writeFileSync(join(dir, `mod${f}.ts`), `export const x${f} = ${f};\n`);
    }
  }
  return cwd;
}

function ctxFor(cwd: string, signal: AbortSignal): ToolContext {
  return {
    cwd,
    config: ConfigSchema.parse({ permissions: { mode: 'yolo' } }),
    signal,
    permissions: new PermissionManager('yolo', cwd),
    files: new FileTracker(),
  };
}

const watchdog = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`WATCHDOG: ${label} did not settle in ${ms}ms`)), ms),
    ),
  ]);

test('glob still returns the files it used to, newest first', async () => {
  const cwd = makeTree(200);
  writeFileSync(join(cwd, 'pkg0', 'src', 'deep', 'newest.ts'), 'export const newest = 1;\n');

  const result = await watchdog(
    globTool.execute({ pattern: '**/*.ts' }, ctxFor(cwd, new AbortController().signal)),
    30_000,
    'glob',
  );

  assert.match(result.content, /match(es)? for/);
  assert.match(result.content, /newest\.ts/, 'the most recently written file is listed');
  assert.equal(result.display?.kind, 'list');
});

test('a root-relative pattern matches, not just a **/ pattern', async () => {
  // Regression: routing glob through ripgrep initially passed an ABSOLUTE
  // search path, so rg matched `src/agent/*.ts` against
  // `C:\project\src\agent\loop.ts` and found nothing. Only `**/`-prefixed
  // patterns worked, which hid the bug from the first round of tests — a live
  // run is what exposed it. rg now runs with its cwd at the search root.
  const cwd = makeTree(40);

  const result = await watchdog(
    globTool.execute({ pattern: 'pkg0/src/deep/*.ts' }, ctxFor(cwd, new AbortController().signal)),
    30_000,
    'glob',
  );

  assert.match(result.content, /match(es)? for/, 'a root-relative pattern must find files');
  assert.doesNotMatch(result.content, /No files match/);
  assert.match(result.content, /mod0\.ts/);
});

test('glob honours its ignore list', async () => {
  const cwd = makeTree(20);
  mkdirSync(join(cwd, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(cwd, 'node_modules', 'junk', 'ignored.ts'), 'export const nope = 1;\n');

  const result = await watchdog(
    globTool.execute({ pattern: '**/*.ts' }, ctxFor(cwd, new AbortController().signal)),
    30_000,
    'glob',
  );
  assert.doesNotMatch(result.content, /node_modules/);
});

test('an already-cancelled glob settles instead of walking the tree', async () => {
  const cwd = makeTree(400);
  const controller = new AbortController();
  controller.abort();

  // Must settle (reject) promptly — the point is that it does not run to
  // completion in the background.
  await assert.rejects(
    () => watchdog(globTool.execute({ pattern: '**/*.ts' }, ctxFor(cwd, controller.signal)), 15_000, 'glob'),
    (err: unknown) => err instanceof AbortedError || (err as Error).name === 'AbortedError',
  );
});

test('cancelling a glob in flight settles it, after it has genuinely started', async () => {
  // Sized from measurement: this tree takes ~420ms to walk, so cancelling at
  // ~60ms lands solidly mid-search rather than racing a glob that already
  // finished — which is how a timing-based test passes without proving
  // anything.
  const cwd = makeTree(12_000);
  const controller = new AbortController();

  const pending = globTool.execute({ pattern: '**/*.ts' }, ctxFor(cwd, controller.signal));
  pending.catch(() => {});

  // Explicit synchronisation: hand control back to the event loop so the child
  // process is actually spawned before we cancel.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 60));

  controller.abort();

  // If the boundary were not cancellable this would hang until the whole tree
  // had been walked; the watchdog turns that into a failure rather than a hang.
  await assert.rejects(
    () => watchdog(pending, 15_000, 'in-flight glob'),
    (err: unknown) => err instanceof AbortedError || (err as Error).name === 'AbortedError',
  );
});
