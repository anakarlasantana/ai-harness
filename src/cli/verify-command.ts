import path from 'node:path';
import type { Command } from 'commander';
import type { AppEnv } from '../config/env.js';
import { LocalContextLoader } from '../context/LocalContextLoader.js';
import { log } from '../core/logger.js';
import type { TestRun } from '../core/Task.js';
import { execSafe } from '../engine/CommandRunner.js';
import { detectStack } from '../engine/StackDetector.js';
import { E2ERunner, writeRunArtifacts } from '../engine/e2e/E2ERunner.js';
import { buildDigest, causaDoFalha } from '../engine/e2e/EvidenceDigest.js';
import { E2EDeclarationSchema, type E2EDeclaration, type E2EStep } from '../engine/e2e/types.js';
import { TaskMemory } from '../memory/TaskMemory.js';

/**
 * `ai e2e` — verificação de uma aplicação.
 *
 * Roda **o que a aplicação declarou** (`.harness/context.json`): a prontidão
 * (`verification.readiness`) ou o ciclo ponta-a-ponta (`e2e`). O harness não
 * conhece a stack do alvo; ele executa, digere e registra.
 *
 * Cada passo é gravado na memória da task à medida que termina, então o
 * dashboard mostra a execução em andamento — não só o resultado final.
 */
interface VerifyFlags {
  journey?: string;
  readiness?: boolean;
  keep?: boolean;
  skipBefore?: boolean;
  json?: boolean;
  dir?: string;
}

export interface E2ERegisterOptions {
  /** Quando definido, o comando entra como depreciado (oculto + aviso). */
  deprecatedAs?: string;
}

/** Registra `e2e` sob um pai (topo do CLI ou o namespace `verify`). */
export function registerE2ECommand(
  parent: Command,
  env: AppEnv,
  options: E2ERegisterOptions = {},
): void {
  const cmd = parent
    .command('e2e', { hidden: Boolean(options.deprecatedAs) })
    .argument('[taskId]', 'id da execução (default: readiness|e2e-<jornada>-<timestamp>)')
    .description('Roda a prontidão (`--readiness`) ou as jornadas ponta-a-ponta declaradas pelo alvo')
    .option('--journey <nome>', 'jornada declarada em e2e.journey (ex.: cliente)')
    .option('--readiness', 'roda só o "definition of done" (verification.readiness)')
    .option('--keep', 'não executa os passos de limpeza (`e2e.after`)')
    .option('--skip-before', 'pula os passos de preparação (`e2e.before`)')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((taskIdArg: string | undefined, opts: VerifyFlags) =>
      runE2ECommand(taskIdArg, opts, env),
    );

  if (options.deprecatedAs) {
    cmd.hook('preAction', () => {
      log.warn(`"e2e" está depreciado — use \`${options.deprecatedAs}\`.`);
    });
  }
}

/** O corpo de `verify e2e` / `verify ready` (readiness é o mesmo ciclo, sem jornada). */
export async function runE2ECommand(
  taskIdArg: string | undefined,
  opts: VerifyFlags,
  env: AppEnv,
): Promise<void> {
      const cwd = opts.dir ? path.resolve(opts.dir) : env.cwd;
      const local = LocalContextLoader.load(cwd);
      const memory = new TaskMemory(cwd);
      const alvo = path.basename(cwd);

      const taskId =
        taskIdArg ??
        `${opts.readiness ? 'readiness' : 'e2e'}${opts.journey ? `-${opts.journey}` : ''}-${new Date()
          .toISOString()
          .slice(0, 16)
          .replace(/[:T]/g, '')}`;

      const runId = new Date().toISOString().replace(/[:.]/g, '-');
      const startedAt = new Date().toISOString();

      await memory.update(taskId, (t) => {
        if (!t.description) {
          t.description = `${opts.readiness ? 'prontidão' : 'e2e'} de ${alvo}${
            opts.journey ? ` · jornada ${opts.journey}` : ''
          }`;
        }
      });

      const run: TestRun = {
        id: runId,
        kind: opts.readiness ? 'readiness' : 'e2e',
        journey: opts.journey,
        command: '',
        status: 'running',
        startedAt,
        steps: [],
        facts: { fiveXX: 0, consoleErrors: 0 },
        headline: 'em execução',
      };
      await memory.upsertTestRun(taskId, run);
      await memory.appendTrace(taskId, {
        timestamp: startedAt,
        activePersona: 'test-runner',
        status: 'thinking',
        thought: `${opts.readiness ? 'prontidão' : 'e2e'} iniciada em ${alvo}${
          opts.journey ? ` (jornada ${opts.journey})` : ''
        }`,
      });

      const commit = await currentCommit(cwd);

      try {
        if (opts.readiness) {
          await runReadiness({ cwd, local, memory, taskId, run, commit });
        } else {
          await runE2E({ cwd, local, memory, taskId, run, commit, opts });
        }
      } catch (err) {
        const message = (err as Error).message;
        log.err(message);
        await memory.upsertTestRun(taskId, {
          ...run,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          headline: message.slice(0, 120),
        });
        await memory.setStatus(taskId, 'error');
        process.exitCode = 1;
        if (opts.json) console.log(JSON.stringify({ ok: false, taskId, runId, error: message }, null, 2));
      }
}

interface RunReadinessArgs {
  cwd: string;
  local: ReturnType<typeof LocalContextLoader.load>;
  memory: TaskMemory;
  taskId: string;
  run: TestRun;
  commit?: string;
}

/**
 * Prontidão: um comando só, o que o repositório declarou como "está pronto".
 * Se o alvo não declarou, cai no `testCommand`/detecção — e avisa no card.
 */
async function runReadiness(args: RunReadinessArgs): Promise<void> {
  const { cwd, local, memory, taskId, run, commit } = args;
  const stack = detectStack(cwd, local.config);
  const command = stack.readinessCmd ?? stack.testCmd;

  if (!command) {
    await memory.upsertTestRun(taskId, {
      ...run,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      headline: 'sem comando de prontidão declarado',
    });
    await memory.setStatus(taskId, 'error');
    throw new Error(
      'Nenhum comando de prontidão. Declare `verification.readiness.command` em .harness/context.json.',
    );
  }

  const t0 = Date.now();
  const res = await execSafe(command, cwd, { timeoutMs: stack.readinessTimeoutMs ?? 300_000 });
  const step: E2EStep = {
    name: 'readiness',
    command,
    status: res.ok ? 'passed' : 'failed',
    durationMs: Date.now() - t0,
    code: res.code,
    timedOut: res.timedOut,
    tail: [],
  };

  const finishedAt = new Date().toISOString();
  await memory.upsertTestRun(taskId, {
    ...run,
    command,
    status: res.ok ? 'passed' : 'failed',
    finishedAt,
    durationMs: step.durationMs,
    steps: [
      {
        name: command,
        status: step.status,
        durationMs: step.durationMs,
        detail: res.ok ? 'ok' : res.clipped.split('\n').slice(-3).join(' | ').slice(0, 240),
      },
    ],
    headline: res.ok ? 'pronto' : `falhou em ${command}`,
  });
  await memory.setStatus(taskId, res.ok ? 'qa-passed' : 'qa-failed');
  await memory.appendTrace(taskId, {
    timestamp: finishedAt,
    activePersona: 'test-runner',
    status: res.ok ? 'success' : 'error',
    toolCalled: command,
    thought: `${res.ok ? 'prontidão OK' : 'prontidão FALHOU'} (${Math.round(step.durationMs / 1000)}s)${
      commit ? ` · commit ${commit}` : ''
    }`,
  });

  verdict({
    ok: res.ok,
    titulo: `readiness · ${path.basename(cwd)}`,
    durationMs: step.durationMs,
    passos: 1,
    facts: undefined,
    digestPath: undefined,
    primeiraCausa: res.ok ? undefined : firstLine(res.clipped),
    taskId,
    runId: run.id,
  });
}

interface RunE2EArgs {
  cwd: string;
  local: ReturnType<typeof LocalContextLoader.load>;
  memory: TaskMemory;
  taskId: string;
  run: TestRun;
  commit?: string;
  opts: VerifyFlags;
}

/** O ciclo declarado: `before → jornadas → logs → after`, digerido e registrado. */
async function runE2E(args: RunE2EArgs): Promise<void> {
  const { cwd, local, memory, taskId, run, commit, opts } = args;
  const declaration = declarationFrom(local);

  const registro = { current: run };
  await memory.upsertTestRun(taskId, registro.current);

  const runner = new E2ERunner();
  const result = await runner.run({
    cwd,
    declaration,
    journey: opts.journey,
    keep: opts.keep,
    skipBefore: opts.skipBefore,
    onStep: async (step) => {
      registro.current = {
        ...registro.current,
        command: journeyCommand(declaration, opts.journey),
        steps: [...registro.current.steps, passoParaDashboard(step)],
        headline: `${step.name}: ${step.status}`,
      };
      await memory.upsertTestRun(taskId, registro.current);
    },
  });

  const digest = buildDigest({
    result,
    declaration,
    alvo: path.basename(cwd),
    commit,
  });
  const digestPath = await writeRunArtifacts(cwd, result.runId, digest);

  const finalRun: TestRun = {
    ...registro.current,
    command: result.command,
    status: result.ok ? 'passed' : 'failed',
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    steps: result.steps.map(passoParaDashboard),
    facts: result.facts,
    evidenceDir: result.evidenceDir,
    digestPath,
    headline: result.ok
      ? `jornada${result.journey ? ` ${result.journey}` : ''} verde`
      : causaDoFalha(digest, result.steps),
  };
  await memory.upsertTestRun(taskId, finalRun);
  await memory.setStatus(taskId, result.ok ? 'qa-passed' : 'qa-failed');
  await memory.appendTrace(taskId, {
    timestamp: result.finishedAt,
    activePersona: 'test-runner',
    status: result.ok ? 'success' : 'error',
    toolCalled: result.command,
    thought: `${result.ok ? 'e2e PASSOU' : 'e2e FALHOU'} em ${Math.round(
      result.durationMs / 1000,
    )}s · 5xx=${result.facts.fiveXX} console=${result.facts.consoleErrors}`,
  });

  if (!result.ok) {
    await memory.appendQaFeedback(taskId, digest.slice(0, 2000));
    process.exitCode = 1;
  }

  verdict({
    ok: result.ok,
    titulo: `e2e${result.journey ? ` · ${result.journey}` : ''} · ${path.basename(cwd)}`,
    durationMs: result.durationMs,
    passos: result.steps.length,
    facts: result.facts,
    digestPath,
    primeiraCausa: result.ok ? undefined : firstLine(digest.split('\n').find((l) => l.startsWith('  - ')) ?? ''),
    taskId,
    runId: result.runId,
  });

  if (opts.json) {
    console.log(JSON.stringify({ ok: result.ok, taskId, runId: result.runId, digestPath, result }, null, 2));
  }
}

function declarationFrom(local: ReturnType<typeof LocalContextLoader.load>): E2EDeclaration {
  const bruto = local.config.e2e;

  if (!bruto?.command) {
    throw new Error(
      'A aplicação não declarou o ciclo ponta-a-ponta. Em .harness/context.json, informe `e2e.command` (e, se houver, `before`, `after`, `journey`).',
    );
  }

  const parsed = E2EDeclarationSchema.safeParse(bruto);

  if (!parsed.success) {
    throw new Error(`Declaração e2e inválida: ${parsed.error.issues[0]?.message ?? 'formato'}`);
  }

  return parsed.data;
}

function journeyCommand(declaration: E2EDeclaration, journey?: string): string {
  return (journey ? declaration.journey[journey] : undefined) ?? declaration.command;
}

function passoParaDashboard(step: E2EStep): TestRun['steps'][number] {
  return {
    name: step.name,
    status: step.status,
    durationMs: step.durationMs,
    detail: step.tail.slice(-1)[0],
  };
}

/** Commit curto, quando o alvo for um repositório git (vai para o digest). */
async function currentCommit(cwd: string): Promise<string | undefined> {
  try {
    const res = await execSafe('git rev-parse --short HEAD', cwd, { timeoutMs: 10_000 });
    return res.ok ? res.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string | undefined {
  const linha = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  return linha?.slice(0, 160);
}

interface VerdictArgs {
  ok: boolean;
  titulo: string;
  durationMs: number;
  passos: number;
  facts?: { fiveXX: number; consoleErrors: number };
  digestPath?: string;
  primeiraCausa?: string;
  taskId: string;
  runId: string;
}

/** O contrato de saída do CLI: três linhas, o que o agente precisa ler. */
function verdict(args: VerdictArgs): void {
  const segundos = `${Math.round(args.durationMs / 100) / 10}s`;
  const fatos = args.facts ? ` · 5xx ${args.facts.fiveXX} · console ${args.facts.consoleErrors}` : '';

  console.log('');
  console.log(`${args.titulo}   ${args.ok ? 'PASSOU' : 'FALHOU'}  (${segundos})`);
  console.log(`  ${args.passos} passo(s)${fatos} · task ${args.taskId}`);
  if (args.primeiraCausa) console.log(`  causa: ${args.primeiraCausa}`);
  if (args.digestPath) console.log(`  digest: ${args.digestPath}`);
  console.log('');
}
