import type { AppEnv, ProviderKind } from '../config/env.js';
import { resolveEndpoint, resolveModelFallbacks, resolveProviderKind } from '../providers/EndpointResolver.js';
import { qualifyModel } from '../providers/modelSlug.js';
import type { LocalContextConfig } from './LocalContextLoader.js';

/**
 * Resolution of per-stage configuration (model + provider + sampling).
 *
 * Precedence (highest first):
 *   1. CLI flag (--model / --provider)
 *   2. .harness/context.json : models[stage] / provider / providerByStage[stage]
 *   3. .harness/context.json : defaultModel
 *   4. env (.env)            : HARNESS_MODEL / CLAUDE_MODEL / OPENAI_MODEL
 *   5. provider default
 *
 * Names in `.harness/context.json` stay PLAIN (`qwen3-32b`, not
 * `qwen/qwen3-32b`) so one repo can swap endpoints via `.env` alone; the
 * qualification for the active endpoint happens here, at call time.
 */
export function resolveStageModel(
  stage: string,
  local: LocalContextConfig,
  env: AppEnv,
  cliModel?: string,
): string | undefined {
  const resolved = resolveEndpoint(env);
  const slug = resolved.slug;

  const raw =
    cliModel ??
    local.models?.[stage] ??
    local.defaultModel ??
    resolved.profile.defaultModel;

  if (!raw) return undefined;

  // Claude/Kiro speak their own naming; only OpenAI-compatible endpoints need
  // vendor qualification.
  if (resolved.profile.kind !== 'openai') return raw;

  return qualifyModel(raw, slug);
}

/** Reserve models (qualified) configured for this app via HARNESS_MODEL_FALLBACKS. */
export function resolveStageModelFallbacks(env: AppEnv): string[] {
  const resolved = resolveEndpoint(env);
  if (resolved.profile.kind !== 'openai') return [];
  return resolveModelFallbacks(env, resolved.slug);
}


/** Resolve the provider kind for a stage (flag > local > env > auto). */
export function resolveStageProvider(
  stage: string,
  local: LocalContextConfig,
  env: AppEnv,
  cliProvider?: ProviderKind,
): ProviderKind {
  if (cliProvider) return cliProvider;

  const perStage = local.providerByStage?.[stage];
  if (perStage && perStage !== 'auto') return perStage;

  if (local.provider && local.provider !== 'auto') return local.provider;

  return resolveProviderKind(env);
}

/** Resolve sampling overrides for a stage. */
export function resolveStageTuning(
  stage: string,
  local: LocalContextConfig,
): { maxTokens?: number; temperature?: number } {
  const t = local.stages?.[stage];
  if (!t) return {};
  return {
    ...(t.maxTokens !== undefined ? { maxTokens: t.maxTokens } : {}),
    ...(t.temperature !== undefined ? { temperature: t.temperature } : {}),
  };
}

/** Resolve the MCP tool whitelist for a stage (undefined = all available). */
export function resolveStageMcpTools(
  stage: string,
  local: LocalContextConfig,
): string[] | undefined {
  return local.mcpTools?.[stage];
}
