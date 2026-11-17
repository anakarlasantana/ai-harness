import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { log } from '../core/logger.js';

/**
 * Environment configuration, validated with Zod.
 * Loaded from the CURRENT repository's `.env` (the directory where the CLI
 * was invoked), so each app can carry its own provider/credentials.
 */

export const PROVIDER_KINDS = ['kiro', 'openai', 'claude'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** `auto` infers the wire format from whichever endpoint was configured. */
export const PROVIDER_SELECTIONS = ['auto', ...PROVIDER_KINDS] as const;
export type ProviderSelection = (typeof PROVIDER_SELECTIONS)[number];

const EnvSchema = z.object({
  HARNESS_PROVIDER: z.enum(PROVIDER_SELECTIONS).default('auto'),
  HARNESS_MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(8),
  HARNESS_DEBUG: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),

  // ── Generic endpoint (canonical, provider-agnostic) ─────────────────────────
  // One triple drives any OpenAI-compatible endpoint (Groq, DeepSeek, OpenRouter,
  // Ollama, Together...) and the Claude Messages API. Providers that need no
  // credential at all (Kiro, via CLI SSO) simply ignore these.
  /** Base URL of the model endpoint. `/v1` is appended when missing. */
  HARNESS_BASE_URL: z.string().optional(),
  /** Credential for the endpoint above. */
  HARNESS_API_KEY: z.string().optional(),
  /** Default model (overridden per stage by `.harness/context.json:models`). */
  HARNESS_MODEL: z.string().optional(),
  /** Comma-separated reserve models tried when the primary fails. */
  HARNESS_MODEL_FALLBACKS: z.string().optional(),
  /** Total attempts per model call before giving up (1 disables retries). */
  HARNESS_PROVIDER_RETRIES: z.coerce.number().int().min(1).max(6).default(3),

  // Kiro (SSO via local CLI first; HTTP fallback only)
  KIRO_CLI_BIN: z.string().optional(),
  KIRO_GATEWAY_URL: z.string().url().optional(),
  KIRO_SESSION_TOKEN: z.string().optional(),
  KIRO_TEMPLATES_PATH: z.string().optional(),

  // OpenAI-compatible legacy aliases (still honored, lower precedence).
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  /** Custom base URL for OpenAI-compatible endpoints (e.g. https://api.deepseek.com/v1). */
  OPENAI_BASE_URL: z.string().optional(),

  // Claude / Anthropic
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().optional(),
  /** Custom base URL for Anthropic-compatible gateways. */
  ANTHROPIC_BASE_URL: z.string().optional(),


  // Design / Figma MCP
  /** Personal Figma access token (injected as Bearer into the Figma MCP HTTP transport). */
  FIGMA_ACCESS_TOKEN: z.string().optional(),
  /** Figma MCP endpoint (defaults to the official hosted MCP). */
  FIGMA_MCP_URL: z.string().url().default('https://mcp.figma.com/mcp'),

  // Dashboard
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type AppEnv = z.infer<typeof EnvSchema> & {
  /** Absolute path to the repository that invoked the CLI. */
  cwd: string;
};

/**
 * Load and validate the environment for the given working directory.
 * @param cwd Directory where the CLI was invoked (defaults to process.cwd()).
 */
export function loadEnv(cwd: string = process.cwd()): AppEnv {
  const envPath = path.resolve(cwd, '.env');
  loadDotenv({ path: envPath, override: false, quiet: true });

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    log.err(`Configuração de ambiente inválida:\n${issues}`);
    throw new Error('Falha na validação do ambiente (.env)');
  }

  if (parsed.data.HARNESS_DEBUG) {
    process.env.HARNESS_DEBUG = '1';
  }

  return { ...parsed.data, cwd };
}
