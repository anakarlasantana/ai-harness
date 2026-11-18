import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../core/logger.js';
import { execSafe } from '../CommandRunner.js';
import type {
  E2EDeclaration,
  E2EFacts,
  E2ELogTail,
  E2ERunResult,
  E2EStep,
} from './types.js';

/**
 * Executor do ciclo ponta-a-ponta declarado pelo alvo.
 *
 * `before → command → logs → after`, com o `after` garantido em `finally` (uma
 * stack que sobe e não desce envenena a próxima execução) e os **logs lidos
 * antes dele** — a limpeza pode remover os containers e levar o log junto.
 */
export interface RunE2EOptions {
  cwd: string;
  declaration: E2EDeclaration;
  /** Chave em `journey` (ex.: `cliente`). Ausente = roda o `command`. */
  journey?: string;
  skipBefore?: boolean;
  /** Mantém a stack de pé (não roda `after`). */
  keep?: boolean;
  /** Observabilidade: chamado a cada passo (o CLI grava na memória da task). */
  onStep?: (step: E2EStep) => void | Promise<void>;
}

/** Palavras que transformam uma linha de log em "linha que interessa". */
const SINAL = /(error|erro|exception|5\d\d|ECONN|ETIMEDOUT|unhandled|traceback|panic)/i;

export class E2ERunner {
  async run(opts: RunE2EOptions): Promise<E2ERunResult> {
    const { cwd, declaration } = opts;
    const startedAt = new Date();
    const runId = startedAt.toISOString().replace(/[:.]/g, '-');
    const timeoutMs = declaration.timeoutMs;
    const steps: E2EStep[] = [];

    const journeyCommand = opts.journey ? declaration.journey[opts.journey] : undefined;

    if (opts.journey && !journeyCommand) {
      throw new Error(
        `Jornada "${opts.journey}" não declarada. Disponíveis: ${
          Object.keys(declaration.journey).join(', ') || '(nenhuma)'
        }`,
      );
    }

    const command = journeyCommand ?? declaration.command;
    const record = async (step: E2EStep): Promise<void> => {
      steps.push(step);
      await opts.onStep?.(step);
    };

    let aborted = false;
    let logs: E2ELogTail[] = [];

    try {
      if (!opts.skipBefore) {
        for (const [i, cmd] of declaration.before.entries()) {
          const step = await this.exec(`before#${i + 1}`, cmd, cwd, timeoutMs);
          await record(step);
          if (step.status === 'failed') {
            aborted = true;
            break;
          }
        }
      }

      if (!aborted) {
        const step = await this.exec(
          opts.journey ? `jornada:${opts.journey}` : 'e2e',
          command,
          cwd,
          timeoutMs,
        );
        await record(step);
      }

      // Os logs são lidos AQUI, antes do `after`: a limpeza pode remover os
      // containers (`compose down`) e levar o log com eles — sem esta ordem, o
      // caminho feliz do contrato perde a seção `## logs` do digest.
      logs = await this.collectLogs(declaration, cwd, startedAt.toISOString());
    } finally {
      if (!opts.keep) {
        for (const [i, cmd] of declaration.after.entries()) {
          const step = await this.exec(`after#${i + 1}`, cmd, cwd, timeoutMs);
          await record(step);
        }
      } else {
        await record({
          name: 'after',
          command: declaration.after.join(' ; ') || '-',
          status: 'skipped',
          durationMs: 0,
          code: null,
          timedOut: false,
          tail: ['mantida de pé por --keep'],
        });
      }
    }

    const evidenceDir = this.newestEvidenceDir(cwd, declaration.evidenceDir, startedAt);
    const digestPath = evidenceDir ? path.join(evidenceDir, declaration.digest) : undefined;
    const digest = digestPath ? this.readText(digestPath) : undefined;
    const facts = this.facts(digest);

    const finishedAt = new Date();
    const runOk =
      !aborted &&
      steps
        .filter((s) => s.name.startsWith('jornada') || s.name === 'e2e')
        .every((s) => s.status === 'passed');

    return {
      ok: runOk,
      runId,
      command,
      journey: opts.journey,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      steps,
      logs,
      facts,
      evidenceDir,
      digestPath,
      digest,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async exec(
    name: string,
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<E2EStep> {
    const t0 = Date.now();
    log.info(`e2e: ${name} → ${command}`);

    try {
      const res = await execSafe(command, cwd, { timeoutMs });
      const step: E2EStep = {
        name,
        command,
        status: res.ok ? 'passed' : 'failed',
        durationMs: Date.now() - t0,
        code: res.code,
        timedOut: res.timedOut,
        tail: relevantLines(`${res.stdout}\n${res.stderr}`, 6),
      };

      if (res.ok) log.ok(`e2e: ${name} ok (${Math.round(step.durationMs / 1000)}s)`);
      else log.warn(`e2e: ${name} falhou (code=${res.code}, timedOut=${res.timedOut})`);

      return step;
    } catch (err) {
      // Comando fora da whitelist ou binário inexistente: falha do contrato, não
      // do alvo. Vira passo falho para o digest recordApproval a causa.
      log.warn(`e2e: ${name} não executou: ${(err as Error).message}`);
      return {
        name,
        command,
        status: 'failed',
        durationMs: Date.now() - t0,
        code: null,
        timedOut: false,
        tail: [(err as Error).message],
      };
    }
  }

  private async collectLogs(
    declaration: E2EDeclaration,
    cwd: string,
    since: string,
  ): Promise<E2ELogTail[]> {
    const out: E2ELogTail[] = [];

    for (const logDecl of declaration.logs) {
      const command = logDecl.command.replace(/\{since\}/g, since);

      try {
        const res = await execSafe(command, cwd, { timeoutMs: 60_000 });
        out.push({ name: logDecl.name, lines: relevantLines(`${res.stdout}\n${res.stderr}`, 8) });
      } catch (err) {
        out.push({ name: logDecl.name, lines: [`(não executou: ${(err as Error).message})`] });
      }
    }

    return out;
  }

  /** Diretório de evidência mais recente criado durante a execução. */
  private newestEvidenceDir(cwd: string, evidenceDir: string, startedAt: Date): string | undefined {
    const base = path.isAbsolute(evidenceDir) ? evidenceDir : path.join(cwd, evidenceDir);

    try {
      return fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(base, e.name))
        .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
        .filter((x) => x.m >= startedAt.getTime() - 5_000)
        .sort((a, b) => b.m - a.m)[0]?.p;
    } catch {
      return undefined;
    }
  }

  private readText(fp: string): string | undefined {
    try {
      return fs.readFileSync(fp, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Fatos que a evidência do alvo já sabe contar (5xx e erro de console). */
  private facts(digest?: string): E2EFacts {
    if (!digest) return { fiveXX: 0, consoleErrors: 0 };

    const cinco = digest.match(/5xx:\s*(\d+)/i);
    const consoleErros = digest.match(/console\.error[^:]*:\s*(\d+)/i);

    return {
      fiveXX: cinco?.[1] ? Number(cinco[1]) : 0,
      consoleErrors: consoleErros?.[1] ? Number(consoleErros[1]) : 0,
    };
  }
}

/** Últimas `max` linhas que casam com o sinal de interesse (ou o fim, se nada casar). */
export function relevantLines(text: string, max: number): string[] {
  const lines = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const sinal = lines.filter((l) => SINAL.test(l));
  const escolhidas = sinal.length > 0 ? sinal : lines.slice(-max);

  return escolhidas.slice(-max);
}

/** Escreve os artefatos do harness (digest) em `.harness/tests/<runId>/`. */
export async function writeRunArtifacts(
  cwd: string,
  runId: string,
  digest: string,
): Promise<string> {
  const dir = path.join(cwd, '.harness', 'tests', runId);
  await fsp.mkdir(dir, { recursive: true });
  const fp = path.join(dir, 'digest.md');
  await fsp.writeFile(fp, digest, 'utf8');
  return fp;
}
