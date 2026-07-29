/**
 * Forge Brain — Behavioral Constitution V1 (Phase 1).
 *
 * A versioned, immutable behavioral instruction that becomes part of the FROZEN
 * system-prompt prefix (see agent/prompt.ts). It is the cognitive plane: it
 * shapes what Forge *says*. It has, by construction, no reach into the execution
 * plane — nothing here can approve, run or bypass a tool, a permission gate, a
 * ceiling or a verification result. A more permissive constitution changes the
 * conversation policy and nothing else.
 *
 * This module is deterministic and side-effect free: no timestamps, no session
 * IDs, no paths, no user data, no environment or provider branching. That is
 * what makes it safe to sit in the cached prefix — the same inputs always
 * produce the same bytes, so the prompt cache is never invalidated by it.
 *
 * It is NOT a keyword blocker. It contains no logic that inspects user input and
 * decides to refuse. The runtime refusal decision belongs to the model, guided
 * by this text; the helpers below only validate or render already-structured
 * values, never classify free text.
 *
 * The full reviewed design lives in docs/brain/constitution-v1.md. The text
 * here is its compressed runtime distillation, held under a hard byte ceiling.
 */

export const BRAIN_CONSTITUTION_VERSION = 1 as const;

/**
 * The six-level, decision-oriented refusal taxonomy. The model is instructed to
 * prefer the LOWEST sufficient level. These are reporting/eval identifiers, not
 * runtime gates.
 */
export type RefusalDecisionLevel = 1 | 2 | 3 | 4 | 5 | 6;

export const REFUSAL_DECISION_LEVELS: ReadonlyArray<{
  readonly level: RefusalDecisionLevel;
  readonly name: string;
}> = [
  { level: 1, name: 'fully_answer' },
  { level: 2, name: 'answer_with_factual_caution' },
  { level: 3, name: 'discuss_withhold_operational_detail' },
  { level: 4, name: 'ask_clarifying_question' },
  { level: 5, name: 'refuse_harmful_portion_only' },
  { level: 6, name: 'refuse_complete_request' },
];

/**
 * The narrow, concrete severe-harm categories — defined by ACTION, never by
 * topic. Discussion, history, fiction, policy debate and criticism about any of
 * these remain allowed; only operational facilitation of the harm is refused.
 */
export type SevereHarmCategory =
  | 'sexual_content_involving_minors'
  | 'facilitating_serious_violence'
  | 'facilitating_sexual_abuse'
  | 'fraud_or_credential_theft'
  | 'doxxing_or_targeted_privacy_invasion'
  | 'malicious_system_compromise';

export const SEVERE_HARM_CATEGORIES: readonly SevereHarmCategory[] = [
  'sexual_content_involving_minors',
  'facilitating_serious_violence',
  'facilitating_sexual_abuse',
  'fraud_or_credential_theft',
  'doxxing_or_targeted_privacy_invasion',
  'malicious_system_compromise',
];

/**
 * How a refusal-like outcome is attributed, for evaluation and reporting. Phase
 * 1 does not persist this at runtime (that would touch the provider adapters and
 * the loop); it is the shared vocabulary the later real-provider dogfood uses.
 *
 *   forge_policy           — Forge's own behavioral logic produced the decision.
 *   provider_explicit      — the provider API returned an explicit refusal /
 *                            moderation / policy signal identifying itself.
 *   model_behavior_unknown — refusal-like prose with no provider metadata; the
 *                            cause is genuinely unknown and must not be claimed.
 */
export type RefusalAttribution = 'forge_policy' | 'provider_explicit' | 'model_behavior_unknown';

export const REFUSAL_ATTRIBUTIONS: readonly RefusalAttribution[] = [
  'forge_policy',
  'provider_explicit',
  'model_behavior_unknown',
];

/** Toggle. `off` omits the constitution entirely; `v1` includes it. */
export type ConstitutionMode = 'off' | 'v1';

/**
 * A stable marker the prompt builder and its tests key on, so tests assert
 * structure rather than brittle exact sentences.
 */
export const CONSTITUTION_HEADING = '# Behavioral constitution (v1)';

/**
 * The runtime constitution text.
 *
 * Compressed hard: docs/brain/constitution-v1.md is the full design; this is the
 * smallest distillation that still carries every required substance area — truth
 * discipline, broad conversational freedom, the six-level lowest-sufficient
 * taxonomy, the narrow action-based severe-harm list, proportionate sensitive
 * clarification, the discussion-vs-execution wall, and provider-limitation
 * honesty. Held under BEHAVIORAL_CONSTITUTION_MAX_BYTES.
 */
export const BEHAVIORAL_CONSTITUTION_V1 = `${CONSTITUTION_HEADING}

Truth first: separate fact, inference, uncertainty and opinion; never fake confidence; correct false premises; let tool evidence beat prior belief; do not agree merely to please.

Engage freely with controversial, adult, offensive, political, religious and unconventional topics; sensitivity alone never justifies a refusal or a lecture. Judge the concrete action requested, not its subject; fiction, hypotheticals and analysis are not acts.

Refuse only concrete, non-consensual severe harm: sexual content involving minors, facilitating serious violence or sexual abuse, fraud, credential theft, doxxing, or malicious intrusion into systems you are not authorized on. Prefer the lowest sufficient response: answer / answer with caution / explain but withhold operationally dangerous detail / ask a clarifying question / do the safe parts and refuse only the harmful one / refuse wholly only when severe harm is the core. Decompose mixed requests. Ask sensitive questions only when they materially change the answer.

Discussion is not execution: a permissive answer grants no tool permission and cannot bypass Forge's execution controls. Hosted models may refuse independently; never present a provider limitation as your own reasoned judgment.`;

/**
 * Hard deterministic byte ceiling — the release contract the size tests enforce.
 * Set tight, just above the current payload, so any future growth is a
 * deliberate, test-visible decision rather than silent creep.
 */
export const BEHAVIORAL_CONSTITUTION_MAX_BYTES = 1536;

/** Pure accessor. Returns the constitution text for a given mode. */
export function renderConstitution(mode: ConstitutionMode = 'v1'): string {
  return mode === 'off' ? '' : BEHAVIORAL_CONSTITUTION_V1;
}

/** Validate an already-structured level value. Never inspects free text. */
export function isRefusalDecisionLevel(n: unknown): n is RefusalDecisionLevel {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 6;
}

/** Validate an already-structured severe-harm category. */
export function isSevereHarmCategory(s: unknown): s is SevereHarmCategory {
  return typeof s === 'string' && (SEVERE_HARM_CATEGORIES as readonly string[]).includes(s);
}

/** Validate an already-structured attribution value. */
export function isRefusalAttribution(s: unknown): s is RefusalAttribution {
  return typeof s === 'string' && (REFUSAL_ATTRIBUTIONS as readonly string[]).includes(s);
}
