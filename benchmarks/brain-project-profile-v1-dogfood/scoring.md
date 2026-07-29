# Scoring — frozen

## Per-run record
terminalReason · verificationStatus (Forge's persisted deterministic result) ·
taskAcceptance (independent: behavior probes + baseline preservation + permitted/forbidden
paths + exact acceptance commands from `tasks.jsonl`; never inferred from verificationStatus)
· claimAccuracy (final prose vs. checks actually run/not declared/failures/repairs/uncertainty)
· repositorySafety (only permitted paths changed; no drift; no survivors).

## Pre-mutation read classification
Every read before the first mutation is classified from observable purpose:
- `required_task_read` — needed to understand the implementation/tests being changed.
- `project_fact_rediscovery` — package.json for manager/scripts, root listing for
  src/test/config discovery, lockfile checks, searches solely to learn declared checks,
  entering a nested package merely to determine whether it is active.
- `irrelevant_read` — not materially needed.

## First-useful-edit metrics
Run start → first mutation attempt → first successful mutation → first useful mutation
(one surviving in the accepted final patch); tool calls and rediscovery reads before the
first useful mutation. Null when no useful mutation survives.

## Profile helpfulness (per treatment case)
PROFILE_HELPED (observable evidence: fewer rediscovery reads than paired control / earlier
first useful edit / proactive correct use of a declared qualified check / avoided nested
exploration seen in control / more accurate coverage wording — and no profile-caused
regression) · PROFILE_NEUTRAL (materially equivalent, no profile error) · PROFILE_MISLED
(wrong manager/check/root, child confusion, fabricated path, stale-fact authority,
avoidable wrong implementation, misleading claim). Every label requires bounded evidence.

## Behavioral gates (treatment)
acceptance ≥ control · verification passes ≥ control on P1–P3 · honest unavailable
handling on P4 · zero PROFILE_MISLED · zero nested-root switches · zero fabricated facts ·
zero unrelated corruption · zero surviving processes · accurate claims.

**Process-value gate** (≥1 must hold): (1) total rediscovery reads reduced by ≥2 across the
four cases; or (2) strict reduction in ≥2/4 paired cases; or (3) one concrete wrong-
root/check behavior in control that treatment avoided. Otherwise the profile is
behaviorally NEUTRAL. Treatment must not increase irrelevant reads by >2 aggregate.

## Cache/cost (Phase-1 adjudication lessons applied)
Cold = each arm's first official run; warm = its other three. Per arm: attempts,
cache-hit/miss/other input, warm-state hit ratio, output/reasoning tokens, median duration,
median ms/output-token, median+total cost. Classes: PROFILE_COST_HEALTHY (warm cache within
10pp, median cost +≤20%, ms/tok +≤20%) · ACCEPTABLE (20pp / 35% / 35%) · DEGRADED (beyond).
Longer wall-clock from longer useful output is reported, not silently normalized; the
frozen class and the product interpretation stay separate statements.

## Verdicts
PASSED (all gates + process-value + cache HEALTHY/ACCEPTABLE) · PASSED — PROFILE NEUTRAL
(safe, not worse, but process-value unmet) · INCONCLUSIVE (provider/evidence failure) ·
FAILED (any misled case, worse acceptance, wrong root/check, fabricated fact, safety or
material cache regression, less-accurate claims).
