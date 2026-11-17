import fs from 'node:fs';
import path from 'node:path';
import type { SpecRecord } from './SpecRecord.js';

/**
 * Definition of Ready (DoR): o que a **máquina** confere antes de o humano
 * decidir. O humano aprova o artefato; cada critério é verificado aqui — é o que
 * permite 1 gate por feature em vez de 1 por critério.
 */
export interface DorResultado {
  bloqueios: string[];
  avisos: string[];
}

/** Teto de critérios por spec: acima disso a revisão humana perde eficácia. */
export const MAX_CRITERIOS = 10;

const NIVEIS = new Set(['unit', 'api', 'jornada']);
const EARS = /\b(when|while|if|where|the system shall|o sistema (deve|deverá))\b/i;

export function avaliarDor(spec: SpecRecord, cwd: string): DorResultado {
  const bloqueios: string[] = [];
  const avisos: string[] = [];

  if (spec.criterios.length === 0) {
    bloqueios.push('nenhum critério de aceite (CA-n) declarado');
  }

  if (spec.criterios.length > MAX_CRITERIOS) {
    bloqueios.push(
      `${spec.criterios.length} critérios (teto ${MAX_CRITERIOS}) — divida a feature em specs menores`,
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

    const [nivel, alvo] = ca.prova.split(':');

    if (!nivel || !NIVEIS.has(nivel)) {
      bloqueios.push(`${ca.id}: nível de prova inválido ("${nivel}"); use unit, api ou jornada`);
      continue;
    }

    if (nivel === 'api') {
      avisos.push(`${ca.id}: prova em nível \`api\` (ainda não implementado — fase E)`);
      continue;
    }

    if (nivel === 'unit' && alvo && !fs.existsSync(path.join(cwd, alvo))) {
      bloqueios.push(`${ca.id}: arquivo de teste ausente (${alvo})`);
    }

    if (nivel === 'jornada' && alvo) {
      const [nome, passo] = alvo.split('@');
      const arquivo = path.join(cwd, 'e2e', 'jornadas', `${nome}.spec.ts`);

      if (!fs.existsSync(arquivo)) {
        bloqueios.push(`${ca.id}: jornada "${nome}" não existe em e2e/jornadas/`);
      } else if (passo && !fs.readFileSync(arquivo, 'utf8').includes(`test.step("${passo}"`)) {
        bloqueios.push(`${ca.id}: passo "${passo}" não existe na jornada ${nome}`);
      }
    }

    if (!EARS.test(ca.texto)) {
      avisos.push(`${ca.id}: texto sem condição explícita (EARS recomendado) — aceito como texto-livre`);
    }

    if (ca.texto.length > 220) {
      avisos.push(`${ca.id}: critério longo (${ca.texto.length} chars) — difícil de verificar`);
    }
  }

  if (!/^##\s+História/im.test(spec.corpo)) avisos.push('seção "## História" ausente');
  if (!/^##\s+Não-objetivos/im.test(spec.corpo)) avisos.push('seção "## Não-objetivos" ausente');

  return { bloqueios, avisos };
}
