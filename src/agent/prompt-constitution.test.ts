/**
 * How the constitution sits inside the frozen system prompt.
 *
 * The invariants under test are the ones that protect Forge's founding cost
 * thesis: the constitution must be in the stable prefix, before dynamic project
 * content, present exactly once, identical across every front end, and
 * byte-stable across builds. A regression here is a silent cache-cost
 * regression, not a visible bug.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, type PromptContext } from './prompt.ts';
import { CONSTITUTION_HEADING, BEHAVIORAL_CONSTITUTION_V1 } from './behavioral-constitution.ts';

const ctx = (over: Partial<PromptContext> = {}): PromptContext => ({
  cwd: 'C:/proj',
  shell: 'bash',
  isGitRepo: true,
  toolNames: ['read_file', 'edit_file', 'grep', 'shell'],
  permissionMode: 'auto-edit',
  ...over,
});

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('inclusion', () => {
  test('the constitution appears exactly once', () => {
    assert.equal(count(buildSystemPrompt(ctx()), CONSTITUTION_HEADING), 1);
  });

  test('the full constitution text is present verbatim', () => {
    assert.ok(buildSystemPrompt(ctx()).includes(BEHAVIORAL_CONSTITUTION_V1));
  });

  test('off omits it entirely', () => {
    const off = buildSystemPrompt(ctx({ constitution: 'off' }));
    assert.equal(count(off, CONSTITUTION_HEADING), 0);
  });

  test('projectDoc does not duplicate the constitution', () => {
    const withDoc = buildSystemPrompt(ctx({ projectDoc: 'Use tabs. Run npm test.' }));
    assert.equal(count(withDoc, CONSTITUTION_HEADING), 1);
  });
});

describe('ordering', () => {
  test('the constitution sits after the identity line and before # Approach', () => {
    const p = buildSystemPrompt(ctx());
    const identity = p.indexOf('You are forge');
    const con = p.indexOf(CONSTITUTION_HEADING);
    const approach = p.indexOf('# Approach');
    assert.ok(identity < con, 'after identity');
    assert.ok(con < approach, 'before the approach section');
  });

  test('the constitution appears before dynamic projectDoc', () => {
    const p = buildSystemPrompt(ctx({ projectDoc: 'PROJECT_DOC_MARKER' }));
    assert.ok(
      p.indexOf(CONSTITUTION_HEADING) < p.indexOf('PROJECT_DOC_MARKER'),
      'constitution must be in the stable prefix ahead of project-specific content',
    );
  });

  test('tool listing and environment order are unchanged by the constitution', () => {
    const on = buildSystemPrompt(ctx());
    const off = buildSystemPrompt(ctx({ constitution: 'off' }));
    // Removing the constitution must leave every other section in the same
    // relative order — the constitution is purely additive.
    for (const section of ['# Approach', '# Tools', '# Communication', '# Environment']) {
      assert.ok(on.includes(section) && off.includes(section));
    }
    assert.equal(
      on.replace(BEHAVIORAL_CONSTITUTION_V1 + '\n\n', ''),
      off,
      'the only difference is the inserted constitution block',
    );
  });
});

describe('stability', () => {
  test('two builds with equal inputs are byte-identical', () => {
    assert.equal(buildSystemPrompt(ctx()), buildSystemPrompt(ctx()));
  });

  test('different PromptContext objects with equal values yield equal prefixes', () => {
    const a = buildSystemPrompt(ctx());
    const b = buildSystemPrompt(ctx());
    assert.equal(Buffer.byteLength(a, 'utf8'), Buffer.byteLength(b, 'utf8'));
    assert.equal(a, b);
  });

  test('the constitution contains no timestamp, path, random value or provider name', () => {
    const c = BEHAVIORAL_CONSTITUTION_V1;
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(c), 'no date');
    assert.ok(!/[A-Za-z]:[\\/]/.test(c), 'no path');
    assert.ok(!/deepseek|anthropic|openai|gpt|claude/i.test(c), 'no provider name');
    assert.ok(!/\b[0-9a-f]{8,}\b/i.test(c), 'no hash-like token');
  });

  test('the project profile does not perturb the constitution or its position', () => {
    // Phase 2 inserts a static project profile after Environment, before projectDoc.
    // It must leave the constitution byte-identical and still sit before the profile.
    const profileBlock = '# Project profile\n\nfacts here';
    const withProfile = buildSystemPrompt(ctx({ projectProfile: profileBlock }));
    const off = buildSystemPrompt(ctx());
    assert.ok(withProfile.includes(BEHAVIORAL_CONSTITUTION_V1), 'constitution intact with profile');
    assert.ok(
      withProfile.indexOf(CONSTITUTION_HEADING) < withProfile.indexOf('# Project profile'),
      'constitution precedes the profile',
    );
    // Removing the profile block restores the exact off-mode prompt.
    assert.equal(withProfile.replace('\n\n' + profileBlock, ''), off);
  });

  test('constitution is independent of cwd, shell, git and permission mode', () => {
    const base = buildSystemPrompt(ctx());
    const varied = buildSystemPrompt(
      ctx({ cwd: 'D:/other', shell: 'powershell', isGitRepo: false, permissionMode: 'yolo' }),
    );
    const extract = (p: string): string => {
      const start = p.indexOf(CONSTITUTION_HEADING);
      return p.slice(start, start + BEHAVIORAL_CONSTITUTION_V1.length);
    };
    assert.equal(extract(base), extract(varied), 'the constitution block never varies with environment');
  });
});
