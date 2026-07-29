/**
 * Validation of the Phase-1 behavioral corpus (data at
 * benchmarks/brain-constitution-v1/cases.jsonl).
 *
 * These tests check the CORPUS DEFINITION — well-formed, balanced, and free of
 * anything it must not contain. They do NOT run a provider and do NOT test model
 * behavior; the constitution's real effect on DeepSeek is a separate
 * real-provider dogfood, deliberately out of scope in Phase 1.
 *
 * The corpus encodes the constitution's central claim in data: topic
 * sensitivity alone is never a Level 6, and full-answer cases outnumber
 * complete-refusal cases — a distribution impossible if the design were a topic
 * blocklist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isRefusalDecisionLevel, isRefusalAttribution } from './behavioral-constitution.ts';

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../benchmarks/brain-constitution-v1/cases.jsonl',
);

interface CorpusCase {
  caseId: string;
  category: string;
  prompt: string;
  expectedDecisionLevel: number;
  expectedSafeBehavior: string;
  forbiddenBehavior: string;
  notes: string;
  providerAttributionExpected?: string;
}

const raw = readFileSync(CORPUS, 'utf8').trim();
const lines = raw.split('\n');
const cases: CorpusCase[] = lines.map((l) => JSON.parse(l) as CorpusCase);

test('every line parses as JSON and the corpus is meaningful', () => {
  assert.equal(cases.length, lines.length);
  assert.ok(cases.length >= 12);
});

test('every case id is unique', () => {
  assert.equal(new Set(cases.map((c) => c.caseId)).size, cases.length);
});

test('every case has a valid decision level', () => {
  for (const c of cases) assert.ok(isRefusalDecisionLevel(c.expectedDecisionLevel), c.caseId);
});

test('all six decision levels are represented', () => {
  const levels = new Set(cases.map((c) => c.expectedDecisionLevel));
  for (const l of [1, 2, 3, 4, 5, 6]) assert.ok(levels.has(l), `level ${l}`);
});

test('full-answer cases outnumber complete-refusal cases', () => {
  const full = cases.filter((c) => c.expectedDecisionLevel === 1).length;
  const refuse = cases.filter((c) => c.expectedDecisionLevel === 6).length;
  assert.ok(full > refuse, `Level 1 (${full}) must exceed Level 6 (${refuse})`);
});

test('adult, political, religious, offensive and fictional categories each have a Level 1 example', () => {
  for (const cat of ['adult', 'political', 'religion', 'offensive', 'fiction']) {
    assert.ok(
      cases.some((c) => c.category === cat && c.expectedDecisionLevel === 1),
      `${cat} needs a Level 1 case — sensitivity is not refusal`,
    );
  }
});

test('every Level 6 case names a concrete severe-harm core', () => {
  const sixes = cases.filter((c) => c.expectedDecisionLevel === 6);
  assert.ok(sixes.length > 0);
  for (const c of sixes) {
    assert.match(
      c.notes,
      /(sexual_content_involving_minors|facilitating_serious_violence|facilitating_sexual_abuse|fraud_or_credential_theft|doxxing_or_targeted_privacy_invasion|malicious_system_compromise)/,
      `${c.caseId} must cite a concrete severe-harm category`,
    );
  }
});

test('no Level 6 is justified by topic sensitivity alone', () => {
  const topicOnly = new Set([
    'adult',
    'political',
    'religion',
    'offensive',
    'fiction',
    'drugs',
    'humor',
    'taboo',
    'unconventional',
  ]);
  for (const c of cases.filter((x) => x.expectedDecisionLevel === 6)) {
    assert.ok(!topicOnly.has(c.category), `${c.caseId}: topic alone must not be Level 6`);
  }
});

test('mixed requests are Level 5, never an automatic Level 6', () => {
  const mixed = cases.filter((c) => c.category === 'partial_refusal');
  assert.ok(mixed.length > 0);
  for (const c of mixed) assert.equal(c.expectedDecisionLevel, 5, c.caseId);
});

test('attribution values, when present, use only the defined vocabulary', () => {
  for (const c of cases) {
    if (c.providerAttributionExpected !== undefined) {
      assert.ok(isRefusalAttribution(c.providerAttributionExpected), c.caseId);
    }
  }
});

test('no fixture contains a credential, real target, or operational harm detail', () => {
  const forbidden = [
    /sk-[a-z0-9]{16,}/i,
    /password\s*[:=]\s*\S+/i,
    /BEGIN (RSA|OPENSSH) PRIVATE KEY/,
    /\b\d{16}\b/,
  ];
  for (const c of cases) {
    for (const re of forbidden) {
      assert.ok(!re.test(c.prompt), `${c.caseId}: no actionable secret/target`);
    }
    if (c.expectedDecisionLevel === 6) {
      assert.match(c.prompt, /^\[Placeholder:/, `${c.caseId}: severe-harm cores are placeholders`);
    }
  }
});

test('corpus ordering is deterministic across reads', () => {
  const second = readFileSync(CORPUS, 'utf8').trim().split('\n');
  assert.deepEqual(
    second.map((l) => (JSON.parse(l) as CorpusCase).caseId),
    cases.map((c) => c.caseId),
  );
});
