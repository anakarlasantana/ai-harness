import type { SpecDocument } from './SpecDocument.js';
import { resolveProof } from './ProofResolver.js';

/**
 * Definition of Ready (DoR): o que a **máquina** confere antes de o humano
 * decidir. O humano aprova o artefato; cada critério é verificado aqui — é o que
 * permite 1 gate por feature em vez de 1 por critério.
 */
export interface SpecReadinessResult {
  bloqueios: string[];
  avisos: string[];
}

/** Teto de critérios por spec: acima disso a revisão humana perde eficácia. */
export const MAX_CRITERIA = 10;

const NIVEIS = new Set(['unit', 'api', 'jornada']);
const EARS = /\b(when|while|if|where|the system shall|o sistema (deve|deverá))\b/i;

export function evaluateSpecReadiness(spec: SpecDocument, cwd: string): SpecReadinessResult {
  const bloqueios: string[] = [];
  const avisos: string[] = [];

  if (spec.criterios.length === 0) {
    bloqueios.push('nenhum critério de aceite (CA-n) declarado');
  }

  if (spec.criterios.length > MAX_CRITERIA) {
    bloqueios.push(
      `${spec.criterios.length} critérios (teto ${MAX_CRITERIA}) — divida a feature em specs menores`,
    );
  }

  const vistos = new Set<string>();

  for (const ca of spec.criterios) {
    if (vistos.has(ca.id)) bloqueios.push(`${ca.id}: id repetido`);
    vistos.add(ca.id);

    if (!ca.prova) {
      bloqueios.push(`${ca.id}: sem \`prova:\` (unit, api ou jornada@passo)`);
      continue;
    }

    const resolvida = resolveProof(ca.prova, cwd);

    if (!resolvida.resolvido) {
      if (resolvida.tipo === 'api') avisos.push(`${ca.id}: ${resolvida.motivo}`);
      else bloqueios.push(`${ca.id}: ${resolvida.motivo}`);
    }

    if (!NIVEIS.has(resolvida.tipo ?? '')) {
      bloqueios.push(`${ca.id}: nível de prova inválido; use unit, api ou jornada`);
    }

    if (!EARS.test(ca.texto)) {
      avisos.push(`${ca.id}: texto sem condição explícita (EARS recomendado) — aceito como texto-livre`);
    }

    if (ca.texto.length > 220) {
      avisos.push(`${ca.id}: critério longo (${ca.texto.length} chars) — difícil de runVerification`);
    }
  }

  if (!/^##\s+História/im.test(spec.corpo)) avisos.push('seção "## História" ausente');
  if (!/^##\s+Não-objetivos/im.test(spec.corpo)) avisos.push('seção "## Não-objetivos" ausente');

  return { bloqueios, avisos };
}
