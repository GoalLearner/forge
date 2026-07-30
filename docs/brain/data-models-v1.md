# Forge Brain — Data Models V1

**Status:** implementation-neutral schemas. No migrations, no source. Referenced
by `architecture-v1.md` and `roadmap-v1.md`.

For each: purpose · required · optional · source of truth · persistence ·
invalidation · privacy.

---

## BrainTask
- **Purpose:** the top-level unit of one submitted prompt's cognition.
- **Required:** `id`, `runId`, `rawInput`, `createdAt`.
- **Optional:** `intent`, `acceptance[]`, `selectedContext`, `planState`.
- **Source of truth:** derived from user input + run.
- **Persistence:** per-run JSON on `run_ledgers` (additive key).
- **Invalidation:** run-scoped; never reused across prompts.
- **Privacy:** local; contains the user's request verbatim — session-scoped.

## TaskIntent
- **Purpose:** classify what is being asked.
- **Required:** `kind` ∈ {conversation, investigation, coding, execution}, `confidence`.
- **Optional:** `goals[]`, `constraints[]`, `ambiguities[]`.
- **Source:** intent classifier (cognitive plane).
- **Persistence:** per-run JSON. **Invalidation:** run-scoped.
- **Privacy:** local.

## AcceptanceCriterion
- **Purpose:** an objective condition for "done", separate from verification.
- **Required:** `text`, `checkable` (bool), `source` ∈ {user, inferred}.
- **Optional:** `validationCommand`, `met` (bool, set by evaluator).
- **Source:** extracted from the request; inferred criteria flagged as such.
- **Persistence:** per-run JSON. **Invalidation:** run-scoped.
- **Privacy:** local.

## ContextCandidate
- **Purpose:** a file/symbol considered for inclusion.
- **Required:** `path`, `reason`, `score`.
- **Optional:** `symbol`, `lineRange`, `rejected` (bool + why).
- **Source:** context selector (grep/glob/read).
- **Persistence:** per-run JSON (rejections kept for observability).
- **Invalidation:** run-scoped. **Privacy:** local; paths only, no secret bodies persisted.

## SelectedContext
- **Purpose:** the bounded set actually placed in the conversation tail.
- **Required:** `candidates[]` (chosen), `explanation`, `byteBudget`.
- **Optional:** `truncated` (bool).
- **Source:** selector. **Persistence:** per-run JSON.
- **Invalidation:** run-scoped. **Privacy:** local. **MUST land in the tail, never the frozen prefix.**

## PlanStep
- **Purpose:** one bounded intended action.
- **Required:** `id`, `description`, `evidenceRequired`, `status` ∈ {pending, active, done, failed, abandoned}.
- **Optional:** `allowedTools[]`, `dependsOn[]`.
- **Source:** planner. **Persistence:** per-run JSON.
- **Invalidation:** run-scoped. **Privacy:** local.

## PlanState
- **Purpose:** the plan and its progress.
- **Required:** `steps[]`, `revisions` (count), `stalled` (bool).
- **Optional:** `scopeGrowthDetected`, `escalate` (bool + reason).
- **Source:** planner; **subordinate to run ceilings** — advisory only.
- **Persistence:** per-run JSON. **Invalidation:** run-scoped. **Privacy:** local.

## MemoryRecord
- **Purpose:** a durable, evidenced project fact.
- **Required:** `id`, `fact`, `scope` (project path), `source`, `evidence`, `confidence`, `createdAt`, `lastVerifiedAt`, `invalidationCondition`, `status` ∈ {verified, unverified, invalidated}.
- **Optional:** `appliesToCommit`, `appliesToFiles[]`.
- **Source:** evaluator, gated — an unverified model statement is stored `unverified` and never surfaced as fact.
- **Persistence:** *(amended — see "Storage direction" below; the original
  single-table plan is no longer a commitment)*.
- **Invalidation:** `invalidationCondition` (e.g. "file X changed"); checked before recall; stale → `invalidated`, not deleted.
- **Privacy:** local; per-project isolated; inspectable, deletable; **no credentials, no unnecessary intimate detail**; never trained on without explicit permission.

### Storage direction — DESIGN CONSTRAINT (roadmap Amendment V1, A3)

**Status: Phase 4 is NOT IMPLEMENTED. No memory exists. No schema is defined
here, and none may be created by this constraint.**

Forge does **not** commit to markdown-only or database-only memory. The
preferred direction is **hybrid**, decided properly during Phase 4 design.

**Canonical structured store.** Whatever backs it must eventually support stable
record IDs, project scope, memory type, source provenance, source hashes,
confidence, verification state, creation time, last-verification time,
supersession state, contradiction links, expiration/freshness state, atomic
updates, and queryable relationships. SQLite is the likely implementation;
another local structured store may be justified during Phase 4 design. Plain
files alone cannot carry contradiction links and atomic updates, which is why
markdown-only is not adopted.

**Markdown views.** Markdown is genuinely useful — but as a *projection*, not as
the source of truth: human-readable exports, git-reviewable project summaries,
user-editable candidate memories, materialized views, portable backups, and
project-local context references.

**User-edited markdown must not silently become verified canonical truth.** The
required flow is:

```
user-authored markdown → candidate memory → provenance attached
  → validation, or an explicit `unverified` status
  → canonical record only after acceptance
```

This preserves the existing rule that an unverified statement is stored
`unverified` and never surfaced as fact.

**Prompt-cache constraint.** Memory content must **never** be loaded
automatically into the stable permanent prefix. Retrieval must be bounded,
task-specific, provenance-aware, freshness-aware, stable-hashed when reusable,
and tail-placed where practical, and it must state conflicts and uncertainty
explicitly. Changing memory must not invalidate the cached prefix on every
request — that would forfeit the 50–120× discount the whole design rests on.
This is the same static-vs-dynamic placement rule Phase 2 established for the
project profile.

## SkillDefinition
- **Purpose:** a reusable, auditable procedure.
- **Required:** `name`, `preconditions[]`, `contextRequirements[]`, `allowedTools[]`, `procedure[]` (ordered), `requiredVerification`, `stopConditions[]`, `expectedEvidence`.
- **Optional:** `examples[]`.
- **Source:** authored files under `.forge/skills/`.
- **Persistence:** files (project + global). **Invalidation:** manual/versioned.
- **Privacy:** local. **A skill that cannot declare its verification is invalid** — no opaque prompt macros.

## ExperienceRecord
- **Purpose:** a prior *verified* task trajectory for retrieval.
- **Required:** `taskSummary`, `selectedContext`, `toolSequence[]`, `patchSummary`, `verificationFailures[]`, `repairs[]`, `finalAcceptance`, `cost`, `outcome`, `verified` (bool).
- **Optional:** `durationSeconds`.
- **Source:** recorded **only** when `verificationStatus === passed && taskAcceptance === met`.
- **Persistence:** **new `experience_records` table**, additive, per project.
- **Invalidation:** superseded by newer verified trajectories; kept for audit.
- **Privacy:** local; per-project; patch summaries not full diffs of secret files.

## EvaluationResult
- **Purpose:** the self-critique verdict for one run.
- **Required:** `verificationStatus`, `taskAcceptance` ∈ {met, partially_met, not_met}, `unsupportedClaims[]`, `addressesRequest` (bool).
- **Optional:** `uncertaintyNoted`, `notes`.
- **Source:** evaluator. **May only downgrade an outcome, never upgrade a red check.**
- **Persistence:** per-run JSON. **Invalidation:** run-scoped. **Privacy:** local.

## BehavioralDecision
- **Purpose:** the constitution's per-turn posture choice.
- **Required:** `level` (1–6), `rationale`.
- **Optional:** `withheldPart`, `clarifyingQuestion`, `providerRefusalAttributed` (bool).
- **Source:** constitution layer (cognitive plane). **Cannot reach an execution control.**
- **Persistence:** per-run JSON summary (not chain-of-thought — a concise decision record).
- **Invalidation:** run-scoped. **Privacy:** local.

## RefusalDecision
- **Purpose:** the specific narrow-refusal outcome when level ≥ 3.
- **Required:** `category` (one of the seven §4 hard stops), `scope` (the exact refused part), `saferAlternativeOffered` (bool).
- **Optional:** `mixedRequestDecomposed` (bool).
- **Source:** constitution layer. **Persistence:** per-run JSON.
- **Invalidation:** run-scoped. **Privacy:** local. **Category must be a specific §4 item, never a topic.**

## ModelCapabilityProfile
- **Purpose:** what a given model can be trusted to do (future router input).
- **Required:** `modelKey`, `providerFilters` (observed refusal tendencies), `toolUseReliability`, `contextWindow`, `costPerMTokens`.
- **Optional:** `reasoningTokens` (bool), `notes`.
- **Source:** measured, not assumed. **Persistence:** config.
- **Invalidation:** re-measured per model version. **Privacy:** local; no routing acts on it in V1.
