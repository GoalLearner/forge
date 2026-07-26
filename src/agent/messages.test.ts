/**
 * The regression test that protects the cost model.
 *
 * If the cached prompt prefix changes between turns, every request is billed at
 * the uncached rate — up to 50x more on DeepSeek V4 Flash, with no error, no
 * warning, and no visible symptom other than the bill. That failure is easy to
 * introduce (one interpolated timestamp, one reordered tool) and nearly
 * impossible to notice by eye, so it gets an explicit test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Conversation } from './messages.ts';
import { toChatMessages } from '../providers/openai.ts';
import { stableStringify } from '../util/stable-json.ts';
import type { ModelEntry } from '../config/schema.ts';
import type { ToolSchema } from '../providers/types.ts';

const TOOLS: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'edit_file',
    description: 'Edit a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

const CHEAP_MODEL: ModelEntry = {
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  contextWindow: 1_000_000,
  maxOutput: 8192,
  pricing: { input: 0.435, cachedInput: 0.003625, output: 0.87 },
  autoCache: true,
  subscription: false,
  local: false,
};

const ANTHROPIC_MODEL: ModelEntry = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  contextWindow: 1_000_000,
  maxOutput: 8192,
  pricing: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  autoCache: false,
  minCacheable: 512,
  subscription: false,
  local: false,
};

function makeConversation(): Conversation {
  return new Conversation({ system: 'You are forge. Be concise.', tools: TOOLS });
}

// ---------------------------------------------------------------------------

test('the prefix fingerprint is stable as the conversation grows', () => {
  const conversation = makeConversation();
  const initial = conversation.prefixFingerprint();

  conversation.addUserText('fix the bug');
  conversation.addAssistant([
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
  ]);
  conversation.addToolResults([{ type: 'tool_result', tool_use_id: 'c1', content: 'contents' }]);
  conversation.addUserText('now the other one');

  assert.equal(
    conversation.prefixFingerprint(),
    initial,
    'system + tools must not change once a session has started',
  );
});

test('tool registration order does not affect the prefix', () => {
  const forward = new Conversation({ system: 'S', tools: TOOLS });
  const reversed = new Conversation({ system: 'S', tools: [...TOOLS].reverse() });

  assert.equal(
    forward.prefixFingerprint(),
    reversed.prefixFingerprint(),
    'tools render at position 0; unstable ordering would invalidate the whole cache',
  );
});

test('serialized request prefix is byte-identical across turns', () => {
  const conversation = makeConversation();
  const signal = new AbortController().signal;

  conversation.addUserText('first request');
  const turnOne = conversation.buildRequest(CHEAP_MODEL, 4096, signal);
  const turnOneWire = toChatMessages(turnOne.system, [...turnOne.messages]);

  // Simulate a full tool round-trip, then a second user turn.
  conversation.addAssistant([
    { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
  ]);
  conversation.addToolResults([{ type: 'tool_result', tool_use_id: 'c1', content: 'body' }]);
  conversation.addUserText('second request');

  const turnTwo = conversation.buildRequest(CHEAP_MODEL, 4096, signal);
  const turnTwoWire = toChatMessages(turnTwo.system, [...turnTwo.messages]);

  assert.equal(turnOne.system, turnTwo.system, 'system prompt must be frozen');
  assert.deepEqual(turnOne.tools, turnTwo.tools, 'tool list must be frozen');

  // The real requirement: turn two's wire payload must literally *begin with*
  // turn one's. That is what "prefix cache hit" means at the byte level.
  assert.ok(turnTwoWire.length > turnOneWire.length, 'turn two should have grown');
  assert.equal(
    stableStringify(turnTwoWire.slice(0, turnOneWire.length)),
    stableStringify(turnOneWire),
    'the shared prefix must be byte-identical, or every turn is billed uncached',
  );
});

test('a built request snapshots the transcript rather than aliasing it', () => {
  // A request that keeps changing after it is built makes retries and cache
  // reasoning unsound — it no longer describes what was actually sent.
  const conversation = makeConversation();
  conversation.addUserText('one');
  const request = conversation.buildRequest(CHEAP_MODEL, 4096, new AbortController().signal);
  const lengthAtBuild = request.messages.length;

  conversation.addUserText('two');
  assert.equal(request.messages.length, lengthAtBuild);
});

test('tool_use arguments serialize identically regardless of key insertion order', () => {
  // A tool call replayed from SQLite can rebuild its input object with a
  // different key order than the in-memory original. Without stable
  // serialization, `forge --resume` would silently start from a cold cache.
  const a = { path: 'a.ts', old_string: 'x', new_string: 'y' };
  const b = { new_string: 'y', path: 'a.ts', old_string: 'x' };
  assert.equal(stableStringify(a), stableStringify(b));
});

test('auto-cache providers receive no cache_control hints', () => {
  const conversation = makeConversation();
  conversation.addUserText('hi');
  conversation.addAssistant([{ type: 'text', text: 'hello' }]);

  const request = conversation.buildRequest(CHEAP_MODEL, 4096, new AbortController().signal);
  assert.equal(request.cacheHints.cacheSystem, false);
  assert.equal(request.cacheHints.cacheMessageIndex, null);
});

test('Anthropic gets a system breakpoint plus a rolling one', () => {
  // The system prompt has to clear the model's minimum cacheable prefix
  // (512 tokens for Opus 5) or the breakpoint is silently a no-op.
  const conversation = new Conversation({ system: 'x'.repeat(4000), tools: TOOLS });
  conversation.addUserText('hi');
  conversation.addAssistant([{ type: 'text', text: 'hello' }]);

  const request = conversation.buildRequest(ANTHROPIC_MODEL, 4096, new AbortController().signal);
  assert.equal(request.cacheHints.cacheSystem, true);
  assert.equal(request.cacheHints.cacheMessageIndex, 1, 'rolling breakpoint sits on the newest turn');
});

test('Anthropic skips the breakpoint when the prefix is too short to cache', () => {
  const conversation = new Conversation({ system: 'short', tools: [] });
  conversation.addUserText('hi');
  conversation.addAssistant([{ type: 'text', text: 'hello' }]);

  const request = conversation.buildRequest(ANTHROPIC_MODEL, 4096, new AbortController().signal);
  assert.equal(
    request.cacheHints.cacheSystem,
    false,
    'a marker below minCacheable does nothing but must not be sent as if it worked',
  );
});

test('switching models is reported so the user knows the cache reset', () => {
  const conversation = makeConversation();
  assert.equal(conversation.noteModel('deepseek/deepseek-v4-pro'), false, 'first call is not a switch');
  assert.equal(conversation.noteModel('deepseek/deepseek-v4-pro'), false, 'same model is not a switch');
  assert.equal(conversation.noteModel('anthropic/claude-opus-5'), true, 'model change must be reported');
});

test('parallel tool results are grouped into one message', () => {
  const conversation = makeConversation();
  conversation.addAssistant([
    { type: 'tool_use', id: 'a', name: 'read_file', input: { path: '1.ts' } },
    { type: 'tool_use', id: 'b', name: 'read_file', input: { path: '2.ts' } },
  ]);
  conversation.addToolResults([
    { type: 'tool_result', tool_use_id: 'a', content: 'one' },
    { type: 'tool_result', tool_use_id: 'b', content: 'two' },
  ]);

  const userTurns = conversation.messages.filter((m) => m.role === 'user');
  assert.equal(userTurns.length, 1, 'splitting results trains models out of parallel tool use');
  assert.equal(userTurns[0]?.content.length, 2);
});
