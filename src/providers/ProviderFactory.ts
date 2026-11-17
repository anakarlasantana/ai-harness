import type { AppEnv, ProviderKind } from '../config/env.js';
import { log } from '../core/logger.js';
import { ClaudeProvider } from './ClaudeProvider.js';
import { resolveEndpoint } from './EndpointResolver.js';
import { KiroProvider } from './KiroProvider.js';
import type { LLMProvider } from './LLMProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';

/**
 * Provider factory.
 *
 * Resolution precedence for the WIRE FORMAT (`kind`):
 *   1. explicit `override` (e.g. CLI flag --provider)
 *   2. .harness/context.json:provider
 *   3. HARNESS_PROVIDER (.env) — `auto` infers it from the configured endpoint
 *   4. default: kiro
 *
 * Credentials and the base URL never reach this file: `resolveEndpoint()` turns
 * them into an `EndpointProfile`, so provider selection and endpoint selection
 * are independent concerns. That is what lets one app keep its provider in
 * `.harness/context.json` while another needs zero credentials (Kiro).
 */
export function createProvider(
  env: AppEnv,
  resolution: { override?: ProviderKind; fromLocalContext?: ProviderKind } = {},
): LLMProvider {
  const resolved = resolveEndpoint(env);
  const kind: ProviderKind =
    resolution.override ?? resolution.fromLocalContext ?? resolved.profile.kind ?? 'kiro';

  const profile =
    kind === resolved.profile.kind ? resolved.profile : { ...resolved.profile, kind };

  log.debug(
    `ProviderFactory: "${kind}" via ${profile.label}` +
      (profile.baseUrl ? ` @ ${profile.baseUrl}` : ''),
  );

  switch (kind) {
    case 'kiro':
      return new KiroProvider(env);
    case 'openai':
      return new OpenAIProvider(env, profile);
    case 'claude':
      return new ClaudeProvider(env, profile);
    default: {
      // Exhaustiveness guard.
      const never: never = kind;
      throw new Error(`Provider desconhecido: ${String(never)}`);
    }
  }
}

