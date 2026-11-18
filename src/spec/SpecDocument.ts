import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * Spec de uma feature: `spec/<ID>-<slug>/requisito.md`.
 *
 * O frontmatter é **flat** (chave: valor) de propósito — a aplicação lê o mesmo
 * arquivo com um parser de 10 linhas (`scripts/gen-rastreio.mjs`), sem depender
 * de YAML. O harness pode usar `yaml`, mas precisa gravar o mesmo formato.
 */
export type SpecState = 'skeleton' | 'em-revisao' | 'aprovado' | 'rejeitado' | 'entregue';

export interface SpecCriterion {
  id: string;
  texto: string;
  prova: string | null;
}

export interface SpecDocument {
  /** Pasta da spec (`spec/<ID>-<slug>`). */
  dir: string;
  arquivo: string;
  front: Record<string, string>;
  corpo: string;
  criterios: SpecCriterion[];
  /** Hash do bloco de critérios — é o que a aprovação assina. */
  sha: string;
}

/**
 * Normalização do hash — **idêntica** à da aplicação
 * (`scripts/gen-rastreio.mjs`). Divergir aqui quebra a aprovação: o app
 * reprovaria o `aprovado_sha` que o harness gravou.
 */
export function criteriaSha(criterios: SpecCriterion[]): string {
  const normalizado = criterios.map((c) => `${c.id}|${c.texto}|${c.prova ?? '-'}`).join('\n');
  return createHash('sha256').update(normalizado).digest('hex');
}

/** Extrai `- **CA-n** — texto` + a linha seguinte `prova: \`...\``. */
export function parseCriteria(corpo: string): SpecCriterion[] {
  const lista: SpecCriterion[] = [];
  let atual: SpecCriterion | null = null;

  for (const linha of corpo.split('\n')) {
    const ca = /^- \*\*(CA-\d+)\*\*\s*[—–-]\s*(.+)$/.exec(linha);

    if (ca?.[1] && ca[2]) {
      atual = { id: ca[1], texto: ca[2].trim(), prova: null };
      lista.push(atual);
      continue;
    }

    const prova = /^\s+prova:\s*`([^`]+)`\s*$/.exec(linha);
    if (prova?.[1] && atual) atual.prova = prova[1].trim();
  }

  return lista;
}

export function readSpecDocument(pasta: string): SpecDocument {
  const arquivo = path.join(pasta, 'requisito.md');
  const texto = fs.readFileSync(arquivo, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(texto);

  if (!m?.[1]) {
    throw new Error(`${arquivo}: sem frontmatter YAML (delimitado por ---).`);
  }

  const bruto = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  const front: Record<string, string> = {};

  for (const [chave, valor] of Object.entries(bruto)) {
    front[chave] = valor === null || valor === undefined ? '' : String(valor);
  }

  const corpo = m[2] ?? '';
  const criterios = parseCriteria(corpo);

  return { dir: pasta, arquivo, front, corpo, criterios, sha: criteriaSha(criterios) };
}

export function writeSpecDocument(spec: SpecDocument): void {
  const front = stringifyYaml(spec.front, { lineWidth: 100 });
  fs.writeFileSync(spec.arquivo, `---\n${front}---\n${spec.corpo}`, 'utf8');
}

/** Acrescenta uma seção no fim do corpo (histórico append-only). */
export function appendHistory(spec: SpecDocument, linha: string): void {
  const bruto = fs.readFileSync(spec.arquivo, 'utf8');
  const partes = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(bruto);
  const corpo = (partes?.[2] ?? '').trimEnd();

  const temHistorico = /^## Histórico\s*$/m.test(corpo);
  const novo = temHistorico ? `${corpo}\n${linha}\n` : `${corpo}\n\n## Histórico\n\n${linha}\n`;

  fs.writeFileSync(spec.arquivo, `---\n${partes?.[1] ?? ''}\n---\n${novo}`, 'utf8');
  spec.corpo = novo;
}

/** Specs do alvo, ordenadas por id. */
export function listSpecs(cwd: string): { id: string; estado: string; slug: string }[] {
  const dir = path.join(cwd, 'spec');
  let entradas: fs.Dirent[] = [];

  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: { id: string; estado: string; slug: string }[] = [];

  for (const entrada of entradas) {
    if (!entrada.isDirectory()) continue;

    const arquivo = path.join(dir, entrada.name, 'requisito.md');
    if (!fs.existsSync(arquivo)) continue;

    const front = readSpecDocument(path.join(dir, entrada.name)).front;

    out.push({
      id: front.id ?? entrada.name,
      estado: front.estado ?? 'skeleton',
      slug: entrada.name,
    });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function findSpec(cwd: string, id: string): SpecDocument {
  const dir = path.join(cwd, 'spec');
  const disponiveis = listSpecs(cwd);

  const alvo = disponiveis.find((s) => s.id === id || s.slug.startsWith(`${id}-`));

  if (!alvo) {
    throw new Error(
      `spec ${id} não encontrada em spec/. Disponíveis: ${disponiveis.map((s) => s.id).join(', ') || '(nenhuma)'}`,
    );
  }

  return readSpecDocument(path.join(dir, alvo.slug));
}

export function slugify(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
