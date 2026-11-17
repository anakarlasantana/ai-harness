#!/usr/bin/env node
/** check-plan.mjs — DoR do plano e regra do G2, sem precisar de TTY. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { lerPlano, validarPlano, avaliarRisco } = await import(
  path.join(RAIZ, 'dist', 'spec', 'Tasks.js')
);

const falhas = [];
const ok = (nome, condicao, detalhe = '') => {
  if (condicao) console.log(`  ok   ${nome}`);
  else falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

const criterios = [{ id: 'CA-1', texto: 'a', prova: 'unit:x' }, { id: 'CA-2', texto: 'b', prova: 'unit:y' }];
const alvo = mkdtempSync(path.join(tmpdir(), 'harness-plan-'));

const escrever = (nome, linhas) => {
  const dir = path.join(alvo, nome);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tarefas.md'), linhas.join('\n') + '\n');
  return dir;
};

const valido = escrever('valido', [
  '- **T-1** · escopo: `backend/x/**` · fronteira: produto · cobre: CA-1 · wave: 1',
  '- **T-2** · escopo: `e2e/**` · fronteira: teste · cobre: CA-2 · wave: 2 (depende T-1)',
]);

const plano = lerPlano(valido);
ok('lê 2 tarefas', plano.tarefas.length === 2, `veio ${plano.tarefas.length}`);
ok('lê fronteira e wave', plano.tarefas[1]?.fronteira === 'teste' && plano.tarefas[1]?.wave === 2);
ok('lê dependência', plano.tarefas[1]?.depende.includes('T-1') === true);
ok('plano válido não bloqueia', validarPlano(plano, criterios).bloqueios.length === 0, validarPlano(plano, criterios).bloqueios.join(' | '));

const orfao = lerPlano(
  escrever('orfao', ['- **T-1** · escopo: `backend/**` · fronteira: produto · cobre: CA-1 · wave: 1']),
);
ok('CA órfão bloqueia', validarPlano(orfao, criterios).bloqueios.some((b) => b.includes('CA-2')));

const fronteiraErrada = lerPlano(
  escrever('fronteira', [
    '- **T-1** · escopo: `backend/x/**` · fronteira: teste · cobre: CA-1 · wave: 1',
    '- **T-2** · escopo: `e2e/**` · fronteira: produto · cobre: CA-2 · wave: 2',
  ]),
);
const fb = validarPlano(fronteiraErrada, criterios).bloqueios.join(' | ');
ok('fronteira teste não toca produto', fb.includes('fronteira teste'));
ok('fronteira produto não toca e2e', fb.includes('fronteira produto'));

const waveErrada = lerPlano(
  escrever('wave', [
    '- **T-1** · escopo: `backend/x/**` · fronteira: produto · cobre: CA-1, CA-2 · wave: 2 (depende T-2)',
    '- **T-2** · escopo: `e2e/**` · fronteira: teste · cobre: CA-1 · wave: 2',
  ]),
);
ok('dependência na mesma wave bloqueia', validarPlano(waveErrada, criterios).bloqueios.some((b) => b.includes('wave')));

ok('G2 dispensado com 2 tarefas', !avaliarRisco(plano).exige);

const quatro = lerPlano(
  escrever('quatro', [
    '- **T-1** · escopo: `backend/**` · fronteira: produto · cobre: CA-1, CA-2 · wave: 1',
    '- **T-2** · escopo: `backend/**` · fronteira: produto · cobre: CA-1 · wave: 1',
    '- **T-3** · escopo: `backend/**` · fronteira: produto · cobre: CA-2 · wave: 1',
    '- **T-4** · escopo: `backend/**` · fronteira: produto · cobre: CA-1 · wave: 1',
  ]),
);
ok('G2 exigido com >3 tarefas', avaliarRisco(quatro).exige);

const contrato = lerPlano(
  escrever('contrato', ['- **T-1** · escopo: `packages/contrato/**` · fronteira: produto · cobre: CA-1, CA-2 · wave: 1']),
);
ok('G2 exigido ao tocar packages/contrato', avaliarRisco(contrato).exige);

const migration = lerPlano(
  escrever('migration', [
    '- **T-1** · escopo: `backend/src/modules/x/migrations/**` · fronteira: produto · cobre: CA-1, CA-2 · wave: 1',
  ]),
);
ok('G2 exigido ao tocar migration', avaliarRisco(migration).exige);

rmSync(alvo, { recursive: true, force: true });

if (falhas.length > 0) {
  console.error(`  FAIL plano (${falhas.length}):`);
  for (const f of falhas) console.error(`       - ${f}`);
  process.exit(1);
}

console.log('  ok   plano: tarefas, fronteira, waves, órfãos e regra do G2 conferidos');
