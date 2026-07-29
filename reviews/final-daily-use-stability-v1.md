# Forge Final Daily-Use Stability Review V1

**Date:** 2026-07-28 · **Verdict: READY FOR DAILY USE WITH DOCUMENTED LIMITS**
**Roadmap: EXISTING ROADMAP COMPLETE WITH ACCEPTED LIMITATIONS**
**Brain gate: BRAIN PLANNING UNLOCKED**

---

## 1. Production identity

Validated in a detached worktree outside OneDrive, never from an evidence branch.

| | |
|---|---|
| Production commit | `9651f1e0f228d4e3375efcae3ffd36fcb1ff6ee0` |
| Parent | `c41c901809e9f9f06b34315d7349c2860633a7d2` ✓ |
| Worktree status | clean; 0 source mutations; 0 package/lock drift |
| `git diff --check HEAD^..HEAD` | 0 issues |
| Canonical repo | clean; **no remote**; 0 tags |

### Full evidence chain (all hashes resolved, none assumed)

| Milestone | Full hash |
|---|---|
| Stage 0 baseline | `9555b12b4d2e11aea07876f8fa0f640f132e4e68` |
| Step 4B initial | `7f68a56bb8e3a56e1960a0e0f8ff5fff3869fe27` |
| Step 4B corrected | `7392a4b0e426af1a12b6da643a9f3e473a2aeb1d` |
| Post-edit verification | `84133bd336e790b1c3c0e85d3e23d1c5b441a832` |
| Attribution correction | `55b636c91aa2b0e6a84ec5773a75bca33e7b70c1` |
| Script discovery | `c41c901809e9f9f06b34315d7349c2860633a7d2` |
| CRLF editing | `9651f1e0f228d4e3375efcae3ffd36fcb1ff6ee0` |
| Dogfood 001 | `cef82f6de6786da62090653a77efd9baf0e83293` |
| Dogfood 002 | `a82e8023d8f7dc6ed352102099d265e21b1bc31f` |
| Protocol v1 | `25626dbead572e2c6d0526984b2fa88e0bd83fce` |
| Protocol v2 | `ab508e1e4111ce3fce337ac86cc3e4475a19905c` (parent = v1 ✓) |
| T2/T3 results | `e8ff627cbb9ce8cfa403aabfb4bbdad913a4d1f6` (parent = v2 ✓) |

---

## 2. Deterministic stability evidence

All against `9651f1e`. No paid provider request.

| Battery | Reps | Tests | Pass | Fail | Hangs | Duration |
|---|---|---|---|---|---|---|
| `npm run typecheck` | 1 | — | clean | 0 | 0 | — |
| `npm run build` | 1 | — | success | 0 | 0 | — |
| `npm test` (full) | **3** | **481** | 481 | **0** | 0 | 34–35 s |
| Structured editing | **10** | 49 | 49 | **0** | 0 | 721–786 ms |
| Verification & repair | **5** | 99 | 99 | **0** | 0 | 21.63–21.77 s |
| Execution safety | **5** | 90 | 90 | **0** | 0 | 31.95–32.09 s |
| Accounting & persistence | **5** | 157 | 157 | **0** | 0 | 4.89–8.85 s |

**Zero flakes across all 23 runs.** No package or lockfile drift, no source mutation, **0 surviving node processes** after the execution-safety battery.

Coverage confirmed present: CRLF↔LF both directions, mixed-ending preservation, BOM, Unicode/UTF-16 mapping, ambiguity, `replace_all`, failed-edit non-mutation, stale-file rejection, `multi_edit` atomicity, 60 000-line fixture; verification arming, required-check failure, ≤2 repair rounds, `verification_failed`, **N7 regression (3 cases)**, **N8 regression (1 case)**, mutation/verified generation, changed-path attribution, dirty-tree handling, script discovery, unsafe-script exclusion; tool timeout, runtime budget, step ceiling, cancellation, supersession, taskkill, shell/glob cancellation; aggregate retry ceiling, exact attempt counts, partial usage, reasoning-token persistence, cost confidence, integer nanodollars, tool pairing, headless + TUI ledgers, cache-prefix stability.

---

## 3. Milestone audit

Each commit's parent is the previous milestone — a clean linear chain, no rebases.

| Milestone | Scope | Verdict |
|---|---|---|
| Stage 0 `9555b12` | 93 files (root) | matches intent |
| Step 4B `7f68a56` → `7392a4b` | 21 files then 9 (+945/−180) | corrected build is the shipped one |
| Post-edit verification `84133bd` | 11 files, +2019/−5 | matches intent |
| Attribution `55b636c` | 4 files, +290/−24 | matches intent |
| Script discovery `c41c901` | 4 files, +463/−16 | matches intent |
| CRLF editing `9651f1e` | 4 files, +778/−81 | matches intent |

Protected-area guard across all post-Stage-0 milestones: **0** touches to `prompt.ts` / `messages.ts` / `truncate.ts`, **0** to `models.json`. Only `7392a4b` touched `src/providers/` (3 files) — expected, that is the ledger's provider-usage plumbing.

No discrepancy found between commit intent and current behaviour.

---

## 4. Real-provider evidence matrix

Read from committed artifacts, not summaries.

| | Dogfood 001 | Dogfood 002 | T2 | T3 |
|---|---|---|---|---|
| Evidence commit | `cef82f6` | `a82e802` | `e8ff627` | `e8ff627` |
| Forge commit | `c41c901` | `9651f1e` | `9651f1e` | `9651f1e` |
| Model | v4-pro | v4-pro | v4-pro | v4-pro |
| Session | `5e76459b…` | `a9772d66…` | `711bae7e…` | `4a4fc3e2…` |
| Run | `…ms4c99ov` | `…ms4go02p` | `…ms59h5s8` | `…ms59j41r` |
| Duration | 100 s | 41 s | 38 s | 38 s |
| Attempts / requests | 8 / 8 | 7 / 7 | 9 / 9 | 7 / 7 |
| Retries | 0/4 | 0/4 | 0/4 | 0/4 |
| Repair rounds | 0/2 | 0/2 | 0/2 | 0/2 |
| Structured tools | `edit_file` **failed** → `write_file` | `edit_file` ✓ | `multi_edit` ×2 ✓ | `multi_edit` + `edit_file` ×2 ✓ |
| `write_file` used | **yes** (CRLF fallback) | no | no | no |
| Verification | passed | passed | passed | passed |
| Task acceptance | met | met | met | met |
| Independent validation | 31/31 tests | 38/38 tests | tc 0, 9/9, check 0 | tc 0, 5/5, check 0 |
| Claude Code fallback | none | none | none | none |
| Cost | `estimated` 14 790 870 n **$0.0148** | `estimated` 8 600 008 n **$0.00860** | `estimated` 4 280 371 n **$0.00428** | `estimated` 4 366 936 n **$0.00437** |
| Score | PASS | PASS (SURGICAL_PASS) | PASS | PASS |

**Combined real spend across all four runs: ~$0.032.**

Every reported request appears in the ledger (8/8, 7/7, 9/9, 7/7). `otherInputTokens` persists as **null**, never coerced to zero. No result was manually corrected; no official task was rerun; canonical repositories stayed clean throughout; every completion claim matched independent validation.

The 001 → 002 transition is the clearest single piece of product evidence: the same class of CRLF edit that forced a whole-file rewrite before `9651f1e` became a first-attempt mid-file splice after it.

---

## 5. N7 and N8 residual evidence status

| | N7 (false success) | N8 (corruption / blind retry) |
|---|---|---|
| Live closure | **NOT closed** | **NOT closed** |
| Why | T2 passed both required checks on first verification | T3's structured edits all succeeded; no repair needed |
| Deterministic mechanism | **verified** — 3 N7 regression cases, 5 consecutive runs | **verified** — 1 N8 regression case, 5 consecutive runs |
| Blocks daily use | **no** | **no** |

The v1 defects demonstrably do not reproduce, and the enforcement is structural (in the loop, not the prompt). But a guardrail that was never loaded is not a guardrail that was proven under load. Both remain **accepted residual evidence gaps**, closable only by an authentic model mistake during ordinary use.

---

## 6. Finding dispositions

**A — Live N7 unproven.** Accepted residual gap. Deterministic coverage recorded as mechanism evidence. No failure manufactured.

**B — Live N8 unproven.** Accepted residual gap. Dogfood 002 and T3 recorded as successful structured-edit evidence.

**C — T3 checks do not prove task completeness.** Disposition: **documentation / reporting discipline only** — no production correction, no enhancement in this review. Established as a permanent evaluation rule:

> `verificationStatus` and `taskAcceptance` must be recorded separately whenever natural-language acceptance can exceed the declared automated checks.

**D — `npx` in a task command.** Resolved to `C:\…\forge\node_modules\typescript` — **local, no network**. `tsc` is not on PATH, so no global is silently required; without a local install `npm exec --no` refuses and instructs rather than fetching. `run_shell` is gated by `assessCommand` in every mode (a PowerShell diagnostic was auto-denied live in Dogfood 001). Forge's own declared verification ran `npm run typecheck` independently of the model's diagnostic. **Not a daily-use blocker.**

**E — `read_file` still exposes invisible carriage returns.** Production grep confirms the **only** content matcher is `edit-match.ts`, consumed solely by `edit_file` and `multi_edit` via `applyEdit` — both now tolerant. No other production matcher consumes `read_file` output. **Accepted implementation note**, not an open defect. `read_file` unchanged, as instructed.

**Full-suite flake.** One isolated 480/481 was observed during an earlier session and never reproduced (6 consecutive clean runs then, 3 more here, plus 20 targeted battery runs — **29 consecutive clean runs total**). Classified **isolated non-reproducible flake**, not a product failure. No test name was captured at the time; if it recurs, capture and quarantine before acting.

**Worktree hygiene.** `git worktree prune --dry-run` reports **7 stale metadata entries** from removed temporary worktrees (`co-false`, `co-true`, `forge-at-c41c901`, `N10`, `prod`, `v1`, `v2`). Five real worktrees remain registered, four holding dogfood-v1 branches. **Repository hygiene only — unrelated to product readiness.** Not pruned during this review, as instructed.

---

## 7. Known product limitations

| Limitation | Class | Status | Operating restriction |
|---|---|---|---|
| **Shell-only mutation** — a file changed exclusively via `run_shell` does not arm verification | **accepted daily-use limitation** | still true; never exercised in any of the four real runs (all mutations went through structured tools) | Review any run whose diff exceeds what the structured tools reported. Permission gating limits exposure; `auto-edit` mode confirms shell commands. |
| **Interrupted-run persistence** — a kill after filesystem mutation but before finalization persists no ledger or verification row | **accepted daily-use limitation** | unchanged; deliberately unsolved | Files are on disk and recoverable through Git. After an interrupted run, inspect `git status` / `git diff` manually — do not trust the absence of a ledger row. |
| **Missing declared checks** — projects with no safe typecheck/test/build script | **informational** | reports `verification_unavailable` honestly; invents nothing, installs nothing | Human review required for every change in such a project. |
| **Monorepo / nested roots** — project root is `cwd`; nested `package.json` files are not walked | **future enhancement** | current limitation | Run Forge from the directory whose `package.json` declares the checks you want. |
| **Task vs check completeness** — automated verification proves only the declared checks | **permanent distinction** | — | Always read the diff. A green run is not an accepted run. |

---

## 8. Daily-use operating envelope

| Category | Status | Conditions |
|---|---|---|
| Repository explanation | **APPROVED** | read-only |
| Code search & diagnosis | **APPROVED** | read-only |
| Test additions | **APPROVED** | evidenced twice live (001, 002) |
| Single-file fixes | **APPROVED** | declared checks present |
| Small multi-file features | **APPROVED WITH CONDITIONS** | ≤3 production files; read the full diff (T3 evidence) |
| Focused refactors | **APPROVED WITH CONDITIONS** | behaviour must be covered by declared tests |
| Declared-check verification | **APPROVED** | exact + qualified discovery verified |
| Bounded repair | **APPROVED** | ≤2 rounds, deterministically verified |
| Git inspection | **APPROVED** | read-only git tools |
| Shell commands | **APPROVED WITH CONDITIONS** | `auto-edit` (never `yolo`) for unfamiliar work; review shell-created mutations manually |
| Large files | **APPROVED WITH CONDITIONS** | 60 000-line fixture verified; prefer `edit_file`/`multi_edit`, reject a whole-file `write_file` on a large file |
| CRLF files | **APPROVED** | live-proven in Dogfood 002 |
| Dirty working trees | **APPROVED** | advisory-only `git diff --check`; user files never enter repair instructions |
| Projects without declared checks | **APPROVED WITH CONDITIONS** | status will be `verification_unavailable`; full human review required |
| Monorepos | **APPROVED WITH CONDITIONS** | run from the correct nested root |
| Deployment | **NOT YET APPROVED** | excluded by design |
| Destructive migrations | **NOT YET APPROVED** | excluded by design |
| Long autonomous tasks | **NOT YET APPROVED** | no live evidence beyond ~100 s; bound scope to 15–45 min |
| Cross-repository work | **NOT YET APPROVED** | one repository per run; no evidence |

---

## 9. Required owner procedure

1. **Start clean.** A dedicated branch or isolated worktree. Never a dirty canonical checkout.
2. **Run from the right directory** — the one whose `package.json` declares your checks.
3. **Confirm safe checks exist.** If none, expect `verification_unavailable` and plan to review everything yourself.
4. **Give one bounded, objective task.** ≤3 production files, 15–45 minutes, objectively checkable.
5. **Use `auto-edit`, not `yolo`,** unless you have read the exact commands the task will need.
6. **Read the coverage line.** `typecheck: not declared` means typechecking did not happen — it is not a pass.
7. **Read the diff.** Every changed path, every hunk. Verification proves the declared checks and nothing more.
8. **Judge acceptance separately** from verification status. Green checks ≠ task done.
9. **Review shell commands** and anything the diff shows that the structured tools did not report.
10. **Never delegate** deployment, publishing, destructive migrations, or credential handling.
11. **Preserve failed-run state** until inspected — do not `git checkout .` before reading it.
12. **Escalate to Claude Code** when Forge fails, verification is unavailable, scope grows beyond the brief, or your acceptance review fails.

---

## 10. Remaining risks

| Risk | Sev | Likelihood | Impact | Mitigation | Product change warranted? |
|---|---|---|---|---|---|
| Shell-only mutation escapes verification | **Medium** | Low — all 4 real runs used structured tools | Unverified change reported without an unverified notice | Review diffs; `auto-edit` gating | **Yes, eventually** — a `git status` baseline at run start would close it |
| Interrupted run leaves no accounting | Low | Low | Files on disk, no ledger row | Inspect `git status` after any interruption | Not yet — no observed instance |
| Task incomplete despite green checks | **Medium** | Moderate — inherent to declared checks | False confidence | Mandatory diff review; separate acceptance judgment | No — this is a property of automated checks |
| N7/N8 unproven under live load | Low | — | Guardrails deterministically verified but not live-loaded | Ordinary daily use will supply the evidence | No |
| Monorepo mis-rooting | Low | Moderate if used on one | `verification_unavailable` | cwd discipline | Future enhancement |
| Recurrence of the unreproduced flake | Low | Very low (29 consecutive clean runs) | Noise | Capture the name if it returns | No |

---

## 11. Verdict

**READY FOR DAILY USE WITH DOCUMENTED LIMITS.**

All load-bearing deterministic suites pass repeatably with zero flakes. Four real-provider runs were accurate, safe, cheap and honestly reported. No unresolved defect can cause ordinary bounded work on the approved structured-edit path to be falsely reported as verified. Every remaining gap has an explicit operating restriction, and repository recovery through Git remains available in all cases.

**EXISTING ROADMAP COMPLETE WITH ACCEPTED LIMITATIONS** — every planned milestone shipped and was independently verified; what remains are documented limitations with operating restrictions, not unfinished work.

**BRAIN PLANNING UNLOCKED** — no correction is required first; the daily-use procedure is documented; brain work begins as a separate phase, conversation and branch.

**Recommended immediate next action:** begin Forge Brain architecture planning as a separate phase and branch. Use Forge daily under the procedure above; the N7/N8 live gaps will close on their own the first time a real model makes a real mistake.
