# CLAUDE.md

O canônico das regras é o [AGENTS.md](AGENTS.md) — leia antes de codar. Resumo do
que **não** se negocia:

- **Código em inglês** (arquivo, tipo, função, variável, flag). Comentário,
  mensagem de CLI e documentação em **pt-BR**.
- **Nome autoexplicativo**: o arquivo diz o que é ou faz; sigla só se for
  universal (`E2E`, `CLI`). `PascalCase.ts` para tipo/classe, `kebab-case` para
  script.
- `npm run check` verde antes de qualquer commit (cli, nomes, spec, plano).
  Nunca `git commit --no-verify`.

Regras por caminho (Cline) ficam em `.clinerules/` — as mesmas ideias, com
exemplos. Contrato completo em [docs/glossario.md](docs/glossario.md).
