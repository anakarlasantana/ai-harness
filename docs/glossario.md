# Glossário e superfície do CLI

Fonte única dos nomes do `ai-harness`. **Código e comandos em inglês; documentação
em pt-BR.** `npm run check:cli` compara esta tabela com `ai --help` e reprova
divergência (comando visível que não está aqui, ou marcado `implementado` e
ausente do CLI).

## Termos

| Termo | Significado único (não use como sinônimo de outro) |
| :--- | :--- |
| **spec** | conjunto `requisito + desenho + tarefas` de **uma** feature, em `spec/<ID>-<slug>/` |
| **requisito** | o “quê” — história, regras e critérios de aceite (`CA-n`) |
| **CA** | critério de aceite verificável; declara `prova:` (unit, api, jornada@passo) |
| **tarefa** | unidade de execução do plano: escopo de arquivos, fronteira (produto/teste), CA que cobre, wave |
| **plan** | o conjunto de tarefas de uma spec (não confundir com “plano de resposta do modelo”) |
| **jornada** | caminho de um ator na aplicação; um spec de navegador (`e2e/jornadas/*.spec.ts`) |
| **run** | uma execução registrada de verificação (prontidão ou jornada) em `.harness/tasks/*.json` |
| **verificação** | ato de executar comandos declarados e produzir veredito (sem opinião de modelo) |
| **papel (role)** | quem o modelo encarna numa etapa (`planejador`, `developer`, `test-runner`) |
| **etapa (stage)** | passo do pipeline: `spec → plan → build → verify` |
| **gate** | transição que exige aprovação humana ou veredito de máquina |
| **rework (RW)** | achado registrado em `laudos/reworks/RW-*.md` — a pista de **defeito** |
| **alvo (target)** | repositório que o harness opera, com contrato em `.harness/` |

## Superfície

| Comando | O que faz | Efeito | Status |
| :--- | :--- | :--- | :--- |
| `ai spec list` | lista as specs do alvo (id, estado, CAs) | leitura | implementado |
| `ai spec new` | abre rascunho de spec | `spec/<ID>/requisito.md` | planejado (fase C) |
| `ai spec review` | laudo de lacunas do requisito (DoR) | relatório | planejado (fase C) |
| `ai spec approve` | **pausa** e registra a aprovação (identidade + `criterios_sha`) | frontmatter | planejado (fase C) |
| `ai plan create` | gera `desenho.md` + `tarefas.md` (waves) | artefatos | planejado (fase D) |
| `ai plan approve` | aprova o plano (só quando há risco) | frontmatter | planejado (fase D) |
| `ai plan list` | lista tarefas e waves | leitura | planejado (fase D) |
| `ai build code` | implementa (developer + TDD) | código | implementado |
| `ai build review` | revisão em 5 eixos | relatório | implementado |
| `ai build simplify` | simplifica sem mudar comportamento | código | implementado |
| `ai build ship` | checklist de pré-lançamento | relatório | implementado |
| `ai build constraints` | define a barra de qualidade | relatório | implementado |
| `ai build webperf` | auditoria de performance | relatório | implementado |
| `ai build debug` | debug guiado por root-cause | relatório | implementado |
| `ai build design` | analisa protótipo → spec de UI | relatório | implementado |
| `ai build design-review` | fidelidade implementação × protótipo | relatório | implementado |
| `ai build design-code` | implementa UI fiel ao design | código | implementado |
| `ai verify ready` | roda o “definition of done” declarado | veredito | implementado |
| `ai verify e2e` | roda as jornadas declaradas (+ digest) | `testRuns[]` | implementado |
| `ai verify api` | persona de API (L1) | veredito | planejado (fase E) |
| `ai verify proofs` | confere se cada `CA` tem prova resolvida | `rastreio.json` | planejado (fase F) |
| `ai fix <rwId>` | conduz um rework: fronteira, branch, dossiê | registro | implementado |
| `ai fix <rwId> --verificar` | gates + veredito no registro | registro | implementado |
| `ai fix --task <id> --feedback` | correção guiada por histórico (ex-`rework`) | código | planejado (fase E) |
| `ai ops doctor` | configuração efetiva (endpoint/modelo) | relatório | implementado |
| `ai ops models` | modelos que o endpoint expõe | relatório | implementado |
| `ai ops index` | mapa do repositório | `.harness/context/repo-map.md` | implementado |
| `ai ops dashboard` | monitor local | servidor HTTP | implementado |

## Nomes depreciados (ocultos, com aviso)

`plan`→`build code`? não: `plan` é etapa, não comando de build. Os antigos
continuam funcionando e avisam no stderr; saem na próxima versão maior:

| Antigo | Novo |
| :--- | :--- |
| `ai plan <id> <req>` | `ai spec new` + `ai plan create` (fase C/D) |
| `ai code <id> <instr>` | `ai build code` |
| `ai review` / `ship` / `simplify` / `constraints` / `webperf` / `debug` / `design*` | `ai build <mesmo nome>` |
| `ai qa <id>` | `ai verify ready` (loop com modelo entra como `--fix` na fase E) |
| `ai e2e` | `ai verify e2e` |
| `ai rework <id> <feedback>` | `ai fix --task <id> --feedback` (fase E) |
| `ai sync <id>` | sem equivalente ainda — continua oculto até decisão |
| `ai doctor` / `models` / `index` / `dashboard` | `ai ops <mesmo nome>` |
