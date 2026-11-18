import fs from 'node:fs';
import path from 'node:path';
import { lerPlano, avaliarRisco } from './Tasks.js';
import { lerSpec, type SpecRecord } from './SpecRecord.js';

/**
 * O que precisa estar aprovado para o código começar.
 *
 * G1 é obrigatório sempre: a spec existe, está `aprovado` e o `aprovado_sha`
 * casa com os critérios de hoje. G2 é exigido pela regra do risco (>3 tarefas,
 * `packages/contrato`, migration) e tem de estar registrado.
 */
export interface GateResultado {
  ok: boolean;
  motivos: string[];
  spec?: SpecRecord;
}

export function avaliarGates(cwd: string, specId: string): GateResultado {
  const motivos: string[] = [];
  const dir = path.join(cwd, 'spec');

  let pastas: string[] = [];

  try {
    pastas = fs.readdirSync(dir).filter((nome) => fs.existsSync(path.join(dir, nome, 'requisito.md')));
  } catch {
    return { ok: false, motivos: [`spec/ não existe em ${cwd}`] };
  }

  const pasta = pastas.find((nome) => nome === specId || nome.startsWith(`${specId}-`));

  if (!pasta) {
    return { ok: false, motivos: [`spec ${specId} não encontrada (${pastas.join(', ') || 'nenhuma'})`] };
  }

  const spec = lerSpec(path.join(dir, pasta));

  if (spec.front.estado !== 'aprovado') {
    motivos.push(`G1: estado "${spec.front.estado ?? 'rascunho'}" — rode \`ai spec approve ${specId}\``);
  }

  if (spec.front.aprovado_sha && spec.front.aprovado_sha !== spec.sha) {
    motivos.push(
      `G1: critérios mudaram depois da aprovação (sha ${spec.front.aprovado_sha.slice(0, 12)} → ${spec.sha.slice(0, 12)})`,
    );
  }

  if (!spec.front.aprovado_sha) {
    motivos.push('G1: sem aprovação registrada (aprovado_sha ausente)');
  }

  const plano = lerPlano(path.join(dir, pasta));
  const risco = avaliarRisco(plano);

  if (risco.exige && !spec.front.plano_aprovado_por) {
    motivos.push(`G2: exigido (${risco.motivos.join('; ')}) — rode \`ai plan approve ${specId}\``);
  }

  if (risco.exige && spec.front.plano_sha && spec.front.plano_sha !== plano.sha) {
    motivos.push(
      `G2: plano mudou depois da aprovação (sha ${spec.front.plano_sha.slice(0, 12)} → ${plano.sha.slice(0, 12)})`,
    );
  }

  return { ok: motivos.length === 0, motivos, spec };
}
