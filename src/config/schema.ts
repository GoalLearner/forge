/**
 * Configuration shape and validation.
 *
 * Design notes:
 *  - Everything has a working default. `forge` must start with an empty config
 *    file and one API key in the environment.
 *  - Secrets are never stored in the config file. `apiKey` holds an *indirection*
 *    ("env:DEEPSEEK_API_KEY"), resolved at load time. A literal key is allowed but
 *    warned about, because config files get committed by accident.
 *  - Built-in provider presets mean a user typically writes only `[tiers]`.
 */

import { z } from 'zod';

/** Pricing is USD per 1,000,000 tokens. */
export const PricingSchema = z.object({
  input: z.number().nonnegative(),
  /** Input tokens served from the provider's prompt cache. The whole ballgame. */
  cachedInput: z.number().nonnegative().default(0),
  /** Anthropic only: writing to the cache costs a premium (1.25x base). */
  cacheWrite: z.number().nonnegative().optional(),
  output: z.number().nonnegative(),
});

export const ModelEntrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive().default(8192),
  pricing: PricingSchema,
  /**
   * True when the provider caches prompt prefixes with no client-side markers
   * (DeepSeek, GLM, Kimi). False for Anthropic, which needs explicit
   * `cache_control` breakpoints.
   */
  autoCache: z.boolean().default(false),
  /** Anthropic only: prefixes shorter than this silently fail to cache. */
  minCacheable: z.number().int().positive().optional(),
  /** Flat-rate plan — token pricing is zero because it's already paid for. */
  subscription: z.boolean().default(false),
  local: z.boolean().default(false),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const ProviderSchema = z.object({
  /**
   * Wire format, not vendor. "openai" = ChatCompletions, "anthropic" = Messages.
   * DeepSeek and Z.ai each speak both; pick whichever endpoint you point at.
   */
  kind: z.enum(['openai', 'anthropic']),
  baseURL: z.string().optional(),
  /** "env:VAR_NAME" (preferred) or a literal key (discouraged). */
  apiKey: z.string().optional(),
  /** Extra headers, e.g. an OpenRouter attribution header. */
  headers: z.record(z.string(), z.string()).default({}),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const TiersSchema = z.object({
  /** Cheap+small: summarization, commit messages, ranking. Never drives the loop. */
  fast: z.string().default('deepseek/deepseek-v4-flash'),
  /** The default driver. Everything runs here unless you say otherwise. */
  cheap: z.string().default('deepseek/deepseek-v4-pro'),
  /** Opt-in escalation. Costs real money — never selected automatically in M1. */
  strong: z.string().default('anthropic/claude-opus-5'),
});
export type Tiers = z.infer<typeof TiersSchema>;
export type TierName = keyof Tiers;

export const LimitsSchema = z.object({
  /** Hard cap on a single tool result before it is truncated. Protects context. */
  maxToolOutputBytes: z.number().int().positive().default(30_000),
  /** Default line cap for read_file when no explicit limit is given. */
  maxFileReadLines: z.number().int().positive().default(2000),
  /** Warn the user when the transcript passes this share of the context window. */
  contextWarnPct: z.number().min(0).max(1).default(0.7),
  /** Start eliding old tool results at this share. Real compaction is M2. */
  contextTrimPct: z.number().min(0).max(1).default(0.9),
  /** Runaway guard: max assistant turns in one user request. */
  maxSteps: z.number().int().positive().default(50),
  /** Network retries for 429/5xx/transport errors. */
  maxRetries: z.number().int().nonnegative().default(4),

  /**
   * Ceiling on a single tool call. A tool that hangs — a credential prompt, a
   * wedged child process — would otherwise stall the run forever with no way
   * out but the Stop button.
   */
  toolTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .default(120_000),
  /**
   * Ceiling on ACTIVE run time. Excludes time parked on an approval prompt, so
   * stepping away from a permission dialog can never trip it.
   */
  maxRuntimeMs: z
    .number()
    .int()
    .positive()
    .max(86_400_000)
    .default(900_000),
  /**
   * Hard cap on a caller-supplied `run_shell` timeout_ms. Long builds are a
   * legitimate need, so the model may ask for more than `toolTimeoutMs` — but
   * not without bound.
   */
  maxExplicitShellTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .default(600_000),
});

/**
 * Note on `.prefault({})` below: these sub-schemas already give every field a
 * default, so an omitted section should be filled in field-by-field. zod v4's
 * `.default()` short-circuits parsing and would demand a fully-populated
 * object; `.prefault()` feeds `{}` *through* the schema so the inner defaults
 * apply. That is what makes a completely empty config.toml valid.
 */
export const ConfigSchema = z.object({
  providers: z.record(z.string(), ProviderSchema).default({}),
  tiers: TiersSchema.prefault({}),
  /** Model catalog overrides / additions, merged over the built-in models.json. */
  models: z.record(z.string(), ModelEntrySchema.partial()).default({}),
  permissions: z
    .object({
      /**
       * safe      — confirm every write and every shell command
       * auto-edit — writes apply automatically, shell still confirmed (default)
       * yolo      — no confirmation at all (dangerous commands still warn)
       */
      mode: z.enum(['safe', 'auto-edit', 'yolo']).default('auto-edit'),
      /** Extra directories the agent may touch beyond the project root. */
      extraRoots: z.array(z.string()).default([]),
      /** Globs the agent may never read, on top of the built-in secret patterns. */
      deny: z.array(z.string()).default([]),
    })
    .prefault({}),
  shell: z
    .object({
      /** "auto" = PowerShell on Windows, bash elsewhere. */
      kind: z.enum(['auto', 'powershell', 'bash', 'cmd']).default('auto'),
      /** Explicit interpreter path, e.g. "C:\\Program Files\\Git\\bin\\bash.exe". */
      path: z.string().optional(),
      timeoutMs: z.number().int().positive().default(120_000),
    })
    .prefault({}),
  limits: LimitsSchema.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Built-in provider presets. Users normally supply only the API key (via env),
 * so a minimal config.toml is just `[tiers]`.
 *
 * Note `zai` and `zai-coding-plan` are the *same vendor* on two different wire
 * formats: metered pay-per-token over ChatCompletions, and the flat-rate Coding
 * Plan over an Anthropic-shaped endpoint.
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    kind: 'openai',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'env:DEEPSEEK_API_KEY',
    headers: {},
  },
  zai: {
    kind: 'openai',
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKey: 'env:ZAI_API_KEY',
    headers: {},
  },
  'zai-coding-plan': {
    kind: 'anthropic',
    baseURL: 'https://api.z.ai/api/anthropic',
    apiKey: 'env:ZAI_API_KEY',
    headers: {},
  },
  moonshot: {
    kind: 'openai',
    baseURL: 'https://api.moonshot.ai/v1',
    apiKey: 'env:MOONSHOT_API_KEY',
    headers: {},
  },
  anthropic: {
    kind: 'anthropic',
    // No baseURL — the SDK default is correct, and ANTHROPIC_BASE_URL still works.
    apiKey: 'env:ANTHROPIC_API_KEY',
    headers: {},
  },
  openrouter: {
    kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'env:OPENROUTER_API_KEY',
    headers: {},
  },
  ollama: {
    kind: 'openai',
    baseURL: 'http://localhost:11434/v1',
    // Ollama ignores the key but the OpenAI SDK requires a non-empty string.
    apiKey: 'ollama',
    headers: {},
  },
  openai: {
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'env:OPENAI_API_KEY',
    headers: {},
  },
};
