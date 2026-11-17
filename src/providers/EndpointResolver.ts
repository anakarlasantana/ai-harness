import type { AppEnv, ProviderKind } from '../config/env.js';
import { log } from '../core/logger.js';
import type { EndpointProfile } from './EndpointProfile.js';
import { detectSlug, qualifyModel, slugLabel, type ProviderSlug } from './modelSlug.js';
import { normalizeOpenAIBaseUrl } from './url.js';

/**
 * EndpointResolver — turns the (deliberately dumb) environment into an
 * EndpointProfile.
 *
 * Precedence, highest first:
 *   1. HARNESS_BASE_URL / HARNESS_API_KEY / HARNESS_MODEL   (generic — canonical)
 *   2. OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL      (OpenAI-compatible legacy)
 *   3. ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / CLAUDE_MODEL (Claude wire format)
 *   4. KIRO_GATEWAY_URL / KIRO_CLI_BIN                      (no credentials at all)
 *
 * `HARNESS_PROVIDER=auto` (default) infers the WIRE FORMAT from the resolved
 * base URL, so a single generic triple drives Groq, DeepSeek, OpenRouter,
 * Ollama and OpenAI without touching code. Kiro and Claude stay explicit
 * because they do not speak the OpenAI wire format (Kiro = CLI/SSO,
 * Claude = Messages API with `x-api-key`).
 */

export interface EndpointResolution {
  profile: EndpointProfile;
  /** Slug detected from the base URL (`unknown` when nothing matched). */
  slug: ProviderSlug;
  /** Where the effective values came from (shown by `ai doctor`). */
  sources: {
    kind: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

/** Resolve the wire-format kind for the current app. */
export function resolveProviderKind(env: AppEnv): ProviderKind {
  if (env.HARNESS_PROVIDER !== 'auto') return env.HARNESS_PROVIDER;

  // auto: infer from whichever endpoint was configured.
  if (env.HARNESS_BASE_URL) return 'openai';
  if (env.OPENAI_BASE_URL) return 'openai';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_BASE_URL) return 'claude';
  if (env.ANTHROPIC_API_KEY) return 'claude';

  // Nothing configured for an HTTP endpoint -> fall back to Kiro (CLI/SSO).
  return 'kiro';
}

/** Default base URL per known wire format (used when only a key is given). */
function defaultBaseUrlFor(kind: ProviderKind): string | undefined {
  if (kind === 'claude') return 'https://api.anthropic.com';
  if (kind === 'openai') return 'https://api.openai.com/v1';
  return undefined;
}

/** Pick the first non-empty value and report which variable produced it. */
function pick(
  candidates: Array<{ value: string | undefined; name: string }>,
): { value: string | undefined; from: string } {
  for (const c of candidates) {
    if (c.value !== undefined && c.value.trim() !== '') {
      return { value: c.value.trim(), from: c.name };
    }
  }
  return { value: undefined, from: '(default)' };
}

/**
 * Build the complete endpoint profile for the current app.
 * Never throws on missing credentials — `ai doctor` needs to inspect broken
 * setups. Transports validate what they actually require.
 */
export function resolveEndpoint(env: AppEnv): EndpointResolution {
  const kind = resolveProviderKind(env);

  if (kind === 'kiro') {
    return {
      profile: {
        kind: 'kiro',
        label: 'Kiro (CLI/SSO)',
        apiKey: env.KIRO_SESSION_TOKEN,
        requiresApiKey: false,
        source: env.HARNESS_PROVIDER === 'auto' ? 'auto (sem endpoint HTTP)' : 'HARNESS_PROVIDER',
      },
      slug: 'unknown',
      sources: {
        kind: env.HARNESS_PROVIDER === 'auto' ? 'auto (fallback kiro)' : 'HARNESS_PROVIDER',
        baseUrl: 'KIRO_GATEWAY_URL',
        apiKey: 'KIRO_SESSION_TOKEN',
        model: '(CLI default)',
      },
    };
  }

  if (kind === 'claude') {
    const base = pick([
      { value: env.HARNESS_BASE_URL, name: 'HARNESS_BASE_URL' },
      { value: env.ANTHROPIC_BASE_URL, name: 'ANTHROPIC_BASE_URL' },
    ]);
    const key = pick([
      { value: env.HARNESS_API_KEY, name: 'HARNESS_API_KEY' },
      { value: env.ANTHROPIC_API_KEY, name: 'ANTHROPIC_API_KEY' },
    ]);
    const model = pick([
      { value: env.HARNESS_MODEL, name: 'HARNESS_MODEL' },
      { value: env.CLAUDE_MODEL, name: 'CLAUDE_MODEL' },
    ]);

    return {
      profile: {
        kind: 'claude',
        label:
          base.value && base.value !== 'https://api.anthropic.com'
            ? `Claude (gateway ${safeHostname(base.value)})`
            : 'Claude (Anthropic)',
        baseUrl: base.value ?? defaultBaseUrlFor('claude'),
        apiKey: key.value,
        defaultModel: model.value,
        requiresApiKey: true,
        source: env.HARNESS_PROVIDER === 'auto' ? 'auto (Anthropic)' : 'HARNESS_PROVIDER',
      },
      slug: 'unknown',
      sources: {
        kind: env.HARNESS_PROVIDER === 'auto' ? 'auto' : 'HARNESS_PROVIDER',
        baseUrl: base.from,
        apiKey: key.from,
        model: model.from,
      },
    };
  }

  // ── openai (OpenAI-compatible wire format) ────────────────────────────────
  const base = pick([
    { value: env.HARNESS_BASE_URL, name: 'HARNESS_BASE_URL' },
    { value: env.OPENAI_BASE_URL, name: 'OPENAI_BASE_URL' },
  ]);
  const key = pick([
    { value: env.HARNESS_API_KEY, name: 'HARNESS_API_KEY' },
    { value: env.OPENAI_API_KEY, name: 'OPENAI_API_KEY' },
  ]);
  const model = pick([
    { value: env.HARNESS_MODEL, name: 'HARNESS_MODEL' },
    { value: env.OPENAI_MODEL, name: 'OPENAI_MODEL' },
  ]);

  const rawBase = base.value ?? defaultBaseUrlFor('openai');
  let normalizedBase: string | undefined;
  if (rawBase) {
    try {
      normalizedBase = normalizeOpenAIBaseUrl(rawBase);
    } catch (err) {
      log.warn(`EndpointResolver: ${(err as Error).message}`);
      normalizedBase = rawBase;
    }
  }

  // Ollama (and any local daemon) needs no credential.
  const slug = detectSlug(normalizedBase);
  const requiresApiKey = slug !== 'ollama';

  const label = normalizedBase
    ? `${slugLabel(slug)}${slug === 'unknown' ? ` (${safeHostname(normalizedBase)})` : ''}`
    : 'OpenAI';

  return {
    profile: {
      kind: 'openai',
      label,
      baseUrl: normalizedBase,
      apiKey: key.value,
      defaultModel: model.value ? qualifyModel(model.value, slug) : undefined,
      slug,
      requiresApiKey,
      source: env.HARNESS_PROVIDER === 'auto' ? 'auto (endpoint HTTP)' : 'HARNESS_PROVIDER',
    },
    slug,
    sources: {
      kind: env.HARNESS_PROVIDER === 'auto' ? 'auto' : 'HARNESS_PROVIDER',
      baseUrl: base.from,
      apiKey: key.from,
      model: model.from,
    },
  };
}

/**
 * Parse `HARNESS_MODEL_FALLBACKS` (comma-separated) into a qualified model list.
 * Empty entries are dropped so trailing commas are harmless.
 */
export function resolveModelFallbacks(env: AppEnv, slug: ProviderSlug): string[] {
  const raw = env.HARNESS_MODEL_FALLBACKS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .map((m) => qualifyModel(m, slug));
}

/** Hostname of a URL, or the raw string when it does not parse. */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
