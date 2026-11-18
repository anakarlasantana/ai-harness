#!/usr/bin/env node
/**
 * check-file-names.mjs — a nomenclatura do harness é uma regra, não um gosto.
 *
 * Em `src/`: PascalCase (o arquivo exporta um tipo/classe) ou kebab-case
 * (módulo de funções). Nada de português no nome — o código é inglês.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASCAL = /^[A-Z][A-Za-z0-9]*\.ts$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*\.ts$/;

const PORTUGUES = [
  'dossie',
  'escopo',
  'prova',
  'tarefa',
  'tarefas',
  'plano',
  'requisito',
  'rastreio',
  'senha',
  'chave',
  'arquivo',
  'mensagem',
];

const falhas = [];

function varrer(dir) {
  for (const entrada of readdirSync(dir)) {
    const completo = path.join(dir, entrada);

    if (statSync(completo).isDirectory()) {
      varrer(completo);
      continue;
    }

    if (!entrada.endsWith('.ts')) continue;

    const relativo = path.relative(RAIZ, completo);

    if (!PASCAL.test(entrada) && !KEBAB.test(entrada)) {
      falhas.push(`${relativo}: use PascalCase ou kebab-case`);
      continue;
    }

    // Tokeniza em palavras (PascalCase e kebab) antes de comparar: "HumanApproval"
    // não pode casar com "prova" por substring.
    const palavras = entrada
      .replace(/\.ts$/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[-_\s]+/)
      .map((palavra) => palavra.toLowerCase());

    const achado = palavras.find((palavra) => PORTUGUES.includes(palavra));
    if (achado) falhas.push(`${relativo}: nome em português ("${achado}")`);
  }
}

varrer(path.join(RAIZ, 'src'));

if (falhas.length === 0) {
  console.log('  ok   nomes de arquivo na convencao (PascalCase ou kebab-case, sem portugues)');
  process.exit(0);
}

console.error('  FAIL convencao de nome de arquivo:');
for (const f of falhas) console.error(`       - ${f}`);
process.exit(1);
