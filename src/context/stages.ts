/**
 * Stage configuration for the minimal-context engine.
 *
 * Each pipeline stage loads ONLY the persona + skills it needs. `core.md` is
 * always loaded separately by the ContextAssembler (the golden rule).
 *
 * Skill names below use the REAL folder names from the Kiro V5 template. The
 * `aliases` field maps the friendlier names mentioned in specs to those real
 * folders, so callers can use either.
 */

export type StageName =
  | 'plan'
  | 'code'
  | 'qa'
  | 'e2e'
  | 'rework'
  | 'sync'
  | 'spec'
  | 'review'
  | 'ship'
  | 'simplify'
  | 'constraints'
  | 'webperf'
  | 'debug'
  | 'design'
  | 'design-review'
  | 'design-code';

export interface StageConfig {
  /** Relative path (inside templates/kiro-v5) of the agent JSON to load. */
  agentPath: string;
  /** Real skill folder names to load. */
  skills: string[];
  /** Human label of the active persona (used in the dashboard trace). */
  persona: string;
  /** Optional specialist agent paths for parallel fan-out (review/ship). */
  specialists?: string[];
}

export const STAGE_CONFIG: Record<StageName, StageConfig> = {
  plan: {
    agentPath: 'agents/project-manager/project-manager.json',
    skills: ['pm-roadmap-management', 'pm-delivery-planning'],
    persona: 'project-manager',
  },
  code: {
    agentPath: 'agents/developer/developer.json',
    skills: ['dev-test-driven-development', 'dev-incremental-implementation'],
    persona: 'developer',
  },
  qa: {
    agentPath: 'agents/developer/test-engineer.json',
    skills: ['dev-code-review-and-quality', 'dev-test-driven-development'],
    persona: 'test-engineer',
  },
  e2e: {
    agentPath: 'agents/developer/test-engineer.json',
    skills: ['dev-test-driven-development', 'dev-debugging-and-error-recovery'],
    persona: 'test-runner',
  },
  rework: {
    agentPath: 'agents/techlead/techlead.json',
    skills: ['dev-documentation-and-adrs', 'dev-debugging-and-error-recovery'],
    persona: 'techlead',
  },
  sync: {
    agentPath: '',
    skills: ['shared-git-workflow-and-versioning'],
    persona: 'sync',
  },
  spec: {
    agentPath: 'agents/project-manager/project-manager.json',
    skills: ['shared-spec-driven-development', 'pm-roadmap-management'],
    persona: 'project-manager',
  },
  review: {
    agentPath: 'agents/developer/code-reviewer.json',
    skills: ['dev-code-review-and-quality', 'dev-security-and-hardening'],
    persona: 'code-reviewer',
    specialists: [
      'agents/developer/security-auditor.json',
      'agents/techlead/architecture-reviewer.json',
    ],
  },
  ship: {
    agentPath: 'agents/developer/developer.json',
    skills: ['dev-shipping-and-launch'],
    persona: 'developer',
    specialists: [
      'agents/developer/code-reviewer.json',
      'agents/developer/security-auditor.json',
      'agents/developer/web-performance-auditor.json',
    ],
  },
  simplify: {
    agentPath: 'agents/developer/developer.json',
    skills: ['dev-code-simplification'],
    persona: 'developer',
  },
  constraints: {
    agentPath: 'agents/techlead/techlead.json',
    skills: ['dev-constraint-driven-development'],
    persona: 'techlead',
  },
  webperf: {
    agentPath: 'agents/developer/web-performance-auditor.json',
    skills: ['dev-performance-optimization'],
    persona: 'web-performance-auditor',
  },
  debug: {
    agentPath: 'agents/developer/developer.json',
    skills: ['dev-debugging-and-error-recovery', 'dev-test-driven-development'],
    persona: 'developer',
  },
  design: {
    agentPath: 'agents/design/ui-ux-designer.json',
    skills: ['design-prototype-analysis', 'dev-frontend-ui-engineering'],
    persona: 'ui-ux-designer',
  },
  'design-review': {
    agentPath: 'agents/design/design-reviewer.json',
    skills: ['design-fidelity-review', 'dev-frontend-ui-engineering'],
    persona: 'design-reviewer',
  },
  'design-code': {
    agentPath: 'agents/design/design-to-code.json',
    skills: ['design-prototype-analysis', 'dev-frontend-ui-engineering'],
    persona: 'design-to-code',
  },
};

/**
 * Friendly-name -> real skill folder aliases (as referenced in the spec).
 */
export const SKILL_ALIASES: Record<string, string> = {
  'pm-roadmap': 'pm-roadmap-management',
  'dev-tdd': 'dev-test-driven-development',
  'shared-code-review': 'dev-code-review-and-quality',
  'optional-test-automation': 'dev-test-driven-development',
  'tl-adrs': 'dev-documentation-and-adrs',
};

/** Resolve a (possibly aliased) skill name to its real folder name. */
export function resolveSkillName(name: string): string {
  return SKILL_ALIASES[name] ?? name;
}

/** Extra git/sprint guidance injected for the `sync` stage. */
export const SYNC_INSTRUCTIONS = `# Sync Stage

Foco: sincronização de repositório e alinhamento de sprint.

- Resolva conflitos de merge preservando a intenção lógica de ambos os lados; não descarte mudanças alheias sem justificar.
- Nunca use \`git add -A\` cego; faça stage apenas dos arquivos tocados pela tarefa.
- Verifique o alinhamento com o objetivo da sprint e sinalize divergências de escopo.
- Produza um resumo compacto: conflitos resolvidos, arquivos afetados, riscos e próximo passo.`;
