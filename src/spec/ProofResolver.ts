import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve uma prova declarada num critério: `unit:<arquivo>`,
 * `jornada:<nome>@<passo>` ou `api:<nome>`.
 *
 * É a mesma regra do `gen-rastreio.mjs` do alvo — por isso ela mora num lugar só
 * aqui também: DoR, `verify proofs` e o futuro rastreio não podem divergir.
 */
export interface ResolvedProof {
  tipo: string | null;
  alvo: string | null;
  resolvido: boolean;
  motivo: string | null;
}

export function resolveProof(prova: string | null, cwd: string): ResolvedProof {
  if (!prova) return { tipo: null, alvo: null, resolvido: false, motivo: 'sem prova declarada' };

  const [tipo, alvo] = prova.split(':');

  if (!tipo || !alvo) {
    return { tipo: tipo ?? null, alvo: null, resolvido: false, motivo: `prova malformada: ${prova}` };
  }

  if (tipo === 'unit') {
    const existe = fs.existsSync(path.join(cwd, alvo));
    return { tipo, alvo, resolvido: existe, motivo: existe ? null : `arquivo ausente: ${alvo}` };
  }

  if (tipo === 'jornada') {
    const [nome, passo] = alvo.split('@');
    const arquivo = path.join(cwd, 'e2e', 'jornadas', `${nome}.spec.ts`);

    if (!fs.existsSync(arquivo)) {
      return { tipo, alvo, resolvido: false, motivo: `jornada ausente: ${nome}` };
    }

    if (passo && !fs.readFileSync(arquivo, 'utf8').includes(`test.step("${passo}"`)) {
      return { tipo, alvo, resolvido: false, motivo: `passo ausente na jornada: ${passo}` };
    }

    return { tipo, alvo, resolvido: true, motivo: null };
  }

  if (tipo === 'api') {
    return { tipo, alvo, resolvido: false, motivo: 'nivel api sem runner ainda (declare verification.api.command)' };
  }

  return { tipo, alvo, resolvido: false, motivo: `tipo de prova desconhecido: ${tipo}` };
}

/** Quantos `test.step(...)` a jornada tem — o tamanho da história. */
export function countJourneySteps(cwd: string, nome: string): number {
  const arquivo = path.join(cwd, 'e2e', 'jornadas', `${nome}.spec.ts`);

  try {
    return (fs.readFileSync(arquivo, 'utf8').match(/test\.step\(/g) ?? []).length;
  } catch {
    return 0;
  }
}
