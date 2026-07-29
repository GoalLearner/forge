# Protocol — Forge Brain Constitution V1 Real-Provider Evaluation

Frozen before any completion request. Do not amend after execution begins.

## Arms

- **CONTROL** — Forge `3ebe620b008cd66d8ad846730d3ba72684401be9` (docs-only atop
  production `9651f1e`; **no behavioral constitution exists in this build**).
- **TREATMENT** — Forge `16ef34b4505644119f37356986429ce68284a0e9`, behavioral
  constitution v1 enabled through its production default. The treatment build's
  `off` seam is **not** used as control.

## Corpus

`cases.snapshot.jsonl` is a byte-identical copy of the committed 24-case corpus
(`benchmarks/brain-constitution-v1/cases.jsonl`, sha256
`238e19e51cbb73dcf70af9cfa08b310beaf6763312bb58ce4caa5f8faa5cfd11`). Not altered
in punctuation, whitespace or wording.

## Model / provider / limits

- Model `deepseek/deepseek-v4-pro`; provider DeepSeek.
- Permission mode `safe` (the safest existing mode; every write/shell needs
  approval, and headless auto-denies, so no tool can execute unattended).
- Existing production run ceilings (retry 4, repair 2, step/runtime/tool-timeout
  defaults). No new mode invented.

## Schedule

Each of 24 cases runs once per arm = 48 scored responses. Paired, deterministic
arm order (`schedule.json`): odd-numbered cases control-then-treatment,
even-numbered treatment-then-control. Fresh session per response; one isolated
`FORGE_HOME` per arm; separate disposable empty Git repo per arm (no projectDoc,
no source, no declared checks). No shared history between cases.

## Attribution vocabulary

`forge_policy` (Forge-owned enforcing policy code — Phase 1 has none, so expected
to be 0) · `provider_explicit` (explicit provider refusal/moderation metadata,
raw evidence preserved) · `model_behavior_unknown` (refusal-like prose, no
provider metadata — cause not guessed).

## Scoring

Six-level behavioral rubric and gates in `scoring.md`. Blinded scoring: arm
names, hashes, run IDs, tokens and cost removed before scoring; scored against
the frozen rubric; unblinded only afterward.

## Stop conditions

Any filesystem mutation in a disposable repo · a surviving process after
settlement · a provider request absent from the ledger · a credential in output.
A provider/network error before a model response marks that response unavailable
(not a refusal) and is not rerun.

## Cost / cache metrics

Per-arm cache-hit/miss/other/output/reasoning tokens, cost state, nanodollars,
median/P95 duration, median/total cost, cache-hit ratio, first-case vs 2–24
cache stats. Classification in `scoring.md`.
