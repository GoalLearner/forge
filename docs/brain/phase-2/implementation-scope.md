# Forge Brain Phase 2 — Implementation Scope (frozen intent)

For the GO slice (static project profile). Planning only; no code written.

---

## 1. Implementation boundary

Additive, read-only, one shared injection seam, feature-flagged, revert-clean. No loop-middle
change, no new runtime dependency.

## 2. Likely files

**New**
- `src/agent/project-profile.ts` — pure `buildProjectProfile(cwd)` + `renderProjectProfile()`.
- `src/agent/project-profile.test.ts` — deterministic unit + fixture tests.
- `test/fixtures/project-profile/**` — synthetic project trees (see `evaluation.md`).

**Modified (minimal, additive)**
- `src/agent/prompt.ts` — add optional `projectProfile?: string` to `PromptContext`; insert the
  rendered block after `# Environment`, before `# Project conventions`. Mirrors exactly how the
  constitution field was added in `16ef34b` (one optional field, one guarded `push`).
- One **shared session-context helper** (new small function, or an existing shared init point)
  called by `src/cli.tsx` and `src/desktop/main.ts` so both front ends build the profile
  identically. If no shared point exists, add one rather than duplicating the call.
- `src/agent/verification.ts` — **only if needed**: extract the pure `package.json`→declared-checks
  discovery into an exported helper the profile can reuse. If extraction risks touching gate
  behavior, instead call the existing function read-only and do not refactor the gate.

**Must NOT change**
- `src/agent/messages.ts` (prefix assembly / cache hints).
- `src/agent/loop.ts` (the loop middle).
- `src/agent/behavioral-constitution.ts` and the constitution's prompt position.
- `src/safety/*` (permissions, PathJail, danger), `src/agent/run.ts` (ceilings), the verification
  gate semantics, `src/providers/*`.
- `src/session/db.ts` schema (no migration in this slice; ledger key is additive JSON only, and
  optional).

## 3. Rollback

- Config flag `projectProfile: 'off'` (mirrors `constitution: 'off'`) disables rendering.
- Full removal = revert `prompt.ts`'s one field/push, delete `project-profile.ts`, undo the
  shared-helper wiring. No data migration to unwind.

## 4. Exit criteria

- New deterministic tests green; **531 baseline unchanged** (no regression).
- Prefix-stability test proves the profile is session-static: `prefixFingerprint()` is
  byte-identical across simulated turns with a profile present.
- Constitution byte-identity and section ordering unchanged (extend
  `prompt-constitution.test.ts`).
- Profile respects every budget in `architecture.md` §4; never emits a nonexistent path.
- Declared checks in the profile equal what the verification gate would run (shared-source test).
- Real-provider dogfood shows fewer rediscovery reads before the first useful edit, with no
  evidence the profile misled the model (`evaluation.md`).

## 5. Independent-verification gate

Before implementation: an independent review of this plan (decision + architecture + evaluation).
After implementation: independent verification that the execution plane is byte-unchanged, the
531 baseline holds, the cache fingerprint is stable, and the dogfood metric moved the right way —
before the slice is considered done. No merge/push/tag at any planning or implementation step
without that gate.

## 6. Stop conditions (abort the slice)

- Any measured prefix-cache regression attributable to the profile (fingerprint changes mid
  session, or hit-rate falls on a control-vs-profile comparison).
- Any execution-plane file requires a non-additive change to make the profile work.
- The profile emits a fabricated or wrong path/script in any fixture.
- 531 baseline regresses and cannot be restored additively.
