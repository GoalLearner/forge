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
