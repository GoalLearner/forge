/**
 * Error classification tests.
 *
 * Two things matter here:
 *   1. Retrying the right things. Retrying a 400 wastes time and money on a
 *      request that is guaranteed to fail identically; NOT retrying a 429 makes
 *      forge fall over on the exact failure that is most expected.
 *   2. Producing an error a human can act on. Both SDKs flatten every network
 *      failure to "Connection error.", so the useful detail has to be dug out
 *      of a nested cause chain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHttpError, findErrorCode, findRootMessage } from './retry.ts';

test('retries rate limits and server errors', () => {
  for (const status of [408, 409, 429, 500, 502, 503, 529]) {
    const error = classifyHttpError({ status, message: 'boom' }, 'deepseek');
    assert.equal(error.opts.retryable, true, `status ${status} should be retryable`);
  }
});

test('does not retry client errors that will fail identically', () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const error = classifyHttpError({ status, message: 'nope' }, 'deepseek');
    assert.equal(error.opts.retryable, false, `status ${status} should not be retryable`);
  }
});

test('honours a Retry-After header', () => {
  const error = classifyHttpError(
    { status: 429, message: 'slow down', headers: { 'retry-after': '12' } },
    'moonshot',
  );
  assert.equal(error.opts.retryAfter, 12);
});

test('gives actionable hints for the common failures', () => {
  assert.match(classifyHttpError({ status: 401 }, 'zai').opts.hint ?? '', /API key/i);
  assert.match(classifyHttpError({ status: 404 }, 'deepseek').opts.hint ?? '', /Model IDs change/i);
  assert.match(classifyHttpError({ status: 413 }, 'zai').opts.hint ?? '', /clear/i);
});

test('a 402 says the key is fine and the balance is not', () => {
  // The most likely first-run failure on prepaid providers like DeepSeek, and
  // the one most easily misread as "my key is broken".
  const error = classifyHttpError({ status: 402, message: 'Insufficient Balance' }, 'deepseek');
  assert.equal(error.opts.retryable, false, 'retrying will not conjure credit');
  assert.match(error.opts.hint ?? '', /out of credit/i);
  assert.match(error.opts.hint ?? '', /key itself is valid/i);
});

test('finds a syscall code buried in a nested cause chain', () => {
  // The real shape of a refused connection from the OpenAI SDK.
  const wrapped = Object.assign(new Error('Connection error.'), {
    cause: Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:45999'), {
        code: 'ECONNREFUSED',
      }),
    }),
  });
  assert.equal(findErrorCode(wrapped), 'ECONNREFUSED');
});

test('descends into AggregateError.errors as well as cause', () => {
  const aggregate = Object.assign(new Error('all failed'), {
    errors: [Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' })],
  });
  assert.equal(findErrorCode(aggregate), 'ENOTFOUND');
});

test('survives a self-referential cause chain', () => {
  const looped: { cause?: unknown; message: string } = { message: 'loop' };
  looped.cause = looped;
  assert.equal(findErrorCode(looped), undefined, 'must terminate rather than hang');
});

test('extracts the deepest, most specific message', () => {
  const wrapped = Object.assign(new Error('Connection error.'), {
    cause: Object.assign(new TypeError('fetch failed'), {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:45999'),
    }),
  });
  assert.equal(findRootMessage(wrapped), 'connect ECONNREFUSED 127.0.0.1:45999');
});

test('a refused connection is retryable and explains itself', () => {
  const wrapped = Object.assign(new Error('Connection error.'), {
    cause: Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      }),
    }),
  });
  const error = classifyHttpError(wrapped, 'ollama');

  assert.equal(error.opts.retryable, true);
  assert.match(error.message, /ECONNREFUSED/, 'the root cause belongs in the message');
  assert.match(error.opts.hint ?? '', /listening/i);
  assert.match(error.opts.hint ?? '', /ollama serve/i, 'name the actual fix');
});

test('an unrecognized non-HTTP error is not retried', () => {
  const error = classifyHttpError(new TypeError('x.foo is not a function'), 'deepseek');
  assert.equal(error.opts.retryable, false, 'a bug in forge must not be retried four times');
});
