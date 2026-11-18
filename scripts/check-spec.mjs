#!/usr/bin/env node
/**
 * check-spec.mjs — o gate da esteira de requisitos, sem precisar de TTY.
 *
 * Exercita as funções puras de `dist/spec` com um alvo temporário:
 * hash dos critérios, DoR, guardas do ambiente e gravação da aprovação.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (nome) => import(path.join(RAIZ, 'dist', 'spec', nome));

const { lerSpec, shaDosCriterios } = await dist('SpecRecord.js');
const { avaliarDor } = await dist('Dor.js');
const { aplicarAprovacao, guardasDoAmbiente, identidade, aplicarRejeicao } = await dist('Gate.js');

const falhas = [];
const ok = (nome, condicao, detalhe = '') => {
  if (condicao) console.log(`  ok   ${nome}`);
  else falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

const alvo = mkdtempSync(path.join(tmpdir(), 'harness-spec-'));
const pasta = path.join(alvo, 'spec', 'FEAT-001-teste');

mkdirSync(path.join(alvo, 'e2e', 'jornadas'), { recursive: true });
mkdirSync(path.join(alvo, 'backend', 'src', 'x', '__tests__'), { recursive: true });
mkdirSync(pasta, { recursive: true });

writeFileSync(path.join(alvo, 'backend', 'src', 'x', '__tests__', 'x.spec.ts'), '// teste\n');
writeFileSync(
  path.join(alvo, 'e2e', 'jornadas', 'cliente.spec.ts'),
  'test("x", async () => { await test.step("passo um", async () => {}) })\n',
);

const requisito = (cas) => `---
id: FEAT-001
titulo: Feature de teste
persona: cliente
estado: rascunho
---

## História

Como cliente, quero X.

## Critérios de aceite

${cas}

## Não-objetivos

- nada
`;

const valida = requisito(
  [
    '- **CA-1** — When o checkout abre, the sistema shall exibir as opções.',
    '  prova: `unit:backend/src/x/__tests__/x.spec.ts`',
    '- **CA-2** — When a pessoa confirma, the sistema shall registrar o pedido.',
    '  prova: `jornada:cliente@passo um`',
  ].join('\n'),
);

const arquivo = path.join(pasta, 'requisito.md');
writeFileSync(arquivo, valida);

const spec = lerSpec(pasta);
ok('lê 2 critérios', spec.criterios.length === 2, `veio ${spec.criterios.length}`);
ok('sha igual ao normalizado', spec.sha === shaDosCriterios(spec.criterios));
ok('sha é determinístico', shaDosCriterios(spec.criterios) === shaDosCriterios([...spec.criterios]));

const dor = avaliarDor(spec, alvo);
ok('DoR: spec válida não bloqueia', dor.bloqueios.length === 0, dor.bloqueios.join(' | '));

const semProva = lerSpec(writeFixture('sem-prova', requisito('- **CA-1** — algo sem prova.')));
ok('DoR: CA sem prova bloqueia', avaliarDor(semProva, alvo).bloqueios.some((b) => b.includes('sem `prova:`')));

const provaQuebrada = writeFixture(
  'prova-quebrada',
  requisito(
    ['- **CA-1** — algo.', '  prova: `unit:backend/src/__tests__/nao-existe.spec.ts`'].join('\n'),
  ),
);
ok(
  'DoR: prova ausente bloqueia',
  avaliarDor(lerSpec(provaQuebrada), alvo).bloqueios.some((b) => b.includes('arquivo de teste ausente')),
);

const onze = writeFixture(
  'onze',
  requisito(
    Array.from({ length: 11 }, (_, i) => `- **CA-${i + 1}** — c${i}.`).join('\n'),
  ),
);
ok('DoR: teto de 10 critérios', avaliarDor(lerSpec(onze), alvo).bloqueios.some((b) => b.includes('teto')));

const guardaAgente = guardasDoAmbiente({ isTTY: false, env: {} });
ok('guarda: sem TTY recusa', !guardaAgente.ok);

const guardaHumano = guardasDoAmbiente({ isTTY: true, env: {} });
ok('guarda: TTY humano passa', guardaHumano.ok);

const guardaCI = guardasDoAmbiente({ isTTY: true, env: { CI: '1' } });
ok('guarda: CI recusa', !guardaCI.ok);

const quem = identidade(alvo, 'Ana Karla Santana <t-ana.santana@cni.com.br>');
ok('identidade declarada', quem.conta === 't-ana.santana@cni.com.br' && quem.origem === 'declarado');

const aprovada = lerSpec(pasta);
aplicarAprovacao(aprovada, { identidade: quem, avisos: [], quando: '2026-01-01T00:00:00Z', terminal: false });
const lida = lerSpec(pasta);
ok('aprovação grava estado', lida.front.estado === 'aprovado');
ok('aprovação grava sha', lida.front.aprovado_sha === lida.sha);
ok('aprovação grava identidade', lida.front.aprovado_conta === 't-ana.santana@cni.com.br');
ok('aprovação --por não é terminal', lida.front.aprovado_terminal === 'false');
ok('histórico anexado', /## Histórico/.test(readFileSync(arquivo, 'utf8')));

aplicarRejeicao(lerSpec(pasta), { identidade: quem, motivo: 'faltou regra', quando: '2026-01-02T00:00:00Z' });
ok('rejeição grava motivo', /motivo_rejeicao: faltou regra/.test(readFileSync(arquivo, 'utf8')));

rmSync(alvo, { recursive: true, force: true });

const { avaliarGates } = await import(path.join(RAIZ, 'dist', 'spec', 'Gates.js'));

const alvoGate = mkdtempSync(path.join(tmpdir(), 'harness-gates-'));
const pastaGate = path.join(alvoGate, 'spec', 'FEAT-009-gate');
mkdirSync(pastaGate, { recursive: true });
mkdirSync(path.join(alvoGate, 'backend', 'src', 'x', '__tests__'), { recursive: true });
writeFileSync(path.join(alvoGate, 'backend', 'src', 'x', '__tests__', 'x.spec.ts'), '// t\n');

const specGate = (extra) => `---
id: FEAT-009
titulo: Gate
estado: rascunho
${extra}
---

## História

x

## Critérios de aceite

- **CA-1** — When a, the sistema shall b.
  prova: \`unit:backend/src/x/__tests__/x.spec.ts\`

## Não-objetivos

- x
`;

const tarefas = (n) =>
  Array.from(
    { length: n },
    (_, i) => `- **T-${i + 1}** · escopo: \`backend/src/x/**\` · fronteira: produto · cobre: CA-1 · wave: 1`,
  ).join('\n') + '\n';

writeFileSync(path.join(pastaGate, 'requisito.md'), specGate(''));
ok('gate: rascunho bloqueia', !avaliarGates(alvoGate, 'FEAT-009').ok);

writeFileSync(
  path.join(pastaGate, 'requisito.md'),
  specGate(`aprovado_por: Ana\naprovado_sha: ${lerSpec(pastaGate).sha}`).replace(
    'estado: rascunho',
    'estado: aprovado',
  ),
);
writeFileSync(path.join(pastaGate, 'tarefas.md'), tarefas(1));
ok('gate: aprovado e plano sem risco passa', avaliarGates(alvoGate, 'FEAT-009').ok, avaliarGates(alvoGate, 'FEAT-009').motivos.join(' | '));

const antes = lerSpec(pastaGate);
writeFileSync(
  path.join(pastaGate, 'requisito.md'),
  specGate(`aprovado_por: Ana\naprovado_sha: ${antes.sha}`)
    .replace('estado: rascunho', 'estado: aprovado')
    .replace('shall b', 'shall c'),
);
ok(
  'gate: critério mudado depois da aprovação bloqueia',
  avaliarGates(alvoGate, 'FEAT-009').motivos.some((m) => m.includes('critérios mudaram')),
);

const specOk = lerSpec(pastaGate);
writeFileSync(
  path.join(pastaGate, 'requisito.md'),
  specGate(`aprovado_por: Ana\naprovado_sha: ${specOk.sha}`).replace('estado: rascunho', 'estado: aprovado'),
);
writeFileSync(path.join(pastaGate, 'tarefas.md'), tarefas(4));
ok(
  'gate: G2 exigido sem aprovação de plano bloqueia',
  avaliarGates(alvoGate, 'FEAT-009').motivos.some((m) => m.includes('G2')),
);

rmSync(alvoGate, { recursive: true, force: true });

function writeFixture(nome, conteudo) {
  const dir = path.join(alvo, 'spec', nome);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'requisito.md'), conteudo);
  return dir;
}

if (falhas.length > 0) {
  console.error(`  FAIL spec (${falhas.length}):`);
  for (const f of falhas) console.error(`       - ${f}`);
  process.exit(1);
}

console.log('  ok   spec: hash, DoR, guardas e aprovação conferidos');
