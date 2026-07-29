# Forge Brain Phase 2 — Risk Register (Static Project Profile)

Severity × likelihood after the mitigations already designed into `architecture.md` /
`implementation-scope.md`.

| # | Risk | Sev | Likelihood | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | **False context** — profile states a wrong/stale fact and the model trusts it over reality | High | Low | Only deterministic facts presented as fact; inferred facts labeled "likely"; unknown stated, never guessed; no path emitted unless observed on disk; profile framed as orientation, model can re-read | Low |
| R2 | **Staleness** — a file changes mid-session; the frozen profile is out of date | Med | Med | Profile is session-static by design (like the environment block); it is orientation not authority; `applicabilityHash` recorded for a future refresh decision; model always free to re-read | Low |
| R3 | **Context bloat** — profile grows and raises every request's cost | Med | Low | Hard 2 KB budget; rank-and-omit with visible counts; high-priority facts capped in size; it is static so it stays cached | Low |
| R4 | **Cache impact** — the profile perturbs the prefix and breaks the cost thesis | High | Low | Session-static → frozen prefix, never per-turn; `prefixFingerprint()` stability test is a hard gate; dogfood checks hit-rate | Low |
| R5 | **Monorepo ambiguity** — wrong root chosen | Med | Med | Nested roots stated as facts-with-evidence, not resolved to one root; depth-2 cap; model sees structure and decides | Low |
| R6 | **Repository-instruction injection** — a repo file uses the profile to change behavior | High | Low | Profile content is untrusted data; cannot grant tools or change permission/ceiling/verification/constitution; same boundary `projectDoc` already lives under | Low |
| R7 | **Model over-reliance** — model stops verifying because the profile "already knows" | Med | Med | Profile lists facts, not conclusions; declared checks still run at the gate regardless; dogfood explicitly inspects for profile-caused wrong edits | Low–Med |
| R8 | **Scope creep into a planner** — "static profile" quietly grows per-task selection or model judgment | High | Med | Hard non-goal: no per-task/model-judgment selection in this slice; that is deferred Candidate B; module is pure and judgment-free; reviewer checks the diff for any selection logic | Low |
| R9 | **Disguised memory/index** — profile becomes a persisted cross-session store or index | High | Low | No new table; no cross-session persistence; profile rebuilt each session from disk; embeddings/vector DB/index are explicit non-goals | Low |
| R10 | **Front-end drift** — CLI and desktop build different profiles | Med | Med | One shared constructor; test asserts both entry points yield the same profile for the same cwd | Low |
| R11 | **Discovery crash** — malformed package.json/encoding breaks session start | Med | Low | All discovery wrapped; failures degrade facts to `unknown`; profile falls back to environment-only; never throws at session start | Low |
| R12 | **Constitution disturbed** — the added section shifts the constitution's bytes/position | High | Low | Profile inserted strictly after the constitution; `prompt-constitution.test.ts` extended to assert byte-identity and ordering | Low |

**Aggregate:** no High residual. The dominant *governance* risks are R8 (scope creep into
selection/planning) and R7 (over-reliance) — both controlled by keeping the slice pure-facts and
by the independent-review gate on the diff. The dominant *technical* risk (R4, cache) is directly
guarded by the existing prefix-stability regression test, which is the same mechanism that
protected the Phase-1 constitution.
