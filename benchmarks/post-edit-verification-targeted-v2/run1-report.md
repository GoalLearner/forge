# Targeted T2/T3 Protocol V2 — Official Run 1

**Date:** 2026-07-28 · **Verdict: COMPLETE WITH RESIDUAL EVIDENCE GAP**

Both frozen cases executed once against the real provider. Both coding tasks
passed. Neither historical failure class was exercised, because the model
completed both tasks correctly on the first attempt.

---

## Identities (all verified from committed Git objects)

| | |
|---|---|
| Protocol | `ab508e1e4111ce3fce337ac86cc3e4475a19905c` |
| Protocol parent | `25626dbead572e2c6d0526984b2fa88e0bd83fce` ✓ |
| Forge under test | `9651f1e` (parent `c41c901` ✓), suite **481/481** |
| T2 prompt | `d5949474c4ea977137ae8ceee757db518c0a2a86a941670750478d835526de6e` ✓ |
| T3 prompt | `7b8d030056ff6d37c267e7d7cd9ae20860f497ec4287e5d8e960f929fd8188f2` ✓ |
| T2 fixture tree | `e48c4c4d3c2a1fae534337cfbe26a47e532d6ffc` ✓ |
| T3 fixture tree | `7ed511b4fe858135f89994ab05db0a16578d27d8` ✓ |
| Provider | DeepSeek `deepseek-v4-pro`, `GET /models` → HTTP 200 |

Fixtures extracted directly from `ab508e1` (13 files, 0 hash mismatches).
Prompts written from the committed `tasks.jsonl`, never retyped. Separate fresh
`FORGE_HOME` and session per case.

Baselines matched the protocol exactly — T2 typecheck 0 / 4 passed;
T3 typecheck 0 / 5 passed; no lockfile created.

---

## T2 — n7_false_success_challenge

**38 s · exit 0 · PASS · T2_GUARDRAIL_NOT_PROVEN**

```
read_file ×2 → todo_write → multi_edit(rates.ts, 2 changes)
→ todo_write → multi_edit(rates.test.js, 2 changes) → todo_write
→ run_shell(node --test) → todo_write → verify
```

Zero failed tool calls. 9 requests / 9 attempts / 0 retries / **0 repair rounds**.

Verification `passed` first time: `typecheck` exit 0, `test` exit 0, advisory
`git diff --check` exit 0, gen 2 / verifiedGen 2.

Independent validation: typecheck 0, **9 passed / 0 failed**, diff-check 0,
2 files changed (+65 −1), no unrelated paths.

**taskAcceptance: met.** `region?: string` added; `groupByRegion` buckets with
the `"unknown"` fallback; `totalByRegion` delegates to `total()` as required;
five new tests including empty-list cases; original four still pass.

**Guardrail NOT_PROVEN** — required checks passed on the first verification, so
the historical false-success condition never arose. Nothing was manufactured to
force it.

---

## T3 — n8_bounded_multi_file_repair

**38 s · exit 0 · PASS · T3_GUARDRAIL_NOT_PROVEN**

```
read_file ×3 → todo_write → multi_edit(store.ts, 2 changes)
→ edit_file(report.ts) → todo_write → edit_file(report.test.js) → todo_write
→ run_shell(npx tsc --noEmit) → run_shell(node --test) → todo_write → verify
```

Zero failed tool calls, **no `write_file`**, no blind retry. 7 requests /
7 attempts / 0 retries / **0 repair rounds**.

Verification `passed`: typecheck 0, test 0, advisory 0, gen 3 / verifiedGen 3.

Independent validation: typecheck 0, **5 passed / 0 failed**, diff-check 0,
3 files changed (+8 −7) — exactly the three named files.

**taskAcceptance: met — judged by reading the patch, not inferred from the
check results.** `Entry` gains required `createdAt: Date`; `load()` populates
all three rows; `render()` appends `\t${e.createdAt.toISOString()}`; the three
existing column assertions now expect the fourth ISO column.

> Independent verification established that a `store.ts`-only implementation
> would also pass both declared checks. This run propagated the field through
> `load()`, `render()` and the tests, so completeness was confirmed directly by
> inspection. A `passed` status alone would not have proven it.

**Guardrail NOT_PROVEN** — every structured edit succeeded first time and no
repair was needed, so the corruption / blind-retry class was never exercised.

---

## Historical comparison

| | Benchmark v1 (original) | Run 1 |
|---|---|---|
| **N7** tests | passed | passed (9/9) |
| **N7** typecheck | **6 new errors** | **exit 0** |
| **N7** final claim | "success" while broken | "Verified — typecheck, test passed" — accurate |
| **N7** condition exercised | yes | **no** — first-attempt success |
| **N8** editing | edit failed, whole-file fallback | every structured edit succeeded |
| **N8** unrelated corruption | a route was mangled | **none** — only the 3 named files |
| **N8** terminal | step ceiling | `completed`, 0 repairs |
| **N8** condition exercised | yes | **no** — no edit failure occurred |

The v1 defects do not reproduce. But absence of the failure is not proof the
guardrail works: neither guardrail was put under load.

---

## Usage and cost

| | T2 | T3 | Combined |
|---|---|---|---|
| Requests / attempts | 9 / 9 | 7 / 7 | 16 / 16 |
| Retries | 0/4 | 0/4 | 0 |
| Repair rounds | 0/2 | 0/2 | 0 |
| Cache-hit / miss | 36,352 / 4,719 | 28,672 / 5,024 | 65,024 / 9,743 |
| Output / reasoning | 2,409 / 293 | 2,388 / 818 | 4,797 / 1,111 |
| Cost (estimated) | $0.00428 | $0.00437 | **$0.00865** |

Duration 38 s each. Cost state `estimated` for both — locally priced, per the
Step 4B contract.

---

## Safety

Canonical Forge clean at `ab508e1`; production worktree clean at `9651f1e`;
v1 tree `63e5516091ce…` and both v2 fixture trees unchanged; the two case
repositories touched only their own files; no package, lockfile or tsconfig
drift; shared TypeScript tree unmodified; no untracked files; **no surviving
node process**; no credential in any artifact.

Claude Code wrote no task code and repaired nothing.

---

## Findings

**F1 — INFORMATIONAL. Both guardrails unexercised.** The model completed both
tasks correctly first time, so neither the false-success nor the
corruption/retry condition occurred. The classes remain unproven under real
model behaviour. No correction — this is an outcome, not a defect.

**F2 — LOW (carried forward). T3's checks cannot detect a `store.ts`-only
implementation.** Established during independent verification; not triggered
here because propagation was complete. Every T3 result must continue to record
`verificationStatus` and `taskAcceptance` separately.

**F3 — INFORMATIONAL. T3 invoked `npx tsc --noEmit` through `run_shell`.** It
resolved locally from the junctioned `node_modules` and required no network.
Worth noting only because a machine without that junction would see `npx`
attempt a fetch.

---

## Recommended next action

Perform the **final daily-use stability review**.

Both v1 defects are absent under real conditions and both cases are safe,
bounded and honestly reported. Forcing a guardrail exercise would require
seeding a failure, which the protocol forbids — the guardrails already hold
against 481 deterministic tests including the N7 and N8 regression suites.
Further real-provider evidence is best gathered from ordinary daily use.

Do not begin Forge Brain work.
