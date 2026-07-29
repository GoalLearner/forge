# Daily-Use Finding 001 — Zero-Dependency Verification Readiness — Closure

**Status: CLOSED WITH MINOR ACCEPTED LIMITATIONS** (2026-07-29).

Verification-readiness work, not a Brain phase. Commit chain, all parents resolved from Git:
`a042e4c` (daily-use evidence) → `beb9413` (first fix) → `3877c47` (verified v2 correction).
Test floor at `3877c47`: **639/639**. This document records the closure; it modifies no
source, no tests, and not the existing evidence log.

---

## 1. How it was found

The first real daily-use task after Phase 2 shipped — adding an optional `maxLength` to a
`slugify` helper — ran on a **zero-dependency** fixture repo declaring `"test": "node --test"`
with no `node_modules`. Forge completed the task correctly (8/8 independent probes, scope
exact, honest prose), but the **verification gate reported the declared check unavailable**,
and the model separately ran `node --test` by hand. The run was logged against the Candidate B
trigger template; **no trigger fired** — this was never a context-selection problem.

## 2. The original defect

`verification.ts` dropped **every** selected script when `node_modules` was absent, with no
inspection of whether the script actually needed installed packages. For a dependency-free
`node --test` this was a **false negative**: the command runs fine without installing anything.
Reproduced at the pre-fix commit: plan returned `checks: []`, `executeVerification` →
`unavailable`, 0 commands executed, while `node --test` and `npm test` both passed 1/1.

## 3. First fix — `beb9413`

Introduced `classifyDeclaredCheckReadiness`: with `node_modules` present, semantics unchanged;
without it, a script is runnable only if the package declares no dependencies **and** the body
is a direct `node` invocation (no `npx`, no package binaries, no shell composition). The npm
happy path worked, and the full suite was green.

## 4. First independent verification — two blockers

IV found that the **inspected** script body is not the **executed** command:

1. **Lifecycle hooks ignored.** `npm test` also runs `pretest`/`posttest`. A repo with
   `pretest: vitest` + `test: node --test` was classified runnable; real `npm test` exited 1
   (`'vitest' is not recognized`) and the run persisted **`status: failed`**.
2. **Package manager unchecked.** A `pnpm-lock.yaml` repo emitted `pnpm run test` on a machine
   without pnpm; launch failed with `CommandNotFoundException` and persisted **`status: failed`**.

Both turned an **environment** problem into a **project-code failure** — strictly worse than
the false-unavailable they replaced, because it would burn repair rounds on an unrelated error.
Finding 001 therefore **remained open**. IV also flagged two minor metadata defects: a
non-object dependency field (`dependencies: 42`) was silently treated as dependency-free, and
`dependencies: null` crashed `Object.keys` into a bogus "could not be parsed".

## 5. V2 correction — `3877c47`

Without `node_modules`, the exception now requires **all** of:

1. `node_modules` absent (the only branch these rules apply to);
2. package manager is **unambiguously npm** (npm ships with node; pnpm/yarn/bun are never
   probed — no PATH scan, no `where`/`which`, nothing invoked during discovery);
3. all four dependency fields missing or **empty plain objects** (`null`, arrays, strings,
   numbers, booleans are `unsupported_shape` and block);
4. the selected script body is a direct node invocation;
5. every present lifecycle hook — `pre<S>`, `post<S>`, one level only — is one too.

Anything else is unavailable: **zero commands execute, nothing is persisted as failed, no
repair round opens.** Reasons are bounded and name only sanitized script/hook names.

## 6. Second independent verification

**VERIFIED WITH MINOR ACCEPTED LIMITATIONS.** Both prior blockers were reproduced at `beb9413`
and confirmed fixed at `3877c47`. Results: lifecycle chain correct (eligible A–E selected;
ineligible F–M blocked before execution; `prepretest`/`postposttest` correctly *not* inspected);
manager restriction correct across all eight lockfile combinations including ambiguity;
dependency metadata conservative across all four fields × eight shapes; direct-node classifier
rejected all 20 unsupported forms with no false positives; unknown never executes; profile/gate
parity exact across eight fixtures (including `matchType` and `selectionReason`); the stale
profile could not override live readiness; `node_modules`-present semantics preserved.

## 7. Accepted limitations

- **U+2028/U+2029 in one raw reason path.** These Unicode separators survive in the raw
  `unavailableReasons` string, which `loop.ts` joins into a user-visible notice unsanitized.
  No CR/LF or heading injection was reproducible (C0/DEL are stripped), and the
  project-profile renderer already sanitizes them. **Optional future hardening** — add
  `\u2028\u2029` to the reason-name strip class the next time `verification.ts` is legitimately
  changed. Not worth a dedicated commit.
- **`retry-budget.test.ts` timing flake.** Fails intermittently under full-suite parallel load,
  passes 8/8 in isolation. The file is **byte-identical at `a042e4c`, `beb9413`, and `3877c47`**
  (sha256 `f05b4635…`) and imports nothing from `verification.ts` — entirely outside this
  finding. Track separately only if it becomes reproducible or affects normal operation.
- **Same-agent verification.** Implementation and verification were performed by the same
  agent. Mitigated by driving every gate from real execution against external fixtures and by
  base-vs-treatment module comparison. Does not reopen finding 001.

## 8. Operating position

**Constitution v1 ON · static project profile v1 ON · zero-dependency readiness v2 active.**
The profile remains a session-start informational snapshot with no authority; the verification
gate rediscovers checks from live files on every run. Unsupported environments stay unavailable
*before* execution rather than failing during it.

**Approved envelope:** real bounded coding work; human diff review; separate task-acceptance
review; declared-check verification; zero-dependency npm direct-node checks; surgical edits;
small multi-file tasks within the existing envelope.

**Still outside the envelope:** long unattended autonomous work; deployment; destructive
migrations; cross-repository work; automatic root switching; Candidate B selector behavior;
unreviewed production release.

## 9. Roadmap

**Candidate B remains deferred** — no trigger fired at any point in this finding, and nothing
here was a context-selection failure. **The static project profile remains complete** — it was
never modified by this work, holds no readiness logic of its own, and mirrored the canonical
plan exactly at every step, including while the plan itself was wrong. **Finding 001 was
verification-readiness work, not a new Brain phase.**
