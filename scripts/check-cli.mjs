#!/usr/bin/env node
/**
 * check-cli.mjs — a superfície do CLI e o glossário não podem divergir.
 *
 * Fonte única: `docs/glossario.md`. Este script compara a tabela (linhas com
 * status `implementado`) com o que `ai --help` realmente expõe, nos dois
 * sentidos:
 *
 *   - comando marcado `implementado` que não existe no CLI  → falha
 *   - comando visível no CLI que não está no glossário      → falha
 *
 * Nomes depreciados são ocultos de propósito (`hidden`), então não aparecem no
 * `--help` nem contam como divergência.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLOSSARIO = path.join(RAIZ, 'docs', 'glossario.md');
const CLI = path.join(RAIZ, 'dist', 'index.js');

/** Comandos que o CLI expõe: folhas (`topo sub`) e comandos sem filhos. */
function comandosDoCli() {
  const visiveis = new Set();
  const topo = listar(CLI, []);

  for (const nome of topo) {
    const sub = listar(CLI, [nome]);

    // Quem tem filhos é namespace: o glossário declara as folhas, não o pai.
    if (sub.length > 0) {
      for (const s of sub) visiveis.add(`${nome} ${s}`);
    } else {
      visiveis.add(nome);
    }
  }

  return visiveis;
}

function listar(bin, args) {
  let saida = '';

  try {
    saida = execFileSync(process.execPath, [bin, ...args, '--help'], { encoding: 'utf8' });
  } catch (err) {
    saida = String(err.stdout ?? '');
  }

  const linhas = saida.split('\n');
  const inicio = linhas.findIndex((l) => l.trim() === 'Commands:');
  if (inicio < 0) return [];

  const nomes = [];

  for (const linha of linhas.slice(inicio + 1)) {
    // Só linhas de item: dois espaços + nome + (espaço/`[`). A descrição quebra
    // em linha seguinte com recuo maior e não casa.
    const m = /^ {2}([a-z][a-z0-9-]*)(?=[\s[])/.exec(linha);
    if (!m?.[1]) continue;
    if (m[1] === 'help') continue;
    nomes.push(m[1]);
  }

  return nomes;
}

/** Linhas do glossário com status `implementado`. */
function implementadosNoGlossario() {
  const texto = readFileSync(GLOSSARIO, 'utf8');
  const declarados = new Set();

  for (const linha of texto.split('\n')) {
    if (!linha.startsWith('|')) continue;
    const celulas = linha.split('|').map((c) => c.trim());
    const comando = /^`ai\s+([^`]+)`/.exec(celulas[1] ?? '')?.[1];
    const status = celulas[celulas.length - 2] ?? '';
    if (!comando || !status.startsWith('implementado')) continue;

    declarados.add(
      comando
        .split(/\s+/)
        .filter((p) => !p.startsWith('<') && !p.startsWith('--'))
        .join(' '),
    );
  }

  return declarados;
}

const cli = comandosDoCli();
const glossario = implementadosNoGlossario();

const faltandoNoCli = [...glossario].filter((c) => !cli.has(c));
const foraDoGlossario = [...cli].filter((c) => !glossario.has(c));

if (faltandoNoCli.length === 0 && foraDoGlossario.length === 0) {
  console.log(`  ok   cli e glossario em dia (${cli.size} comando(s) visivel(is))`);
  process.exit(0);
}

if (faltandoNoCli.length > 0) {
  console.error(`  FAIL glossario marca como implementado, mas o CLI nao expoe:`);
  for (const c of faltandoNoCli) console.error(`       - ai ${c}`);
}

if (foraDoGlossario.length > 0) {
  console.error(`  FAIL o CLI expoe comando que nao esta no glossario:`);
  for (const c of foraDoGlossario) console.error(`       - ai ${c}`);
}

console.error('\n  Corrija docs/glossario.md (ou a superficie do CLI) e rode de novo.');
process.exit(1);
