# Targeted Post-Edit Verification Rerun v1 — PROTOCOL BLOCKED

**Date:** 2026-07-28 · **Status: NOT EXECUTED — no case ran, no result fabricated**

The blocker is different from last time. In the original attempt the environment
was unusable (`api.deepseek.com` unreachable). That is now fixed. This time the
environment is fully ready and the **frozen protocol artifact itself cannot
deterministically reconstruct the two fixtures**, so running it would mean
authoring the measurement conditions rather than reproducing them.

---

## Environment: ready

| | |
|---|---|
| Forge commit | `9651f1e fix: make structured edits line-ending tolerant` (parent `c41c901`) |
| Working tree | clean; no remote |
| typecheck / build | pass / pass |
| Full suite | **481 / 481**, 0 failures, no flake this run |
| Provider | DeepSeek — `GET /models` → **HTTP 200** |
| Models offered | `deepseek-v4-flash`, `deepseek-v4-pro` |

Nothing about the environment prevents execution. The original blocker is gone.

---

## Frozen protocol identity

Commit `25626db test: define targeted post-edit verification dogfood`, reachable
only from `bench/post-edit-verification-targeted-v1`. Not modified by this run.

| Artifact | SHA-256 |
|---|---|
| `protocol.md` | `2ffaa98dc924aa63f529027d3723a8af544f36b40adbf163652c59bb70502f20` |
| `tasks.jsonl` | `dabcc8c6aa192840bc2b80754d6b8e2f211fb44590839ad4b6b8dfc34c0e692c` |
| `summary.md` | `5ab9c9a55b4efe4c8d344b8f559d59fd3318bde310d5988a0e2aa177d52944bc` |
| `environment.md` | `313947a0a819b4a6b372125f6b0141c6cdc2bd1f9c79ac903fd9c4286f2e19db` |
| protocol dir tree | `63e5516091ce9bedb75f22904dddb4559fedf707` |

### Case naming

The protocol contains no cases literally named `N7` or `N8`. It defines
**T1–T4 plus O1**, and the mapping to the historical failure classes is stated
in the artifact's own `category` fields — not inferred:

- **T2** — `n7_false_success_challenge` → the N7 rerun
- **T3** — `n8_bounded_multi_file_repair` → the N8 rerun

### Exact prompts, extracted verbatim

Both prompts are complete in `tasks.jsonl` and were extracted, not rewritten.

| Case | Prompt SHA-256 |
|---|---|
| T2 | `d5949474c4ea977137ae8ceee757db518c0a2a86a941670750478d835526de6e` |
| T3 | `7b8d030056ff6d37c267e7d7cd9ae20860f497ec4287e5d8e960f929fd8188f2` |

---

## Why execution was blocked

Both scored cases target **synthetic fixtures that were never committed**. The
protocol describes them in prose under `fixtureSetup`; the actual seed files do
not exist anywhere.

Verified exhaustively:

- `environment.md` contains no fixture source (no `interface`, `export function`,
  `rates.ts`, `store.ts`, `report.ts` or fixture body anywhere in it)
- `results.jsonl` is **0 bytes**
- every `artifacts/*/NOT-EXECUTED.md` is a one-line stub
- `git ls-tree -r bench/post-edit-verification-targeted-v1` contains no fixture
  directory
- nothing remains on disk from the original blocked attempt

### What is under-determined

**T2** requires `src/rates.ts` exporting
`interface Rate { code: string; perMille: number }` and
`total(rs: Rate[]): number`. The interface is exact. **The body of `total()` and
the entire contents of `src/rates.test.js` are unspecified** — the protocol says
only "asserting total() behaviour, passing at baseline".

T2 measures whether a real model produces *passing tests alongside a failing
typecheck*. Under `strict: true`, whether that condition is even reachable
depends directly on the shape of the code the model is extending. Two operators
writing `total()` differently would produce two different experiments.

**T3** is less determined still. It requires `src/store.ts` with "an exported
`Entry` type" — **the fields of `Entry` are never stated**, and `Entry` is
precisely what the task mutates (`createdAt: Date` is added to it). The bodies
of `load()` and `render()`, and all of `src/report.test.js`, are unspecified.

### Why this is a stop, not a judgement call

Authoring those files would make me the author of the conditions the benchmark
measures. The point of the rerun is to reproduce two *specific historical
failure classes*; whether either is reachable is a direct function of the
fixture I would be inventing. A "closed" verdict obtained that way would be
unfalsifiable.

The protocol's own instruction is explicit: reconstructing a task from
incomplete artifacts is protocol drift, and a rerun that drifts cannot be
scored. `summary.md` asserts the cases are "executable as written" — that is
true of the prompts and false of the fixtures, and this run is the first time
anyone has tried to build them.

---

## What was NOT done

No worktree was created. No fixture was authored. No Forge session was started.
No provider completion was requested. **$0.00 spent** — a true zero; no request
was dispatched.

No result row, score, guardrail classification or failure-class closure is
claimed for T2 or T3.

---

## Repository safety

Canonical Forge clean at `9651f1e`; the frozen protocol branch untouched at
`25626db`; no target repository touched; no remote; nothing merged, pushed or
tagged.

---

## Smallest correction that unblocks this

Amend the frozen protocol **once**, on its own branch, to commit the actual
fixture seed files for T2 and T3 — `rates.ts`, `rates.test.js`, `store.ts`,
`report.ts`, `report.test.js`, `tsconfig.json`, `package.json` — with their
SHA-256 hashes recorded in `tasks.jsonl`.

That converts the fixtures from prose into frozen evidence, makes the rerun
reproducible by anyone, and changes no prompt, acceptance criterion or scoring
rule. Both prompts already hash cleanly and need no edit.

This is a deliberate, recorded amendment of an artifact that was never executed
— not a rewrite of a benchmark that produced results.
