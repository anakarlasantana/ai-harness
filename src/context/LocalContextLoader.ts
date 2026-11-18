import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { log } from '../core/logger.js';
import type { ProviderSelection } from '../config/env.js';

/**
 * Local Context Folder (.harness/) loader.
 *
 * Each application can drop a `.harness/` directory at its repo root to steer
 * the agent autonomously, keeping the harness itself 100% generic:
 *
 *   .harness/context.json      | context.jsonc | .harnessai | .harnessrc
 *      → metadata: provider, architecture rules, lint/test commands, mcpServers
 *   .harness/instructions.md
 *      → app-specific style guides appended to the System Prompt
 */

const LocalConfigSchema = z.object({
  /**
   * Wire format for this app. `auto` (or omitted) lets the harness infer it
   * from the endpoint configured in `.env` — so an app can stay provider-neutral
   * and still own its choice here.
   */
  provider: z.enum(['auto', 'kiro', 'openai', 'claude']).optional(),
  architectureRules: z.array(z.string()).optional(),
  lintCommand: z.string().optional(),
  testCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  styleGuide: z.string().optional(),
  /** Per-app MCP servers (same shape as Kiro's mcp.json `mcpServers`). */
  mcpServers: z.record(z.any()).optional(),

  // ── Model & per-stage tuning (cost optimization) ──────────────────────────
  /** Model to use per stage/persona. Keys are stage names (plan, code, qa, ...). */
  models: z.record(z.string(), z.string()).optional(),
  /** Fallback model when a stage isn't in `models`. */
  defaultModel: z.string().optional(),
  /** Optional provider override per stage (e.g. { code: "groq" }). */
  providerByStage: z.record(z.string(), z.enum(['auto', 'kiro', 'openai', 'claude'])).optional(),
  /** Per-stage sampling overrides. */
  stages: z
    .record(
      z.string(),
      z.object({
        maxTokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
      }),
    )
    .optional(),
  /** Which MCP tools each stage is allowed to use, e.g. { design: ["figma.get_design_context"] }. */
  mcpTools: z.record(z.string(), z.array(z.string())).optional(),

  // ── Verificação (prontidão e ponta-a-ponta) ────────────────────────────────
  /**
   * `verification.readiness.command` é o "definition of done" do repositório
   * em UM comando (ex.: `make ready`). Tem precedência sobre `testCommand`.
   */
  verification: z
    .object({
      readiness: z
        .object({
          command: z.string().min(1),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
      /** Persona de API (L1): o comando que roda os testes de integração do alvo. */
      api: z
        .object({
          command: z.string().min(1),
          timeoutMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  /** Ciclo ponta-a-ponta declarado pelo alvo (validado em `engine/e2e/types`). */
  e2e: z
    .object({
      before: z.array(z.string().min(1)).optional(),
      command: z.string().min(1).optional(),
      after: z.array(z.string().min(1)).optional(),
      journey: z.record(z.string(), z.string().min(1)).optional(),
      timeoutMs: z.number().int().positive().optional(),
      evidenceDir: z.string().optional(),
      digest: z.string().optional(),
      logs: z
        .array(z.object({ name: z.string().min(1), command: z.string().min(1) }))
        .optional(),
      allowlist: z.array(z.object({ status: z.number().int(), path: z.string().optional() })).optional(),
    })
    .optional(),
  /** Onde os registros de rework vivem (lido pelo fluxo de correção). */
  rework: z
    .object({
      dir: z.string().min(1),
      indice: z.string().optional(),
      template: z.string().optional(),
      regra: z.string().optional(),
    })
    .optional(),
});

export type LocalContextConfig = z.infer<typeof LocalConfigSchema>;

export interface LocalContext {
  /** Path of the .harness directory, if it exists. */
  dir: string | null;
  config: LocalContextConfig;
  /** Contents of instructions.md (or styleGuide target), if present. */
  instructions: string;
}

const CONFIG_CANDIDATES = ['context.json', 'context.jsonc', '.harnessai', '.harnessrc'];

export class LocalContextLoader {
  private static cache = new Map<string, LocalContext>();

  /** Load (and cache) the local context for a given repo root. */
  static load(cwd: string): LocalContext {
    const cached = LocalContextLoader.cache.get(cwd);
    if (cached) return cached;

    const dir = path.join(cwd, '.harness');
    const hasDir = fs.existsSync(dir) && fs.statSync(dir).isDirectory();

    let config: LocalContextConfig = {};
    if (hasDir) {
      config = LocalContextLoader.readConfig(dir);
    }

    const instructions = hasDir ? LocalContextLoader.readInstructions(dir, config) : '';

    const ctx: LocalContext = { dir: hasDir ? dir : null, config, instructions };
    LocalContextLoader.cache.set(cwd, ctx);

    if (hasDir) {
      log.debug(
        `LocalContext: .harness encontrado (provider=${config.provider ?? '-'}, instructions=${instructions.length} chars).`,
      );
    }
    return ctx;
  }

  private static readConfig(dir: string): LocalContextConfig {
    for (const name of CONFIG_CANDIDATES) {
      const fp = path.join(dir, name);
      if (!fs.existsSync(fp)) continue;
      try {
        const raw = fs.readFileSync(fp, 'utf8');
        const cleaned = stripJsonComments(raw);
        const parsed = JSON.parse(cleaned);
        const result = LocalConfigSchema.safeParse(parsed);
        if (!result.success) {
          log.warn(
            `LocalContext: ${name} inválido (${result.error.issues[0]?.message}); ignorando campos.`,
          );
          return {};
        }
        return result.data;
      } catch (err) {
        log.warn(`LocalContext: falha ao ler ${name}: ${(err as Error).message}`);
      }
    }
    return {};
  }

  private static readInstructions(dir: string, config: LocalContextConfig): string {
    const target = config.styleGuide
      ? path.resolve(dir, config.styleGuide)
      : path.join(dir, 'instructions.md');
    try {
      if (fs.existsSync(target)) return fs.readFileSync(target, 'utf8').trim();
    } catch (err) {
      log.warn(`LocalContext: falha ao ler instructions: ${(err as Error).message}`);
    }

    // Fallback cross-tool: `AGENTS.md` na raiz do repositório é o padrão que
    // Cline, Codex e Claude leem. Uma regra, um arquivo — o harness não duplica.
    try {
      const agents = path.join(dir, '..', 'AGENTS.md');
      if (fs.existsSync(agents)) {
        log.debug('LocalContext: usando AGENTS.md como instruções.');
        return fs.readFileSync(agents, 'utf8').trim();
      }
    } catch (err) {
      log.warn(`LocalContext: falha ao ler AGENTS.md: ${(err as Error).message}`);
    }

    return '';
  }
}

/** Strip // and /* *\/ comments so `.jsonc` / `.harnessrc` parse as JSON. */
function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '"' && input[i - 1] !== '\\') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Provider override parsed from the local context, if any. */
export function localProvider(ctx: LocalContext): ProviderSelection | undefined {
  return ctx.config.provider;
}
