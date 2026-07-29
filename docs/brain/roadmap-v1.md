# Forge Brain — Roadmap V1

**Status:** design. Conservative and evidence-gated. Not all proposed
components should necessarily be built; each phase must earn the next.

---

## Candidate first slices (compared)

| Candidate | User value | Cache-prefix risk | Provider-request risk | Testability | Model dependence | Coding effect | Freedom effect | Migration | Dogfood safety | Rollback |
|---|---|---|---|---|---|---|---|---|---|---|
| **A. Constitution + refusal layer** | High — the headline "candid, low-refusal" behavior | **Low** — static text, added once to the frozen prefix, stays cached | **Low** — string only | **High** — labeled corpus, 6 levels | Medium — hosted model may still filter | Neutral | **Direct** | **None** | Safe — conversation only, no new execution | **Trivial** — revert `prompt.ts` string |
| B. Project-context foundation | High — better patches | Low if in the tail | Low | Medium | Low | **Direct** | Neutral | None (grep/glob) or one table | Safe-ish | Easy |
| C. Task/acceptance model | Medium — better self-assessment | Low | Low | Medium | Medium | Indirect | Neutral | Additive JSON | Safe | Easy |

### Recommended first slice: **A — Constitution + refusal-decision layer**

Justified from the existing code, not preference:

1. **It is the north star's actual headline.** The whole reason brain work was
   unlocked is the "candid, truth-seeking, minimal-refusal" posture. A delivers
   that directly; B and C improve coding, which the daily-use review already
   rated APPROVED.
2. **`prompt.ts` is already the exact, cache-safe seam.** The constitution is
   static text appended to a function that is called once and frozen. The 50–120×
   cache cliff — Forge's founding cost thesis — is *not touched*, because static
   prefix text stays cached. B and C risk introducing per-turn context that must
   be placed carefully to avoid that cliff.
3. **Lowest blast radius.** A changes one string-building function and adds a
   behavioral-decision helper. No new table, no loop change, no tool change, no
   permission change. Rollback is reverting a string.
4. **It is the most testable in isolation.** The 6-level taxonomy maps to a
   labeled corpus with deterministic expected levels; B/C need coding fixtures
   and human patch-rating.
5. **It respects the plane boundary by construction.** A lives entirely in the
   cognitive plane and cannot reach an execution control even if it wanted to.

The honest caveat: A's ceiling is capped by the hosted provider's own filters
(constitution §7). That is a *reason to start it now* and learn where DeepSeek's
limits actually bite, informing the later local-model decision — not a reason to
defer.

---

## Phase sequence

Each phase carries: user value · scope · exclusions · dependencies · files
likely affected · new data structures · tests · dogfood task · success metrics ·
rollback · exit criteria · independent-verification gate.

### Phase 1 — Constitution + refusal layer *(recommended first)*

- **Value:** the candid, low-refusal posture; correct provider-refusal attribution.
- **Scope:** constitution text into the frozen system prompt; a pure
  `behavioralDecision(request) → level` helper used for evaluation and, if
  warranted, light response shaping.
- **Exclusions:** no per-turn prompt changes; no execution-policy change; no
  memory; no routing.
- **Dependencies:** none.
- **Files likely affected:** `agent/prompt.ts` (add a constitution section),
  possibly a new `agent/constitution.ts` (pure, no I/O).
- **New data structures:** `RefusalDecision`, `BehavioralDecision` (in-memory).
- **Tests:** labeled-corpus eval for all six levels; **prefix-byte-stability
  test proving the constitution stays cached**; no regression of 481.
- **Dogfood:** a conversational session across the B/C corpus + one coding task,
  confirming coding behavior is unchanged.
- **Success metrics:** eval suites A (truthfulness), B (freedom), C (hard-stop
  precision) all pass; cost per request unchanged (cache intact).
- **Rollback:** revert the `prompt.ts` string and delete `constitution.ts`.
- **Exit criteria:** B and C both green; 481 unchanged; measured request cost flat.
- **IV gate:** independent review of the constitution + a fresh corpus run.

### Phase 2 — Project-context foundation

- **Value:** better patches through relevant context, no global index.
- **Scope:** grep/glob-based bounded context selection with explanation; read at
  run start, placed in the conversation tail (not the frozen prefix).
- **Exclusions:** no vector DB, no embeddings, no persistent global index, no cloud.
- **Dependencies:** existing `fs-read`, `search`, `PathJail`.
- **Files:** new `agent/context-selector.ts`; a hook before request assembly.
- **Data:** `ContextCandidate`, `SelectedContext` (per-run JSON).
- **Tests:** context-precision fixtures; **prefix-stability test** (selection
  must land in the tail); no 481 regression.
- **Dogfood:** a multi-file task where context selection should help.
- **Metrics:** D-suite context precision ≥ 70%, patch correctness up or flat.
- **Rollback:** disable the hook (feature flag), selection is additive.
- **Exit:** context precision gate met, cost within 1.5×.
- **IV gate:** independent review of selection + cache measurement.

### Phase 3 — Task & acceptance model

- **Value:** explicit acceptance criteria; the permanent verification-vs-acceptance split becomes first-class.
- **Scope:** intent classification + acceptance extraction, recorded per run.
- **Exclusions:** no planning yet.
- **Files:** new `agent/intent.ts`; additive `run_ledgers` key.
- **Data:** `TaskIntent`, `AcceptanceCriterion`.
- **Tests:** intent-classification fixtures; evaluator uses recorded criteria.
- **Metrics:** E/H acceptance judgments improve; no regression.
- **Rollback:** additive JSON key, ignore on read.

### Phase 4 — Verified project memory

- **Value:** durable, evidenced project facts across sessions (the M2 the TUI already promises).
- **Scope:** `memory_records` table (additive migration); remember/forget/inspect/disable controls; per-project scope.
- **Exclusions:** no global cross-project memory; no cloud sync; no training.
- **Files:** `session/db.ts` (additive table), new `session/memory.ts`, CLI/TUI controls.
- **Data:** `MemoryRecord` (see below).
- **Tests:** recall, source fidelity, staleness invalidation, scope isolation, migration.
- **Metrics:** E-suite gates.
- **Rollback:** table is additive; disable reads.

### Phase 5 — Planner & progress controller

Bounded plans, evidence tags, repeated-failure/scope-growth detection —
subordinate to ceilings. Only after context + acceptance exist.

### Phase 6 — Skill system

Reusable procedures with allowed-tools + required-verification. Depends on
context + planner.

### Phase 7 — Experience retrieval

`experience_records` of *verified* trajectories. Depends on acceptance +
memory patterns being proven.

### Phase 8 — Model adapter / capability profiles *(interface only)*

Document a profile per model; still no automatic routing.

### Phase 9 — Local / fine-tuned model *(conditional, not scheduled)*

Considered **only if** committed evidence shows hosted-provider filters
materially block legitimate Phase-1 behavior, AND execution safety can be held
identical. Never a default.

---

## Global rollback boundary

Every phase is additive or feature-flagged, never a rewrite of a trustworthy
component. The 481-test suite is the floor: no phase ships that regresses it.
Any phase that would touch `messages.ts` prefix assembly, a permission gate, or
a run ceiling is out of scope by definition.

## Condition for a local model

Documented, not scheduled: a Phase-1 corpus run where hosted DeepSeek refuses or
filters ≥ some material fraction of Level-1 legitimate requests, reproducibly,
with attribution — combined with a plan that keeps the entire execution plane
byte-identical. Until both hold, hosted models stay.
