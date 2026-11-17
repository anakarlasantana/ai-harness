import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { AppEnv, ProviderKind } from '../config/env.js';
import { ContextAssembler } from '../context/ContextAssembler.js';
import { LocalContextLoader, localProvider } from '../context/LocalContextLoader.js';
import {
  resolveStageModel,
  resolveStageModelFallbacks,
  resolveStageMcpTools,
  resolveStageProvider,
  resolveStageTuning,
} from '../context/resolution.js';
import { REPO_MAP_TOOL, RepoIndex, filterMapByArea } from '../context/RepoIndex.js';
import { STAGE_CONFIG, type StageName } from '../context/stages.js';
import { log } from '../core/logger.js';
import type { Task } from '../core/Task.js';
import { createTask } from '../core/Task.js';
import { detectStack } from '../engine/StackDetector.js';
import { Orchestrator, extractFilesFromText } from '../engine/Orchestrator.js';
import { QALoop } from '../engine/QALoop.js';
import { TaskMemory } from '../memory/TaskMemory.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { McpManager } from '../mcp/McpManager.js';
import { createProvider } from '../providers/ProviderFactory.js';
import {
  buildDoctorReport,
  formatDoctorReport,
  probeModels,
  reportModelsProbe,
} from '../providers/diagnostics.js';
import type { LLMProvider } from '../providers/LLMProvider.js';
import { startDashboard } from './dashboard.js';
import { registerFixCommand } from './fix-command.js';
import { registerE2ECommand, runE2ECommand } from './verify-command.js';
import { registerSpecCommand } from './spec-command.js';

export interface CommonFlags {
  provider?: ProviderKind;
  templates?: string;
  dryRun?: boolean;
  json?: boolean;
  maxIterations?: string;
  mcpFromKiro?: boolean;
  model?: string;
  sequential?: boolean;
}

interface Session {
  env: AppEnv;
  local: ReturnType<typeof LocalContextLoader.load>;
  memory: TaskMemory;
  assembler: ContextAssembler;
  provider: LLMProvider;
  registry: McpRegistry;
}

function buildSession(env: AppEnv, flags: CommonFlags, stage: StageName): Session {
  const local = LocalContextLoader.load(env.cwd);
  const fromContext = localProvider(local);
  // One provider per app; the model varies per stage. `auto` in context.json
  // means "infer the wire format from the configured endpoint".
  const provider = createProvider(env, {
    override: flags.provider,
    fromLocalContext:
      fromContext && fromContext !== 'auto'
        ? fromContext
        : resolveStageProvider(stage, local.config, env),
  });
  const assembler = new ContextAssembler({ templatesPath: flags.templates, local });
  const memory = new TaskMemory(env.cwd);
  const registry = McpRegistry.load({
    cwd: env.cwd,
    fromKiro: flags.mcpFromKiro,
    localServers: local.config.mcpServers,
  });
  return { env, local, memory, assembler, provider, registry };
}


/**
 * Cria o McpManager do app e registra as tools nativas do harness.
 * `repo_map` entra no catalogo de TODOS os stages (custo zero quando nao
 * chamada) e responde "onde olhar" antes de o modelo ler arquivos.
 */
function createMcpManager(session: Session): McpManager {
  const mcp = new McpManager(session.registry);
  mcp.registerNativeTool(REPO_MAP_TOOL, async (args) => {
    const map = RepoIndex.readOrRefresh(session.env.cwd);
    const area = typeof args.area === 'string' ? args.area : undefined;
    return area ? filterMapByArea(map, area) : map;
  });
  return mcp;
}

function withStackHint(env: AppEnv, text: string): string {
  const local = LocalContextLoader.load(env.cwd);
  const stack = detectStack(env.cwd, local.config);
  return `[STACK DETECTADA] ${stack.hint}\n[RAIZ] ${env.cwd}\n\n${text}`;
}

function stagePersona(stage: StageName): string {
  const map: Record<StageName, string> = {
    plan: 'project-manager',
    code: 'developer',
    qa: 'test-engineer',
    e2e: 'test-runner',
    rework: 'techlead',
    sync: 'sync',
    spec: 'project-manager',
    review: 'code-reviewer',
    ship: 'developer',
    simplify: 'developer',
    constraints: 'techlead',
    webperf: 'web-performance-auditor',
    debug: 'developer',
    design: 'ui-ux-designer',
    'design-review': 'design-reviewer',
    'design-code': 'design-to-code',
  };
  return map[stage];
}

function stageUsesTools(_stage: StageName): boolean {
  // TODO os stages usam ferramentas, incluindo `plan`.
  // Antes, `plan` era text-only e — instruido a "analisar a aplicacao" — o modelo
  // inventava chamadas em texto puro (DSML do DeepSeek v4) e devolvia
  // `toolCalls: 0`. O custo de leitura e controlado pela whitelist `mcpTools`
  // do .harness/context.json (ex.: plan so pode repo_map/list/read/status).
  return true;
}

function statusForStage(stage: StageName, hitCap: boolean): Task['status'] {
  if (hitCap) return 'error';
  switch (stage) {
    case 'plan':
      return 'planned';
    case 'code':
      return 'coded';
    case 'qa':
      return 'qa-passed';
    case 'rework':
      return 'reworked';
    case 'sync':
      return 'synced';
    default:
      // Intermediate workflow stages (spec, review, ship, design, ...) leave
      // the task status unchanged at the persisted level; we record them in
      // the execution trace only.
      return 'coded';
  }
}

interface RunStageArgs {
  env: AppEnv;
  flags: CommonFlags;
  stage: StageName;
  taskId: string;
  userText: string;
  ensureTask: () => Promise<Task>;
}

async function runStage(args: RunStageArgs): Promise<void> {
  const { env, flags, stage, taskId, userText } = args;
  const session = buildSession(env, flags, stage);

  // In dry-run we don't need a persisted task; fall back to a synthetic one.
  let task: Task;
  if (flags.dryRun) {
    task = (await args.ensureTask().catch(() => null)) ?? createTask(taskId, userText);
  } else {
    task = await args.ensureTask();
  }

  const usesTools = stageUsesTools(stage);
  const systemPrompt = session.assembler.buildSystemPrompt(stage, task, { hasTools: usesTools });
  const model = resolveStageModel(stage, session.local.config, env, flags.model);
  const modelFallbacks = resolveStageModelFallbacks(env);
  const tuning = resolveStageTuning(stage, session.local.config);
  const mcpTools = resolveStageMcpTools(stage, session.local.config);

  if (flags.dryRun) {
    const mcpCount = session.registry.list().length;
    log.info(
      `[DRY-RUN] stage=${stage} task=${taskId} provider=${session.provider.name} ` +
        `model=${model ?? '(default)'} mcpServers=${mcpCount}` +
        (mcpTools ? ` mcpTools=${mcpTools.length}` : ''),
    );
    console.log('\n===== SYSTEM PROMPT (' + systemPrompt.length + ' chars) =====\n');
    console.log(systemPrompt);
    console.log('\n===== USER TASK =====\n');
    console.log(withStackHint(env, userText));
    return;
  }

  const orchestrator = new Orchestrator();
  const mcp = createMcpManager(session);
  const maxIterations = flags.maxIterations
    ? Number(flags.maxIterations)
    : env.HARNESS_MAX_ITERATIONS;

  log.info(
    `Stage "${stage}" · task "${taskId}" · provider "${session.provider.name}" · model "${model ?? 'default'}"`,
  );

  // Build specialist prompts for fan-out stages (review/ship).
  const stageCfg = STAGE_CONFIG[stage];
  const specialistDefs = (stageCfg.specialists ?? []).map((agentPath) => ({
    persona: agentPath.split('/').pop()?.replace('.json', '') ?? agentPath,
    systemPrompt: `${session.assembler.getCorePrompt()}\n\n${session.assembler.buildSpecialistPrompt(agentPath)}`,
  }));

  const runOpts = {
    provider: session.provider,
    systemPrompt,
    userTask: withStackHint(env, userText),
    persona: stagePersona(stage),
    stage,
    taskMemory: session.memory,
    task,
    mcp,
    registry: session.registry,
    maxIterations,
    enableTools: usesTools,
    model,
    modelFallbacks,
    tuning,
    mcpTools,
  };

  const result =
    specialistDefs.length > 0
      ? await orchestrator.runFanOut(runOpts, specialistDefs, flags.sequential === true)
      : await orchestrator.run(runOpts);

  await session.memory.setStatus(taskId, statusForStage(stage, result.hitIterationCap));
  if (stage === 'plan') {
    await session.memory.setArchitectureDecision(taskId, result.finalText);
  }
  const files = extractFilesFromText(result.finalText);
  if (files.length > 0) await session.memory.addFiles(taskId, files);

  outputResult(flags, result.finalText, {
    stage,
    taskId,
    model: model ?? '(default)',
    iterations: result.iterations,
    toolCalls: result.toolCallsExecuted,
    hitCap: result.hitIterationCap,
  });
}

function outputResult(flags: CommonFlags, text: string, meta: Record<string, unknown>): void {
  if (flags.json) {
    console.log(JSON.stringify({ ...meta, result: text }, null, 2));
    return;
  }
  console.log('\n' + text + '\n');
  log.ok(
    `Concluído: stage=${meta.stage} iterações=${meta.iterations} toolCalls=${meta.toolCalls}` +
      (meta.hitCap ? ' (teto atingido)' : ''),
  );
}

export function registerCommands(program: Command, env: AppEnv): void {
  const addCommon = (cmd: Command): Command =>
    cmd
      .option('--provider <kind>', 'kiro | openai | claude')
      .option('--templates <path>', 'caminho dos templates Kiro V5')
      .option('--dry-run', 'apenas monta e mostra o prompt (sem chamar o modelo)')
      .option('--json', 'saída em JSON')
      .option('--max-iterations <n>', 'teto de iterações do loop ReAct')
      .option('--mcp-from-kiro', 'herdar MCPs de ~/.kiro/settings/mcp.json')
      .option('--model <name>', 'override do modelo para esta execução')
      .option('--sequential', 'especialistas em sequência (modo econômico)');

  /**
   * Nome antigo: continua funcionando, avisa no stderr e não aparece no `--help`.
   * A superfície visível é a do docs/glossario.md — `npm run check:cli` confere.
   */
  const deprecate = (cmd: Command, novo: string): Command =>
    cmd
      .hook('preAction', () => {
        log.warn(`"${cmd.name()}" está depreciado — use \`${novo}\`.`);
      });

  // ── Handlers: uma implementação por intenção ──────────────────────────────
  // O nome novo e o antigo chamam o MESMO handler: não existem dois caminhos
  // para o mesmo trabalho.

  const hPlan = async (taskId: string, requisito: string, opts: CommonFlags): Promise<void> => {
    const memory = new TaskMemory(env.cwd);
    await runStage({
      env,
      flags: opts,
      stage: 'plan',
      taskId,
      userText: requisito,
      ensureTask: () =>
        memory.update(taskId, (t) => {
          if (!t.description) t.description = requisito;
        }),
    });
  };

  const hCode = async (taskId: string, instrucao: string, opts: CommonFlags): Promise<void> => {
    const memory = new TaskMemory(env.cwd);
    await runStage({
      env,
      flags: opts,
      stage: 'code',
      taskId,
      userText: instrucao,
      ensureTask: () => memory.require(taskId),
    });
  };

  const hRework = async (taskId: string, feedback: string, opts: CommonFlags): Promise<void> => {
    const memory = new TaskMemory(env.cwd);
    await memory.appendQaFeedback(taskId, `Rework solicitado: ${feedback}`);
    await runStage({
      env,
      flags: opts,
      stage: 'rework',
      taskId,
      userText: feedback,
      ensureTask: () => memory.require(taskId),
    });
  };

  const hSync = async (taskId: string, opts: CommonFlags): Promise<void> => {
    const memory = new TaskMemory(env.cwd);
    await runStage({
      env,
      flags: opts,
      stage: 'sync',
      taskId,
      userText: 'Sincronize o repositório: resolva conflitos lógicos e alinhe com a sprint.',
      ensureTask: () => memory.require(taskId),
    });
  };

  const hQa = async (taskId: string, opts: CommonFlags): Promise<void> => {
    const session = buildSession(env, opts, 'qa');
    const task = await session.memory.require(taskId);
    const local = LocalContextLoader.load(env.cwd);
    const stack = detectStack(env.cwd, local.config);

    if (stack.readinessCmd) {
      stack.testCmd = stack.readinessCmd;
      stack.lintCmd = undefined;
    }

    const systemPrompt = session.assembler.buildSystemPrompt('qa', task, { hasTools: true });
    const orchestrator = new Orchestrator();
    const maxIterations = opts.maxIterations
      ? Number(opts.maxIterations)
      : env.HARNESS_MAX_ITERATIONS;

    log.info(`QA · task "${taskId}" · stack "${stack.name}"`);
    const qa = new QALoop();
    const result = await qa.run({
      cwd: env.cwd,
      provider: session.provider,
      orchestrator,
      taskMemory: session.memory,
      task,
      stack,
      systemPrompt,
      maxAttempts: 3,
      runFix: async (messages) => {
        const mcp = createMcpManager(session);
        const r = await orchestrator.run({
          provider: session.provider,
          systemPrompt: messages[0]?.content ?? systemPrompt,
          userTask: messages[1]?.content ?? '',
          persona: 'developer',
          stage: 'code',
          taskMemory: session.memory,
          task,
          mcp,
          registry: session.registry,
          maxIterations,
          enableTools: false,
        });
        return r.finalText;
      },
    });

    outputResult(opts, result.lastOutput || (result.passed ? 'QA passou.' : 'QA falhou.'), {
      stage: 'qa',
      taskId,
      passed: result.passed,
      attempts: result.attempts,
      iterations: 0,
      toolCalls: 0,
      hitCap: false,
    });
  };

  /** Etapa guiada por modelo (review, ship, design, ...). */
  const hStage =
    (stage: StageName, defaultText = '', textArgName?: string, requiresTask = true) =>
    async (...params: unknown[]): Promise<void> => {
      const opts = params[params.length - 2] as CommonFlags;
      const taskId = params[0] as string;
      const text = textArgName ? (params[1] as string) : defaultText;
      const memory = new TaskMemory(env.cwd);
      await runStage({
        env,
        flags: opts,
        stage,
        taskId,
        userText: text,
        ensureTask: requiresTask
          ? () => memory.require(taskId)
          : () =>
              memory.update(taskId, (t) => {
                if (!t.description) t.description = text;
              }),
      });
    };

  const hIndex = (opts: { check?: boolean; json?: boolean; print?: boolean }): void => {
    if (opts.check) {
      const stale = RepoIndex.isStale(env.cwd);
      if (opts.json) console.log(JSON.stringify({ stale }));
      else if (stale) log.warn('Mapa desatualizado — rode `ai ops index`.');
      else log.ok('Mapa atualizado.');
      if (stale) process.exitCode = 1;
      return;
    }

    const map = RepoIndex.readOrRefresh(env.cwd);
    const tokens = Math.round(map.length / 4);

    if (opts.print) console.log(map);

    if (opts.json) {
      console.log(JSON.stringify({ chars: map.length, tokens, path: RepoIndex.mapPath(env.cwd) }));
      return;
    }
    log.ok(`Mapa gerado: ${map.length} chars (~${tokens} tokens) em ${RepoIndex.mapPath(env.cwd)}`);
  };

  const hDoctor = async (opts: { probe?: boolean; json?: boolean }): Promise<void> => {
    const report = buildDoctorReport(env);

    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.log('\n' + formatDoctorReport(report) + '\n');

    if (opts.probe) {
      const probe = await probeModels(env);
      if (opts.json) console.log(JSON.stringify({ probe }, null, 2));
      else reportModelsProbe(probe, report.model);
    }
  };

  const hModels = async (opts: { json?: boolean }): Promise<void> => {
    const report = buildDoctorReport(env);
    const probe = await probeModels(env);
    if (opts.json) {
      console.log(JSON.stringify(probe, null, 2));
      return;
    }
    reportModelsProbe(probe, report.model);
  };

  const hDashboard = async (opts: { port?: string; dir?: string }): Promise<void> => {
    const cwd = opts.dir ? path.resolve(opts.dir) : env.cwd;
    await startDashboard({ cwd, port: opts.port ? Number(opts.port) : undefined });
    log.info('Pressione Ctrl+C para encerrar o dashboard.');
  };

  // ── Superfície: spec · plan · build · verify · fix · ops ────────────────────

  registerSpecCommand(program, env);

  const build = program
    .command('build')
    .description('Execução: implementar, revisar, simplificar, entregar, desenhar, auditar');

  const asCode = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').argument('<instrucao>').description('Implementa (developer + TDD)'))
      .action(hCode);
  const asReview = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').description('Revisão em 5 eixos (code-reviewer + security + arch)'))
      .action(hStage('review'));
  const asSimplify = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').description('Simplifica sem mudar comportamento'))
      .action(hStage('simplify'));
  const asShip = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').description('Checklist de pré-lançamento (go/no-go)'))
      .action(hStage('ship'));
  const asConstraints = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').description('Define a barra de qualidade do projeto'))
      .action(hStage('constraints'));
  const asWebperf = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').description('Auditoria de performance web'))
      .action(hStage('webperf'));
  const asDebug = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').argument('<bug>').description('Debug guiado por root-cause'))
      .action(hStage('debug', '', 'bug'));
  const asDesign = (cmd: Command): Command =>
    addCommon(
      cmd
        .argument('<taskId>')
        .argument('<prototipo>')
        .description('Analisa protótipo (Figma MCP ou screenshot) → spec de UI'),
    ).action(hStage('design', '', 'prototipo', false));
  const asDesignReview = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').description('Fidelidade implementação × protótipo'))
      .action(hStage('design-review'));
  const asDesignCode = (cmd: Command): Command =>
    addCommon(cmd.argument('<taskId>').argument('<instrucao>').description('Implementa UI fiel ao design'))
      .action(hStage('design-code'));

  asCode(build.command('code'));
  asReview(build.command('review'));
  asSimplify(build.command('simplify'));
  asShip(build.command('ship'));
  asConstraints(build.command('constraints'));
  asWebperf(build.command('webperf'));
  asDebug(build.command('debug'));
  asDesign(build.command('design'));
  asDesignReview(build.command('design-review'));
  asDesignCode(build.command('design-code'));

  const verify = program
    .command('verify')
    .description('Verificação: prontidão, jornadas e provas dos critérios');

  verify
    .command('ready')
    .argument('[taskId]', 'id da execução')
    .description('Roda o "definition of done" declarado pelo alvo (verification.readiness)')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((taskId: string | undefined, opts: { json?: boolean; dir?: string }) =>
      runE2ECommand(taskId, { ...opts, readiness: true }, env),
    );

  registerE2ECommand(verify, env);
  registerFixCommand(program, env);

  const ops = program.command('ops').description('Ferramentas: configuração, modelos, mapa e dashboard');

  const asIndex = (cmd: Command): Command =>
    cmd
      .description('Gera/atualiza o mapa do repositório (.harness/context/repo-map.md)')
      .option('--check', 'sai com código 1 se o mapa estiver desatualizado (CI)')
      .option('--json', 'métricas em JSON')
      .option('--print', 'imprime o mapa completo')
      .action(hIndex);
  const asDoctor = (cmd: Command): Command =>
    cmd
      .description('Mostra a configuração efetiva de endpoint/modelo (env > context.json)')
      .option('--probe', 'também consulta GET /models no endpoint')
      .option('--json', 'saída em JSON')
      .action(hDoctor);
  const asModels = (cmd: Command): Command =>
    cmd
      .description('Lista os modelos que o endpoint configurado realmente expõe')
      .option('--json', 'saída em JSON')
      .action(hModels);
  const asDashboard = (cmd: Command): Command =>
    cmd
      .description('Sobe o dashboard local (http://127.0.0.1:3000)')
      .option('--port <n>', 'porta HTTP')
      .option('--dir <path>', 'diretório do repositório (default: cwd)')
      .action(hDashboard);

  asIndex(ops.command('index'));
  asDoctor(ops.command('doctor'));
  asModels(ops.command('models'));
  asDashboard(ops.command('dashboard'));

  // ── Nomes antigos (ocultos): funcionam, avisam e saem na próxima versão ────

  deprecate(asCode(program.command('code', { hidden: true })), 'ai build code');
  deprecate(asReview(program.command('review', { hidden: true })), 'ai build review');
  deprecate(asSimplify(program.command('simplify', { hidden: true })), 'ai build simplify');
  deprecate(asShip(program.command('ship', { hidden: true })), 'ai build ship');
  deprecate(asConstraints(program.command('constraints', { hidden: true })), 'ai build constraints');
  deprecate(asWebperf(program.command('webperf', { hidden: true })), 'ai build webperf');
  deprecate(asDebug(program.command('debug', { hidden: true })), 'ai build debug');
  deprecate(asDesign(program.command('design', { hidden: true })), 'ai build design');
  deprecate(asDesignReview(program.command('design-review', { hidden: true })), 'ai build design-review');
  deprecate(asDesignCode(program.command('design-code', { hidden: true })), 'ai build design-code');

  registerE2ECommand(program, env, { deprecatedAs: 'ai verify e2e' });
  deprecate(asIndex(program.command('index', { hidden: true })), 'ai ops index');
  deprecate(asDoctor(program.command('doctor', { hidden: true })), 'ai ops doctor');
  deprecate(asModels(program.command('models', { hidden: true })), 'ai ops models');
  deprecate(asDashboard(program.command('dashboard', { hidden: true })), 'ai ops dashboard');

  addCommon(
    program
      .command('plan', { hidden: true })
      .argument('<taskId>')
      .argument('<requisito>')
      .description('(depreciado) use `ai spec new` + `ai plan create`'),
  ).action(hPlan);
  addCommon(
    program
      .command('rework', { hidden: true })
      .argument('<taskId>')
      .argument('<feedback>')
      .description('(depreciado) use `ai fix --task --feedback`'),
  ).action(hRework);
  addCommon(
    program.command('sync', { hidden: true }).argument('<taskId>').description('(depreciado) sync de repositório'),
  ).action(hSync);
  addCommon(
    program.command('qa', { hidden: true }).argument('<taskId>').description('(depreciado) use `ai verify ready`'),
  ).action(hQa);
}
