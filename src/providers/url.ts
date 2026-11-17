/**
 * Base-URL normalization for OpenAI-compatible endpoints.
 *
 * Every vendor documents its base URL differently, and users paste all of them:
 *
 *   https://api.deepseek.com                          (docs)
 *   https://api.deepseek.com/v1                       (OpenAI SDK convention)
 *   https://api.deepseek.com/v1/chat/completions      (curl snippet)
 *   https://api.groq.com/openai/v1                    (Groq docs)
 *   http://localhost:11434                            (Ollama daemon)
 *
 * Providers must all end up with the SAME shape: a base URL the SDK can append
 * `/chat/completions` to. This module collapses every variant to that shape.
 */

/** Vendors whose OpenAI-compatible surface lives under `/v1`. */
const V1_VENDORS = [
  'api.deepseek.com',
  'api.openai.com',
  'api.mistral.ai',
  'api.together.xyz',
  'api.groq.com', // already publishes /openai/v1 — handled by the passthrough rule
];

/**
 * Normalize a user-provided OpenAI-compatible base URL.
 *
 * - strips a trailing `/chat/completions` (or `/completions`) suffix
 * - appends `/v1` when the URL has no version segment
 * - preserves vendor-specific prefixes such as Groq's `/openai/v1`
 */
export function normalizeOpenAIBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Base URL inválida: "${raw}" (esperado http(s)://host[/path])`);
  }

  // 1. Drop an endpoint suffix the user pasted by mistake.
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/(chat\/completions|completions)$/, '');
  pathname = pathname.replace(/\/+$/, '');

  // 2. Already versioned? (/v1, /v1beta, /openai/v1, /api/v3 ...)
  const isVersioned = /(^|\/)(v\d+(?:beta|alpha)?)(\/|$)/.test(pathname);

  if (!isVersioned) {
    // Ollama serves /v1; bare hosts get /v1 appended.
    pathname = `${pathname}/v1`;
  }

  url.pathname = pathname;
  url.search = '';
  url.hash = '';

  return url.toString().replace(/\/+$/, '');
}

/**
 * Build the absolute chat-completions endpoint from a normalized base URL.
 * Kept in one place so providers never concatenate paths by hand.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${normalizeOpenAIBaseUrl(baseUrl)}/chat/completions`;
}

/** Vendors we recognize for the diagnostics panel. */
export const KNOWN_V1_VENDORS = V1_VENDORS;
