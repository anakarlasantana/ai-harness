import type { ProviderKind } from '../config/env.js';
import type { ProviderSlug } from './modelSlug.js';

/**
 * EndpointProfile — single source of truth for "where does the model live and
 * how do I talk to it?".
 *
 * The harness keeps ONE provider per app (chosen by the app's
 * `.harness/context.json` or `HARNESS_PROVIDER`) and varies only the MODEL per
 * stage. Credentials + base URL are therefore generic: swapping
 * Groq -> DeepSeek -> OpenRouter -> Ollama is a three-variable change, never a
 * code change.
 *
 * Providers that need no credentials at all (Kiro, which inherits the local CLI
 * SSO session) simply report `requiresApiKey: false`, so the generic
 * `HARNESS_API_KEY` / `HARNESS_BASE_URL` variables stay optional for them.
 */
export interface EndpointProfile {
  /** Wire format the transport speaks. */
  kind: ProviderKind;
  /** Human label for logs / `ai doctor` (e.g. "Groq", "DeepSeek"). */
  label: string;
  /** Effective base URL (already normalized for `openai`-kind endpoints). */
  baseUrl?: string;
  /** Effective credential (never logged verbatim). */
  apiKey?: string;
  /** Default model when the stage/context does not dictate one. */
  defaultModel?: string;
  /**
   * Vendor slug used to qualify bare model names (e.g. `groq` turns
   * `qwen3-32b` into `qwen/qwen3-32b`). `unknown` = leave names untouched.
   */
  slug?: ProviderSlug;
  /** False for Kiro (CLI SSO): the generic credential vars are not needed. */
  requiresApiKey: boolean;
  /** Extra headers the transport should send on every request. */
  extraHeaders?: Record<string, string>;
  /** Where the effective configuration came from (diagnostics only). */
  source?: string;
}

/** Mask a secret for display: keep a short head + tail. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '(ausente)';
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
