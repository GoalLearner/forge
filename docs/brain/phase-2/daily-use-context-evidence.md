# Daily-Use Context Evidence — Candidate B Trigger Log

Standing config: constitution v1 ON, static project profile ON. This log collects the
evidence that decides whether Candidate B (task-specific context selector) is ever
re-opened. Documentation only — no runtime persistence, no migration.

**When to record a run** (not every conversation): context discovery caused noticeable
friction; a trigger may have fired; a real repository differed meaningfully from the
synthetic dogfood fixtures; Forge explored the wrong area; or the user had to point Forge
at the right file.

## Locked triggers (from candidate-b-decision.md — any ONE re-opens planning only)

1. ≥3 tasks each with ≥2 irrelevant pre-edit reads
2. ≥2 wrong-file / duplicate-basename explorations
3. ≥1 bounded task failing because the relevant file was not found
4. ≥1 monorepo/package confusion not prevented by the static profile
5. ≥2 runs reaching the context guard because of discovery reads
6. Median pre-edit tool calls ≥6 across ≥5 real-repository tasks (dogfood baseline: 2–3)
7. ≥3 user corrections of file selection

NOT sufficient: one anecdotal run, "want a smarter agent", roadmap ordering, a single
package.json rediscovery, or a subjective impression without tool evidence.

## Entry template

```markdown
### YYYY-MM-DD — <short task summary>
- Run/session ID:
- Repository: <name> (<type: single-package / monorepo / non-npm>, ~<file count>)
- Active project root:
- Pre-edit tool calls: <n>
- Project-fact rediscovery reads: <n> (<which>)
- Irrelevant pre-edit reads: <n> (<which>)
- Wrong-file / duplicate-basename exploration: <none | detail>
- Monorepo / nested-package confusion: <none | detail>
- User file-selection correction: <none | detail>
- Context-guard pressure: <none | warn | trim>
- Time to first useful edit: <s | n/a>
- Task acceptance: <met | not met | partial>
- Verification status: <passed | failed | unavailable>
- Trigger fired: <none | #N — detail>
- Evidence: <transcript/session ref or tool-sequence excerpt>
```

## Recurrence fields — record when a run FAILED or needed correction

Added by roadmap Amendment V1 (`roadmap-v1.md` → A2). These are **recorded by
hand**. The runtime does not aggregate failures, no storage was added, and
nothing here fires automatically.

Fill this block **in addition to** the entry template above whenever a run
produced a failure, an unavailable check, a repair round, or a substantive user
correction. Skip it for clean runs.

```markdown
- failure_class: <see list below>
- failure_signature: <normalized — see rule below>
- repository: <name>
- subsystem: <e.g. verification / shell / edit / profile / provider>
- environment_or_code: <environment | project_code | forge_runtime | task_specification | unknown>
- verification_outcome: <passed | failed | unavailable | not_applicable>
- repair_count: <n>
- user_correction: <none | detail>
- first_seen: <YYYY-MM-DD>
- last_seen: <YYYY-MM-DD>
- occurrence_count: <n>
- affected_commit: <short sha>
- evidence_link_or_path: <transcript ref / artifact path>
```

**`failure_class`** — a stable broad category, one of: `verification_readiness`,
`wrong_file_selection`, `process_settlement`, `provider_retry`,
`structured_edit`, `task_acceptance`, `stale_context`, `environment`,
`accounting`, `user_specification`.

**`failure_signature`** — a normalized description that must stay comparable
across runs. Exclude absolute paths, timestamps, random IDs, exact
temporary-directory names, and provider request IDs. Good:
`declared node --test check marked unavailable because node_modules absent`.
Bad: `C:\Users\...\Temp\forge-bench-20260726\scratch\A4\repo failed at 17:41`.

**`environment_or_code`** — separates "the machine was wrong" from "the code was
wrong". Finding 001 turned on exactly this distinction: an `environment` failure
was being persisted as a `project_code` failure.

## Recurrence thresholds

A **candidate finding** should be surfaced when any one of these holds:

1. the same normalized class/signature appears in **≥3 independent runs**;
2. the same failure appears in **≥2 different repositories**;
3. the user makes the same substantive correction in **≥3 sessions**;
4. a failure consumes repair attempts in **≥2 otherwise unrelated tasks**;
5. a **previously accepted limitation** starts occurring in normal daily use.

Crossing a threshold does exactly three things: surface a candidate finding,
link the supporting evidence, and recommend a bounded audit.

It must **not** edit the constitution, change permissions, modify the roadmap,
create source changes, promote autonomy, add a feature, or open Candidate B.
The required flow is:

```
evidence collected → threshold reached → candidate finding surfaced
  → human review → explicit authorization → bounded correction
```

This is deliberately **not** an autonomous self-improvement backlog.

## Recurrence tally

| failure_class | Occurrences | Repos | Candidate finding? |
|---|---|---|---|
| verification_readiness | 1 (finding 001, closed) | 1 | no — resolved at `3877c47` |

## Running tally

| Trigger | Count so far | Threshold |
|---|---|---|
| 1. Tasks with ≥2 irrelevant pre-edit reads | 0 | 3 |
| 2. Wrong-file explorations | 0 | 2 |
| 3. Task failed — file not found | 0 | 1 |
| 4. Monorepo confusion | 0 | 1 |
| 5. Context-guard from discovery | 0 | 2 |
| 6. Median pre-edit calls ≥6 (across ≥5 tasks) | n/a | see trigger |
| 7. User file-selection corrections | 0 | 3 |

## Entries

### 2026-07-29 — slugify maxLength option (bounded feature + tests)
- Run/session ID: forge headless, fresh FORGE_HOME (`Temp/slugify-daily/home`), $0.00604, 13 requests, cache 92%
- Repository: slugify-kit fixture (single-package npm, zero-dependency, ~5 files, baseline `276109e`)
- Active project root: `.` (correct)
- Pre-edit tool calls: 3 (read src/slugify.js, test/slugify.test.js, package.json)
- Project-fact rediscovery reads: 1 (package.json — justified: profile marked the declared
  `test` script *unavailable* because node_modules is absent, so inspecting the script body
  was reasonable)
- Irrelevant pre-edit reads: 0
- Wrong-file / duplicate-basename exploration: none
- Monorepo / nested-package confusion: none
- User file-selection correction: none
- Context-guard pressure: none
- Time to first useful edit: 12.9s
- Task acceptance: met (independent probes 8/8, tests 7/7, scope exact — only the two
  permitted files changed; surgical edits; nothing committed)
- Verification status: unavailable (honest) — gate declined to run the declared `test`
  script because node_modules is absent and Forge never installs; the model separately ran
  `node --test` itself and reported real results; one transient provider retry (1/4)
- Trigger fired: **none**
- Evidence: `Temp/slugify-daily/forge-run.log` (timestamped tool sequence)
- Learning (not a trigger): for **zero-dependency** repos, the node_modules-absent
  unavailability rule is conservative — `node --test` runs fine without installing. A
  future narrow verification-discovery refinement could treat "no dependencies declared"
  as runnable; noted only, not scheduled.
- **Correction (finding 001 adjudicated):** the package.json read stays classified
  `project_fact_rediscovery`, but the original "justified" framing is refined: the read was
  *induced by a verification-readiness false negative*, not by a profile gap — the gate
  (and therefore the profile) wrongly marked the declared zero-dependency `node --test`
  check unavailable solely because node_modules was absent. Adjudicated result: task
  accepted; claim honesty passed; **verification readiness false negative found**
  (reproduced at `verification.ts` — blanket node_modules rule); Candidate B trigger NOT
  fired; narrow verification correction opened and fixed on
  `fix/verification-zero-dependency-checks` (`classifyDeclaredCheckReadiness`: direct-node
  scripts in dependency-free packages are runnable; package binaries/npx/composed commands
  and dependency-declaring packages remain unavailable). The original run result stands.
- **Second correction (finding 001 v2):** `beb9413` fixed the basic npm happy path, but
  independent verification found two gaps in it, both because the *inspected* script body is
  not the *executed* command. (1) **Lifecycle hooks:** `npm test` also runs `pretest`/
  `posttest`, so `pretest: vitest` executed and exited 1. (2) **Package manager:** a
  pnpm-lock repo emitted `pnpm run test` on a machine without pnpm. Both persisted an
  **environment failure as a project-code failure** (`status: failed`) — worse than the
  false-unavailable they replaced — so **finding 001 remained open**. The v2 correction
  classifies the effective npm lifecycle chain (`pre<S>`, `S`, `post<S>`, one level only)
  and restricts the zero-dependency exception to unambiguous npm, plus conservative
  dependency-shape handling (`null`/array/primitive metadata no longer counts as
  dependency-free, and no longer crashes into a bogus "could not be parsed"). Unavailable
  now means unavailable: zero commands execute and nothing is persisted as failed.
  **Candidate B still did not fire** — none of this is context selection. The **static
  profile remained correct throughout**: it has no readiness logic of its own and mirrored
  the canonical plan exactly at every step, including while the plan was wrong.
