import type { ReworkClass } from './ReworkRecord.js';

/**
 * Fronteira do patch: quem conserta o quê.
 *
 * - `teste`   → só o instrumento (e2e, __tests__, .spec/.test). O produto não é tocado.
 * - `produto` → código do produto, mas **nunca** `e2e/` (senão o teste passa a
 *               esconder o bug) e nunca as próprias regras.
 * - `ambiente`/`dado`/`indefinido` → não é correção de código; exige decisão
 *               explícita (`--forcar`).
 */
export interface Escopo {
  descricao: string;
  /** Arquivos que o patch pode tocar. */
  permite: RegExp[];
}

/** Nunca editável por um agente, em nenhuma classificação. */
const SAGRADOS: RegExp[] = [
  /^AGENTS\.md$/,
  /^\.clinerules\//,
  /^\.harness\/context\.json$/,
];

const TESTE: RegExp[] = [/^e2e\//, /(^|\/)__tests__\//, /\.spec\.[jt]sx?$/, /\.test\.[jt]sx?$/];

export function escopoDe(classificacao: ReworkClass): Escopo {
  switch (classificacao) {
    case 'teste':
      return { descricao: 'só o instrumento (e2e/**, __tests__/**, *.spec, *.test)', permite: TESTE };
    case 'produto':
      return {
        descricao: 'código do produto — e2e/**, AGENTS.md, .clinerules/** e .harness/context.json ficam de fora',
        permite: [/^backend\//, /^frontend\//, /^admin\//, /^packages\//, /^scripts\//, /^docs\//],
      };
    default:
      return { descricao: 'nenhum arquivo (ambiente/dado não é correção de código)', permite: [] };
  }
}

/** Arquivos que violam o escopo (vazio = patch dentro da fronteira). */
export function violacoes(classificacao: ReworkClass, arquivos: string[]): string[] {
  const escopo = escopoDe(classificacao);

  return arquivos.filter((arquivo) => {
    if (SAGRADOS.some((r) => r.test(arquivo))) return true;
    return !escopo.permite.some((r) => r.test(arquivo));
  });
}
