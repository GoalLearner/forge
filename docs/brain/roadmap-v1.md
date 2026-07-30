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

---

# Amendment V1 (2026-07-30) — verification, recurrence, memory

Recorded after reviewing an external write-up on building a personal AI agent.
The article describes a *business assistant configured on top of* a coding
runtime; Forge *is* the runtime, so most of its advice is out of category. Three
adjustments were adopted, one candidate deferred, and several recommendations
explicitly rejected. **No production behaviour changed with this amendment.**

Everything below is either **BINDING POLICY**, **DESIGN CONSTRAINT**,
**DEFERRED — EVIDENCE REQUIRED**, or **NON-GOAL**. Nothing below describes an
implemented capability.

## Why the rejections are economic, not stylistic

Forge's thesis is a dependable daily coding agent at a fraction of the cost of a
flat-rate subscription. That depends on six properties, and each rejection in
§A4 protects at least one:

- a **byte-stable cached prefix** (the 50–120× discount on DeepSeek);
- **bounded, deterministic project context**;
- **on-demand retrieval** rather than speculative loading;
- **evidence-gated execution**;
- **honest verification** — never a pass that was not run;
- **low marginal provider cost** per request.

Advice written from inside a flat-rate model treats context as free. It is not
free here, which is why several widely-repeated recommendations are rejected
below rather than deferred.

## A1. Independent-verification policy — BINDING POLICY

Supersedes the per-phase "IV gate" lines above, which remain accurate about
*what* is reviewed; this defines *how independent* the reviewer must be. Tier is
chosen by what the change can break, not by diff size.

### Tier 1 — routine bounded task

Small features, focused bug fixes, regression tests, one-to-three-file changes,
UI work inside the approved envelope.

Required: declared checks · deterministic validation · human diff review · a
task-acceptance judgment recorded **separately** from verification status.
A different verification model is **not** mandatory.

### Tier 2 — core runtime or trust-boundary change

Verification semantics, process settlement, cancellation, retry/repair, cost and
accounting truthfulness, permission behaviour, repository safety, memory
correctness rules, provider-boundary behaviour.

Required: a **frozen** verification protocol · the verifier may not modify source
· full diff inspection · independently constructed or external fixtures · real
command execution · inspection of persisted state where applicable · implementer
and verifier identities recorded. **A different model family is strongly
preferred.**

### Tier 3 — phase closure or envelope expansion

Brain-phase closure, execution-safety closure, permission-envelope expansion,
autonomous-boundary expansion, daily-use readiness decisions, long-horizon
autonomy approval, memory-system acceptance.

Required: **a different model family from the implementer** · frozen protocol ·
no source modification · direct diff inspection · external and adversarial
fixtures · real execution · explicit findings and a closure classification.

### Same-model exception

A same-model verifier is permitted at Tier 2, and at Tier 3 **only when another
model is genuinely unavailable**, provided all of the following hold:

1. same-agent or same-model status is **disclosed** in the report;
2. the verification is explicitly marked a **process limitation**;
3. evidence is strengthened with adversarial external fixtures and direct
   execution rather than reasoning alone;
4. the limitation is weighed during final acceptance.

A Tier 3 verification taken under this exception **must not be described as
fully independent**, and the closure record must state the accepted limitation.

### Scope of this policy

Different-model verification is an **evaluation policy, not a production
architecture**. It authorises no council, no parallel coding agents, and no
autonomous delegation. Model diversity alone is not evidence: a second model
that inspects nothing adds nothing.

## A2. Recurring-failure evidence — BINDING POLICY (manual)

Recorded in `phase-2/daily-use-context-evidence.md`. Recurrence is captured **by
hand**; the runtime does **not** aggregate failures and no storage was added.
Crossing a threshold surfaces a *candidate finding* for human review — it never
edits the constitution, changes permissions, alters this roadmap, writes source,
promotes autonomy, or opens Candidate B.

## A3. Verified memory — DESIGN CONSTRAINT (Phase 4, unimplemented)

See `data-models-v1.md` → *MemoryRecord*. Forge does **not** commit now to
markdown-only or database-only memory; the direction is hybrid — a canonical
structured store with markdown as views and as a candidate-memory inbox. Memory
content must never be loaded automatically into the stable prefix.

## A4. Explicit rejections — NON-GOALS

**Multi-agent council architecture.** No agent councils, parallel coding agents,
mandatory strategist/devil's-advocate agents, autonomous delegation, agent
voting, or multi-agent edit reconciliation. Reasons: cost multiplication,
context duplication, ownership ambiguity, conflicting edits, settlement
complexity, unclear verification attribution, reconciliation risk. A separate
verifier on a different model (§A1) is not a production multi-agent system.

**Fail-open context loading.** Rejected: *"when uncertain, load more context."*
Forge's policy remains **retrieve narrowly, and only when justified**. Reasons:
provider cost, cache degradation, latency, stale-fact risk, instruction
dilution, reduced reproducibility, context-window pressure. Protected: the
bounded static profile, the stable prefix, on-demand task-specific retrieval.

**Dynamic session metadata in the stable prefix.** No automatic injection of
current time, date, day of week, machine identity, session ID, or changing task
counts. `agent/prompt.ts` already forbids this; a per-request clock is a silent
50–120× cost regression. Dynamic facts may be supplied *outside* the stable
prefix when a task genuinely needs them.

**Automatic earned privilege.** Forge may never expand its own authority. The
only permitted flow is: successful evidence → Forge *proposes* a permission
change → the user explicitly approves → a visible policy update.

**Self-scored refinement as verification.** Model-generated scores ("8/10",
"continue until satisfied") are not completion evidence. Iteration is triggered
only by a declared-check failure, a deterministic evaluator failure, an unmet
acceptance criterion, human rejection, or an explicit bounded refinement request.

**Proactive unsolicited repository changes.** No autonomous source edits, branch
creation, feature implementation, or roadmap changes based on an observation
alone. A future read-only observation system may record evidence, attach
confidence, and surface a candidate task — it may not act without authorisation.

**Autonomous self-maintained backlog.** No agent-controlled backlog that silently
reorders Forge's priorities. Recurring evidence may produce a proposed finding;
roadmap changes remain a human decision.

## A5. Project-profile drift warning — DEFERRED — EVIDENCE REQUIRED

A possible future use of the existing profile fingerprint: capture it at session
start, recompute relevant project facts before verification or session
resumption, compare, and warn **only** when meaningful facts changed (e.g.
package.json or the declared verification commands). Constraints if it is ever
built: no time, weekday, or machine identity injection; no freshness banner on
every response; live verification stays authoritative. **Build only after real
daily-use drift produces evidence for it.** Not implemented; no such warning
exists today.

## A6. Roadmap state after this amendment

| Item | Status |
|---|---|
| Trustworthy execution | COMPLETE |
| Daily-use reliability envelope | COMPLETE |
| Brain Phase 1 — constitution | COMPLETE |
| Brain Phase 2 — static project profile | COMPLETE |
| Daily real-project use | CURRENT |
| Candidate B — task selector | DEFERRED, pending the existing triggers |
| Verified memory (Phase 4) | NOT IMPLEMENTED |
| Long-horizon planner (Phase 5) | NOT IMPLEMENTED |
| Autonomous supervisor | SEPARATE FUTURE PROGRAM |
| Multi-agent council | NON-GOAL |

Recurring-failure counting is **not** a new Brain phase — it is an evidence
practice. This amendment moves Candidate B neither forward nor backward: an
article is not daily-use evidence, and only the locked triggers can reopen it.

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
