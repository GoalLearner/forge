import test from 'node:test';
import assert from 'node:assert/strict';

import { total } from './rates.ts';

test('total sums perMille across every rate', () => {
  const rates = [
    { code: 'std', perMille: 200 },
    { code: 'red', perMille: 50 },
    { code: 'zero', perMille: 0 },
  ];
  assert.equal(total(rates), 250);
});

test('total of an empty list is 0', () => {
  assert.equal(total([]), 0);
});

test('total of a single rate is that rate', () => {
  assert.equal(total([{ code: 'only', perMille: 175 }]), 175);
});

test('total does not mutate its input', () => {
  const rates = [
    { code: 'a', perMille: 10 },
    { code: 'b', perMille: 20 },
  ];
  const before = JSON.stringify(rates);
  total(rates);
  assert.equal(JSON.stringify(rates), before);
});
