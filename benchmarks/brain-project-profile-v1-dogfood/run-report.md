# Forge Brain Phase 2 — Static Project Profile Real-Provider Dogfood (run 1)

Frozen protocol `070a3b7` (child of treatment `9ce342e`). Model `deepseek/deepseek-v4-pro`,
permission mode yolo (both arms), 4 fixtures × 2 arms = 8 scored runs, no reruns, no
manual help, no unscored completion (provider pre-check was one non-completion GET /models).
Same-agent scoring limitation disclosed: blinded views were scored before unblinding, but
author/evaluator are the same agent.

## Verdict: PHASE 2 DOGFOOD PASSED

Both arms accepted 4/4 tasks. The treatment (static profile) was **never misled, never
worse**, and demonstrated the exact process value it was built for: project-fact
rediscovery reads fell **4 → 1** (−3), with strict reductions in 2/4 paired cases and one
concrete avoided check-discovery behavior (P2). Cost class **PROFILE_COST_HEALTHY** —
treatment was cheaper (−8.2% median cost), faster (−17.6% median wall-clock, −10.3%
ms/output-token), with warm cache within 4.6pp.

## Execution summary

| Run | Exit | Duration | Attempts | Cost | Changed paths |
|---|---|---|---|---|---|
| p1-control | 0 | 81.8s | 10 | $0.00460 | permitted only |
| p1-treatment | 0 | 55.4s | 6 | $0.00296 | permitted only |
| p2-treatment | 0 | 30.6s | 6 | $0.00346 | permitted only |
| p2-control | 0 | 32.6s | 7 | $0.00313 | permitted only |
| p3-control | 0 | 33.6s | 7 | $0.00329 | permitted only |
| p3-treatment | 0 | 24.0s | 4 | $0.00293 | permitted only |
| p4-treatment | 0 | 19.2s | 4 | $0.00259 | permitted only |
| p4-control | 0 | 24.1s | 4 | $0.00293 | permitted only |

8/8 completed; 0 provider failures; total official duration 301.2s; total spend $0.02589.

## Acceptance & verification (independent)

All 8 runs: typecheck + tests green in the terminal repo, functional probes pass, baselines
preserved, forbidden paths untouched (incl. `packages/` on both P3 runs), P4 evaluator
command passes both arms. Verification: P1–P3 "Verified — typecheck, test[:unit] passed" in
all 6 runs; P4 honestly reported "could not be automatically verified — no required project
checks are declared" in **both** arms. Claim accuracy 8/8.

## Project-fact rediscovery (blinded classification)

| Fixture | Control | Treatment | Detail |
|---|---|---|---|
| P1 | 1 | **0** | control read package.json for scripts; treatment ran `npm run typecheck` + `npm test` without ever reading it |
| P2 | 2 | **0** | control globbed for the named test file and read package.json to discover `test:unit`; treatment used `npm run test:unit` proactively |
| P3 | 1 | 1 | both read package.json; both left `packages/` alone |
| P4 | 0 | 0 | both went straight to the two named files |
| **Total** | **4** | **1** | irrelevant reads 0 vs 0 |

## First useful edit (all mutations survived into accepted patches)

P1 25.0s vs 28.2s · P2 10.0s vs 15.5s · P3 11.8s vs 17.8s · P4 12.3s vs 18.2s — treatment
earlier in **4/4** (median 12.0s vs 18.0s). Tool calls before first useful edit: treatment
2/2/3/2 vs control 4/4/4/2.

## Profile helpfulness

- **P1: PROFILE_HELPED** — rediscovery 1→0; checks run without package.json; earlier edit; cheaper.
- **P2: PROFILE_HELPED** — the designed discriminator: treatment used the profiled qualified
  `test:unit` proactively; control needed a glob + package.json read to find it.
- **P3: PROFILE_NEUTRAL** — treatment was faster (4 vs 7 attempts) but still read
  package.json (rediscovery equal); single-sample attribution withheld. Nested discipline
  held in both arms.
- **P4: PROFILE_NEUTRAL** — identical honest missing-check behavior.

**PROFILE_MISLED: 0/4.** No wrong manager/check/root, no child confusion, no fabricated
path, no stale-fact authority, no misleading claim.

## Gates

Acceptance 4≥4 ✓ · verification passes 3≥3 on declared-check fixtures ✓ · honest
unavailable on P4 ✓ · zero misled ✓ · zero nested switches ✓ · zero fabricated facts (4/4
pre-dispatch profile validations passed: 651/763/735/603 bytes, checks == plan, root `.`,
P3 nested = candidates only) ✓ · zero unrelated corruption (only permitted paths in 8/8) ✓
· zero whole-file fallbacks (all edit_file/multi_edit) ✓ · zero surviving processes ✓ ·
attempts == ledger rows 8/8 ✓ · claims accurate ✓.
**Process-value gate: met on all three prongs** — total rediscovery −3 (≥2); strict
reduction in 2/4 pairs (P1, P2); one concrete avoided check-discovery behavior (P2).
Irrelevant-read delta 0 (≤2 permitted).

## Cache, tokens, latency, cost — PROFILE_COST_HEALTHY

| | Control | Treatment |
|---|---|---|
| Cold run cache-hit | 85.9% (p1-control) | 83.5% (p1-treatment) |
| Warm-state cache-hit | 82.7% | 78.1% (−4.6pp, within 10pp) |
| Provider attempts | 28 | 20 |
| Total output tokens | 6,103 | 5,113 |
| Median duration | 33.1s | 27.3s (−17.6%) |
| ms / output token | 28.2 | 25.3 (−10.3%) |
| Median cost | $0.00321 | $0.00295 (−8.2%) |
| Total cost | $0.01395 | $0.01195 |

Structural note (honest reporting, not normalization): each run's prefix embeds its own
cwd, so cross-run prefix caching is nil in both arms; ratios reflect within-run attempt
reuse. Treatment's slightly lower ratio follows from *fewer attempts per run* (less prefix
re-amortization) plus its ~0.7KB larger prefix — and it is still cheaper in absolute cost.
Product interpretation matches the frozen class: the profile pays for itself immediately.

## Findings

- **F1 (minor, process):** same-agent blinded scoring; response style makes arms partially
  inferable (treatment tends to skip package.json). Disclosed; n=4 pairs is small.
  Non-blocking.
- **F2 (note):** P3 treatment read package.json despite the profile carrying the same
  facts — the profile reduces but does not eliminate rediscovery. Expected; no correction
  required.
- **F3 (note):** cross-run prefix caching is structurally absent because cwd differs per
  run; a future cache-focused study should hold cwd constant. Non-blocking here since both
  arms are affected identically.

## Decisions

- **Phase 2 decision: PHASE 2 STATIC PROFILE COMPLETE.**
- **Candidate B gate: CANDIDATE B MAY BE RECONSIDERED** (not designed here).
- **Next action: close Phase 2 and make the separate Candidate B go/no-go decision.**
