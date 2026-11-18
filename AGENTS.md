# AGENTS.md — ai-harness

Regras para qualquer agente (Cline, Kiro, Claude, Codex) que mexa neste
repositório. Ele é a **fábrica**: roda em outros repos e não conhece nenhum
deles. O que muda por app é o `.harness/context.json` do alvo.

## Definition of Done (executável)

`npm run check` tem de imprimir **cinco** linhas `ok` (cli, nomes, spec, plano +
build/tipos) antes de qualquer commit. O hook `.githooks/pre-commit` roda o mesmo
comando; nunca use `--no-verify`.

## Idioma e nomenclatura

- **Código em inglês**: nomes de arquivo, tipos, funções, variáveis, flags,
  colunas e chaves de contrato.
- **pt-BR** para: comentários, mensagens de CLI, documentação, `docs/` e nomes de
  domínio do **produto** no alvo (`loja`, `requisitos.json`) — nunca no harness.
- **Nome autoexplicativo**: o arquivo diz o que é ou faz. Se precisa do doc para
  entender, o nome está errado. Sigla só se for universal (`E2E`, `CLI`, `HTTP`).
- `PascalCase.ts` quando o arquivo exporta tipo/classe; `kebab-case` para script.
  `scripts/check-file-names.mjs` reprova o resto — inclusive palavra em português.
- Sem `Dor.ts`, `Prova.ts`, `Dossie.ts`, `Escopo.ts`: o modelo é
  `SpecReadiness.ts`, `ProofResolver.ts`, `ReworkBriefing.ts`, `PatchScope.ts`.

## Regras duras

1. A superfície do CLI é a de [`docs/glossario.md`](docs/glossario.md) — fonte
   única. Comando visível fora dela (ou o contrário) reprova o check.
2. O harness **executa** o que o alvo declara; não embute Medusa, Next, Playwright
   nem nome de container no código.
3. Gate humano é TTY: agente não aprova spec (`HARNESS_AGENT`, `CLINE_*`, `CI`
   são recusados de propósito).
4. Artefato de máquina (`.harness/tasks/`, `.harness/tests/`, `.harness/rework/`)
   não entra no git.
5. Diff mínimo: sem reformatação geral, sem renomear por gosto, um assunto por
   commit com a medição no corpo.

## Onde olhar antes de mexer

| Preciso de | Vá para |
| :--- | :--- |
| comandos e termos | `docs/glossario.md` |
| ciclo do teste ponta-a-ponta | `docs/verificacao-e-testes.md` |
| esteira de requisitos (G1/G2) | `docs/esteira-de-requisitos.md` |
| fluxo de correção (RW) | `docs/fluxo-de-rework.md` |
| como o alvo declara tudo | `.harness/context.json.example` |
