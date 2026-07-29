# Forge Brain Phase 2 — Static Project Profile V1 — Findings Closure

**Status: PHASE 2 CLOSED WITH ACCEPTED LIMITATIONS** (2026-07-29).

Evidence chain (all parents verified from Git): implementation `9ce342e58e56ac23e7c3722d45f317862b05c9df`
(independently verified, 582/582) → dogfood protocol `070a3b75887c2c7f3ff35e610241890afd51aff3`
(frozen, unmodified) → results `54cd424eac179878ff3cec6fca461e9e2ed589a3` → evidence tip
`54ef2cec012d17b11060714cf35e0cd3cd8ac654` (8 additive tool-sequence artifacts only).
This document records the closure; it modifies no evidence and no source.

## What was shipped

A deterministic, session-static, read-only project profile in the frozen system prefix:
package manager (canonical, shared with the verification gate), declared checks (byte-equal
to `buildVerificationPlan`), config signals, source/test roots, project-doc names, and
labeled nested-package candidates — hard-capped at 2,048 bytes, injection-sanitized,
fingerprinted, off-switchable to a byte-identical baseline prompt. No persistence, no
selection, no model judgment.

## What the dogfood proved (recomputed from committed evidence at closure)

8/8 scored runs completed (4 fixtures × 2 arms, deepseek-v4-pro, no preflight completion):

- **Correctness/safety:** acceptance 4/4 vs 4/4; verification passed on all declared-check
  fixtures in both arms; honest verification-unavailable on P4 in both arms; changed paths
  permitted-only in 8/8; repair rounds 0; zero whole-file fallbacks; attempts == ledger
  rows 8/8; **zero profile-misled incidents** (no wrong manager/check/root, no fabricated
  fact, no staleness misuse).
- **Process value:** project-fact rediscovery reads **4 → 1**; provider attempts **28 → 20**;
  first useful edit earlier in **4/4** pairs (median 18.0s → 12.0s); tool calls before the
  first useful edit down in 3/4; irrelevant reads 0 vs 0. The designed P2 discriminator hit:
  the treatment used the profiled qualified `test:unit` proactively, where control needed a
  glob + a package.json read to discover it.
- **Cost:** total $0.01395 → $0.01195; median cost −8.2%; median wall-clock −17.6%;
  ms/output-token −10.3%. Cache: **no material regression** (below).

## Cache interpretation (corrected wording)

The run-report phrase "cross-run prefix caching is nil" was an overstatement. Precisely:
the ledgers show substantial caching in both arms — 84.0% (control) and 79.7% (treatment)
of input tokens were cache hits — dominated by **within-run attempt-level reuse** of each
run's own prefix. **Complete**-prefix reuse across runs was impossible in both arms because
the Environment block embeds the per-run cwd; bytes **before** the cwd line (identity,
constitution, approach/tools sections) may still have cached partially across runs — the
ledger cannot separate that contribution. Treatment's warm-state ratio was 4.6pp lower with
fewer attempts amortizing its first-attempt miss, and it was still cheaper in absolute
terms. Classification: **CACHE_NO_MATERIAL_REGRESSION**. No claim is made that the profile
*improved* caching — the evidence does not causally support one.

## Finding dispositions

- **F1 — same-agent assessment** (implementation, verification, scoring, and closure by one
  agent; blinded views scored before unblinding). Objective metrics (acceptance, attempts,
  cost, timestamps, changed paths) are mechanical and were re-derived from committed
  artifacts at closure; read-purpose and PROFILE_HELPED labels carry same-judge risk but
  rest on grep-verifiable tool lines (the package.json reads are visible in the committed
  tool sequences). *Severity: minor (process). Blocks closure: no. Smallest correction: a
  genuinely independent scorer on a future run.*
- **F2 — P3 treatment still read package.json.** Expected model redundancy: the profile is
  orientation, not authority, and the model is told to re-check. Not a profile defect and
  **not** evidence for a task-specific selector (the read was of the fact source itself,
  not a hunt for relevant files). *Severity: note. Blocks: no. Correction: none.*
- **F3 — per-run cwd in the prefix limits cross-run cache comparison.** A benchmark-design
  limitation, symmetric across arms; a future cache-focused study should pin cwd. Not a
  profile issue. *Severity: note. Blocks: no.*
- **F4 — tool-sequence artifacts initially excluded by the repo's `*.log` gitignore.**
  Fully repaired by additive commit `54ef2ce`; at closure every committed sequence was
  cross-checked against its run row (timestamps within duration, first-mutation ms equal to
  the locked blinded scores, pre-mutation read counts re-derived and equal, changed paths
  equal). Original results untouched. *Severity: minor (fixed). Blocks: no.*
- **F5 — no live non-npm package-manager evidence.** The planned pnpm fixture was converted
  to npm before freeze (pnpm absent on the machine; documented in the frozen protocol).
  Live evidence therefore covers the qualified-fallback objective but not non-npm managers
  end-to-end. Deterministic coverage of pnpm/yarn/bun detection and profile/gate parity is
  extensive (unit + independent verification, 11 lockfile combos × 2 orders). *Severity:
  accepted evidence limitation. Blocks: no. Smallest correction: one future dogfood on a
  real pnpm/bun project when one enters daily use.*
- **F6 (closure-discovered) — committed `results.jsonl` rows do not echo `promptSha256` /
  `forgeCommit` per row.** Both are recoverable from the frozen `tasks.jsonl` + `schedule.json`
  and the runner design; all other fields match the raw capture byte-for-byte. Evidence tip
  classification: **FINAL_EVIDENCE_TIP_VALID_WITH_MINOR_PROCESS_GAP**. *Severity: minor
  (schema). Blocks: no. Smallest correction: include both fields in future result rows.*

## P2 fixture deviation

**P2_DEVIATION_REDUCED_EVIDENCE_SCOPE.** The frozen protocol documents the change
accurately and it predates the freeze; fixture identity was stable afterward (tree hash
`26dce03a…`); the qualified-fallback objective was preserved **and delivered the round's
clearest positive evidence**. What was not collected: live non-npm behavior (F5). A rerun
is not required.

## Accepted limitations (the "with accepted limitations" list)

1. Same-agent evaluation chain (F1).
2. Four-fixture, single-run scale — results are not generalized beyond the measured run.
3. No live non-npm package-manager case (F5).
4. Result-row schema gap (F6).
5. Cross-run cache attribution not separable (F3).

## Operating position after closure

Constitution v1 **on** + static project profile **on** (both production defaults) are the
standing configuration for daily use. The profile is a snapshot, never authoritative; the
verification gate keeps rediscovering checks independently.
