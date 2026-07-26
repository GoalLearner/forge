/**
 * Retry policy for provider calls.
 *
 * The important subtlety: we retry only failures that occur *before the first
 * event is yielded*. Once tokens have been streamed to the screen, a retry
 * would duplicate visible output and, worse, produce a message array that
 * doesn't match what the user saw. Mid-stream failures surface to the loop,
 * which keeps the partial assistant turn and lets the user decide.
 *
 * Only transport errors and 429/5xx are retried. A 400 means our request is
 * malformed and retrying it identically is guaranteed to fail again — that is a
 * bug to surface, not to paper over.
 */

import { ProviderError, AbortedError } from './types.ts';

export interface RetryOptions {
  maxRetries: number;
  signal: AbortSignal;
  /** Called before each retry so the UI can show "retrying (2/4)...". */
  onRetry?: (attempt: number, delayMs: number, error: ProviderError) => void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Exponential backoff with full jitter. Jitter matters more than it looks: a
 * rate-limited agent that retries on a fixed schedule synchronizes with its own
 * previous attempts and keeps hitting the same limit.
 */
function backoffDelay(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec)) {
    return Math.min(retryAfterSec * 1000, MAX_DELAY_MS);
  }
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.round(Math.random() * ceiling);
}

/**
 * Run `fn`, retrying transient failures. `fn` must be side-effect free up to the
 * point it returns — it opens the stream but must not have yielded anything.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal.aborted) throw new AbortedError();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      const pe = err instanceof ProviderError ? err : classifyUnknown(err);
      if (!pe.opts.retryable || attempt === opts.maxRetries) throw pe;

      lastError = pe;
      const delay = backoffDelay(attempt, pe.opts.retryAfter);
      opts.onRetry?.(attempt + 1, delay, pe);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError ?? new Error('retry loop exhausted');
}

function classifyUnknown(err: unknown): ProviderError {
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError(message, { provider: 'unknown', retryable: false, cause: err });
}

/**
 * Translate an SDK/HTTP error into a ProviderError. Both the OpenAI and
 * Anthropic SDKs expose `status` and `headers` on their error objects, so one
 * classifier covers both.
 */
export function classifyHttpError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;

  const e = err as {
    status?: number;
    message?: string;
    error?: { message?: string };
    headers?: Record<string, string> | Headers;
    code?: string;
  };

  const status = typeof e?.status === 'number' ? e.status : undefined;
  const providerMessage = e?.error?.message ?? e?.message ?? String(err);

  // Transport-level failure: no HTTP response at all. Always worth a retry.
  if (status === undefined) {
    // Both SDKs wrap transport failures in their own error type ("Connection
    // error."), so the useful syscall code lives one or two levels down in
    // `cause`. Without unwrapping, every network problem produces the same
    // uninformative message and no actionable hint.
    const code = findErrorCode(err);

    // Both SDKs report every transport failure as a flat "Connection error.",
    // while the root cause carries the fact you actually need ("bad port",
    // "getaddrinfo ENOTFOUND api.example.com"). Surface it.
    const root = findRootMessage(err);
    const detailed =
      root && root !== providerMessage ? `${providerMessage} (${root})` : providerMessage;

    const transport =
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'EAI_AGAIN' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      /connection error|fetch failed|network|socket hang up|terminated/i.test(providerMessage);

    return new ProviderError(detailed, {
      provider,
      retryable: transport,
      cause: err,
      hint: transportHint(code),
    });
  }

  const retryAfter = readRetryAfter(e.headers);
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;

  return new ProviderError(providerMessage, {
    provider,
    status,
    retryable,
    retryAfter,
    cause: err,
    hint: hintForStatus(status, provider),
  });
}

/**
 * Dig out the underlying syscall error code.
 *
 * A refused connection arrives buried several layers deep:
 *
 *   APIConnectionError            (SDK wrapper — no code)
 *     .cause -> TypeError         ("fetch failed" — no code)
 *       .cause -> AggregateError  (no code, but has .errors)
 *         .errors[0] -> Error     { code: 'ECONNREFUSED' }   <- what we want
 *
 * So the walk follows `cause` AND descends into `errors`, or every network
 * failure reads as an unhelpful "Connection error." with no hint.
 */
export function findErrorCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 6) return undefined;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return code;

  const aggregated = (err as { errors?: unknown }).errors;
  if (Array.isArray(aggregated)) {
    for (const nested of aggregated) {
      const found = findErrorCode(nested, depth + 1);
      if (found) return found;
    }
  }

  return findErrorCode((err as { cause?: unknown }).cause, depth + 1);
}

/** The deepest message in the cause chain — usually the only specific one. */
export function findRootMessage(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 6) return undefined;

  const next =
    (Array.isArray((err as { errors?: unknown }).errors)
      ? ((err as { errors: unknown[] }).errors[0] ?? undefined)
      : undefined) ?? (err as { cause?: unknown }).cause;

  const deeper = findRootMessage(next, depth + 1);
  if (deeper) return deeper;

  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

function transportHint(code: string | undefined): string | undefined {
  switch (code) {
    case 'ECONNREFUSED':
      return 'Nothing is listening at that baseURL. Check the provider URL in your config — and if this is Ollama, that `ollama serve` is running.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Host not found. Check the provider baseURL in your config, and your network connection.';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'The connection timed out. The provider may be down, or a proxy/firewall may be blocking it.';
    default:
      return undefined;
  }
}

function readRetryAfter(headers: Record<string, string> | Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const raw =
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : (headers as Record<string, string>)['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function hintForStatus(status: number, provider: string): string | undefined {
  switch (status) {
    case 401:
    case 403:
      return `Authentication failed for "${provider}". Check that its API key env var is set and valid.`;
    case 402:
      // Worth its own case: DeepSeek and several others are prepaid, so this is
      // the single most likely first-run failure — and it means the key is
      // WORKING, which is the opposite of what "payment required" reads like.
      return `Your "${provider}" account is out of credit. The key itself is valid — this is a billing balance, not an auth problem. Top up in the provider's console and retry.`;
    case 404:
      return `Endpoint or model not found on "${provider}". Model IDs change often — verify the id in your [tiers] against the provider's current model list.`;
    case 413:
      return 'Request too large. Try /clear, or switch to a model with a bigger context window.';
    case 429:
      return `Rate limited by "${provider}".`;
    default:
      return undefined;
  }
}
