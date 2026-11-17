import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { AppEnv } from '../config/env.js';
import { log } from '../core/logger.js';
import { avaliarDor, MAX_CRITERIOS } from '../spec/Dor.js';
import {
  aplicarAprovacao,
  aplicarRejeicao,
  guardasDoAmbiente,
  identidade,
  perguntarDecisao,
} from '../spec/Gate.js';
import { acharSpec, listarSpecs, slugify, type SpecRecord } from '../spec/SpecRecord.js';

/**
 * `ai spec` — levantar, revisar e **aprovar** uma spec.
 *
 * `approve` é uma pausa: mostra o veredito do DoR, pergunta e só grava se o
 * humano responder `a`. Sem TTY (agente/CI) não aprova — de propósito.
 */
interface SpecFlags {
  json?: boolean;
  dir?: string;
  por?: string;
}

export function registerSpecCommand(parent: Command, env: AppEnv): void {
  const spec = parent
    .command('spec')
    .description('Levantamento: requisitos, critérios e aprovação (gate humano)');

  spec
    .command('list')
    .description('Lista as specs do alvo (id, estado, pasta)')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((opts: SpecFlags) => {
      const cwd = resolverDir(opts, env);
      const specs = listarSpecs(cwd);

      if (opts.json) {
        console.log(JSON.stringify({ specs }, null, 2));
        return;
      }

      if (specs.length === 0) {
        console.log('Nenhuma spec em spec/. Crie com `ai spec new <ID> "<título>"`.');
        return;
      }

      for (const s of specs) console.log(`${s.id.padEnd(10)} ${s.estado.padEnd(12)} ${s.slug}`);
    });

  spec
    .command('new')
    .argument('<id>', 'id da spec (ex.: RV-042, FEAT-001)')
    .argument('<titulo...>', 'título da feature')
    .description('Abre uma spec em rascunho (spec/<ID>-<slug>/requisito.md)')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((id: string, titulo: string[], opts: SpecFlags) => {
      const cwd = resolverDir(opts, env);
      const nome = titulo.join(' ');
      const pasta = path.join(cwd, 'spec', `${id}-${slugify(nome)}`);

      if (fs.existsSync(path.join(pasta, 'requisito.md'))) {
        throw new Error(`spec ${id} já existe em ${path.relative(cwd, pasta)}`);
      }

      fs.mkdirSync(pasta, { recursive: true });
      fs.writeFileSync(path.join(pasta, 'requisito.md'), rascunho(id, nome), 'utf8');

      log.ok(`${id}: rascunho em ${path.relative(cwd, pasta)}/requisito.md`);
      console.log(`  próximo: preencha os CA-n com \`prova:\` e rode \`ai spec review ${id}\``);
    });

  spec
    .command('review')
    .argument('<id>')
    .description('Laudo de lacunas (DoR) — advisory, não decide')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((id: string, opts: SpecFlags) => {
      const cwd = resolverDir(opts, env);
      const registro = acharSpec(cwd, id);
      const dor = avaliarDor(registro, cwd);

      if (opts.json) {
        console.log(JSON.stringify({ id: registro.front.id, sha: registro.sha, ...dor }, null, 2));
        return;
      }

      console.log(relatorio(registro, dor));

      if (
        registro.front.estado === 'aprovado' &&
        registro.front.aprovado_sha &&
        registro.front.aprovado_sha !== registro.sha
      ) {
        log.warn(
          `critérios mudaram depois da aprovação (sha ${registro.front.aprovado_sha.slice(0, 12)} → ${registro.sha.slice(0, 12)}): re-aprovar.`,
        );
      }
    });

  spec
    .command('approve')
    .argument('<id>')
    .description('Pausa e registra a aprovação (identidade automática + hash dos critérios)')
    .option('--por <nome>', 'aprovar em nome de alguém (registrado como "declarado")')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action(async (id: string, opts: SpecFlags) => {
      const cwd = resolverDir(opts, env);
      const registro = acharSpec(cwd, id);
      const dor = avaliarDor(registro, cwd);
      const guardas = guardasDoAmbiente();

      if (!guardas.ok && !opts.por) {
        for (const motivo of guardas.motivos) log.err(motivo);
        throw new Error(
          'aprovação não registrada: rode `ai spec approve` num terminal humano (ou --por, registrado como declarado).',
        );
      }

      if (dor.bloqueios.length > 0) {
        console.log(relatorio(registro, dor));
        throw new Error(
          `${dor.bloqueios.length} bloqueio(s) de DoR — corrija e rode de novo. Nada foi aprovado.`,
        );
      }

      console.log(relatorio(registro, dor));

      const quem = identidade(cwd, opts.por);

      if (!opts.por) {
        const { decisao, motivo } = await perguntarDecisao();

        if (decisao === 's') {
          console.log('  nada registrado.');
          return;
        }

        if (decisao === 'e') {
          console.log(`  edite ${path.relative(cwd, registro.arquivo)} e rode de novo. Nada registrado.`);
          process.exitCode = 3;
          return;
        }

        if (decisao === 'r') {
          aplicarRejeicao(registro, { identidade: quem, motivo });
          log.warn(`${registro.front.id}: rejeitado${motivo ? ` (${motivo})` : ''}`);
          return;
        }
      }

      aplicarAprovacao(registro, {
        identidade: quem,
        avisos: dor.avisos,
        terminal: !opts.por && guardas.ok,
      });

      if (opts.json) {
        console.log(
          JSON.stringify(
            { id: registro.front.id, estado: 'aprovado', sha: registro.sha, aprovado_por: quem.por },
            null,
            2,
          ),
        );
        return;
      }

      log.ok(
        `${registro.front.id}: APROVADO por ${quem.por} (${quem.origem}) · sha ${registro.sha.slice(0, 12)}`,
      );
    });
}

function resolverDir(opts: SpecFlags, env: AppEnv): string {
  return opts.dir ? path.resolve(opts.dir) : env.cwd;
}

function relatorio(spec: SpecRecord, dor: { bloqueios: string[]; avisos: string[] }): string {
  const linhas: string[] = [];

  linhas.push('');
  linhas.push(`── ${spec.front.id ?? '?'} · ${spec.front.titulo ?? '(sem título)'}`);
  linhas.push(
    `   ${spec.criterios.length} critério(s) (teto ${MAX_CRITERIOS}) · estado ${
      spec.front.estado ?? 'rascunho'
    } · sha ${spec.sha.slice(0, 12)}`,
  );

  for (const b of dor.bloqueios) linhas.push(`  ✗ ${b}`);
  for (const a of dor.avisos) linhas.push(`  ! ${a}`);

  if (dor.bloqueios.length === 0) linhas.push('  ok pode aprovar');

  linhas.push('');
  return linhas.join('\n');
}

function rascunho(id: string, titulo: string): string {
  return `---
id: ${id}
titulo: ${titulo}
persona: cliente
prioridade: MEDIA
origem:
estado: rascunho
---

## História

Como …, quero …, para ….

## Regras de negócio

- …

## Critérios de aceite

- **CA-1** — When …, the sistema shall ….
  prova: \`unit:backend/src/…/__tests__/….spec.ts\`

## Não-objetivos

- …
`;
}
