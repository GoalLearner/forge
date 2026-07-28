# Summary — Targeted Post-Edit Verification Dogfood **v2**

## Status: FIXTURES FROZEN — NOT YET EXECUTED

v2 supplies the one thing v1 lacked: committed, hashed fixture source for T2
and T3. Prompts, acceptance criteria and scoring are byte-identical to v1.

No case has been executed under v2. `results.jsonl` is intentionally empty.
Provider completion requests during fixture authoring: **0**. Cost: **$0.00**.

Baselines validated three consecutive times each, from fresh copies of the
committed bytes:

| Case | typecheck | test | runs |
|---|---|---|---|
| T2 | exit 0 | 4 passed | 3/3 |
| T3 | exit 0 | 5 passed | 3/3 |

The v1 findings below remain accurate as history, with one correction noted in
`protocol.md`: the awakened-app discovery gap has since been closed.

---

## Historical v1 summary (unchanged)
# Summary — Targeted Post-Edit Verification Dogfood v1

## Status: NOT EXECUTED

Blocked before Phase 6. `api.deepseek.com` does not resolve from the execution
environment, and every one of the five cases requires real provider calls by
definition. Full diagnosis in `environment.md`; case definitions are frozen in
`tasks.jsonl` and are executable as written once provider access exists.

`results.jsonl` is intentionally empty. No case was run, so no result row exists.

## What was completed

| Phase | Status |
|---|---|
| 1 — Verify and freeze Forge | done: 55b636c, clean tree, typecheck pass, build pass, 399/399, no remote |
| 2 — Isolated benchmark state | done: isolated FORGE_HOME, credential by env indirection, no historical ledger rows |
| 3 — Evidence structure | done |
| 4 — Target repository survey | done |
| 5 — Freeze five cases | done: T1–T4 scored, O1 observation |
| 6–11 — Execution, evidence, scoring, cost | **blocked** |

## Why no mock substitute was used

Running the cases against a local mock provider would exercise Forge's loop but
would answer a different question. Every one of the seven objectives concerns
*real model behaviour* — whether a real model repairs a real typecheck failure,
what real repair rounds cost, whether a real model reaches for `run_shell`.
A mock answers none of them, and presenting mock output under a "targeted
real-provider rerun" heading would be the same false-success pattern this
feature exists to prevent.

The mechanism itself is already independently verified against deterministic
fixtures (399/399, N7 and N8 regression suites, dirty-tree attribution). What
remains unmeasured is real model behaviour, and that specifically requires the
provider.

## Findings available without a provider

### Project-command discovery gap (awakened-app)

`awakened-app` — the most-used real repository in this project, clean at
ada9252 — declares only `test:unit`, `test:e2e` and three e2e variants. It has
no `typecheck`, no `build` and no plain `test` script.

Forge's plan builder matches the exact names `typecheck`, `test`, `build` and
`lint`. Against this repository it would therefore select **no required checks**
and report `verification_unavailable` for every code-changing task.

This is not a defect in the verification loop — it degrades honestly rather than
claiming false success — but it means the feature would contribute nothing on
the repository it was most needed for. It is the strongest candidate for the
highest-leverage remaining friction, and it was found without spending anything.

### Repository survey

| Repository | Branch | HEAD | Clean | typecheck | test | build | Usable as target |
|---|---|---|---|---|---|---|---|
| forge | fix/post-edit-verification-attribution | 55b636c | yes | yes | yes | yes | yes (T1) |
| awakened-app | main | ada9252 | yes | no | no (test:unit only) | no | no required checks |
| tldw | main | 7a8beaa | yes | no package.json at root | — | — | no |
| sectory | main | 5661d9d | **no** (4 dirty) | — | — | — | excluded: dirty canonical |

## Next step

Re-run this protocol unchanged from an environment with DeepSeek egress. Nothing
in `tasks.jsonl` needs to be rewritten.
