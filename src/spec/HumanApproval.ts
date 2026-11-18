import { execFileSync } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline/promises';
import { appendHistory, writeSpecDocument, type SpecDocument } from './SpecDocument.js';

/**
 * O gate humano: identity automática + guardas + a decisão.
 *
 * Regra: a aprovação é **do humano no terminal**. O agente não assina — e a
 * única prova disso que não depende de confiança é o ambiente (TTY + ausência
 * de marca de agente/CI). O `aprovado_sha` garante que o critério aprovado é o
 * critério usado depois.
 */
export interface Identity {
  por: string;
  conta: string | null;
  usuarioOs: string;
  host: string;
  origem: 'git-config' | 'declarado';
}

export type ApprovalDecision = 'a' | 'e' | 'r' | 's';

export interface EnvironmentGuardResult {
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

export function environmentGuards(opts: {
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): EnvironmentGuardResult {
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

export function identity(cwd: string, declarado?: string): Identity {
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
export async function askDecision(): Promise<{ decisao: ApprovalDecision; motivo?: string }> {
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

export function applyApproval(
  spec: SpecDocument,
  opts: {
    identity: Identity;
    avisos: string[];
    quando?: string;
    /** `true` só quando a aprovação veio de um terminal humano. */
    terminal?: boolean;
  },
): void {
  const quando = opts.quando ?? new Date().toISOString();

  spec.front.estado = 'aprovado';
  spec.front.aprovado_por = opts.identity.por;
  spec.front.aprovado_conta = opts.identity.conta ?? '';
  spec.front.aprovado_em = quando;
  spec.front.aprovado_sha = spec.sha;
  spec.front.avisos_aceitos = opts.avisos.join(' | ');
  spec.front.aprovado_terminal = opts.terminal ? 'true' : 'false';
  spec.front.aprovado_origem = opts.identity.origem;

  writeSpecDocument(spec);
  appendHistory(
    spec,
    `- ${quando} — aprovado por ${opts.identity.por} <${opts.identity.conta ?? 'sem conta'}> ` +
      `(${opts.identity.host}, origem ${opts.identity.origem}); sha ${spec.sha.slice(0, 12)}` +
      (opts.avisos.length ? `; avisos aceitos: ${opts.avisos.length}` : ''),
  );
}

export function applyRejection(
  spec: SpecDocument,
  opts: { identity: Identity; motivo?: string; quando?: string },
): void {
  const quando = opts.quando ?? new Date().toISOString();

  spec.front.estado = 'rejeitado';
  spec.front.rejeitado_por = opts.identity.por;
  spec.front.rejeitado_em = quando;
  spec.front.motivo_rejeicao = opts.motivo ?? '';

  writeSpecDocument(spec);
  appendHistory(
    spec,
    `- ${quando} — rejeitado por ${opts.identity.por}${opts.motivo ? `: ${opts.motivo}` : ''}`,
  );
}
