import test from 'node:test';
import assert from 'node:assert/strict';

import { load } from './store.ts';
import { render } from './report.ts';

test('render emits one row per entry', () => {
  const out = render(load());
  assert.equal(out.split('\n').length, 3);
});

test('render emits id, label and amount for each row', () => {
  const rows = render(load()).split('\n');
  assert.deepEqual(rows[0].split('\t'), ['a1', 'Coffee', '350']);
  assert.deepEqual(rows[1].split('\t'), ['b2', 'Books', '1299']);
  assert.deepEqual(rows[2].split('\t'), ['c3', 'Transit', '275']);
});

test('render preserves the order load returned', () => {
  const ids = render(load())
    .split('\n')
    .map((row) => row.split('\t')[0]);
  assert.deepEqual(ids, ['a1', 'b2', 'c3']);
});

test('render of an empty list is an empty string', () => {
  assert.equal(render([]), '');
});

test('load returns three entries with positive amounts', () => {
  const entries = load();
  assert.equal(entries.length, 3);
  for (const e of entries) {
    assert.ok(e.amount > 0, `${e.id} should have a positive amount`);
  }
});
