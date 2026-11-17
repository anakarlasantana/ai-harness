import type { E2EDeclaration, E2ERunResult } from './types.js';

/**
 * Digest do harness: um resumo de leitura barata (≤ 60 linhas) que o modelo
 * consome em vez do trace bruto.
 *
 * O alvo manda no conteúdo (o `resumo.md` dele é a fonte dos fatos); aqui só
 * organizamos passo, causa e onde olhar.
 */
const MAX_LINHAS = 60;

export function buildDigest(opts: {
  result: E2ERunResult;
  declaration: E2EDeclaration;
  alvo: string;
  commit?: string;
}): string {
  const { result, declaration, alvo, commit } = opts;
  const linhas: string[] = [];

  linhas.push(`# e2e · ${alvo}${result.journey ? ` · ${result.journey}` : ''}`);
  linhas.push('');
  linhas.push(`resultado: ${result.ok ? 'PASSOU' : 'FALHOU'} (${s(result.durationMs)})`);
  linhas.push(`inicio: ${result.startedAt}${commit ? ` · commit: ${commit}` : ''}`);
  linhas.push(`comando: \`${result.command}\``);
  linhas.push('');

  linhas.push('## passos');
  linhas.push('');
  for (const step of result.steps) {
    const icone = step.status === 'passed' ? 'ok' : step.status === 'skipped' ? '--' : 'FALHOU';
    linhas.push(`- ${icone} \`${step.name}\` (${s(step.durationMs)})${step.code !== null ? ` code=${step.code}` : ''}`);
    if (step.status === 'failed' && step.tail.length > 0) {
      for (const l of step.tail.slice(-3)) linhas.push(`  - ${limpar(l)}`);
    }
  }
  linhas.push('');

  linhas.push('## fatos');
  linhas.push('');
  linhas.push(`- 5xx: ${result.facts.fiveXX}`);
  linhas.push(`- console.error/pageerror: ${result.facts.consoleErrors}`);
  if (declaration.allowlist.length > 0) {
    linhas.push(`- allowlist: ${declaration.allowlist.map((a) => `${a.status} ${a.path ?? ''}`.trim()).join(' · ')}`);
  }
  linhas.push('');

  const logsComSinal = result.logs.filter((l) => l.lines.length > 0);
  if (logsComSinal.length > 0) {
    linhas.push('## logs');
    linhas.push('');
    for (const l of logsComSinal) {
      linhas.push(`### ${l.name}`);
      for (const linha of l.lines.slice(-4)) linhas.push(`- ${limpar(linha)}`);
    }
    linhas.push('');
  }

  if (result.digest) {
    linhas.push('## evidencia do alvo');
    linhas.push('');
    const corpo = result.digest
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .slice(0, 18);
    for (const l of corpo) linhas.push(`> ${limpar(l)}`);
    linhas.push('');
  }

  linhas.push('## onde olhar');
  linhas.push('');
  if (result.evidenceDir) linhas.push(`- evidencia: \`${result.evidenceDir}\``);
  if (result.digestPath) linhas.push(`- resumo do alvo: \`${result.digestPath}\``);
  linhas.push(`- artefatos do harness: \`.harness/tests/${result.runId}/digest.md\``);

  return linhas.slice(0, MAX_LINHAS).join('\n') + '\n';
}

/** Ruído típico de `docker logs` (pid, timestamp, CONSOLE) — não é causa. */
const RUIDO = /(\[pid=|\bINFO:CONSOLE\b|^\s*"x-publishable|\{since\})/;

/**
 * A "causa" de uma falha, para o card do dashboard: primeiro a linha da jornada
 * no digest do alvo (é o que o time escreveu), depois a última linha não-ruidosa
 * do passo que falhou. Pura, para poder ser testada sem rodar o alvo.
 */
export function causaDoFalha(
  digest: string,
  steps: { status: string; tail: string[] }[],
): string | undefined {
  const doAlvo = digest
    .split('\n')
    .find((l) => l.startsWith('- `') || l.startsWith('resultado:'));

  if (doAlvo) return doAlvo.replace(/^-\s*/, '').slice(0, 160);

  const doPasso = steps
    .filter((s) => s.status === 'failed')
    .flatMap((s) => s.tail)
    .filter((l) => !RUIDO.test(l));

  const primeira = doPasso
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .find((l) => l.length > 0);

  return primeira?.slice(0, 160) ?? 'falhou';
}

function s(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

function limpar(linha: string): string {
  return linha.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 200);
}
