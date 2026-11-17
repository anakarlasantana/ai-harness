import { execFileSync } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline/promises';
import { anexarHistorico, gravarSpec, type SpecRecord } from './SpecRecord.js';

/**
 * O gate humano: identidade automática + guardas + a decisão.
 *
 * Regra: a aprovação é **do humano no terminal**. O agente não assina — e a
 * única prova disso que não depende de confiança é o ambiente (TTY + ausência
 * de marca de agente/CI). O `aprovado_sha` garante que o critério aprovado é o
 * critério usado depois.
 */
export interface Identidade {
  por: string;
  conta: string | null;
  usuarioOs: string;
  host: string;
  origem: 'git-config' | 'declarado';
}

export type Decisao = 'a' | 'e' | 'r' | 's';

export interface Guardas {
  ok: boolean;
  motivos: string[];
}

/** Marcas de que quem chama não é uma pessoa num terminal. */
const MARCAS_DE_AGENTE = [
  'HARNESS_AGENT',
  'CLINE_CONNECTOR_CLI_LAUNCH',
  'CLINE_WRAPPER_PATH',
  'CLINE_HOOK_AGENT_RESUME',
  'CI',
];

export function guardasDoAmbiente(opts: {
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): Guardas {
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  const env = opts.env ?? process.env;
  const motivos: string[] = [];

  if (!isTTY) {
    motivos.push('sem terminal interativo (TTY): aprovação exige um humano no terminal');
  }

  for (const marca of MARCAS_DE_AGENTE) {
    if (env[marca]) motivos.push(`ambiente de agente/CI detectado (${marca})`);
  }

  return { ok: motivos.length === 0, motivos };
}

export function identidade(cwd: string, declarado?: string): Identidade {
  const usuarioOs = os.userInfo().username;
  const host = os.hostname();

  if (declarado) {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(declarado);

    return {
      por: (m?.[1] ?? declarado).trim(),
      conta: m?.[2]?.trim() ?? null,
      usuarioOs,
      host,
      origem: 'declarado',
    };
  }

  return {
    por: gitConfig(cwd, 'user.name') ?? usuarioOs,
    conta: gitConfig(cwd, 'user.email'),
    usuarioOs,
    host,
    origem: 'git-config',
  };
}

function gitConfig(cwd: string, chave: string): string | null {
  try {
    const valor = execFileSync('git', ['config', chave], { cwd, encoding: 'utf8' }).trim();
    return valor || null;
  } catch {
    return null;
  }
}

/** Pergunta a decisão (uma tecla) e, se for rejeitar, o motivo. */
export async function perguntarDecisao(): Promise<{ decisao: Decisao; motivo?: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (;;) {
      const resposta = (await rl.question('[a] aprovar   [e] editar   [r] rejeitar   [s] sair\n> '))
        .trim()
        .toLowerCase();

      if (resposta === 'a' || resposta === 'e' || resposta === 'r' || resposta === 's') {
        const motivo = resposta === 'r' ? (await rl.question('motivo (uma linha): ')).trim() : undefined;
        return { decisao: resposta, motivo };
      }
    }
  } finally {
    rl.close();
  }
}

export function aplicarAprovacao(
  spec: SpecRecord,
  opts: {
    identidade: Identidade;
    avisos: string[];
    quando?: string;
    /** `true` só quando a aprovação veio de um terminal humano. */
    terminal?: boolean;
  },
): void {
  const quando = opts.quando ?? new Date().toISOString();

  spec.front.estado = 'aprovado';
  spec.front.aprovado_por = opts.identidade.por;
  spec.front.aprovado_conta = opts.identidade.conta ?? '';
  spec.front.aprovado_em = quando;
  spec.front.aprovado_sha = spec.sha;
  spec.front.avisos_aceitos = opts.avisos.join(' | ');
  spec.front.aprovado_terminal = opts.terminal ? 'true' : 'false';
  spec.front.aprovado_origem = opts.identidade.origem;

  gravarSpec(spec);
  anexarHistorico(
    spec,
    `- ${quando} — aprovado por ${opts.identidade.por} <${opts.identidade.conta ?? 'sem conta'}> ` +
      `(${opts.identidade.host}, origem ${opts.identidade.origem}); sha ${spec.sha.slice(0, 12)}` +
      (opts.avisos.length ? `; avisos aceitos: ${opts.avisos.length}` : ''),
  );
}

export function aplicarRejeicao(
  spec: SpecRecord,
  opts: { identidade: Identidade; motivo?: string; quando?: string },
): void {
  const quando = opts.quando ?? new Date().toISOString();

  spec.front.estado = 'rejeitado';
  spec.front.rejeitado_por = opts.identidade.por;
  spec.front.rejeitado_em = quando;
  spec.front.motivo_rejeicao = opts.motivo ?? '';

  gravarSpec(spec);
  anexarHistorico(
    spec,
    `- ${quando} — rejeitado por ${opts.identidade.por}${opts.motivo ? `: ${opts.motivo}` : ''}`,
  );
}
