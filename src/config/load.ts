/**
 * Layered configuration loading.
 *
 * Precedence, lowest to highest:
 *   1. Schema defaults + built-in provider presets
 *   2. ~/.forge/config.toml            (global)
 *   3. <project>/.forge/config.toml    (per-project)
 *   4. Environment variables           (FORGE_MODEL, FORGE_PERMISSION_MODE, ...)
 *   5. CLI flags                       (applied by cli.tsx after this returns)
 *
 * Nothing here throws on a missing config file — zero-config startup is a
 * requirement. It throws only on a *malformed* file, because silently ignoring
 * a typo'd config is worse than failing loudly.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';

import {
  ConfigSchema,
  BUILTIN_PROVIDERS,
  ModelEntrySchema,
  type Config,
  type ModelEntry,
  type ProviderConfig,
} from './schema.ts';
import rawCatalog from './models.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** ~/.forge — global config, session database, logs. */
export function forgeHome(): string {
  const dir = process.env.FORGE_HOME ?? join(homedir(), '.forge');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** <project>/.forge — per-project config and the permission allowlist. */
export function projectForgeDir(cwd: string): string {
  return join(cwd, '.forge');
}

export function globalConfigPath(): string {
  return join(forgeHome(), 'config.toml');
}

export function projectConfigPath(cwd: string): string {
  return join(projectForgeDir(cwd), 'config.toml');
}

export function databasePath(): string {
  return join(forgeHome(), 'forge.db');
}

/**
 * ~/.forge/keys.json — API keys saved from the desktop app's Settings.
 *
 * Env vars remain the preferred source (and always win), but "open PowerShell
 * and run SetEnvironmentVariable" is exactly the kind of step the desktop app
 * exists to remove. Keys stored here live outside any repository, are read
 * only by forge, and are sent only to their provider.
 */
export function keysPath(): string {
  return join(forgeHome(), 'keys.json');
}

export function readStoredKeys(): Record<string, string> {
  try {
    if (!existsSync(keysPath())) return {};
    const parsed = JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) out[name] = value.trim();
    }
    return out;
  } catch {
    // A corrupt keys file must never block startup; it just means "no keys".
    return {};
  }
}

export function writeStoredKey(provider: string, key: string): void {
  const keys = readStoredKeys();
  if (key.trim()) keys[provider] = key.trim();
  else delete keys[provider];
  writeFileSync(keysPath(), `${JSON.stringify(keys, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

/**
 * Parse the bundled catalog, dropping `$comment` keys (JSON has no comments, so
 * the file documents itself with `$`-prefixed entries that are not models).
 */
function loadBuiltinCatalog(): Record<string, ModelEntry> {
  const out: Record<string, ModelEntry> = {};
  for (const [key, value] of Object.entries(rawCatalog as Record<string, unknown>)) {
    if (key.startsWith('$')) continue;
    const parsed = ModelEntrySchema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/**
 * Merge user model overrides over the built-in catalog.
 *
 * A user entry may be partial — `{ pricing = { input = 0.12 } }` patches just
 * the price of a known model. A fully-specified entry adds a new model. This is
 * the escape hatch for the fact that model IDs and prices churn constantly:
 * you never have to wait for a forge release to use a new model.
 */
export function buildCatalog(config: Config): Record<string, ModelEntry> {
  const catalog = loadBuiltinCatalog();
  for (const [key, patch] of Object.entries(config.models)) {
    const base = catalog[key];
    const merged = {
      ...(base ?? {}),
      ...patch,
      pricing: { ...(base?.pricing ?? {}), ...(patch.pricing ?? {}) },
    };
    const parsed = ModelEntrySchema.safeParse(merged);
    if (parsed.success) {
      catalog[key] = parsed.data;
    } else {
      throw new Error(
        `Invalid model entry [models."${key}"] in config: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }
  }
  return catalog;
}

// ---------------------------------------------------------------------------
// Loading + merging
// ---------------------------------------------------------------------------

function readTomlIfPresent(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    // Strip a UTF-8 BOM. Notepad, `Set-Content -Encoding utf8`, and several
    // Windows editors add one by default, and the TOML parser reports it as an
    // invalid character in the first key — an error that points at a line which
    // looks perfectly correct on screen.
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    return parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive merge where `override` wins. Arrays replace rather than concat. */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

export interface LoadedConfig {
  config: Config;
  catalog: Record<string, ModelEntry>;
  /** Absolute project root. All file tools are jailed to this directory. */
  cwd: string;
  /** Config files that were actually found, for `/help` and debugging. */
  sources: string[];
  /** Non-fatal problems worth surfacing once at startup. */
  warnings: string[];
}

export function loadConfig(cwdInput?: string): LoadedConfig {
  const cwd = resolve(cwdInput ?? process.cwd());
  const sources: string[] = [];
  const warnings: string[] = [];

  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(cwd);
  if (existsSync(globalPath)) sources.push(globalPath);
  if (existsSync(projectPath)) sources.push(projectPath);

  // Built-in provider presets form the BASE layer, merged under everything the
  // user wrote. This is what makes a partial override work: a user who only
  // wants a different baseURL for deepseek writes two lines and inherits `kind`
  // and the API-key binding. Layering the presets on after validation instead
  // would reject that config for a missing `kind` the user never needed to know
  // about.
  let merged: Record<string, unknown> = { providers: structuredClone(BUILTIN_PROVIDERS) };
  merged = deepMerge(merged, readTomlIfPresent(globalPath));
  merged = deepMerge(merged, readTomlIfPresent(projectPath));
  merged = deepMerge(merged, envOverrides());

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid forge configuration:\n${detail}`);
  }
  const config = parsed.data;

  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.apiKey && !provider.apiKey.startsWith('env:') && provider.apiKey !== 'ollama') {
      warnings.push(
        `Provider "${name}" has a literal apiKey in config. Prefer apiKey = "env:VAR_NAME" so keys never land in a file you might commit.`,
      );
    }
  }

  const catalog = buildCatalog(config);

  // Validate tier targets early — a typo here is otherwise a confusing runtime
  // failure on the first request rather than a clear message at startup.
  for (const [tier, key] of Object.entries(config.tiers)) {
    if (!catalog[key]) {
      warnings.push(
        `Tier "${tier}" points at unknown model "${key}". Add it under [models."${key}"] in your config, or pick one of: ${Object.keys(catalog).slice(0, 4).join(', ')}, ...`,
      );
    }
  }

  return { config, catalog, cwd, sources, warnings };
}

/**
 * Environment overrides. Deliberately few — env vars are for CI and one-off
 * runs, not a second config system.
 */
function envOverrides(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const tiers: Record<string, string> = {};

  if (process.env.FORGE_CHEAP_MODEL) tiers.cheap = process.env.FORGE_CHEAP_MODEL;
  if (process.env.FORGE_STRONG_MODEL) tiers.strong = process.env.FORGE_STRONG_MODEL;
  if (process.env.FORGE_FAST_MODEL) tiers.fast = process.env.FORGE_FAST_MODEL;
  if (Object.keys(tiers).length) out.tiers = tiers;

  if (process.env.FORGE_PERMISSION_MODE) {
    out.permissions = { mode: process.env.FORGE_PERMISSION_MODE };
  }
  return out;
}

/**
 * Resolve a provider's credential.
 *
 * Order: env var (when apiKey is an "env:FOO" indirection) → a key stored by
 * the desktop app in ~/.forge/keys.json under the provider's name → a literal
 * value from config. Returns null when nothing is set, so callers can say
 * "set DEEPSEEK_API_KEY or add a key in Settings" instead of surfacing a 401.
 */
export function resolveApiKey(provider: ProviderConfig, providerName?: string): string | null {
  const raw = provider.apiKey;
  const stored = providerName ? readStoredKeys()[providerName] : undefined;

  if (!raw) return stored ?? null;
  if (raw.startsWith('env:')) {
    const varName = raw.slice(4);
    return process.env[varName] || stored || null;
  }
  return raw;
}

/** The env var name a provider expects, for error messages. */
export function apiKeyEnvName(provider: ProviderConfig): string | null {
  if (provider.apiKey?.startsWith('env:')) return provider.apiKey.slice(4);
  return null;
}
