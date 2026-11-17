import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { AppEnv } from '../config/env.js';
import { log } from '../core/logger.js';
import {
  aplicarRejeicao,
  guardasDoAmbiente,
  identidade,
  perguntarDecisao,
} from '../spec/Gate.js';
import { acharSpec, gravarSpec, listarSpecs, type SpecRecord } from '../spec/SpecRecord.js';
import { avaliarRisco, lerPlano, validarPlano, type Plano } from '../spec/Tasks.js';

/**
 * `ai plan` — desenho + tarefas (waves) e o **G2**, que só existe quando o
 * plano tem risco objetivo (>3 tarefas, contrato de conteúdo ou migration).
 */
interface PlanFlags {
  json?: boolean;
  dir?: string;
  por?: string;
}

export function registerPlanCommand(parent: Command, env: AppEnv): Command {
  const plan = parent.command('plan').description('Plano: desenho, tarefas com waves e G2');

  plan
    .command('create')
    .argument('<id>')
    .description('Cria desenho.md e tarefas.md (uma tarefa por critério) na spec')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((id: string, opts: PlanFlags) => {
      const cwd = resolverDir(opts, env);
      const registro = acharSpec(cwd, id);
      const desenho = path.join(registro.dir, 'desenho.md');
      const tarefas = path.join(registro.dir, 'tarefas.md');

      if (!fs.existsSync(desenho)) fs.writeFileSync(desenho, templateDesenho(registro), 'utf8');

      if (!fs.existsSync(tarefas)) {
        fs.writeFileSync(tarefas, templateTarefas(registro), 'utf8');
        log.ok(`${registro.front.id}: tarefas.md criado (${registro.criterios.length} tarefa(s) a preencher)`);
      } else {
        log.info(`${registro.front.id}: tarefas.md já existe — nada sobrescrito`);
      }

      console.log(`  próximo: ajuste \`escopo:\` e \`wave:\` e rode \`ai plan verify ${registro.front.id}\``);
    });

  plan
    .command('verify')
    .argument('<id>')
    .description('Laudo do plano (DoR do plano) — advisory')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((id: string, opts: PlanFlags) => {
      const cwd = resolverDir(opts, env);
      const registro = acharSpec(cwd, id);
      const plano = lerPlano(registro.dir);
      const dor = validarPlano(plano, registro.criterios);
      const risco = avaliarRisco(plano);

      if (opts.json) {
        console.log(JSON.stringify({ id: registro.front.id, sha: plano.sha, risco, ...dor }, null, 2));
        return;
      }

      console.log(relatorio(registro, plano, dor, risco));
      avisarDrift(registro, plano);
    });

  plan
    .command('approve')
    .argument('<id>')
    .description('G2: aprova o plano quando há risco (identidade + hash do plano)')
    .option('--por <nome>', 'aprovar em nome de alguém (registrado como "declarado")')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action(async (id: string, opts: PlanFlags) => {
      const cwd = resolverDir(opts, env);
      const registro = acharSpec(cwd, id);
      const plano = lerPlano(registro.dir);
      const dor = validarPlano(plano, registro.criterios);
      const risco = avaliarRisco(plano);

      if (dor.bloqueios.length > 0) {
        console.log(relatorio(registro, plano, dor, risco));
        throw new Error(`${dor.bloqueios.length} bloqueio(s) no plano — corrija antes. Nada foi aprovado.`);
      }

      if (!risco.exige) {
        registrar(registro, plano, {
          por: 'dispensado',
          conta: '',
          quando: new Date().toISOString(),
          risco: 'sem-risco',
        });
        log.ok(`${registro.front.id}: G2 dispensado (${plano.tarefas.length} tarefa(s), sem contrato/migration)`);
        return;
      }

      console.log(relatorio(registro, plano, dor, risco));

      const guardas = guardasDoAmbiente();

      if (!guardas.ok && !opts.por) {
        for (const motivo of guardas.motivos) log.err(motivo);
        throw new Error('G2 exige um humano no terminal (ou --por, registrado como declarado).');
      }

      const quem = identidade(cwd, opts.por);

      if (!opts.por) {
        const { decisao, motivo } = await perguntarDecisao();

        if (decisao === 's') return console.log('  nada registrado.');
        if (decisao === 'e') {
          process.exitCode = 3;
          return console.log(`  edite ${path.relative(cwd, plano.arquivo)} e rode de novo.`);
        }
        if (decisao === 'r') {
          aplicarRejeicao(registro, { identidade: quem, motivo });
          return log.warn(`${registro.front.id}: plano rejeitado`);
        }
      }

      registrar(registro, plano, {
        por: quem.por,
        conta: quem.conta ?? '',
        quando: new Date().toISOString(),
        risco: risco.motivos.join(' | '),
        terminal: !opts.por && guardas.ok,
      });

      if (opts.json) {
        console.log(
          JSON.stringify({ id: registro.front.id, plano_sha: plano.sha, aprovado_por: quem.por }, null, 2),
        );
        return;
      }

      log.ok(`${registro.front.id}: PLANO APROVADO por ${quem.por} · sha ${plano.sha.slice(0, 12)}`);
    });

  plan
    .command('list')
    .description('Lista tarefas e waves por spec')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action((opts: PlanFlags) => {
      const cwd = resolverDir(opts, env);
      const linhas = listarSpecs(cwd).map((s) => {
        const registro = acharSpec(cwd, s.id);
        const plano = lerPlano(registro.dir);
        const risco = avaliarRisco(plano);

        return {
          id: s.id,
          tarefas: plano.tarefas.length,
          waves: [...new Set(plano.tarefas.map((t) => t.wave))].sort((a, b) => a - b),
          g2: risco.exige ? 'exigido' : 'dispensado',
        };
      });

      if (opts.json) return console.log(JSON.stringify({ planos: linhas }, null, 2));
      if (linhas.length === 0) return console.log('Nenhuma spec em spec/.');

      for (const l of linhas) {
        console.log(
          `${l.id.padEnd(10)} ${l.tarefas} tarefa(s) · waves ${l.waves.join(',') || '-'} · G2 ${l.g2}`,
        );
      }
    });

  return plan;
}

function registrar(
  registro: SpecRecord,
  plano: Plano,
  dados: { por: string; conta: string; quando: string; risco: string; terminal?: boolean },
): void {
  registro.front.plano_aprovado_por = dados.por;
  registro.front.plano_aprovado_conta = dados.conta;
  registro.front.plano_aprovado_em = dados.quando;
  registro.front.plano_sha = plano.sha;
  registro.front.plano_risco = dados.risco;
  registro.front.plano_terminal = dados.terminal ? 'true' : 'false';
  gravarSpec(registro);
}

function avisarDrift(registro: SpecRecord, plano: Plano): void {
  if (registro.front.plano_sha && registro.front.plano_sha !== plano.sha) {
    log.warn(
      `plano mudou depois da aprovacao (sha ${registro.front.plano_sha.slice(0, 12)} -> ${plano.sha.slice(0, 12)}): re-aprovar.`,
    );
  }
}

function resolverDir(opts: PlanFlags, env: AppEnv): string {
  return opts.dir ? path.resolve(opts.dir) : env.cwd;
}

function relatorio(
  registro: SpecRecord,
  plano: Plano,
  dor: { bloqueios: string[]; avisos: string[] },
  risco: { exige: boolean; motivos: string[] },
): string {
  const linhas: string[] = [];

  linhas.push('');
  linhas.push(`-- plano ${registro.front.id ?? '?'} - ${plano.tarefas.length} tarefa(s)`);
  linhas.push(`   sha ${plano.sha.slice(0, 12)} - G2 ${risco.exige ? 'exigido' : 'dispensado'}`);

  for (const t of plano.tarefas) {
    linhas.push(
      `   ${t.id} w${t.wave} ${t.fronteira.padEnd(7)} ${t.cobre.join(',')} - ${t.escopo.join(', ') || '(sem escopo)'}`,
    );
  }

  for (const b of dor.bloqueios) linhas.push(`  x ${b}`);
  for (const a of dor.avisos) linhas.push(`  ! ${a}`);
  for (const m of risco.motivos) linhas.push(`  ^ risco: ${m}`);

  if (dor.bloqueios.length === 0) linhas.push('  ok plano consistente');

  linhas.push('');
  return linhas.join('\n');
}

function templateDesenho(registro: SpecRecord): string {
  return `# Desenho -- ${registro.front.id ?? ''}\n\n## Onde vive\n\n| Camada | Arquivo | Papel |\n| :--- | :--- | :--- |\n| ... | \`...\` | ... |\n\n## Fronteira\n\n- ...\n\n## Riscos anotados\n\n- ...\n`;
}

function templateTarefas(registro: SpecRecord): string {
  const linhas = registro.criterios.map(
    (ca, i) =>
      `- **T-${i + 1}** · escopo: \`a-preencher/${ca.id}\` · fronteira: produto · cobre: ${ca.id} · wave: 1`,
  );

  return `# Tarefas -- ${registro.front.id ?? ''}\n\nFormato: \`T-n · escopo · fronteira · cobre · wave\`. Uma tarefa por criterio e' o ponto de partida; ajuste o escopo e junte o que for a mesma mudanca.\n\n${linhas.join('\n')}\n`;
}
