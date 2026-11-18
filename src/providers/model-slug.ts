/**
 * Provider slugs and model-name qualification.
 *
 * The same model is named differently depending on the gateway:
 *
 *   Groq        qwen/qwen3-32b      (vendor prefix mandatory)
 *   DeepSeek    deepseek-chat       (no prefix, no vendor namespace)
 *   OpenRouter  anthropic/claude-…  (vendor prefix mandatory)
 *   Ollama      qwen3:1.7b          (tag, never a vendor path)
 *
 * Because `.harness/context.json` stores plain model names (so one repo can mix
 * stages cheaply), the harness qualifies them at call time using the endpoint's
 * slug. A name that is already qualified is left untouched.
 */

/** Slugs the harness understands (derived from the base URL host). */
export const PROVIDER_SLUGS = [
  'openai',
  'groq',
  'deepseek',
  'openrouter',
  'ollama',
  'together',
  'mistral',
  'cerebras',
  'fireworks',
  'perplexity',
  'xai',
  'unknown',
] as const;

export type ProviderSlug = (typeof PROVIDER_SLUGS)[number];

/** Host fragment -> slug. First match wins. */
const HOST_TO_SLUG: Array<{ match: RegExp; slug: ProviderSlug }> = [
  { match: /(^|\.)api\.groq\.com$/i, slug: 'groq' },
  { match: /(^|\.)api\.deepseek\.com$/i, slug: 'deepseek' },
  { match: /(^|\.)openrouter\.ai$/i, slug: 'openrouter' },
  { match: /(^|\.)api\.openai\.com$/i, slug: 'openai' },
  { match: /(^|\.)api\.together\.xyz$/i, slug: 'together' },
  { match: /(^|\.)api\.mistral\.ai$/i, slug: 'mistral' },
  { match: /(^|\.)api\.cerebras\.ai$/i, slug: 'cerebras' },
  { match: /(^|\.)api\.fireworks\.ai$/i, slug: 'fireworks' },
  { match: /(^|\.)api\.perplexity\.ai$/i, slug: 'perplexity' },
  { match: /(^|\.)api\.x\.ai$/i, slug: 'xai' },
];

/** Detect the provider slug from a base URL, falling back to `unknown`. */
export function detectSlug(baseUrl: string | undefined): ProviderSlug {
  if (!baseUrl) return 'unknown';
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return 'unknown';
  }

  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(host)) return 'ollama';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return 'ollama';

  for (const entry of HOST_TO_SLUG) {
    if (entry.match.test(host)) return entry.slug;
  }
  return 'unknown';
}

/** Human label per slug (diagnostics). */
const SLUG_LABEL: Record<ProviderSlug, string> = {
  openai: 'OpenAI',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  together: 'Together',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  fireworks: 'Fireworks',
  perplexity: 'Perplexity',
  xai: 'xAI',
  unknown: 'OpenAI-compatible',
};

export function slugLabel(slug: ProviderSlug): string {
  return SLUG_LABEL[slug] ?? SLUG_LABEL.unknown;
}

/**
 * Slugs that REQUIRE a `vendor/model` prefix. Everything else keeps plain
 * names, so `deepseek-chat` stays `deepseek-chat`.
 */
const REQUIRES_VENDOR_PREFIX: ReadonlySet<ProviderSlug> = new Set<ProviderSlug>([
  'groq',
  'openrouter',
]);

/** Groq vendors that are valid first path segments. */
const GROQ_VENDORS = [
  'openai',
  'meta-llama',
  'qwen',
  'deepseek',
  'mistralai',
  'google',
  'groq',
  'moonshotai',
  'anthropic',
  'sambanova',
  'nvidia',
  'ibm-granite',
  'allam-2-7b',
  'canopylabs',
  'compound-beta',
  'whisper-large-v3',
  'distil-whisper',
];

/** Ollama models carry a `:tag` and never a vendor path. */
function isOllamaName(model: string): boolean {
  return model.includes(':') && !model.includes('/');
}

/**
 * Qualify a model name for the endpoint that will serve it.
 *
 * @param model   Plain model name from `.harness/context.json` / `.env`.
 * @param slug    Endpoint slug resolved from the base URL.
 * @returns The name to send in the request body.
 */
export function qualifyModel(model: string, slug: ProviderSlug): string {
  const name = model.trim();
  if (!name) return name;

  // Already qualified (`vendor/model`)? Leave it.
  if (name.includes('/')) return name;

  if (!REQUIRES_VENDOR_PREFIX.has(slug)) return name;

  if (slug === 'ollama') return isOllamaName(name) ? name : name;

  if (slug === 'groq') {
    // `qwen3-32b` -> `qwen/qwen3-32b` (best-effort family inference).
    const family = inferGroqVendor(name);
    return family ? `${family}/${name}` : name;
  }

  if (slug === 'openrouter') {
    // OpenRouter always needs a vendor; without one the call 404s, so make the
    // failure explicit and early instead of guessing.
    return name;
  }

  return name;
}

/** Best-effort vendor inference for Groq's flat model names. */
function inferGroqVendor(name: string): string | null {
  const lower = name.toLowerCase();
  if (/^(llama|llama-?guard|prompt-guard)/.test(lower)) return 'meta-llama';
  if (/^qwen/.test(lower)) return 'qwen';
  if (/^deepseek/.test(lower)) return 'deepseek';
  if (/^(mistral|mixtral|codestral|pixtral)/.test(lower)) return 'mistralai';
  if (/^gemma/.test(lower)) return 'google';
  if (/^(whisper|distil-whisper)/.test(lower)) return 'whisper-large-v3';
  if (/^(moonshot|kimi)/.test(lower)) return 'moonshotai';
  if (/^gpt-oss/.test(lower)) return 'openai';
  const exact = GROQ_VENDORS.find((v) => lower.startsWith(v));
  return exact ?? null;
}

/** True when the model name looks like an OpenRouter name (has a vendor). */
export function isVendorQualified(model: string): boolean {
  return /^[a-z0-9._-]+\/[a-z0-9._:\-]+$/i.test(model);
}
