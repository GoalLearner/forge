# Forge Brain Phase 2 — Evaluation Plan (Static Project Profile)

Two layers: deterministic tests (the bulk of confidence, since the profile is pure) and a small
real-provider dogfood (does the profile actually help the model). Paired control/treatment is
used only where its cost is justified.

---

## 1. Deterministic suite (primary)

Assert against fixtures, no provider calls:

- **Package-manager detection** — npm/pnpm/yarn/bun from lockfile + `packageManager` field;
  `unknown` when absent (never guessed).
- **Declared-check extraction equals the gate** — the profile's checks are byte-equal to what
  `verification.ts` would select for the same `package.json` (shared-source test).
- **Source/test root discovery** — `src/`, `test/`/`tests/`/`__tests__/`, `*.test.*` co-location;
  correct on the fixtures below.
- **Nested-project detection** — inner `package.json`s found to depth 2; deeper summarized as a
  count.
- **Ignore generated & dependency dirs** — `node_modules`, `dist`, `build`, `.git`, coverage,
  and `.gitignore`d paths never appear as source/test roots.
- **Stable ordering** — identical bytes across repeated runs and across two different `cwd`
  strings pointing at the same tree (determinism).
- **Byte budgets** — every budget in `architecture.md` §4 enforced; over-budget lists show an
  explicit omitted-count, never silent truncation; high-priority facts never dropped.
- **No nonexistent paths** — every emitted path exists on disk in the fixture.
- **Staleness field** — `applicabilityHash` present and changes when a relevant file changes.
- **Constitution ordering unchanged** — extend `prompt-constitution.test.ts`: constitution stays
  byte-identical and before `projectProfile`, which is before `# Project conventions`.
- **Execution plane untouched** — a test asserting no permission/ceiling/verification symbol is
  imported or altered by the profile module (module-boundary test).
- **Prefix stability** — with a profile present, `prefixFingerprint()` is identical across
  simulated turns (the cost-thesis regression guard).

## 2. Synthetic fixtures

- Single-package TypeScript project (the common case).
- Nested package (one inner `package.json`).
- Small monorepo (2–3 workspaces).
- Source/test pair (`src/x.ts` + `src/x.test.ts`).
- Large generated directory (must be ignored).
- Ambiguous duplicate filenames across roots.
- Missing/empty `package.json` scripts (checks → `unknown`, no crash).
- CRLF project files (parsing + byte budget unaffected — reuses the Phase-1 CRLF lesson).

## 3. Real-provider dogfood (secondary, small)

On the Forge repo itself and one external fixture, `deepseek-v4-pro`, `safe` mode:

Measure, profile **off** vs **on**:
- Tool calls before the first useful edit (expect fewer with the profile).
- Count of `read_file`/`list_dir` calls that only rediscover structure (expect fewer).
- Context tokens added by the profile (expect ≤ budget, cached after turn 1).
- Task success + verification pass (expect flat or better — must not drop).
- Latency and provider cost (expect cache-stable; no prefix regression).
- **Did the profile mislead?** — inspect for any edit/claim that followed a profile fact the
  model should have re-checked (expect none; the profile is orientation, not authority).

Use a paired control/treatment run **only** for the "misled the model" and success axes if a
single-arm read is ambiguous; otherwise a single annotated dogfood session per fixture suffices
for a static, deterministic profile. Apply the Phase-1 adjudication lessons: symmetric
cold/warm cache prep, no unscored preflight that warms one arm, and report per-token as well as
wall-clock latency.

## 4. Pass/fail gates

- All deterministic tests green; **531 baseline unchanged**.
- Prefix fingerprint stable across turns (hard gate — a regression aborts the slice).
- Profile within every byte/time budget; zero fabricated paths across all fixtures.
- Declared checks match the verification gate on every fixture.
- Dogfood: rediscovery reads **down or flat**, task success **flat or up**, no misleading-fact
  incident, no cache regression.

Fail on any: fabricated path, prefix regression, 531 regression, execution-plane change required,
or a dogfood case where the profile caused a wrong edit.
