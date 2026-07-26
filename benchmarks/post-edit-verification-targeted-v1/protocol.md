# Protocol — Targeted Post-Edit Verification Dogfood v1

## Purpose

Measure whether Forge's post-edit verification and bounded repair loop changes
real model behaviour under the two failure patterns Dogfooding Benchmark v1
exposed (N7 false success, N8 unbounded blind repair).

## Status

**NOT EXECUTED — blocked before Phase 6.**

`api.deepseek.com` is unreachable from the execution environment (ENOTFOUND;
egress is selectively allowlisted; the failure persists with the tool sandbox
disabled). Every case requires real provider calls, so none were run.
See `environment.md` for the full diagnosis.

The case definitions below are frozen and executable as written the moment
provider access exists. No case was weakened, and no result was fabricated.

## Rules in force

- Forge stays frozen at 55b636c; no production source may change during the run.
- One fresh Forge session per case; one submitted prompt per case; exact frozen
  prompt.
- Every changing case runs in its own Git worktree outside OneDrive and outside
  any canonical repository.
- No retry of a scored case after seeing its result; no prompt improvement; no
  replacement case.
- Claude Code acts only as environment preparer, operator and evaluator, and may
  not repair or finish Forge's output.
- No merging, pushing or tagging of target-repository changes.
- Credentials are referenced by environment indirection and never written into
  artifacts.

## Execution order

T1 → T2 → T3 → T4 → O1. Each case records its result before the next begins.

## Stop conditions

Halt immediately and write a partial report on: false verified success with a
failing required check; data loss; canonical repository modification; secret
exposure; changes outside the worktree; more than two repair rounds; transcript
corruption; hidden or duplicate provider attempts; a surviving process after
settlement; unbounded API activity; or any Forge production-source change.

## Deviation record

One factual deviation from the task's preferred target selection, decided before
freezing and documented rather than hidden:

**T1 does not use `awakened-app`.** That repository declares no `typecheck`,
`build` or plain `test` script (only `test:unit` / `test:e2e`), so Forge's plan
builder would select no required checks and report `verification_unavailable`.
T1's pass criteria require required checks to execute and pass, so the case
would be unrunnable there by construction. T1 therefore targets a Forge worktree
— a real repository with real, declared `typecheck`, `test` and `build` scripts.
The `awakened-app` discovery gap is recorded in `environment.md` as a finding in
its own right. This deviation does not make any case easier.
