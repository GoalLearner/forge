/**
 * Resolves a tier name or model spec into a live provider client.
 *
 * Two things a user can type:
 *   "cheap" | "strong" | "fast"     -> looked up in [tiers]
 *   "deepseek/deepseek-v4-pro"      -> a catalog key, used directly
 *
 * Provider clients are memoized per provider name, so switching models within
 * the same vendor reuses one HTTP client and its connection pool.
 */

import { resolveApiKey, apiKeyEnvName } from '../config/load.ts';
import type { Config, ModelEntry, TierName } from '../config/schema.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import type { Provider } from './types.ts';

export interface ResolvedModel {
  /** Catalog key, e.g. "deepseek/deepseek-v4-pro". */
  key: string;
  /** Tier this came from, when resolved by tier name. Shown in the UI. */
  tier?: TierName;
  entry: ModelEntry;
  provider: Provider;
}

export class ConfigurationError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.hint = hint;
  }
}

const TIER_NAMES: readonly string[] = ['fast', 'cheap', 'strong'];

export function isTierName(spec: string): spec is TierName {
  return TIER_NAMES.includes(spec);
}

export class ProviderRegistry {
  private clients = new Map<string, Provider>();
  private config: Config;
  private catalog: Record<string, ModelEntry>;

  constructor(config: Config, catalog: Record<string, ModelEntry>) {
    this.config = config;
    this.catalog = catalog;
  }

  /** Every model key in the catalog, for `/model` autocomplete. */
  listModels(): string[] {
    return Object.keys(this.catalog).sort();
  }

  resolve(spec: string): ResolvedModel {
    if (isTierName(spec)) {
      return { ...this.resolveKey(this.config.tiers[spec]), tier: spec };
    }
    return this.resolveKey(spec);
  }

  private resolveKey(key: string): ResolvedModel {
    const entry = this.catalog[key];
    if (!entry) {
      throw new ConfigurationError(
        `Unknown model "${key}".`,
        `Add it under [models."${key}"] in your config, or use one of: ${this.listModels().join(', ')}`,
      );
    }

    const providerConfig = this.config.providers[entry.provider];
    if (!providerConfig) {
      throw new ConfigurationError(
        `Model "${key}" needs provider "${entry.provider}", which is not configured.`,
        `Add a [providers.${entry.provider}] section to your config.`,
      );
    }

    let provider = this.clients.get(entry.provider);
    if (!provider) {
      const apiKey = resolveApiKey(providerConfig, entry.provider);
      if (!apiKey) {
        const envVar = apiKeyEnvName(providerConfig);
        throw new ConfigurationError(
          `No API key for provider "${entry.provider}".`,
          envVar
            ? `Set ${envVar} in your environment, or add a key in the app's Settings.`
            : `Set apiKey under [providers.${entry.provider}] (prefer "env:VAR_NAME").`,
        );
      }

      const opts = {
        apiKey,
        baseURL: providerConfig.baseURL,
        headers: providerConfig.headers,
      };
      provider =
        providerConfig.kind === 'anthropic'
          ? new AnthropicProvider(entry.provider, opts)
          : new OpenAIProvider(entry.provider, opts);

      this.clients.set(entry.provider, provider);
    }

    return { key, entry, provider };
  }
}
