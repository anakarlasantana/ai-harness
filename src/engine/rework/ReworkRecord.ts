import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/**
 * Registro de rework — o artefato que liga um achado do teste ao patch
 * verificado. É **do alvo** (o app decide onde ele mora), mas o formato é o
 * mesmo em qualquer app: o harness só sabe ler e escrever este contrato.
 */
export const REWORK_STATES = [
  'relatado',
  'triado',
  'aplicado',
  'verificado',
  'fechado',
  'descartado',
  'bloqueado',
] as const;

export const REWORK_CLASSES = ['teste', 'produto', 'ambiente', 'dado', 'indefinido'] as const;

export type ReworkState = (typeof REWORK_STATES)[number];
export type ReworkClass = (typeof REWORK_CLASSES)[number];

export const ReworkFrontSchema = z
  .object({
    id: z.string().min(1),
    alvo: z.string().optional(),
    aberto_em: z.string().optional(),
    origem: z
      .object({
        jornada: z.string().optional(),
        passo: z.string().optional(),
        laudo: z.string().optional(),
        commit_base: z.string().optional(),
      })
      .partial()
      .optional(),
    ambiente: z.record(z.string(), z.any()).optional(),
    classificacao: z.enum(REWORK_CLASSES).default('indefinido'),
    /** Critério(s) de aceite que este rework viola (CA-n da spec). */
    ca: z.union([z.string(), z.array(z.string())]).optional(),
    severidade: z.string().optional(),
    sintoma: z.string().optional(),
    reproducao: z.string().optional(),
    evidencias: z.record(z.string(), z.any()).optional(),
    causa_provavel: z.record(z.string(), z.any()).optional(),
    hipoteses: z.array(z.record(z.string(), z.any())).optional(),
    arquivos_suspeitos: z.array(z.string()).optional(),
    testes_a_rodar: z.array(z.string()).optional(),
    criterio_de_aceite: z.string().optional(),
    risco_de_regressao: z.string().optional(),
    patch: z
      .object({
        branch: z.string().optional(),
        commits: z.array(z.string()).optional(),
        pr: z.string().optional(),
      })
      .partial()
      .optional(),
    gates: z.record(z.string(), z.any()).optional(),
    /** Quantas vezes o fluxo já tentou fechar este rework. */
    tentativas: z.number().int().nonnegative().optional(),
    estado: z.enum(REWORK_STATES).default('relatado'),
    proximo_passo: z.string().optional(),
  })
  .passthrough();

export type ReworkFront = z.infer<typeof ReworkFrontSchema>;

export interface ReworkRecord {
  /** Caminho absoluto do arquivo. */
  path: string;
  front: ReworkFront;
  /** Corpo em Markdown (após o segundo `---`). */
  body: string;
}

/** Diretório dos registros, conforme o alvo declarou em `.harness/context.json`. */
export function reworkDir(cwd: string, declared?: string): string {
  return path.isAbsolute(declared ?? '')
    ? (declared as string)
    : path.join(cwd, declared ?? 'docs/laudos/reworks');
}

export class ReworkRecordFile {
  /**
   * Fila por arquivo: o registro é lido-modificado-escrito, e duas execuções do
   * harness ao mesmo tempo (ex.: `--runVerification` e um `fix` no editor) não podem
   * intercalar. Mesma disciplina da memória de task.
   */
  private static readonly filas = new Map<string, Promise<unknown>>();

  constructor(readonly filePath: string) {}

  private enfileirar<T>(op: () => T): Promise<T> {
    const anterior = ReworkRecordFile.filas.get(this.filePath) ?? Promise.resolve();
    const proxima = anterior.then(op, op);
    ReworkRecordFile.filas.set(this.filePath, proxima.catch(() => undefined));
    return proxima;
  }

  read(): ReworkRecord {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);

    if (!match?.[1]) {
      throw new Error(`${this.filePath}: sem frontmatter YAML (delimitado por ---).`);
    }

    const parsed = ReworkFrontSchema.safeParse(parseYaml(match[1]));

    if (!parsed.success) {
      throw new Error(
        `${this.filePath}: frontmatter inválido (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}).`,
      );
    }

    return { path: this.filePath, front: parsed.data, body: match[2] ?? '' };
  }

  /** Atualiza campos do frontmatter preservando o corpo (que é append-only). */
  async update(mutator: (front: ReworkFront) => void): Promise<ReworkRecord> {
    return this.enfileirar(() => {
      const rec = this.read();
      mutator(rec.front);
      this.escrever(rec.front, rec.body);
      return { ...rec, front: rec.front };
    });
  }

  /** Anexa uma seção no fim do corpo (histórico nunca é reescrito). */
  async append(titulo: string, linhas: string[]): Promise<void> {
    return this.enfileirar(() => {
      const rec = this.read();
      const bloco = [`## ${titulo}`, '', ...linhas, ''].join('\n');
      this.escrever(rec.front, `${rec.body.trimEnd()}\n\n${bloco}`);
    });
  }

  /** Escrita atômica: temporário no mesmo diretório + rename. */
  private escrever(front: ReworkFront, body: string): void {
    const conteudo = `---\n${stringifyYaml(front, { lineWidth: 100 })}---\n${body}`;
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, conteudo, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

/** Lista os registros do diretório (ordem alfabética por id). */
export function listRecords(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^RW-.*\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}
