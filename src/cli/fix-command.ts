import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { AppEnv } from '../config/env.js';
import { LocalContextLoader } from '../context/LocalContextLoader.js';
import { log } from '../core/logger.js';
import { execSafe } from '../engine/CommandRunner.js';
import { detectStack } from '../engine/StackDetector.js';
import { buildDossie } from '../engine/rework/Dossie.js';
import { escopoDe, violacoes } from '../engine/rework/Escopo.js';
import {
  ReworkRecordFile,
  listRecords,
  reworkDir,
  type ReworkRecord,
} from '../engine/rework/ReworkRecord.js';

/**
 * `ai fix <RW-id>` — a continuação do fluxo de rework (RV-059).
 *
 * O harness **conduz**, não edita: ele lê o registro, valida a fronteira, abre a
 * branch, escreve o dossiê (contexto mínimo) e — com `--verificar` — roda os
 * gates, confere o que o patch tocou e grava o veredito no próprio registro.
 *
 * Quem escreve o código é o agente de edição (Cline), com aprovação humana; o
 * harness é a régua. Assim ninguém "conserta" a regra que o julga.
 */
interface FixFlags {
  verificar?: boolean;
  forcar?: boolean;
  semBranch?: boolean;
  journey?: string;
  json?: boolean;
  dir?: string;
}

/** Estados em que o registro já foi encerrado: reabrir exige `--forcar`. */
const ENCERRADOS = ['verificado', 'fechado', 'descartado'];

export function registerFixCommand(program: Command, env: AppEnv): void {
  program
    .command('fix')
    .argument('<rwId>', 'id do registro (ex.: RW-2026-003)')
    .description('Conduz um rework registrado: fronteira, branch, dossiê e veredito')
    .option('--verificar', 'roda os gates, confere a fronteira do patch e grava o veredito')
    .option('--forcar', 'permite classificação que não é correção de código (ambiente/dado)')
    .option('--sem-branch', 'não cria/troca de branch')
    .option('--journey <nome>', 'jornada declarada em e2e.journey para re-rodar')
    .option('--json', 'saída em JSON')
    .option('--dir <path>', 'diretório do repositório (default: cwd)')
    .action(async (rwId: string, opts: FixFlags) => {
      const cwd = opts.dir ? path.resolve(opts.dir) : env.cwd;
      const local = LocalContextLoader.load(cwd);
      const dir = reworkDir(cwd, local.config.rework?.dir);
      const arquivo = path.join(dir, `${rwId}.md`);

      if (!fs.existsSync(arquivo)) {
        const disponiveis = listRecords(dir).map((f) => f.replace(/\.md$/, ''));
        throw new Error(
          `Registro ${rwId} não existe em ${path.relative(cwd, dir) || '.'}. Disponíveis: ${
            disponiveis.join(', ') || '(nenhum)'
          }`,
        );
      }

      const rec = new ReworkRecordFile(arquivo);
      const registro = rec.read();
      const classe = registro.front.classificacao;

      // 1) Fronteira: só `teste` e `produto` são correção de código.
      if (classe !== 'teste' && classe !== 'produto' && !opts.forcar) {
        const escopo = escopoDe(classe).descricao;
        log.warn(`${rwId} está classificado como "${classe}": ${escopo}.`);
        throw new Error(
          'Rework de ambiente/dado não vira patch. Corrija a causa externa, ou use --forcar se souber o que está fazendo.',
        );
      }

      // 2) Registro encerrado não se reabre por acidente.
      if (!opts.verificar && !opts.forcar && ENCERRADOS.includes(registro.front.estado)) {
        throw new Error(
          `${rwId} está "${registro.front.estado}". Para reabrir, use --forcar (e diga o motivo no commit).`,
        );
      }

      if (opts.verificar) {
        await verificar({ cwd, local, rec, registro, opts });
      } else {
        await preparar({ cwd, local, rec, registro, opts });
      }
    });
}

interface Ctx {
  cwd: string;
  local: ReturnType<typeof LocalContextLoader.load>;
  rec: ReworkRecordFile;
  registro: ReworkRecord;
  opts: FixFlags;
}

/** Prepara o trabalho: branch + dossiê + estado `triado` no registro. */
async function preparar(ctx: Ctx): Promise<void> {
  const { cwd, local, rec, registro, opts } = ctx;
  const rw = registro.front;
  const branch = `fix/${rw.id.toLowerCase()}-${slugify(rw.sintoma ?? rw.classificacao)}`;

  if (!opts.semBranch) {
    const sujos = await changedFiles(cwd);

    if (sujos.length > 0) {
      throw new Error(
        `Árvore suja (${sujos.length} arquivo(s)). Commite ou guarde antes de abrir a branch, ou use --sem-branch.`,
      );
    }

    const criada = await git(cwd, `checkout -b ${branch}`);
    if (!criada.ok) {
      const existente = await git(cwd, `checkout ${branch}`);
      if (!existente.ok) throw new Error(`Não consegui abrir a branch ${branch}: ${existente.stderr}`);
    }
  }

  const comandos = comandosDeVerificacao(cwd, local, opts.journey);
  const dossiePath = path.join(cwd, '.harness', 'rework', rw.id, 'dossie.md');
  fs.mkdirSync(path.dirname(dossiePath), { recursive: true });

  await rec.update((front) => {
    front.estado = 'triado';
    front.patch = { ...(front.patch ?? {}), branch: opts.semBranch ? front.patch?.branch : branch };
    front.proximo_passo = `aplicar o patch seguindo o dossiê e rodar \`ai fix ${rw.id} --verificar\``;
  });

  // O dossiê nasce depois do update: ele mostra o estado em que o trabalho está.
  const dossie = buildDossie({ record: rec.read(), branch, comandos, dossiePath });
  fs.writeFileSync(dossiePath, dossie, 'utf8');

  await rec.append('Histórico', [
    `- ${new Date().toISOString()} — triado pelo harness (classificação \`${rw.classificacao}\`${
      opts.semBranch ? ', sem branch' : `, branch \`${branch}\``
    }). Dossiê: \`.harness/rework/${rw.id}/dossie.md\`.`,
  ]);

  if (opts.json) {
    console.log(JSON.stringify({ rwId: rw.id, branch, dossiePath, estado: 'triado' }, null, 2));
    return;
  }

  log.ok(`${rw.id}: triado${opts.semBranch ? '' : ` · branch ${branch}`}`);
  console.log('');
  console.log(`fronteira: ${escopoDe(rw.classificacao).descricao}`);
  console.log(`dossiê:    ${path.relative(cwd, dossiePath)}`);
  console.log(`próximo:   ai fix ${rw.id} --verificar`);
  console.log('');
}

/** Verifica: fronteira do patch, gates declarados e veredito no registro. */
async function verificar(ctx: Ctx): Promise<void> {
  const { cwd, local, rec, registro, opts } = ctx;
  const rw = registro.front;
  const registroDir = path.relative(cwd, reworkDir(cwd, local.config.rework?.dir));
  const tocados = await changedFiles(cwd, [registroDir]);

  if (tocados.length === 0) {
    throw new Error('Nada para verificar: a árvore está limpa (o patch foi commitado ou não existe).');
  }

  const fora = violacoes(rw.classificacao, tocados);

  if (fora.length > 0) {
    await rec.update((front) => {
      front.estado = 'bloqueado';
      front.proximo_passo = 'reverter os arquivos fora da fronteira e rodar --verificar de novo';
    });
    await rec.append('Veredito (harness)', [
      `- ${new Date().toISOString()} — **bloqueado**: patch tocou arquivo fora do escopo de \`${rw.classificacao}\`.`,
      ...fora.slice(0, 10).map((f) => `  - \`${f}\``),
    ]);
    throw new Error(`Patch fora da fronteira (${fora.length}): ${fora.join(', ')}`);
  }

  const stack = detectStack(cwd, local.config);
  const prontidao = stack.readinessCmd ?? stack.testCmd;
  const gates: Record<string, string> = {};
  const linhas: string[] = [];

  if (prontidao) {
    const t0 = Date.now();
    const res = await execSafe(prontidao, cwd, { timeoutMs: stack.readinessTimeoutMs ?? 600_000 });
    gates.ready = res.ok ? 'pronto' : 'falhou';
    linhas.push(
      `- \`${prontidao}\`: **${res.ok ? 'PRONTO' : 'FALHOU'}** (${Math.round((Date.now() - t0) / 1000)}s)`,
    );
  } else {
    gates.ready = 'nao-declarado';
    linhas.push('- prontidão não declarada no alvo (`.harness/context.json`).');
  }

  const jornada = comandoDeJornada(local, opts.journey, rw.reproducao);

  if (jornada) {
    const t0 = Date.now();
    const res = await execSafe(jornada, cwd, { timeoutMs: 1_200_000 });
    gates.e2e = res.ok ? 'verde' : 'falhou';
    linhas.push(
      `- \`${jornada}\`: **${res.ok ? 'PASSOU' : 'FALHOU'}** (${Math.round((Date.now() - t0) / 1000)}s)`,
    );
  } else {
    gates.e2e = 'nao-executado';
    linhas.push('- jornada não executada (nenhuma em `e2e.journey` nem comando em `reproducao`).');
  }

  const verde = gates.ready !== 'falhou' && gates.e2e !== 'falhou';
  const tentativas = (rw.tentativas ?? 0) + 1;

  await rec.update((front) => {
    front.gates = { ...(front.gates ?? {}), ...gates };
    front.tentativas = tentativas;
    front.estado = verde ? 'verificado' : tentativas >= 3 ? 'bloqueado' : 'aplicado';
    front.proximo_passo = verde
      ? 'abrir o PR citando o id do rework'
      : tentativas >= 3
        ? 'três tentativas sem sucesso — escala para humano'
        : 'ajustar o patch e rodar --verificar de novo';
  });
  await rec.append(`Veredito (harness) — tentativa ${tentativas}`, [
    `- ${new Date().toISOString()} — **${verde ? 'verificado' : 'não fechado'}**`,
    ...linhas,
    `- arquivos no patch: ${tocados.length} (fronteira \`${rw.classificacao}\`: ok)`,
  ]);

  if (opts.json) {
    console.log(
      JSON.stringify({ rwId: rw.id, verde, gates, tentativas, estado: verde ? 'verificado' : 'aplicado' }, null, 2),
    );
  } else {
    log.ok(`${rw.id}: ${verde ? 'VERIFICADO' : 'NÃO FECHADO'} (tentativa ${tentativas})`);
    for (const l of linhas) console.log(`  ${l.replace(/^- /, '')}`);
  }

  if (!verde) process.exitCode = 1;
}

function comandosDeVerificacao(
  cwd: string,
  local: ReturnType<typeof LocalContextLoader.load>,
  journey?: string,
): string[] {
  const stack = detectStack(cwd, local.config);
  const prontidao = stack.readinessCmd ?? stack.testCmd;
  const jornada = comandoDeJornada(local, journey);

  return [prontidao, jornada].filter((c): c is string => Boolean(c));
}

/** A jornada declarada, ou um comando de reprodução explícito no registro. */
function comandoDeJornada(
  local: ReturnType<typeof LocalContextLoader.load>,
  journey?: string,
  reproducao?: string,
): string | undefined {
  if (journey) return local.config.e2e?.journey?.[journey];

  const declarada = Object.values(local.config.e2e?.journey ?? {})[0];
  if (declarada) return declarada;

  return /^(make|npm|pnpm|yarn|npx|node|docker)\s/.test(reproducao ?? '') ? reproducao : undefined;
}

async function git(
  cwd: string,
  args: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await execSafe(`git ${args}`, cwd, { timeoutMs: 30_000 });
  return { ok: res.ok, stdout: res.stdout, stderr: res.stderr };
}

/** Arquivos alterados/não rastreados, um por linha (`git status --porcelain`). */
async function changedFiles(cwd: string, ignorar: string[] = []): Promise<string[]> {
  const res = await git(cwd, 'status --porcelain -uall');

  if (!res.ok) return [];

  return res.stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 3)
    .map((l) => {
      const caminho = l.slice(3);
      return caminho.includes(' -> ') ? (caminho.split(' -> ')[1] ?? caminho) : caminho;
    })
    .map((c) => c.replace(/^"|"$/g, ''))
    // Artefato do próprio harness/da execução não é patch: dossiê, memória de
    // task, evidência descartável e logs de gate.
    .filter((c) => !/^(\.harness\/|evidence\/|\.run\/)/.test(c))
    // O registro de rework é escrito PELO harness (estado, histórico, veredito).
    .filter((c) => !ignorar.some((dir) => dir.length > 0 && c.startsWith(`${dir}/`)));
}

function slugify(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
