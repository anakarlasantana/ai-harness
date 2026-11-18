import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SpecCriterion } from './SpecDocument.js';

/**
 * TaskPlanModel de execução: `tarefas.md` da spec.
 *
 * Gramática de uma linha (o que `ai plan create` escreve e o que `plan verify`
 * confere):
 *
 *   - **T-1** · escopo: `backend/x/**` · fronteira: produto · cobre: CA-1, CA-2 · wave: 1
 *   - **T-3** · escopo: `e2e/**` · fronteira: teste · cobre: CA-2 · wave: 2 (depende T-1)
 */
export interface PlanTask {
  id: string;
  escopo: string[];
  fronteira: 'produto' | 'teste' | '?';
  cobre: string[];
  wave: number;
  depende: string[];
}

export interface TaskPlanModel {
  arquivo: string;
  tarefas: PlanTask[];
  /** Hash do arquivo — é o que a aprovação do plano assina. */
  sha: string;
  existe: boolean;
}

const PADRAO_TESTE = /(^e2e\/)|(\/__tests__\/)|(\.spec\.[jt]sx?$)|(\.test\.[jt]sx?$)/;

export function parseTaskPlan(pasta: string): TaskPlanModel {
  const arquivo = path.join(pasta, 'tarefas.md');

  if (!fs.existsSync(arquivo)) {
    return { arquivo, tarefas: [], sha: '', existe: false };
  }

  const texto = fs.readFileSync(arquivo, 'utf8');
  const tarefas: PlanTask[] = [];

  for (const linha of texto.split('\n')) {
    const tarefa = lerLinha(linha);
    if (tarefa) tarefas.push(tarefa);
  }

  return {
    arquivo,
    tarefas,
    sha: createHash('sha256').update(texto).digest('hex'),
    existe: true,
  };
}

function lerLinha(linha: string): PlanTask | null {
  const m = /^- \*\*(T-\d+)\*\*\s*·\s*(.+)$/.exec(linha.trim());
  if (!m?.[1] || !m[2]) return null;

  const tarefa: PlanTask = { id: m[1], escopo: [], fronteira: '?', cobre: [], wave: 0, depende: [] };

  for (const parte of m[2].split('·')) {
    const campo = /^\s*([a-zà-ú]+):\s*(.+)$/i.exec(parte);
    if (!campo?.[1] || !campo[2]) continue;

    const chave = campo[1].toLowerCase();
    const valor = campo[2].trim();

    if (chave === 'escopo') {
      tarefa.escopo = valor
        .split(',')
        .map((p) => p.trim().replace(/`/g, ''))
        .filter(Boolean);
    } else if (chave === 'fronteira') {
      const f = valor.toLowerCase();
      tarefa.fronteira = f.startsWith('produto') ? 'produto' : f.startsWith('teste') ? 'teste' : '?';
    } else if (chave === 'cobre') {
      tarefa.cobre = valor
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
    } else if (chave === 'wave') {
      const n = /\d+/.exec(valor);
      tarefa.wave = n ? Number(n[0]) : 0;
      tarefa.depende = [...valor.matchAll(/T-\d+/g)].map((d) => d[0]);
    }
  }

  return tarefa;
}

/** DoR do plano: o que precisa estar certo antes de o humano decidir. */
export function validateTaskPlan(
  plano: TaskPlanModel,
  criterios: SpecCriterion[],
): { bloqueios: string[]; avisos: string[] } {
  const bloqueios: string[] = [];
  const avisos: string[] = [];

  if (!plano.existe) return { bloqueios: ['`tarefas.md` não existe'], avisos };
  if (plano.tarefas.length === 0) bloqueios.push('nenhuma tarefa (T-n) declarada');

  const ids = new Set(plano.tarefas.map((t) => t.id));
  const cas = new Set(criterios.map((c) => c.id));
  const cobertos = new Set<string>();

  for (const t of plano.tarefas) {
    if (t.escopo.length === 0) bloqueios.push(`${t.id}: sem \`escopo:\``);
    if (t.fronteira === '?') bloqueios.push(`${t.id}: \`fronteira:\` deve ser produto ou teste`);
    if (t.cobre.length === 0) bloqueios.push(`${t.id}: sem \`cobre:\` (critério nenhum)`);
    if (t.wave < 1) bloqueios.push(`${t.id}: \`wave:\` ausente ou inválida`);

    for (const ca of t.cobre) {
      cobertos.add(ca);
      if (!cas.has(ca)) bloqueios.push(`${t.id}: cobre ${ca}, que não existe na spec`);
    }

    const testPaths = t.escopo.filter((p) => PADRAO_TESTE.test(p));

    if (t.fronteira === 'produto' && testPaths.length > 0) {
      bloqueios.push(`${t.id}: fronteira produto não pode tocar ${testPaths.join(', ')}`);
    }

    if (t.fronteira === 'teste' && testPaths.length !== t.escopo.length) {
      bloqueios.push(`${t.id}: fronteira teste só pode tocar e2e/, __tests__ ou *.spec/*.test`);
    }

    for (const dep of t.depende) {
      if (!ids.has(dep)) {
        bloqueios.push(`${t.id}: depende de ${dep}, que não existe`);
        continue;
      }

      const anterior = plano.tarefas.find((x) => x.id === dep);
      if (anterior && anterior.wave >= t.wave) {
        bloqueios.push(`${t.id}: depende de ${dep} (wave ${anterior.wave}) mas está na wave ${t.wave}`);
      }
    }
  }

  for (const ca of criterios) {
    if (!cobertos.has(ca.id)) bloqueios.push(`${ca.id}: nenhuma tarefa cobre (critério órfão)`);
  }

  const waves = new Set(plano.tarefas.map((t) => t.wave));
  if (waves.size === 1 && plano.tarefas.length > 1) {
    avisos.push('todas as tarefas na mesma wave — verifique se há dependência real');
  }

  if (plano.tarefas.length > 10) avisos.push(`${plano.tarefas.length} tarefas — considere dividir a feature`);

  return { bloqueios, avisos };
}

/** G2 (aprovação do plano) só é exigido quando há risco objetivo. */
export function evaluatePlanRisk(plano: TaskPlanModel): { exige: boolean; motivos: string[] } {
  const motivos: string[] = [];

  if (plano.tarefas.length > 3) motivos.push(`${plano.tarefas.length} tarefas (limite 3 sem G2)`);

  for (const t of plano.tarefas) {
    if (t.escopo.some((p) => p.startsWith('packages/contrato'))) {
      motivos.push(`${t.id} toca packages/contrato (contrato de conteúdo)`);
    }

    if (t.escopo.some((p) => /migrations?\/|migracao|migração/i.test(p))) {
      motivos.push(`${t.id} toca migration`);
    }
  }

  return { exige: motivos.length > 0, motivos };
}
