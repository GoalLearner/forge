# Forge Brain — Decision Record V1

**Status:** design rationale. Records why, not how.

---

## Why brain work begins now

The reliability roadmap is complete and independently reviewed. Committed
evidence at `9651f1e`:

- 481/481 tests, zero flakes across 23 battery runs in the final review.
- Four real-provider runs (Dogfood 001/002, T2, T3) all PASS, all safe, all
  honestly reported, combined spend ~$0.032.
- Final review verdict `3f0f4b4`: READY FOR DAILY USE, ROADMAP COMPLETE WITH
  ACCEPTED LIMITATIONS, BRAIN PLANNING UNLOCKED.

Brain work begins because the *foundation is trustworthy enough to build
cognition on top of* — the execution plane is dependable, so a cognitive plane
can be added without the risk of amplifying an unreliable base. Doing this
earlier would have meant stacking intelligence on unproven execution.

## Why it stays inside Forge

Forge is a local, single-user personal agent. The brain is a *layer around a
replaceable model*, not a separate product. Keeping it in-process preserves the
one architecture that already works: the additive JSON pattern on `run_ledgers`,
the additive SQLite migrations, the single frozen system prompt. Splitting it out
would reintroduce the cross-front-end drift that MutationState and RunLedger each
had to fix, for no benefit to a solo user.

## Why cognitive freedom is separated from execution authority

This is the central design decision. The constitution wants a *permissive*
conversation policy — candid, low-refusal, willing to discuss the taboo. The
execution plane must stay *least-privilege* — every destructive action gated,
every ceiling enforced, no false verified success.

If those two lived in one policy, loosening conversation would risk loosening
execution, and the entire reliability roadmap would be at hazard from a prompt
edit. The two-plane rule makes that structurally impossible: the constitution is
cognitive-plane-only and cannot reference, bypass or mutate a permission gate, a
timeout, verification, or accounting. A more permissive constitution changes what
Forge *says*, never what it *does to the machine*. This is the load-bearing wall.

## Why the first slice is the constitution (not context or task model)

Evaluated in `roadmap-v1.md` against B (context) and C (task model):

- **It is the north star's headline.** The candid, truth-seeking posture is the
  reason this phase exists. B and C improve coding, already rated APPROVED.
- **It uses the existing cache-safe seam.** `agent/prompt.ts` is built once and
  frozen; static constitution text stays cached, so Forge's founding 50–120×
  cost thesis is untouched. B and C risk per-turn context near that cliff.
- **Lowest blast radius, trivial rollback.** One string-building function plus a
  pure decision helper; revert is deleting a string. No table, no loop change, no
  execution-plane touch.
- **Most testable in isolation.** The six-level taxonomy maps to a labeled
  corpus with deterministic expected levels.

## Alternatives rejected

- **Context foundation first** — higher coding value but touches the cache cliff
  and needs coding fixtures + human rating; deferred to Phase 2, not dropped.
- **Task/acceptance model first** — useful but its main benefit (separating
  verification from acceptance) is already enforced as a *reporting rule* from
  the T3 finding; it can wait for Phase 3.
- **Memory or planner first** — both depend on context and acceptance existing;
  building them first would invent ad-hoc versions to be replaced.
- **Model routing / fine-tuning first** — explicit non-goals; no evidence yet
  justifies either, and both risk the execution plane.
- **A separate multi-agent or SaaS architecture** — contradicts the solo,
  local-first identity; explicitly out of scope.

## Major unresolved decisions

1. **Constitution placement** — frozen prefix (cheap, static, measured here as
   the recommended default) vs per-turn system message (flexible, cache-hostile).
   To be settled by measuring prefix bytes and cost in Phase 1.
2. **Where the hosted-provider ceiling actually is** — Phase 1's corpus run is
   partly an experiment to find where DeepSeek's own filters block legitimate
   Level-1 behavior, informing the eventual local-model question.
3. **Trajectory trust threshold** — proposed `passed && met`; needs validation
   that it is neither too strict (nothing retrievable) nor too loose.
4. **Memory scope** — per-project only for V1; whether a global user-preference
   scope is ever needed is deferred.
5. **Constitution versioning** — how a behavioral change is diffed, reviewed and
   rolled back once it shapes real output.

## Non-negotiables carried into every future phase

- Every phase additive or feature-flagged; no rewrite of a trustworthy component.
- The 481-test floor: no phase ships that regresses it.
- No phase touches prefix assembly, a permission gate, or a run ceiling.
- Cognitive components read execution state; none bypasses it.
- Independent verification gates every slice before daily use.
