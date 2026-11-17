# Kiro Harness V5 — Agent-First

Harness modular multi-persona para o Kiro. Mantém o contexto carregado por sessão no mínimo necessário, ativando personas, skills e referências somente quando a tarefa exige.

A V5 é **agent-first, delegation-last**: a coordenação entra por `agents/orchestrator.json`, que resolve tarefas simples diretamente e só delega quando especialização, isolamento, verificação ou paralelismo real melhoram o resultado.


## Representação

**Fluxo de contexto por sessão** — como o orchestrator despacha a intenção do usuário para a persona correta e como o contexto converge em skills compartilhadas e no steering de projeto.

```
                         ┌──────────────┐
                         │     CORE     │  (steering/core.md — always)
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │ ORCHESTRATOR │  (agents/orchestrator.json)
                         └──────┬───────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
        DEVELOPER           TECH LEAD        PROJECT MANAGER
            │                   │                   │
       implementation       architecture         planning
       testing              decisions            estimation
       debugging            quality              risks
       refactoring          security             dependencies
       performance          scalability          scope
            │                   │                   │
            └───────────────────┼───────────────────┘
                                │
                         ┌──────▼───────┐
                         │  SPECIALIST  │  (quando necessário)
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │   PROJECT    │
                         │   CONTEXT    │
                         └──────────────┘
```

**Estrutura do harness** — o núcleo estável (personas, agentes JSON e contexto de projeto) e as extensões opcionais que podem ser instaladas/removidas sem afetar o core.

```
                       HARNESS
                          │
          ┌───────────────┴───────────────┐
          │                               │
        CORE                         EXTENSIONS
          │                               │
    Orchestrator + Personas         Experimentos
    (Developer/TechLead/PM)         opcionais
    Project Context                       │
          │                       ┌───────┼───────┐
          │                       │       │       │
          │                   Ponytail Caveman  LGPD
          │
          └──────── sempre estável ───────┘
```


## Princípios de design

- Apenas `steering/core.md` é `always`.
- Steering de persona e de projeto usam inclusão `auto`.
- A orquestração é feita pelo `orchestrator`, que carrega **somente** `core.md` — não referencia `skill://.kiro/skills/**` nem todas as personas.
- Agentes customizados usam **JSON** (mesmos campos do Markdown; melhor para configuração programática, suportado no IDE e no CLI).
- Skills permanecem filhas diretas de `.kiro/skills/` com prefixos de persona (`dev-`, `tl-`, `pm-`, `shared-`), para que descoberta e slash-commands não dependam de diretórios de categoria.
- Material detalhado fica em `DETAILS.md` e em `references/`, carregado sob demanda.
- Sub-agentes são usados para trabalho amplo/independente, não para edições triviais.
- Agentes especialistas retornam relatórios compactos para evitar crescimento de contexto.
- Sem SessionStart hook.


## Personas

| Persona | Quando usar |
|---|---|
| **Developer** | Implementação, debugging, testes, refatoração, performance, publicação |
| **Tech Lead** | Arquitetura, trade-offs, ADRs, dívida técnica, roadmap técnico, risco de engenharia |
| **Project Manager** | Roadmap, marcos, escopo, estimativas, riscos, dependências, impedimentos, status de entrega |
| **Cross-functional** | O `orchestrator` combina a menor combinação útil de personas quando a demanda exige múltiplas perspectivas |

Os agentes ficam em `agents/`:

```text
agents/
  orchestrator.json          # entrada de coordenação (carrega só core.md)
  developer/                  # developer + code-reviewer, context-gatherer,
                              #   general-task-execution, security-auditor,
                              #   test-engineer, web-performance-auditor
  techlead/                   # techlead + adr-reviewer, architecture-reviewer,
                              #   dependency-auditor, technical-planner
  project-manager/            # project-manager + delivery-planner,
                              #   estimation-analyst, risk-analyst, roadmap-manager
```


## Fluxo de trabalho

A intenção escrita no chat é mapeada para o workflow correto — não é necessário decorar comandos. Os workflows ficam em `steering/comandos/`. O acionamento explícito por `#<nome>` funciona como atalho.

| Intenção | Workflow |
|---|---|
| Definir o que construir | `spec` |
| Quebrar em tarefas | `planning` |
| Implementar | `build` |
| Testar / corrigir bug | `test` |
| Definir a barra de qualidade | `constraints` |
| Revisar antes do merge | `review` |
| Simplificar / refatorar sem mudar comportamento | `code-simplify` |
| Auditar performance web | `webperf` |
| Pré-lançamento (decisão go/no-go) | `ship` |

### Spec → Plan → Build → Verify → Review → Ship

- **Spec:** gera `SPEC.md` com objetivo, comandos, estrutura do projeto, estilo de código, estratégia de testes e fronteiras.
- **Planning:** modo somente leitura, fatiamento vertical (um caminho completo por tarefa, não camadas horizontais), com critérios de aceitação e passos de verificação — salvo em `tasks/plan.md` e `tasks/todo.md`.
- **Build:** implementação incremental, uma fatia por vez. O modo `build auto` executa o plano inteiro com uma única aprovação humana (checkpoint único), sem parar entre tarefas.

### TDD: RED → GREEN → refatora

Todo build segue o loop:

1. Escreve o teste que falha para o comportamento esperado (RED)
2. Implementa o código mínimo para passar (GREEN)
3. Roda a suíte completa (checagem de regressão)
4. Roda o build para verificar a compilação
5. Faz commit com mensagem descritiva
6. Marca a tarefa como concluída e para

Correção de bug segue o padrão **Prove-It**: escreve primeiro um teste que reproduz o bug (deve falhar), confirma a falha, implementa a correção e confirma que passa.

### Qualidade e ship

- Cada tarefa só fecha com teste passando + build compilando + commit próprio.
- Stage apenas dos arquivos que a tarefa tocou — sem `git add -A` cego.
- Review em 5 eixos: correção, legibilidade, arquitetura, segurança e performance. Achados categorizados como Crítico, Importante ou Sugestão, com referências `arquivo:linha`.
- O `ship` só dá GO com plano de rollback obrigatório.


## Orquestração agent-first

O fluxo de coordenação é:

```
core (always) → orchestrator → persona → specialist (quando necessário)
```

O `orchestrator` segue uma escada de decisão:

1. Resolve diretamente quando a tarefa é pequena, delimitada, já compreendida ou não precisa de isolamento.
2. Delega a **uma** persona quando a tarefa exige a perspectiva de Developer, Tech Lead ou Project Manager.
3. Delega a um especialista quando a tarefa precisa de investigação ou verificação focada.
4. Usa especialistas em paralelo apenas quando o trabalho é genuinamente independente.
5. Compõe personas somente para trabalho cross-functional — nunca carrega todas as personas para tarefas comuns.

Regra: **agent-first, delegation-last**. Não delegar apenas para seguir um workflow; manter a profundidade de delegação rasa (normalmente um salto do orchestrator para persona/especialista).


## Isolamento de contexto

Toda exploração de código e leitura ampla é delegada a sub-agentes (`context-gatherer`, `general-task-execution`). A sessão principal recebe apenas o resultado final, nunca o contexto intermediário — isso mantém o histórico enxuto e reduz consumo de tokens.

As personas especialistas (`code-reviewer`, `security-auditor`, `test-engineer`, `web-performance-auditor`) também rodam como sub-agentes isolados. No `ship`, as três principais rodam em paralelo e a sessão principal funde os relatórios em uma decisão go/no-go.

> Sub-agentes só funcionam em **Autopilot mode**. Em Supervised eles não rodam.


## Contexto de projeto

Steerings de projeto ficam em `steering/project-<nome>.md` e usam `inclusion: auto`. Eles carregam contexto específico do projeto (stack, regras de domínio, referências a artefatos) sem poluir sessões de outros projetos. O projeto empacotado nesta versão é o **AI Observability Hub** (`steering/project-ai-observability-hub.md`).

O contexto de projeto evita assumir a stack tecnológica: detalhes reais de produto/tecnologia/estrutura devem ser adicionados conforme o repositório os estabelece.


## Extensões opcionais

O harness possui um registry de extensões para experimentar técnicas de economia de tokens sem alterar o harness principal:

```text
.kiro/extensions/token-economy/
```

### Extensões disponíveis

- **`ponytail`** — minimização comportamental para implementação; insere uma regra no `steering/core.md` dentro de um bloco gerenciado por marcadores.
- **`caveman`** — Skill opcional para respostas mais concisas; não comprime o contexto enviado ao provedor.
- **`lgpd-technical-audit`** — auditoria técnica LGPD via agente JSON dedicado.

As extensões são opcionais e devem ser testadas isoladamente antes de mantidas. Cada extensão remove apenas os artefatos que controla; o uninstall não restaura backups antigos de forma cega nem sobrescreve alterações posteriores do usuário.

### Instalar e remover

> Os comandos são genéricos. Passe somente o nome do pacote.

```bash
./.kiro/extensions/token-economy/bin/install.sh <extensao>
./.kiro/extensions/token-economy/bin/uninstall.sh <extensao>
```

Exemplo:

```bash
./.kiro/extensions/token-economy/bin/install.sh ponytail
./.kiro/extensions/token-economy/bin/uninstall.sh ponytail
```

### Verificar status

```bash
./.kiro/extensions/token-economy/bin/status.sh          # todas
./.kiro/extensions/token-economy/bin/status.sh ponytail # uma específica
```

Não existe uma lista de extensões embutida nos dispatchers. Para criar uma nova extensão, crie seu próprio diretório com `install.sh` e `uninstall.sh` e consulte `.kiro/extensions/token-economy/CREATING-EXTENSIONS.md`.


## Desativar herança de recursos (Kiro CLI)

Para reduzir a herança automática de steering, skills e `AGENTS.md` pelos agentes customizados:

```bash
kiro-cli settings --workspace chat.disableInheritingDefaultResources true
```


## Teste A/B

1. Faça backup do `.kiro` atual.
2. Instale o harness em uma branch limpa.
3. Abra uma sessão nova no Kiro e observe o contexto carregado no painel de steering (no Kiro CLI, use `/context show`).
4. Teste uma tarefa de developer, uma de arquitetura e uma de roadmap.
5. Compare: steering carregado, skills ativadas, arquivos lidos, número de delegações, tool calls, latência, tokens de entrada/saída e retrabalho.

O objetivo não é minimizar arquivos em disco; é minimizar **contexto irrelevante por tarefa** preservando capacidade especializada.

> Este harness otimiza o carregamento de contexto; não garante um custo fixo de tokens, porque o comportamento do modelo/ferramentas, a complexidade da tarefa e o próprio gerenciamento de contexto do Kiro afetam o consumo.
