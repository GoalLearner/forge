# Candidate B — Task-Specific Context Selector — Go/No-Go Decision

**Decision: NO-GO — COLLECT DAILY-USE EVIDENCE** (2026-07-29).

Candidate B (per-task relevance selection: choose which files/symbols/tests matter for
*this* request) remains **deferred, not rejected**. The decision follows the evidence, not
the roadmap ordering. Evidence base: the Phase 2 dogfood (protocol `070a3b7`, results
`54cd424`, evidence tip `54ef2ce`) plus the Phase 2 planning record at `ca142c1`.

## 1. What the evidence shows

A bounded selector is justified by a *repeated context-relevance failure*. Searching all
eight scored runs for exactly those failure shapes:

| Selector-problem signal | Observed |
|---|---|
| Irrelevant pre-edit reads | **0** in 8/8 runs (both arms) |
| Wrong-file / duplicate-name exploration | none |
| Excessive directory traversal | none (no `list_dir` sweep in any run) |
| Wrong test-file selection | none — correct paired test edited in 6/6 test-bearing runs |
| Monorepo / nested-package confusion | none — `packages/widget` never entered in either P3 arm |
| Task failed because context was not found | none — 8/8 accepted |
| Repeated user intervention to point at files | n/a — single frozen prompt, no follow-ups permitted |
| Context-window pressure from discovery | none — no trim/warn in any run |

Counter-evidence — the problem Candidate B would attack was largely solved by the cheaper
static profile: project-fact rediscovery **4 → 1**, provider attempts **28 → 20**, first
useful edit earlier in **4/4** pairs (median 18.0s → 12.0s), zero misled cases.

## 2. Honest limits of that finding

This does **not** prove a selector is unnecessary in general. The four fixtures are small
(4–8 files); a selector's value would appear on large or unfamiliar repositories, which
this round deliberately did not test. Also, the harness forbids follow-up turns, so
"user re-points Forge at the right file" — a key real-world selector signal — could not
occur by construction. The correct reading is therefore: **no selector-shaped failure
appeared at this scale**, so there is nothing yet for a selector to fix. That argues for
deferral and evidence collection, not rejection.

Candidate B also carries the risks recorded in the Phase 2 plan: it requires model
judgment, which makes it a proto-planner (a plane-boundary risk the static profile avoids
by construction), it is harder to test deterministically, and a wrong selection actively
misleads rather than merely omitting. Building it without a demonstrated problem would
take on those risks for speculative gain.

## 3. Reconsideration triggers (measurable; any ONE re-opens planning)

Collected from ordinary daily use with constitution v1 + static profile enabled, on real
repositories (the Forge repo itself, Insight, Awakened — all larger than the fixtures):

1. **≥3 tasks** each showing **≥2 irrelevant pre-edit reads** (reads not needed for the
   implementation or its acceptance).
2. **≥2 occurrences** of wrong-file or duplicate-basename exploration (editing/reading the
   wrong `index.ts`, `utils.ts`, `types.ts`, etc.).
3. **≥1 bounded task fails** specifically because the relevant existing file was not found.
4. **≥1 monorepo root/package confusion** that the static profile's candidate list did not
   prevent.
5. **≥2 runs** hitting the context guard (warn/trim) where the transcript is dominated by
   repository-discovery reads.
6. **Median pre-edit tool calls ≥6** across **≥5** consecutive real-repo tasks (dogfood
   baseline with the profile was 2–3).
7. **≥3 instances** of the user manually pointing Forge at a file it should have located.

Explicitly insufficient to re-open: a single anecdotal run, a subjective "it felt slow", or
"the roadmap says Phase 2b is next."

## 4. If a trigger fires

Re-enter planning only — an independent scope review before any implementation — and keep
the Phase 2 non-goals intact: bounded, read-only, tail-injected (not the frozen prefix),
no durable memory, no embeddings/index, no planner, deterministic-first with model
assistance strictly budgeted and explainable ("why this file was selected"), and a
precision gate on a labeled fixture set before it ships.

## 5. Operating position

Ship and use what is proven: **constitution v1 on + static project profile on**. Collect
the trigger evidence during normal work. Revisit Candidate B when the evidence — not the
roadmap — asks for it.
