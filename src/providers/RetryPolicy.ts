import { log } from '../core/logger.js';

/**
 * RetryPolicy — classifies provider errors and decides whether (and how long)
 * to wait before retrying.
 *
 * Motivation (real incident): a single `Premature close` from
 * https://api.groq.com/openai/v1/chat/completions aborted a whole task on
 * iteration 1, because the orchestrator treated any provider error as fatal.
 * Transient transport hiccups must be retried; *semantic* errors (bad key, no
 * balance, unknown model) must NOT be retried — they need a config fix.
 */

export type ErrorClass =
  /** Socket reset / premature close / DNS blip — safe to retry. */
  | 'transient'
  /** 429 — rate limited; retry with a longer backoff. */
  | 'rate_limit'
  /** 5xx — upstream hiccup; retry a couple of times. */
  | 'server'
  /** 401/403 — credential problem. Never retry. */
  | 'auth'
  /** 402 — out of balance/quota. Never retry. */
  | 'billing'
  /** 404 / decommissioned model. Never retry (try another model instead). */
  | 'model_not_found'
  /** Anything else (400, malformed response...). Never retry. */
  | 'fatal';

export interface RetryDecision {
  errorClass: ErrorClass;
  retryable: boolean;
  /** Suggested wait before the next attempt (ms). 0 when not retryable. */
  delayMs: number;
  /** Short, actionable explanation for the user. */
  hint: string;
}

/** Backoff schedule for transient/5xx errors (ms). */
const TRANSIENT_BACKOFF = [1_000, 3_000, 9_000];
/** Backoff schedule for 429 — vendors reset per minute. */
const RATE_LIMIT_BACKOFF = [5_000, 15_000, 45_000];

/** Extract an HTTP status from an SDK error of any shape. */
function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}

/** Concatenated message + machine codes, for pattern matching. */
function messageOf(err: unknown): string {
  const e = err as { message?: string; code?: string; type?: string; error?: { message?: string } };
  return [e?.message, e?.code, e?.type, e?.error?.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' | ');
}

/** True when the message looks like a dropped connection. */
function isTransportError(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('premature close') ||
    t.includes('econnreset') ||
    t.includes('etimedout') ||
    t.includes('socket hang up') ||
    t.includes('fetch failed') ||
    t.includes('econnrefused') ||
    t.includes('eai_again') ||
    t.includes('enotfound') ||
    t.includes('terminated') ||
    t.includes('und_err_socket')
  );
}

/** True when the provider says the model does not exist. */
function isModelNotFound(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('model_not_found') ||
    t.includes('no longer available') ||
    t.includes('decommissioned') ||
    t.includes('does not exist') ||
    t.includes('unknown model') ||
    t.includes('invalid model') ||
    t.includes('model not found')
  );
}

/**
 * Classify an error and produce the retry decision for attempt `attempt`
 * (zero-based: 0 = first retry).
 */
export function classifyError(err: unknown, attempt: number): RetryDecision {
  const status = statusOf(err);
  const text = messageOf(err);

  if (isModelNotFound(text) || status === 404) {
    return {
      errorClass: 'model_not_found',
      retryable: false,
      delayMs: 0,
      hint: 'Modelo inexistente neste endpoint — confira HARNESS_MODEL / .harness/context.json e rode `ai models`.',
    };
  }

  if (status === 401 || status === 403) {
    return {
      errorClass: 'auth',
      retryable: false,
      delayMs: 0,
      hint: 'Credencial recusada — confira HARNESS_API_KEY (ou OPENAI_API_KEY) e rode `ai doctor`.',
    };
  }

  if (status === 402) {
    return {
      errorClass: 'billing',
      retryable: false,
      delayMs: 0,
      hint: 'Sem saldo/cota no provedor — recarregue a conta ou troque HARNESS_BASE_URL.',
    };
  }

  if (status === 429) {
    const delay = RATE_LIMIT_BACKOFF[Math.min(attempt, RATE_LIMIT_BACKOFF.length - 1)] ?? 45_000;
    return {
      errorClass: 'rate_limit',
      retryable: true,
      delayMs: delay,
      hint: 'Rate limit do provedor — aguardando a janela reabrir.',
    };
  }

  if (status !== undefined && status >= 500) {
    const delay = TRANSIENT_BACKOFF[Math.min(attempt, TRANSIENT_BACKOFF.length - 1)] ?? 9_000;
    return {
      errorClass: 'server',
      retryable: true,
      delayMs: delay,
      hint: `Provedor instável (HTTP ${status}).`,
    };
  }

  if (isTransportError(text)) {
    const delay = TRANSIENT_BACKOFF[Math.min(attempt, TRANSIENT_BACKOFF.length - 1)] ?? 9_000;
    return {
      errorClass: 'transient',
      retryable: true,
      delayMs: delay,
      hint: 'Conexão interrompida (proxy/rede/keep-alive).',
    };
  }

  return {
    errorClass: 'fatal',
    retryable: false,
    delayMs: 0,
    hint: status ? `Requisição rejeitada (HTTP ${status}).` : 'Erro não classificável.',
  };
}

/** How many retry attempts are allowed per error class. */
export function maxAttemptsFor(errorClass: ErrorClass): number {
  switch (errorClass) {
    case 'transient':
      return TRANSIENT_BACKOFF.length;
    case 'rate_limit':
      return RATE_LIMIT_BACKOFF.length;
    case 'server':
      return 2;
    default:
      return 0;
  }
}

/** Sleep helper (shared by all transports). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Log a retry in a consistent, terse way. */
export function logRetry(
  label: string,
  decision: RetryDecision,
  attempt: number,
  total: number,
  detail: string,
): void {
  log.warn(
    `${label}: ${decision.hint} Retry ${attempt + 1}/${total} em ${Math.round(
      decision.delayMs / 1000,
    )}s (${detail.slice(0, 180)}).`,
  );
}

/**
 * Wrap an async provider call with the retry policy.
 *
 * @param label    Provider label for logs (e.g. "Groq").
 * @param fn       The call to execute; receives the zero-based attempt.
 * @param maxTries Hard cap on total attempts (>= 1).
 */
export async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  maxTries = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const decision = classifyError(err, attempt);
      const allowed = maxAttemptsFor(decision.errorClass);

      // Non-retryable, schedule exhausted, or the cap was reached -> give up
      // with an actionable message that keeps the original error as `cause`.
      if (!decision.retryable || attempt + 1 >= maxTries || attempt >= allowed) {
        throw enrich(err, decision);
      }

      logRetry(label, decision, attempt, Math.min(maxTries, allowed), String((err as Error)?.message ?? err));
      await sleep(decision.delayMs);
    }
  }

  throw lastError;
}

/** Attach the classification hint to the error message (keeps `cause`). */
function enrich(err: unknown, decision: RetryDecision): Error {
  const original = err instanceof Error ? err : new Error(String(err));

  // Transport-shaped fragments inside an HTTP-status error are misleading
  // ("401 ... Premature close"). When the class is semantic, lead with the
  // status and drop the noise.
  const status = statusOf(err);
  const base =
    status !== undefined && (decision.errorClass === 'auth' || decision.errorClass === 'billing' || decision.errorClass === 'model_not_found')
      ? `HTTP ${status} em ${hostFromMessage(original.message) ?? 'endpoint'}`
      : original.message;

  return new Error(`${base} — ${decision.hint} [${decision.errorClass}]`, { cause: original });
}

/** Pull the request URL out of an SDK error message, if present. */
function hostFromMessage(message: string): string | null {
  const match = message.match(/https?:\/\/[^\s)]+/);
  if (!match) return null;
  try {
    return new URL(match[0]).host;
  } catch {
    return null;
  }
}

