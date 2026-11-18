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

const { readSpecDocument, criteriaSha } = await dist('SpecDocument.js');
const { evaluateSpecReadiness } = await dist('SpecReadiness.js');
const { applyApproval, environmentGuards, identity, applyRejection } = await dist('HumanApproval.js');

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
estado: skeleton
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
    '- **CA-2** — When a pessoa confirma, the sistema shall recordApproval o pedido.',
    '  prova: `jornada:cliente@passo um`',
  ].join('\n'),
);

const arquivo = path.join(pasta, 'requisito.md');
writeFileSync(arquivo, valida);

const spec = readSpecDocument(pasta);
ok('lê 2 critérios', spec.criterios.length === 2, `veio ${spec.criterios.length}`);
ok('sha igual ao normalizado', spec.sha === criteriaSha(spec.criterios));
ok('sha é determinístico', criteriaSha(spec.criterios) === criteriaSha([...spec.criterios]));

const dor = evaluateSpecReadiness(spec, alvo);
ok('DoR: spec válida não bloqueia', dor.bloqueios.length === 0, dor.bloqueios.join(' | '));

const semProva = readSpecDocument(writeFixture('sem-prova', requisito('- **CA-1** — algo sem prova.')));
ok('DoR: CA sem prova bloqueia', evaluateSpecReadiness(semProva, alvo).bloqueios.some((b) => b.includes('sem `prova:`')));

const provaQuebrada = writeFixture(
  'prova-quebrada',
  requisito(
    ['- **CA-1** — algo.', '  prova: `unit:backend/src/__tests__/nao-existe.spec.ts`'].join('\n'),
  ),
);
ok(
  'DoR: prova ausente bloqueia',
  evaluateSpecReadiness(readSpecDocument(provaQuebrada), alvo).bloqueios.some((b) => b.includes('arquivo ausente')),
);

const onze = writeFixture(
  'onze',
  requisito(
    Array.from({ length: 11 }, (_, i) => `- **CA-${i + 1}** — c${i}.`).join('\n'),
  ),
);
ok('DoR: teto de 10 critérios', evaluateSpecReadiness(readSpecDocument(onze), alvo).bloqueios.some((b) => b.includes('teto')));

const guardaAgente = environmentGuards({ isTTY: false, env: {} });
ok('guarda: sem TTY recusa', !guardaAgente.ok);

const guardaHumano = environmentGuards({ isTTY: true, env: {} });
ok('guarda: TTY humano passa', guardaHumano.ok);

const guardaCI = environmentGuards({ isTTY: true, env: { CI: '1' } });
ok('guarda: CI recusa', !guardaCI.ok);

const quem = identity(alvo, 'Ana Karla Santana <t-ana.santana@cni.com.br>');
ok('identidade declarada', quem.conta === 't-ana.santana@cni.com.br' && quem.origem === 'declarado');

const aprovada = readSpecDocument(pasta);
applyApproval(aprovada, { identity: quem, avisos: [], quando: '2026-01-01T00:00:00Z', terminal: false });
const lida = readSpecDocument(pasta);
ok('aprovação grava estado', lida.front.estado === 'aprovado');
ok('aprovação grava sha', lida.front.aprovado_sha === lida.sha);
ok('aprovação grava identidade', lida.front.aprovado_conta === 't-ana.santana@cni.com.br');
ok('aprovação --por não é terminal', lida.front.aprovado_terminal === 'false');
ok('histórico anexado', /## Histórico/.test(readFileSync(arquivo, 'utf8')));

applyRejection(readSpecDocument(pasta), { identity: quem, motivo: 'faltou regra', quando: '2026-01-02T00:00:00Z' });
ok('rejeição grava motivo', /motivo_rejeicao: faltou regra/.test(readFileSync(arquivo, 'utf8')));

rmSync(alvo, { recursive: true, force: true });

const { checkCodeGates } = await import(path.join(RAIZ, 'dist', 'spec', 'CodeGateCheck.js'));

const alvoGate = mkdtempSync(path.join(tmpdir(), 'harness-gates-'));
const pastaGate = path.join(alvoGate, 'spec', 'FEAT-009-gate');
mkdirSync(pastaGate, { recursive: true });
mkdirSync(path.join(alvoGate, 'backend', 'src', 'x', '__tests__'), { recursive: true });
writeFileSync(path.join(alvoGate, 'backend', 'src', 'x', '__tests__', 'x.spec.ts'), '// t\n');

const specGate = (extra) => `---
id: FEAT-009
titulo: Gate
estado: skeleton
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
ok('gate: rascunho bloqueia', !checkCodeGates(alvoGate, 'FEAT-009').ok);

writeFileSync(
  path.join(pastaGate, 'requisito.md'),
  specGate(`aprovado_por: Ana\naprovado_sha: ${readSpecDocument(pastaGate).sha}`).replace(
    'estado: skeleton',
    'estado: aprovado',
  ),
);
writeFileSync(path.join(pastaGate, 'tarefas.md'), tarefas(1));
ok('gate: aprovado e plano sem risco passa', checkCodeGates(alvoGate, 'FEAT-009').ok, checkCodeGates(alvoGate, 'FEAT-009').motivos.join(' | '));

const antes = readSpecDocument(pastaGate);
writeFileSync(
  path.join(pastaGate, 'requisito.md'),
  specGate(`aprovado_por: Ana\naprovado_sha: ${antes.sha}`)
    .replace('estado: skeleton', 'estado: aprovado')
    .replace('shall b', 'shall c'),
);
ok(
  'gate: critério mudado depois da aprovação bloqueia',
  checkCodeGates(alvoGate, 'FEAT-009').motivos.some((m) => m.includes('critérios mudaram')),
);

const specOk = readSpecDocument(pastaGate);
writeFileSync(
  path.join(pastaGate, 'requisito.md'),
  specGate(`aprovado_por: Ana\naprovado_sha: ${specOk.sha}`).replace('estado: skeleton', 'estado: aprovado'),
);
writeFileSync(path.join(pastaGate, 'tarefas.md'), tarefas(4));
ok(
  'gate: G2 exigido sem aprovação de plano bloqueia',
  checkCodeGates(alvoGate, 'FEAT-009').motivos.some((m) => m.includes('G2')),
);

rmSync(alvoGate, { recursive: true, force: true });

const { resolveProof, countJourneySteps } = await import(path.join(RAIZ, 'dist', 'spec', 'ProofResolver.js'));
const alvoProva = mkdtempSync(path.join(tmpdir(), 'harness-prova-'));
mkdirSync(path.join(alvoProva, 'e2e', 'jornadas'), { recursive: true });
mkdirSync(path.join(alvoProva, 'backend', 't'), { recursive: true });
writeFileSync(path.join(alvoProva, 'backend', 't', 't.spec.ts'), '// t');
writeFileSync(
  path.join(alvoProva, 'e2e', 'jornadas', 'cliente.spec.ts'),
  'test("x", async () => { await test.step("passo um", async () => {}) })',
);

ok('prova: unit existente resolve', resolveProof('unit:backend/t/t.spec.ts', alvoProva).resolvido);
ok('prova: unit ausente falha', !resolveProof('unit:backend/t/nao.spec.ts', alvoProva).resolvido);
ok('prova: jornada com passo resolve', resolveProof('jornada:cliente@passo um', alvoProva).resolvido);
ok('prova: jornada com passo errado falha', !resolveProof('jornada:cliente@outro', alvoProva).resolvido);
ok('prova: jornada inexistente falha', !resolveProof('jornada:fantasma', alvoProva).resolvido);
ok('prova: api ainda não resolve', !resolveProof('api:qualquer', alvoProva).resolvido);
ok('prova: conta passos da jornada', countJourneySteps(alvoProva, 'cliente') === 1);

rmSync(alvoProva, { recursive: true, force: true });

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
