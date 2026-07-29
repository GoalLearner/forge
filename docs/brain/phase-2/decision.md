# Forge Brain Phase 2 — Decision Record

**Task:** go/no-go and scope freeze for a bounded project-context foundation.
**Base:** constitution commit `16ef34b` (531/531 tests verified green in a clean detached
worktree: typecheck + build + `node --test` all pass, exit 0). Planning only — no source
changed, no Phase 2 code exists.

---

## Decision

**GO — STATIC PROJECT PROFILE.**

Approve only a deterministic, session-static project profile injected once into the frozen
system prefix. **Defer** the task-specific context selector (roadmap Candidate B) to a later
slice that builds on this one. This follows the evidence, and it deliberately **diverges from
the roadmap's Phase-2 label** ("grep/glob task-specific selection in the conversation tail")
— justification in §4.

## 1. Evidence reviewed

- `docs/brain/architecture-v1.md`, `roadmap-v1.md`, `data-models-v1.md`,
  `decision-record-v1.md`, `constitution-v1.md`, `evaluation-v1.md`.
- Phase 1 evaluation `d8cf4bd` + adjudication `47eeffc` (constitution shipped; freedom up,
  safety intact; cache/cost lessons: prefix stability is the cost thesis).
- Production context path at `16ef34b`: `agent/prompt.ts`, `agent/messages.ts`,
  `agent/truncate.ts`, `agent/verification.ts`, `cli.tsx`, `desktop/main.ts`, `headless.ts`.

## 2. The problem, from code (not invented)

1. **The frozen `# Environment` block is thin.** `prompt.ts:79–87` gives the model cwd,
   platform, shell, a git yes/no, permission mode, and the tool list — but **not** the package
   manager, declared scripts, source/test roots, language, or nested-package roots. The model
   rediscovers these every session with `list_dir` / `read_file` on `package.json`.
2. **Declared checks are already computed — but hidden until failure.** `verification.ts:526–641`
   deterministically reads `package.json` and selects the project's safe typecheck/test/build
   scripts. That discovery runs only at the **post-mutation verification gate**, so the model
   commonly learns a project's own checks as a *surprise gate failure*, not up front. Surfacing
   the same facts proactively reuses existing pure code and removes the surprise.
3. **`projectDoc` is the only project context today, and it is optional.** `readProjectDoc`
   loads `AGENTS.md`/`CLAUDE.md`/`.forge/AGENTS.md` into the frozen prefix (`cli.tsx:229`,
   `desktop/main.ts:216`). Repos without one give the model zero project orientation beyond the
   thin environment block.
4. **Two independent prompt-construction sites.** `buildSystemPrompt` is called separately in
   `cli.tsx:236` and `desktop/main.ts:212` (headless consumes a pre-built `Conversation`). A new
   context step added per-site will drift across front ends — the exact bug class `MutationState`
   and `RunLedger` each had to fix. It must live in one shared helper.

This is concrete, code-sourced evidence — not a problem invented to justify the roadmap.

## 3. Candidate comparison

| Criterion | A. Static profile | B. Task selector (tail) | C. Hybrid | D. No-go |
|---|---|---|---|---|
| Immediate coding value | High (kills rediscovery + surprise checks) | High (relevance on multi-file tasks) | Highest | None now |
| Conversational value | Low–med | Low | Low–med | — |
| Complexity | **Low** | Med–high | High | Zero |
| Testability | **High** (fully deterministic) | Medium (needs judgment/ranking) | Medium | — |
| Cache-prefix risk | **Positive** (session-static → prefix, full discount) | Low (tail) but per-turn cost | Mixed | None |
| Context-window cost | Tiny (~1–2 KB once) | Variable per task | Larger | None |
| False-context risk | **Very low** (facts from Git/fs/package.json) | Medium (selection can mislead) | Medium | None |
| Staleness risk | Low (session-static; model can re-read) | Low | Low | None |
| Monorepo behavior | Explicit (nested roots as facts) | Harder (which root?) | Explicit | — |
| Rollback | **Trivial** (flag / revert one field) | Easy | Medium | — |
| Hidden-planner risk | **None** | **Real** (selection ≈ planning) | Real | None |
| Solo-maintainer burden | **Low** | Med | High | Low |

## 4. Why A, and why it diverges from the roadmap label

The roadmap's Phase 2 is Candidate B (per-task grep/glob selection in the tail). Following the
evidence, **A is the smaller, safer, higher-value-per-risk first foundation**, for four reasons:

1. **A is session-static, so it belongs in the frozen prefix, not the tail.** The tail rule
   (`prompt.ts:14`, `messages.ts`) exists for *per-turn dynamic* content. A project profile has
   the same volatility class as `projectDoc` and the environment block — both already in the
   frozen prefix. Placing it there earns the full 50–120× cache discount instead of paying a
   per-turn tail cost. This is a cache-*positive* refinement of the roadmap, not a violation.
2. **A carries no model judgment.** B's per-task selection is, structurally, a proto-planner —
   exactly the risk the plane boundary warns against. A is pure facts; it cannot become a hidden
   planner.
3. **A reuses code that already exists.** The declared-check discovery in `verification.ts` is
   already pure and deterministic; A surfaces it, it does not invent it.
4. **A is the foundation B needs anyway.** A task selector should rank *within* a known project
   structure. Build the structure first; add selection later, on top, once A's facts exist.

B remains a legitimate later slice (Phase 2b), built on A, living in the tail, gated by its own
precision evaluation. C (both at once) is rejected as too large for a first slice. D is rejected
because the evidence in §2 is concrete.

## 5. Product implications

- The daily coding experience improves (less rediscovery, no surprise-check failures) at
  effectively zero cache cost.
- The constitution and the entire execution plane are untouched (see `architecture.md` §
  protected invariants).
- Scope stays small enough for a solo maintainer to ship, test, and roll back in one slice.

## 6. Explicit non-goals

Durable memory, model-written notes, cross-session learning, embeddings, vector DBs, semantic
indexes, cloud retrieval, planners/plan execution, skills, experience replay, model routing,
fine-tuning, multi-agent orchestration, background indexing, repository writes during context
construction, automatic shell execution, permission changes, loop-ceiling changes, verification
changes, and any system-prompt **constitution** change. Also explicitly out: **per-task /
model-judgment context selection** (that is deferred Candidate B).
