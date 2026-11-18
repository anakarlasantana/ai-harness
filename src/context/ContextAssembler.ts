import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../core/logger.js';
import type { ExecutionRecord } from '../core/ExecutionRecord.js';
import type { LocalContext } from './LocalContextLoader.js';
import {
  STAGE_CONFIG,
  SYNC_INSTRUCTIONS,
  resolveSkillName,
  type StageName,
} from './stages.js';

/**
 * Minimal-context assembler.
 *
 * GOLDEN RULE: `steering/core.md` (which carries the Ponytail minimization
 * policy) is ALWAYS loaded into the system prompt. Everything else is loaded
 * strictly on demand, based on the active stage.
 *
 * Final prompt composition (in order):
 *   core.md (always)
 *   + agent.prompt (stage persona)
 *   + skills/*.SKILL.md bodies (stage skills)
 *   + [rework] full qaFeedbackHistory
 *   + [local] architectureRules (.harness/context.json)
 *   + [local] .harness/instructions.md   ← appended last (app authority)
 */
export class ContextAssembler {
  private readonly templatesRoot: string;
  private readonly local: LocalContext;
  private readonly cache = new Map<StageName, string>();
  private coreCache: string | null = null;

  constructor(opts: { templatesPath?: string; local: LocalContext }) {
    this.templatesRoot = resolveTemplatesRoot(opts.templatesPath);
    this.local = opts.local;
    log.debug(`ContextAssembler: templates em ${this.templatesRoot}`);
  }

  /** Build the full system prompt for a stage (and optional task). */
  buildSystemPrompt(
    stage: StageName,
    task?: ExecutionRecord,
    options: { hasTools?: boolean } = {},
  ): string {
    const base = this.stageBasePrompt(stage);

    const parts: string[] = [base];

    // Rework: inject the entire rework/bug timeline for full context recovery.
    if (stage === 'rework' && task && task.qaFeedbackHistory.length > 0) {
      parts.push(
        `# Rework History (${task.id})\n` +
          `Arquitetura decidida: ${task.architectureDecision || '(não registrada)'}\n` +
          `Arquivos alterados: ${task.filesChanged.join(', ') || '(nenhum)'}\n\n` +
          `## Timeline de QA/Reworks\n` +
          task.qaFeedbackHistory.map((h) => `- ${h}`).join('\n'),
      );
    }

    // Local architecture rules.
    const rules = this.local.config.architectureRules ?? [];
    if (rules.length > 0) {
      parts.push(`# Regras de Arquitetura do App\n` + rules.map((r) => `- ${r}`).join('\n'));
    }

    // Local style guide — appended LAST so it has final authority.
    if (this.local.instructions) {
      parts.push(`# Guias de Estilo do App (.harness/instructions.md)\n${this.local.instructions}`);
    }

    // Sem ferramentas, modelos como o DeepSeek v4 vazam a sintaxe interna de
    // tool calling (DSML) em texto puro em vez de responder. Instrucao explicita
    // elimina a alucinacao na origem.
    if (options.hasTools === false) {
      parts.push(
        [
          '# Ferramentas',
          'NENHUMA ferramenta esta disponivel nesta etapa. Nao tente chamar ' +
          'ferramentas. Nao escreva blocos tool_call, DSML, <invoke> ou ' +
          '<function_call> nem JSON de funcao. Responda usando apenas o ' +
          'contexto fornecido acima.',
        ].join(String.fromCharCode(10)),
      );
    }

    return parts.join('\n\n');
  }

  /** Base prompt (core + agent + skills) — cached per stage. */
  private stageBasePrompt(stage: StageName): string {
    const cached = this.cache.get(stage);
    if (cached) return cached;

    const blocks: string[] = [];

    // 1) core.md — ALWAYS.
    blocks.push(this.loadCore());

    // 2) agent prompt (persona).
    const cfg = STAGE_CONFIG[stage];
    if (cfg.agentPath) {
      const agent = this.readAgentPrompt(cfg.agentPath);
      if (agent) blocks.push(agent);
    }

    // 3) skills for this stage.
    for (const skillRaw of cfg.skills) {
      const skill = resolveSkillName(skillRaw);
      const body = this.readSkillBody(skill);
      if (body) blocks.push(`# Skill: ${skill}\n${body}`);
    }

    // 4) sync-specific guidance.
    if (stage === 'sync') blocks.push(SYNC_INSTRUCTIONS);

    const prompt = blocks.join('\n\n');
    this.cache.set(stage, prompt);
    return prompt;
  }

  private loadCore(): string {
    if (this.coreCache !== null) return this.coreCache;
    const fp = path.join(this.templatesRoot, 'steering', 'core.md');
    const body = readMarkdownWithFrontmatterStripped(fp);
    if (!body) {
      log.warn(`ContextAssembler: core.md não encontrado em ${fp}`);
      return '# Harness Core\n(steering/core.md ausente)';
    }
    this.coreCache = body;
    return body;
  }

  private readAgentPrompt(relPath: string): string {
    const fp = path.join(this.templatesRoot, relPath);
    try {
      const json = JSON.parse(fs.readFileSync(fp, 'utf8')) as {
        name?: string;
        description?: string;
        prompt?: string;
      };
      const header = json.name ? `# Persona: ${json.name}\n${json.description ?? ''}\n` : '';
      return `${header}${json.prompt ?? ''}`.trim();
    } catch (err) {
      log.warn(`ContextAssembler: falha ao ler agente ${relPath}: ${(err as Error).message}`);
      return '';
    }
  }

  /** Public: build a specialist persona prompt (agent JSON) for fan-out. */
  buildSpecialistPrompt(agentPath: string): string {
    return this.readAgentPrompt(agentPath);
  }

  /** Public: the always-loaded core prompt (for specialist base). */
  getCorePrompt(): string {
    return this.loadCore();
  }

  private readSkillBody(skillName: string): string {
    const fp = path.join(this.templatesRoot, 'skills', skillName, 'SKILL.md');
    return readMarkdownWithFrontmatterStripped(fp);
  }
}

/** Resolve the templates root: explicit path, env, or bundled default. */
function resolveTemplatesRoot(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit;

  const fromEnv = process.env.KIRO_TEMPLATES_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // Bundled default: <project>/templates/kiro-v5 (relative to dist/ or src/).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../templates/kiro-v5'),
    path.resolve(here, '../../../templates/kiro-v5'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Last resort: original harness location.
  return path.resolve(here, '../../../../harness');
}

/** Read a Markdown file and strip a leading YAML frontmatter block. */
function readMarkdownWithFrontmatterStripped(fp: string): string {
  try {
    if (!fs.existsSync(fp)) return '';
    let text = fs.readFileSync(fp, 'utf8');
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3);
      if (end !== -1) {
        const after = text.indexOf('\n', end + 3);
        text = after !== -1 ? text.slice(after + 1) : '';
      }
    }
    return text.trim();
  } catch {
    return '';
  }
}
