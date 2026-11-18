import path from 'node:path';
import type { Command } from 'commander';
import type { AppEnv } from '../config/env.js';
import { LocalContextLoader } from '../context/LocalContextLoader.js';
import { log } from '../core/logger.js';
import { contarPassos, resolverProva } from '../spec/Prova.js';
import { acharSpec, listarSpecs } from '../spec/SpecRecord.js';

/**
 * `ai verify proofs` — o rastreio visto de fora: cada `CA-n` tem prova válida?
 * E cada jornada declarada existe mesmo?
 *
 * Não escreve nada: o artefato durável é o `rastreio.json` do alvo
 * (`gen-rastreio --check`). Aqui é a leitura sob demanda, sem risco de drift.
 */
interface ProofsFlags {
  json?: boolean;
  dir?: string;
}

export function registerProofsCommand(parent: Command, env: AppEnv): void {
  parent
    .command('proofs')
    .description('Confere as provas de cada critério e o catálogo de jornadas do alvo')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((opts: ProofsFlags) => {
      const cwd = opts.dir ? path.resolve(opts.dir) : env.cwd;
      const local = LocalContextLoader.load(cwd);
      const declaradas = local.config.e2e?.journey ?? {};

      const specs = listarSpecs(cwd).map((s) => {
        const spec = acharSpec(cwd, s.id);

        return {
          id: s.id,
          estado: spec.front.estado ?? 'rascunho',
          criterios: spec.criterios.map((ca) => ({
            ca: ca.id,
            prova: ca.prova,
            ...resolverProva(ca.prova, cwd),
          })),
        };
      });

      const usadas = new Map<string, string[]>();

      for (const s of specs) {
        for (const c of s.criterios) {
          if (c.tipo !== 'jornada' || !c.alvo) continue;
          const nome = c.alvo.split('@')[0] ?? c.alvo;
          usadas.set(nome, [...(usadas.get(nome) ?? []), `${s.id}/${c.ca}`]);
        }
      }

      const jornadas = Object.entries(declaradas).map(([nome, comando]) => ({
        nome,
        comando,
        passos: contarPassos(cwd, nome),
        existe: contarPassos(cwd, nome) > 0,
        coberta: usadas.get(nome) ?? [],
      }));

      const totalCa = specs.reduce((n, s) => n + s.criterios.length, 0);
      const ok = specs.reduce((n, s) => n + s.criterios.filter((c) => c.resolvido).length, 0);
      const falhas = [
        ...specs.flatMap((s) =>
          s.criterios.filter((c) => !c.resolvido).map((c) => `${s.id}/${c.ca}: ${c.motivo}`),
        ),
        ...jornadas.filter((j) => !j.existe).map((j) => `jornada ${j.nome}: spec ausente em e2e/jornadas/`),
      ];

      if (opts.json) {
        console.log(JSON.stringify({ total_ca: totalCa, provados: ok, specs, jornadas, falhas }, null, 2));
      } else {
        for (const s of specs) {
          console.log(`\n${s.id} (${s.estado})`);
          for (const c of s.criterios) {
            console.log(`  ${c.resolvido ? 'ok ' : '✗  '} ${c.ca} ${c.prova ?? '(sem prova)'}${c.motivo ? ` — ${c.motivo}` : ''}`);
          }
        }

        console.log('\njornadas declaradas');
        if (jornadas.length === 0) console.log('  (nenhuma em e2e.journey)');
        for (const j of jornadas) {
          console.log(
            `  ${j.existe ? 'ok ' : '✗  '} ${j.nome} · ${j.passos} passo(s) · ${j.comando}` +
              (j.coberta.length ? ` · prova ${j.coberta.join(', ')}` : ''),
          );
        }

        console.log('');
        if (falhas.length === 0) log.ok(`provas em dia: ${ok}/${totalCa} CA com prova resolvida`);
        else for (const f of falhas) log.err(f);
      }

      if (falhas.length > 0) process.exitCode = 1;
    });
}
