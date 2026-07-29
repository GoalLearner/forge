# Forge Brain Phase 2 — Architecture (Static Project Profile)

Design for the GO slice only. Nothing here is implemented.

---

## 1. Component

A single pure module, proposed `src/agent/project-profile.ts`, exporting:

- `buildProjectProfile(cwd): ProjectProfile` — deterministic, side-effect-free filesystem +
  Git + `package.json` inspection, computed **once at session start**.
- `renderProjectProfile(profile): string` — a bounded, byte-stable Markdown block for the
  frozen prefix. Empty string when there is nothing worth stating (so absent facts add nothing).

It reuses the existing declared-check discovery in `agent/verification.ts` (the pure part that
reads `package.json` and selects safe typecheck/test/build scripts) rather than duplicating it —
the shared function is extracted or called directly, with a test asserting the profile's declared
checks equal what the verification gate would run.

## 2. Data flow

```
session start (cli.tsx / desktop/main.ts, via ONE shared helper)
  → buildProjectProfile(cwd)            pure fs/Git/package.json read, budgeted
  → renderProjectProfile(profile)       bounded Markdown, session-static
  → buildSystemPrompt({ ..., projectProfile })   inserted AFTER # Environment,
                                                  BEFORE # Project conventions (projectDoc),
                                                  and ALWAYS AFTER the constitution
  → Conversation(system, tools)         frozen prefix, unchanged assembly
  → existing loop                       untouched
  → (optional) record profile facts in run_ledgers JSON (additive key, no migration)
```

The profile never enters the loop middle, never varies per turn, and never re-renders mid
session — same lifecycle as the environment block and `projectDoc`.

## 3. Trust model

Every fact carries a source and a trust class:

- **deterministic** — from Git, the filesystem, or a parsed `package.json`/`tsconfig`. Presented
  as fact.
- **inferred** — e.g. "likely test root" from directory/name heuristics. Presented **labeled**
  ("likely"), never as ground truth.
- **unknown** — evidence absent. Stated as unknown or omitted; never guessed.

Hard rules: no path or script is ever emitted unless it was observed on disk / in a parsed file
(no fabrication). `projectDoc` and any repository file remain **untrusted data**, never policy —
the profile cannot grant a tool, change a permission mode, a ceiling, or the verification/
constitution rules. Repository instruction files cannot alter behavior through the profile.

## 4. Context budgets (deterministic)

| Bound | Proposed value | On exceed |
|---|---|---|
| Max profile bytes | 2,048 | rank + omit, with an explicit "N more omitted" line |
| Max declared checks listed | 6 | keep typecheck/test/build first; note omissions |
| Max source/test roots listed | 8 | keep shallowest/largest; note omissions |
| Max config/doc files listed | 12 | canonical names first; note omissions |
| Max nested-project depth | 2 | deeper roots summarized as a count |
| Max nested projects listed | 8 | note "+N more packages" |
| Construction time | < 200 ms (pure reads) | fall back to empty profile + a one-line notice |

No silent truncation of high-priority facts (root, package manager, declared checks): those are
never dropped; lower-priority lists are the ones ranked-and-omitted, always with a visible count.

## 5. Injection seam (and why the frozen prefix, not the tail)

The profile is inserted into `buildSystemPrompt` as a new optional field `projectProfile?: string`,
placed **after `# Environment`, before `# Project conventions`, always after the constitution**.
It is built in **one shared session-context helper** invoked by both `cli.tsx` and
`desktop/main.ts`, so the two front ends cannot diverge.

Justification (cache + safety):
- The profile is **session-static** — identical for every turn of a session — so it has the same
  volatility class as the environment block and `projectDoc`, both already frozen in the prefix.
  Placing it in the prefix earns the full prompt-cache discount and adds **zero** per-turn cost;
  `prefixFingerprint()` stays constant across the session (asserted by a stability test).
- The tail is reserved for genuinely per-turn content. A **future** task-specific selector
  (Candidate B) is the thing that belongs in the tail; this static profile does not.
- Ordering guarantee: the constitution's byte-identical position and the existing section order
  are preserved; the profile is purely additive between two existing sections.

## 6. Observability

A concise, structured profile summary is exposed (a `/context`-style read-only view and/or an
additive `projectProfile` key in the `run_ledgers` JSON — no schema migration, following the
`verification` key precedent). It lists: project root, package manager, declared checks
discovered, source/test roots, nested packages, and which facts were deterministic vs inferred
vs unknown. No hidden chain-of-thought is exposed — only the structured decision facts.
Persistence in the first slice may be deferred to session-only if the ledger key is judged
premature; the render string itself is always inspectable.

## 7. Protected invariants (unchanged by this slice)

- Constitution v1 byte-identical and in the same prefix position; refusal taxonomy unchanged.
- System prompt built once, frozen; `messages.ts` prefix assembly untouched; tool schemas still
  sorted and frozen at construction.
- Read-before-write, PathJail, `dangerous`-confirm-in-every-mode, retry ceiling, verification
  gate, repair bound, terminal-reason accuracy, process-tree kill — all untouched.
- The profile is read-only: it performs **no** repository writes and **no** shell execution
  during construction.

## 8. Failure modes

| Failure | Mitigation |
|---|---|
| Profile bloats the prefix / raises every request's cost | hard byte budget (§4); it is static so it stays cached; stability test proves the fingerprint is constant |
| A fact is stale (file changed mid-session) | profile is orientation, not authority; the model can always re-read; `applicabilityHash` recorded so a later slice can detect staleness — v1 simply freezes at session start like the environment block |
| Monorepo: wrong root chosen | nested roots are stated as **facts with evidence**, not resolved to one "the root"; the model sees the structure and decides |
| Duplicate filenames / ambiguous roots | listed with their real paths; never collapsed into a guess |
| A repo file tries to instruct via the profile | profile content is untrusted data; it cannot change permissions, ceilings, verification, or the constitution |
| Drift across front ends | one shared constructor; a test asserts both entry points produce the same profile for the same cwd |
| Discovery throws (unreadable package.json, odd encoding) | caught; the corresponding facts become `unknown`; the profile degrades to the environment-only baseline, never crashes session start |
