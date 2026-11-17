import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../core/logger.js';
import type { ToolDefinition } from '../providers/LLMProvider.js';

/**
 * RepoIndex - mapa estrutural barato do repositorio.
 *
 * MOTIVACAO: o stage `plan` rodava sem nenhuma visao do codigo real. Instruido a
 * "analisar a aplicacao", o modelo inventava chamadas de ferramenta em texto
 * puro (DSML do DeepSeek v4) e devolvia `toolCalls: 0`. Injetar o codigo inteiro
 * no prompt custaria ~150k tokens por chamada.
 *
 * SOLUCAO: este modulo produz um mapa de ~1k tokens (areas, tamanho, testes)
 * que responde "ONDE olhar". O modelo entao le so os arquivos que importam, via
 * MCP filesystem.
 *
 * A assinatura garante que o mapa NUNCA fica desatualizado:
 *   head        - commit atual
 *   statusHash  - arquivos modificados/novos/deletados (git status --porcelain)
 *   mtimeMax    - maior mtime em codigo (pega escrita entre commits)
 */

export interface RepoSignature {
  head: string;
  statusHash: string;
  mtimeMax: number;
  /** sha1 dos tres campos - o que e comparado com o mapa em disco. */
  combined: string;
}

export interface RepoMapOptions {
  roots?: string[];
  maxDepth?: number;
  maxChars?: number;
}

interface AreaStat {
  rel: string;
  files: number;
  loc: number;
  tests: number;
  entries: Array<{ name: string; loc: number }>;
}

const MAP_DIR = '.harness/context';
const MAP_FILE = 'repo-map.md';
const DEFAULT_MAX_CHARS = 24_000;
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.py', '.java', '.kt', '.rs']);
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '.git', '__pycache__', 'target', 'vendor']);

export class RepoIndex {
  static mapPath(cwd: string): string {
    return path.join(cwd, MAP_DIR, MAP_FILE);
  }

  static computeSignature(cwd: string, roots?: string[]): RepoSignature {
    const head = safeGit(cwd, 'rev-parse HEAD') ?? 'no-git';
    // O proprio cache do mapa aparece no `git status` como arquivo novo; se
    // entrasse na assinatura, o mapa se auto-invalidaria a cada escrita.
    const status = (safeGit(cwd, 'status --porcelain') ?? '')
      .split('\n')
      .filter((line) => !line.includes('.harness/context'))
      .join('\n');
    const statusHash = sha1(status);
    const mtimeMax = maxMtime(cwd, roots ?? detectRoots(cwd));

    return { head, statusHash, mtimeMax, combined: sha1(`${head}:${statusHash}:${mtimeMax}`) };
  }

  static readOrRefresh(cwd: string, opts: RepoMapOptions = {}): string {
    const file = RepoIndex.mapPath(cwd);
    const current = RepoIndex.computeSignature(cwd, opts.roots).combined;

    const cached = readCachedMap(file);
    if (cached && cached.signature === current) {
      log.debug(`RepoIndex: mapa em cache (sig ${current.slice(0, 8)}).`);
      return cached.body;
    }

    const body = RepoIndex.build(cwd, opts);
    writeCachedMap(file, current, body);
    log.debug(`RepoIndex: mapa regenerado (sig ${current.slice(0, 8)}, ${body.length} chars).`);
    return body;
  }

  static isStale(cwd: string, opts: RepoMapOptions = {}): boolean {
    const cached = readCachedMap(RepoIndex.mapPath(cwd));
    if (!cached) return true;
    return cached.signature !== RepoIndex.computeSignature(cwd, opts.roots).combined;
  }

  static build(cwd: string, opts: RepoMapOptions = {}): string {
    const roots = opts.roots ?? detectRoots(cwd);
    const maxDepth = opts.maxDepth ?? 3;
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

    const sig = RepoIndex.computeSignature(cwd, roots);
    const areas: AreaStat[] = [];

    for (const root of roots) {
      const abs = path.resolve(cwd, root);
      if (!fs.existsSync(abs)) continue;
      collectAreas(abs, root, maxDepth, areas);
    }

    const biggest = areas
      .flatMap((a) => a.entries.map((e) => ({ ...e, area: a.rel })))
      .sort((a, b) => b.loc - a.loc)
      .slice(0, 12);

    const totalFiles = areas.reduce((n, a) => n + a.files, 0);
    const totalLoc = areas.reduce((n, a) => n + a.loc, 0);

    // Cobertura indireta: um modulo sem *.test.ts proprio pode ser exercitado
    // por testes de outro modulo (ex.: container.ts e shared/config sao
    // importados por 6 arquivos de teste). Sem isso o mapa reporta falso
    // positivo de "area sem teste".
    const importedByTests = collectIndirectCoverage(cwd, roots, areas);
    // Diretorios de teste nao entram em "sem teste": sao a propria suite.
    const TEST_DIR = /(^|\/)(tests?|__tests__|e2e|specs?)(\/|$)/;
    const noTest = areas.filter(
      (a) =>
        a.tests === 0 &&
        a.files >= 2 &&
        !importedByTests.has(a.rel) &&
        !TEST_DIR.test(a.rel),
    );
    const indirect = areas.filter((a) => a.tests === 0 && importedByTests.has(a.rel));

    const lines: string[] = [];
    lines.push('# Mapa do Repositorio');
    lines.push(`<!-- sig: ${sig.combined} | head: ${sig.head.slice(0, 7)} -->`);
    lines.push('');
    lines.push(`**Totais**: ${totalFiles} arquivos | ${totalLoc} linhas | ${areas.length} areas | ${noTest.length} sem teste`);
    lines.push('');
    lines.push('## Areas');
    lines.push('| area | arquivos | linhas | testes |');
    lines.push('|---|---|---|---|');

    for (const area of [...areas].sort((a, b) => b.loc - a.loc)) {
      lines.push(`| ${area.rel} | ${area.files} | ${area.loc} | ${area.tests > 0 ? area.tests : '-'} |`);
    }

    if (indirect.length > 0) {
      lines.push('');
      lines.push(`## Cobertura indireta (${indirect.length}) - sem teste proprio, mas importadas por testes`);
      for (const a of indirect) {
        const by = importedByTests.get(a.rel) ?? [];
        lines.push(`- ${a.rel} <- ${by.slice(0, 3).join(', ')}${by.length > 3 ? ' ...' : ''}`);
      }
    }

    if (noTest.length > 0) {
      lines.push('');
      lines.push(`## Areas sem teste (${noTest.length})`);
      lines.push(noTest.map((a) => a.rel).join(' - '));
    }

    if (biggest.length > 0) {
      lines.push('');
      lines.push('## Maiores arquivos');
      for (const b of biggest) {
        lines.push(`- \`${b.area}/${b.name}\` (${b.loc} linhas)`);
      }
    }

    let body = lines.join('\n');
    if (body.length > maxChars) {
      body = `${body.slice(0, maxChars)}\n\n... (mapa truncado em ${maxChars} chars; use ai index para ver completo)`;
    }
    return body;
  }
}

function detectRoots(cwd: string): string[] {
  const candidates = ['backend/src', 'src', 'frontend/src', 'app', 'tests', 'test', '__tests__'];
  const found = candidates.filter((rel) => {
    const abs = path.join(cwd, rel);
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  });
  if (found.length === 0) {
    try {
      return fs
        .readdirSync(cwd, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !IGNORED_DIRS.has(d.name) && !d.name.startsWith('.'))
        .map((d) => d.name)
        .slice(0, 6);
    } catch {
      return [];
    }
  }
  return found;
}

function collectAreas(absRoot: string, relRoot: string, maxDepth: number, out: AreaStat[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;

    const abs = path.join(absRoot, entry.name);
    const rel = `${relRoot}/${entry.name}`;

    if (entry.isDirectory()) {
      if (maxDepth > 1) collectAreas(abs, rel, maxDepth - 1, out);
      continue;
    }

    if (!CODE_EXT.has(path.extname(entry.name))) continue;

    let area = out.find((a) => a.rel === relRoot);
    if (!area) {
      area = { rel: relRoot, files: 0, loc: 0, tests: 0, entries: [] };
      out.push(area);
    }

    const loc = countLines(abs);
    area.files += 1;
    area.loc += loc;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) area.tests += 1;
    area.entries.push({ name: entry.name, loc });
  }
}

/**
 * Descobre areas sem teste proprio que sao importadas por algum arquivo de teste
 * ou por testes de integracao (ex.: tests/).
 *
 * Limite conhecido: analise por caminho de import, nao por grafo real de
 * execucao. Importa para resposta do tipo "esta area e exercitada?", nao para
 * percentual de cobertura.
 */
function collectIndirectCoverage(
  cwd: string,
  roots: string[],
  areas: AreaStat[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  // Diretorios de teste nao sao "areas sem teste" - sao a propria suite.
  const TEST_DIR = /(^|\/)(tests?|__tests__|e2e|specs?)(\/|$)/;
  const candidates = areas.filter(
    (a) => a.tests === 0 && a.files >= 2 && !TEST_DIR.test(a.rel),
  );
  if (candidates.length === 0) return result;

  // Coleta todos os arquivos de teste do repo (usado como fonte de import).
  const testFiles: string[] = [];
  const testRoots = [...new Set([...roots, 'tests', 'test', '__tests__'])];

  for (const rel of testRoots) {
    const abs = path.resolve(cwd, rel);
    if (!fs.existsSync(abs)) continue;
    walkFiles(abs, (file) => {
      // Apenas codigo conta como evidencia de cobertura. README/config nao
      // importam nada - incluir .md gerava falso positivo por mencao textual.
      if (!CODE_EXT.has(path.extname(file))) return;
      if (/(\.test|\.spec)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(tests?|__tests__|e2e)(\/|$)/.test(file)) {
        testFiles.push(file);
      }
    }, 5);
  }
  if (testFiles.length === 0) return result;

  // Le cada teste uma vez e procura o nome do modulo/arquivo no conteudo.
  const contents: Array<{ file: string; body: string }> = [];
  for (const file of testFiles) {
    try {
      contents.push({ file, body: fs.readFileSync(file, 'utf8') });
    } catch {
      /* arquivo removido durante a leitura */
    }
  }

  for (const area of candidates) {
    // Chave de busca: ultimo segmento da area (ex.: "shared/config" -> "config")
    // e nomes dos arquivos de codigo (sem extensao).
    const slug = area.rel.split('/').filter(Boolean).pop() ?? area.rel;
    const needles = new Set<string>([slug]);
    for (const e of area.entries) {
      if (!/(\.test|\.spec)\./.test(e.name)) {
        needles.add(e.name.replace(/\.[^.]+$/, ''));
      }
    }

    const matchedBy: string[] = [];
    for (const { file, body } of contents) {
      if (path.resolve(file).startsWith(path.resolve(cwd, area.rel))) continue;
      for (const needle of needles) {
        if (needle.length < 4) continue;
        if (body.includes(needle)) {
          const rel = path.relative(cwd, file);
          if (!matchedBy.includes(rel)) matchedBy.push(rel);
          break;
        }
      }
    }

    if (matchedBy.length > 0) result.set(area.rel, matchedBy);
  }

  return result;
}

/** Percorre um diretorio chamando `onFile` para cada arquivo de codigo/teste. */
function walkFiles(dir: string, onFile: (file: string) => void, depth: number): void {
  if (depth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(child, onFile, depth - 1);
    else onFile(child);
  }
}

function countLines(file: string): number {
  try {
    const content = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
    return content.length > 0 ? n + 1 : 0;
  } catch {
    return 0;
  }
}

function maxMtime(cwd: string, roots: string[]): number {
  let max = 0;
  const walk = (abs: string, depth: number): void => {
    if (depth < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(child, depth - 1);
      } else if (CODE_EXT.has(path.extname(entry.name))) {
        try {
          const m = fs.statSync(child).mtimeMs;
          if (m > max) max = m;
        } catch { /* arquivo removido durante o walk */ }
      }
    }
  };
  for (const rel of roots) walk(path.resolve(cwd, rel), 3);
  return Math.round(max);
}

function safeGit(cwd: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

interface CachedMap {
  signature: string;
  body: string;
}

function readCachedMap(file: string): CachedMap | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const match = /<!--\s*sig:\s*([0-9a-f]+)/.exec(raw);
    if (!match?.[1]) return null;
    return { signature: match[1], body: raw };
  } catch {
    return null;
  }
}

function writeCachedMap(file: string, signature: string, body: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
    log.debug(`RepoIndex: mapa gravado em ${file} (sig ${signature.slice(0, 8)}).`);
  } catch (err) {
    log.warn(`RepoIndex: falha ao gravar mapa: ${(err as Error).message}`);
  }
}

export const REPO_MAP_TOOL: ToolDefinition = {
  server: 'harness',
  name: 'repo_map',
  description:
    'Mapa estrutural do repositorio: areas, contagem de arquivos, linhas de codigo ' +
    'e presenca de testes. Use PRIMEIRO para descobrir onde olhar antes de ler ' +
    'arquivos. Barato e sempre atualizado.',
  inputSchema: {
    type: 'object',
    properties: {
      area: { type: 'string', description: 'Filtra o mapa por uma area (ex.: modules/payment). Opcional.' },
    },
  },
};

export function filterMapByArea(map: string, area: string): string {
  const needle = area.toLowerCase();
  const lines = map.split('\n');
  const kept: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('#')) inSection = false;
    if (line.toLowerCase().includes(needle)) {
      inSection = true;
      kept.push(line);
      continue;
    }
    if (inSection && !line.trim().startsWith('|')) inSection = false;
    if (inSection) kept.push(line);
  }

  if (kept.length === 0) {
    return `${map.split('\n').slice(0, 8).join('\n')}\n\n(area "${area}" nao encontrada - resumo acima)`;
  }
  return kept.join('\n');
}
