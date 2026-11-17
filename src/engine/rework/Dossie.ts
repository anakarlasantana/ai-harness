import type { ReworkRecord } from './ReworkRecord.js';
import { escopoDe } from './Escopo.js';

/**
 * Dossiê: o contexto mínimo que o agente precisa para corrigir **sem** reler o
 * repositório inteiro. Teto de 60 linhas, montado a partir do registro.
 */
export function buildDossie(opts: {
  record: ReworkRecord;
  branch?: string;
  comandos: string[];
  dossiePath: string;
}): string {
  const { record, branch, comandos } = opts;
  const f = record.front;
  const escopo = escopoDe(f.classificacao);
  const l: string[] = [];

  l.push(`# dossiê — ${f.id}`);
  l.push('');
  l.push(
    `alvo: ${f.alvo ?? '-'} · classificação: **${f.classificacao}** · severidade: ${f.severidade ?? '-'}`,
  );
  l.push(`estado: ${f.estado}${branch ? ` · branch: ${branch}` : ''}`);
  if (f.origem?.jornada) {
    l.push(`origem: jornada ${f.origem.jornada}${f.origem.passo ? ` · passo ${f.origem.passo}` : ''}`);
  }
  l.push('');

  if (f.sintoma) {
    l.push('## sintoma');
    l.push(f.sintoma);
    l.push('');
  }

  if (f.causa_provavel) {
    l.push('## causa provável');
    const arquivo = f.causa_provavel.arquivo;
    const porque = f.causa_provavel.porque;
    l.push(`${arquivo ?? '-'}: ${porque ?? '-'}`);
    l.push('');
  }

  const evidencias = Object.entries(f.evidencias ?? {});
  if (evidencias.length > 0) {
    l.push('## evidências');
    for (const [chave, valor] of evidencias.slice(0, 6)) {
      l.push(`- ${chave}: ${resumir(valor)}`);
    }
    l.push('');
  }

  l.push('## fronteira do patch');
  l.push(escopo.descricao);
  l.push('Nunca: `AGENTS.md`, `.clinerules/**`, `.harness/context.json` (regra que o agente edita não é regra).');
  l.push('');

  if (f.criterio_de_aceite) {
    l.push('## critério de aceite');
    l.push(f.criterio_de_aceite);
    l.push('');
  }

  l.push('## como verificar');
  for (const [i, cmd] of comandos.entries()) l.push(`${i + 1}. \`${cmd}\``);
  l.push('');

  if (f.proximo_passo) {
    l.push('## próximo passo');
    l.push(f.proximo_passo);
    l.push('');
  }

  l.push('## depois de aplicar');
  l.push(`\`ai fix ${f.id} --verificar\` — roda os gates, confere a fronteira e grava o veredito no registro.`);

  return l.slice(0, 60).join('\n') + '\n';
}

function resumir(valor: unknown): string {
  if (typeof valor === 'string') return valor.slice(0, 120);
  if (Array.isArray(valor)) return valor.slice(0, 3).map((v) => resumir(v)).join(' · ');
  return JSON.stringify(valor).slice(0, 120);
}
