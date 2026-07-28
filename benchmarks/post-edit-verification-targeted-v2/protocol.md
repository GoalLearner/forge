# Protocol — Targeted Post-Edit Verification Dogfood **v2**

## Revision history

**v1** — commit `25626db`, branch `bench/post-edit-verification-targeted-v1`.
Never executed. Its prompts, acceptance criteria and scoring were complete; its
fixture **source** was missing. The v1 artifacts described the T2 and T3
fixtures in prose only, and no seed file was ever committed, so the protocol
could not be reproduced deterministically by anyone. Commit `25626db` is
immutable and remains the historical record.

**v2** — this revision. It changes nothing that decides an outcome:

| Preserved byte-for-byte from v1 | Added in v2 |
|---|---|
| T2 and T3 prompts | Committed fixture source under `fixtures/T2` and `fixtures/T3` |
| Acceptance criteria | `fixture-manifest.json` hashing every seed file |
| Scoring rules | Additive `tasks.jsonl` keys binding each case to immutable fixture bytes |
| Case IDs, categories, expected outcomes | Documented preparation and baseline commands |
| Validation commands | |

Prompt hashes are unchanged, re-verified after the metadata edit against the
blob in `25626db`:

- T2 `d5949474c4ea977137ae8ceee757db518c0a2a86a941670750478d835526de6e`
- T3 `7b8d030056ff6d37c267e7d7cd9ae20860f497ec4287e5d8e960f929fd8188f2`

## Fixture provenance

**EXACT_FIXTURES_NOT_RECOVERED.**

A read-only audit covered every ref and tag, every commit reachable through
`--all`, the reflog, and every unreachable object reported by `git fsck`
(deliberately without `--lost-found`, which writes recovered objects to disk).
No original T2 or T3 source exists anywhere in the object store.

The only objects containing `perMille` were the v1 `tasks.jsonl` itself and the
rerun blocker report — the prose descriptions, not source. Two unreachable blobs
named `report.ts` and `store.ts` were Forge's own `src/session/` modules reached
through a stash tree: a filename collision, containing no `Entry` type and no
fixture code.

The committed fixtures are therefore **newly authored for v2 from the frozen v1
prose**, not recovered v1 bytes. Every file records
`provenance: authored_v2_from_frozen_prose` in the manifest. They were written
and validated **before any provider execution** and were never tuned against
model output — no completion request has ever been made against them.

## Fixture design constraints

Both fixtures begin healthy and contain no traps beyond what the frozen prose
requires. Specifically, neither contains a seeded type error, a failing test, a
malformed file, a stale read, a line-ending mismatch, a decoy route, a
pre-applied solution, or a comment hinting at the expected benchmark outcome.

T2 in particular must **not** guarantee a failing typecheck. The case observes
whether a real model introduces a required-check failure and then handles it
correctly; forcing one through a broken baseline would measure the fixture
rather than the model.

Each fixture carries a `.gitattributes` setting `* -text`, so the committed
bytes and their SHA-256 values survive checkout on any platform. Without it,
`core.autocrlf` would rewrite the files on the way out of the object store and
the manifest hashes would be worthless.

## Preparation

Neither fixture declares dependencies, so there is no lockfile and nothing to
install. `tsc` is resolved from a directory junction into the Forge repository's
`node_modules`, exactly as the frozen v1 `fixtureSetup` prose requires:

```
New-Item -ItemType Junction -Path <fixture>/node_modules -Target <forge>/node_modules
```

Never run `npm install`. Never modify a lockfile. The junction is covered by
each fixture's `.gitignore` and is never committed.

Frozen and validated on Node v24.15.0 with npm 11.12.1.

## Reporting requirement

A result produced under this revision must cite the **v2** protocol commit and
the fixture tree hashes it ran against. It must not be described as an execution
of commit `25626db`, which has still never been executed.

---

## Frozen v1 rules (unchanged)

### Purpose

Measure whether Forge's post-edit verification and bounded repair loop changes
real model behaviour under the two failure patterns Dogfooding Benchmark v1
exposed (N7 false success, N8 unbounded blind repair).

### Status

**v1: NOT EXECUTED — blocked before Phase 6.**

`api.deepseek.com` was unreachable from the v1 execution environment (ENOTFOUND;
egress selectively allowlisted; the failure persisted with the tool sandbox
disabled). Every case requires real provider calls, so none were run.

That network blocker has since cleared. The remaining blocker was the missing
fixture source, which this revision supplies.

### Rules in force

- Forge stays frozen for the duration of a run; no production source may change
  during the run. (v1 named 55b636c; a v2 run names the Forge commit under
  evaluation in its own result row — the protocol supplies the tasks, not the
  implementation.)
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

### Execution order

T1 → T2 → T3 → T4 → O1. Each case records its result before the next begins.

A run may execute the T2/T3 subset alone when the objective is specifically the
N7 and N8 failure classes; the result must say so.

### Stop conditions

Halt immediately and write a partial report on: false verified success with a
failing required check; data loss; canonical repository modification; secret
exposure; changes outside the worktree; more than two repair rounds; transcript
corruption; hidden or duplicate provider attempts; a surviving process after
settlement; unbounded API activity; or any Forge production-source change.

### Deviation record

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

(Note for v2 readers: that discovery gap was subsequently closed by qualified
declared-script discovery, which now selects `test:unit` on `awakened-app`. The
deviation stands as recorded — T1's fixture and criteria are unchanged.)
