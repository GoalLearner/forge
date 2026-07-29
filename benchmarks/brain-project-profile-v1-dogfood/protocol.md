# Protocol — Forge Brain Project Profile V1 Real-Provider Dogfood

Frozen before any completion request. Not amended after execution begins.

## Arms

- **CONTROL** — Forge `16ef34b4505644119f37356986429ce68284a0e9` (constitution v1, **no
  project profile**). 531/531 tests verified in its clean detached worktree.
- **TREATMENT** — Forge `9ce342e58e56ac23e7c3722d45f317862b05c9df` (constitution v1 +
  static project profile via the normal production path). 582/582 tests verified ×3 in its
  clean detached worktree. The treatment's optional-field off seam is **not** used as the
  control; the real control commit is.

## Fixtures

Four deterministic Git-committed fixture repos outside OneDrive (`pf-fixtures/p1..p4`),
manifests + per-file SHA-256 + tree hashes in `fixture-manifest.json`; frozen prompts +
SHA-256 in `tasks.jsonl`. Baselines verified green before freeze (P1 typecheck+3/3, P2
typecheck+3/3 via `test:unit`, P3 typecheck+2/2, P4 evaluator check ok). Fixtures p1–p3
carry a `node_modules` **junction** to the Forge repo's install (documented shared local
TypeScript dependency; `.gitignore`d, recreated per run copy). No dependency installation
occurs during official execution.

**Documented deviation:** the task spec named `pnpm-lock.yaml` for P2, but this machine has
no pnpm; a pnpm lockfile would make the gate emit `pnpm run …` commands that fail for BOTH
arms as an environment error. P2 therefore uses npm (`package-lock.json`) while preserving
its binding purpose: a qualified `test:unit` fallback with **no exact `test` script**.

## Execution

8 scored runs = 4 fixtures × 2 arms, arm order per `schedule.json` (P1 C→T, P2 T→C, P3
C→T, P4 T→C). No reruns; no follow-up turns; no manual help. Per run: fresh `git clone` of
the fixture (tracked files only) + fresh junction + fresh `FORGE_HOME`; headless CLI
`dist/cli.js -p <frozen prompt> --model deepseek/deepseek-v4-pro --permission-mode yolo --cost`
from the arm's own build. Permission mode is **yolo in both arms equally**: headless
auto-denies interactive approvals, so a mutation dogfood cannot run in safe/auto-edit; the
fixtures are disposable clones and changed paths are audited after every run. Default
production ceilings; same model both arms.

**No unscored completion may occur before or during the schedule.** The only provider
pre-check was one authenticated non-completion `GET /models` (HTTP 200). The first official
call of each arm is its cold observation; its remaining three are warm-state.

## Treatment profile pre-capture

Before dispatching each treatment case, the rendered profile for the fixture cwd is
captured read-only (no provider contact) and checked against fixture facts: no fabricated
fact, no absolute path, correct active root, no child check advertised as active, declared
checks equal `buildVerificationPlan`, ≤2,048 bytes. A wrong profile stops that case →
`BLOCKED_BY_PROFILE_DEFECT`.

## Evidence

Per run: timestamped stdout (ordered tool sequence), terminal repo `git status`/`diff`,
ledger row (attempts, cache-hit/miss/output/reasoning tokens, cost state, nanodollars),
verification summary, duration, exit code. Artifacts bounded under `artifacts/<arm>/<fixture>/`.

## Stop conditions

Changed paths outside the fixture clone · surviving process after settlement · provider
attempt absent from the ledger · credential in output · treatment profile defect (above).
A provider/network failure before a model response marks that run unavailable, not scored,
and is not rerun.

## Scoring

`scoring.md`. Read-purpose and profile-helpfulness are scored from an **arm-blinded**
evidence view (tool sequence, timings, changed paths, final diff, verification evidence;
profile text and arm/commit identifiers stripped) before unblinding; scores locked before
comparison. Response/tool style may make the arm inferable — disclosed, not curable.
