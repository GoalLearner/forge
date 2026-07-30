# Forge Brain — Architecture V1

**Status:** design only. Nothing here is implemented.
**Base:** production commit `9651f1e`, 481/481 tests passing.

---

## 1. Current architecture (audited, not assumed)

49 production source files. The lifecycle, traced through `9651f1e`:

```
user input
  → cli.tsx / desktop/main.ts / headless.ts      entry points
  → SessionStore.create|resume                    session/store.ts
  → buildSystemPrompt(ctx)                        agent/prompt.ts    ← BUILT ONCE, FROZEN
  → buildTools() + toolSchemas()                  tools/index.ts     ← sorted by name
  → Conversation.buildRequest()                   agent/messages.ts  ← byte-stable prefix
  → provider.stream()                             providers/openai|anthropic.ts
  → withRetry(shared RetryBudget)                 providers/retry.ts
  → parseToolArguments()                          agent/json-repair.ts
  → PermissionManager.check + assessCommand       safety/permissions.ts, safety/danger.ts
  → tool execute (PathJail, FileTracker)          tools/*.ts, safety/paths.ts
  → MutationState.recordMutation()                agent/verification.ts
  → verification gate + bounded repair            agent/loop.ts:594+
  → AgentRun terminal reason                      agent/run.ts
  → RunLedger.finalize + saveRunLedger            session/ledger.ts, session/store.ts
```

### Key components and sizes

| Concern | File | Lines |
|---|---|---|
| Agent loop + verification gate | `agent/loop.ts` | 1331 |
| Verification, plan, repair | `agent/verification.ts` | 899 |
| Usage/cost ledger | `session/ledger.ts` | 720 |
| Shell + process-tree kill | `tools/shell.ts` | 572 |
| Run envelope, budgets, reasons | `agent/run.ts` | 557 |
| Session persistence | `session/store.ts` | 520 |
| Structured edits | `tools/fs-write.ts` + `edit-match.ts` | 558 |
| Cache-stable assembly | `agent/messages.ts` | 230 |
| **System prompt** | **`agent/prompt.ts`** | **100** |

### Extension seams that already exist

1. **`buildSystemPrompt(ctx: PromptContext)`** — one pure function, called once
   per session, returns a string. It already accepts `projectDoc` (AGENTS.md /
   CLAUDE.md, read at startup by `cli.tsx:343` and `desktop/main.ts:1209`).
   **This is the constitution's natural insertion point** and it is already
   cache-safe by construction.
2. **`buildTools({ todoStore, disabled })`** — registry construction with an
   explicit disable list.
3. **`MutationState`** — already a per-run cognitive-ish object with generation
   tracking; the planner and evaluator can observe it without modifying it.
4. **`RunLedger`** — per-run accounting with a persisted JSON summary; the
   `verification` key was added additively, proving the pattern.
5. **SQLite additive migration** — `PRAGMA table_info` probe + `CREATE TABLE IF
   NOT EXISTS` in `session/db.ts:128`. Four tables today: `sessions`,
   `messages`, `usage`, `run_ledgers`.

### Areas too tightly coupled to build on naively

- **`agent/loop.ts` (1331 lines)** holds streaming, tool dispatch, permission
  gating, mutation recording, the verification gate and repair in one generator.
  Brain components must attach at its *edges* (before request assembly, after
  terminal decision), not by threading new state through its middle.
- **Three entry points duplicate session construction** (`cli.tsx`,
  `desktop/main.ts`, `headless.ts`). Any brain state must be constructed in one
  shared place or it will drift across front ends — the exact bug class the
  ledger and MutationState each had to fix.
- **`prompt.ts` frozen-once contract** is a hard constraint, not a style choice.

---

## 2. Protected invariants (never weakened by brain work)

| Invariant | Where | Why |
|---|---|---|
| System prompt built once, frozen for the session | `agent/prompt.ts:1-15` | A per-turn interpolation costs 50–120× on every request |
| Byte-stable request prefix | `agent/messages.ts` | Prompt caching is a prefix byte match, not semantic |
| Tool schemas sorted by name; registry frozen at construction | `tools/index.ts:58` | Mid-session tool registration invalidates the whole cache |
| Read-before-write; stale-file rejection | `safety/file-tracker.ts` | Prevents clobbering externally changed files |
| PathJail on file tools | `safety/paths.ts` | Confines writes to the project |
| `dangerous` commands confirm in every mode including yolo | `safety/danger.ts` | The one gate no mode disables |
| Aggregate retry ceiling, exact-once attempts | `providers/retry.ts`, `session/ledger.ts` | Cost honesty |
| Verification gates completion after mutation | `agent/loop.ts:594+` | The N7 fix |
| Repair bounded at 2 rounds | `agent/verification.ts:126` | The N8 fix |
| Terminal reason accuracy; one terminal event | `agent/run.ts` | Stage 0 |
| Process-tree termination; no survivors | `tools/shell.ts` | Stage 0 |
| Cost states never render unknown as $0.00 | `session/ledger.ts` | Step 4B |

**Brain components may read all of these. None may bypass or mutate them.**

---

## 3. Proposed brain architecture

Nine components, in dependency order. Each is *proposed*; §14 of the roadmap
records that not all should necessarily be built.

| # | Component | Owns | Explicitly does not own |
|---|---|---|---|
| A | **Constitution / behavioral policy** | Conversational posture, truthfulness expectations, refusal taxonomy, clarifying-question behavior, uncertainty language, discussion-vs-execution distinction | Filesystem permissions, shell decisions, process termination, verification results |
| B | **Intent & task model** | What is being asked; conversation vs investigation vs coding vs execution; goals, constraints, acceptance criteria, ambiguities | Whether a tool may run |
| C | **Project-context selector** | Which files matter, likely entry points, project scripts/conventions, bounded task context, *why* it was selected | Reading files it has no permission for; any global index |
| D | **Planner & progress controller** | Bounded plans, evidence requirements, progress tracking, repeated-failure and scope-growth detection, stop/escalate conditions | Run ceilings, permissions, verification, cancellation — it is subordinate to all four |
| E | **Verified project memory** | Durable facts with provenance and invalidation | Anything unverified; credentials |
| F | **Skill system** | Reusable procedures with preconditions, allowed tools, ordered steps, required verification, stop conditions | Bypassing the tool allowlist |
| G | **Experience retrieval** | Prior *verified* trajectories | Unverified or mis-scored runs |
| H | **Evaluator / self-critique** | Acceptance vs verification, unsupported-claim detection, uncertainty identification | Overriding a deterministic failed check |
| I | **Model adapter / future router** | Capability profiles per model | Automatic routing (out of scope for V1) |

### Data flow

```
user input
  ↓
[B] intent + acceptance criteria ─────────────┐
  ↓                                            │
[E] memory consulted (scoped, verified) ───────┤
  ↓                                            │
[C] context selected (bounded, explained) ─────┤
  ↓                                            ├→ [A] constitution shapes the
[F] skill matched (optional) ──────────────────┤     system prompt ONCE per session
  ↓                                            │     and the behavioral decision
[D] plan (bounded, evidence-tagged) ───────────┘     per turn
  ↓
══════════ EXECUTION PLANE BOUNDARY ══════════
  ↓
existing loop: permissions → tools → mutation → verification → repair → terminal
  ↓
══════════ back to cognitive plane ═══════════
  ↓
[H] evaluator: verificationStatus vs taskAcceptance
  ↓
[G] trajectory recorded only if verified AND accurately scored
  ↓
[E] memory updated only with evidence
```

### Persistence boundaries

| Component | Store | Scope | Migration |
|---|---|---|---|
| A Constitution | file (`docs/`/config), not DB | global + per-project override | none |
| B Intent | `run_ledgers` JSON, additive key | per run | none |
| C Selected context | `run_ledgers` JSON | per run | none |
| D Plan state | `run_ledgers` JSON | per run | none |
| E Memory | *hybrid — canonical structured store + markdown views; see `data-models-v1.md` → MemoryRecord → "Storage direction"* | per project | additive; **not decided — Phase 4 design** |
| F Skills | files under `.forge/skills/` | project + global | none |
| G Experience | **new table** `experience_records` | per project | additive |
| H Evaluation | `run_ledgers` JSON | per run | none |
| I Capability profiles | config | global | none |

Only E and G need durable storage beyond the run ledger. Everything else rides
the additive JSON pattern already proven by `verification`. E's exact backing
store is **not decided** — roadmap Amendment V1 (A3) records a hybrid direction
and defers the choice to Phase 4 design.

---

## 4. Failure modes to design against

| Failure | Mitigation |
|---|---|
| Constitution text bloats the frozen system prompt and raises every request's cost | Measure prefix bytes before/after; budget the constitution explicitly; it is static so it stays cached |
| A brain component writes per-turn data into the frozen prefix | Architectural rule: only `prompt.ts` writes the prefix, and only at session start |
| Memory records a model claim as fact | Every record requires `evidence`; unverified claims are stored as `unverified` and never surfaced as fact |
| Skills become opaque prompt macros | Every skill declares allowed tools + required verification; a skill that cannot state its verification is rejected |
| Planner talks the loop past a ceiling | Planner output is advisory; ceilings live in `run.ts` and are checked independently |
| Evaluator overrides a red check | Evaluator may only *downgrade* an outcome, never upgrade one |
| Brain state diverges across CLI/TUI/desktop | One shared constructor, as `MutationState` and `RunLedger` now do |
| Provider refuses and Forge presents it as its own judgment | Refusals must be attributed; see constitution §7 |

---

## 5. Open questions

1. Does the constitution belong in the frozen prefix (cheap, static, always on)
   or in a per-turn system message (flexible, cache-hostile)? **Current answer:
   frozen prefix**, but the trade-off should be measured.
2. Can context selection be genuinely useful with grep/glob alone, or does it
   need a persisted per-project file map? Start without.
3. Should memory be per-project only, or is a global user-preference scope
   needed? Start per-project.
4. What makes a trajectory "trusted enough" to retrieve? Proposal:
   `verificationStatus === passed && taskAcceptance === met`, both recorded.
5. How is the constitution versioned and diffed once it shapes behavior?
6. At what point does hosted-provider refusal behavior justify a local model?
