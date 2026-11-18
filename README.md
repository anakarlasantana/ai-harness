# ai-harness

Harness **multi-agente universal** em TypeScript/Node: automatiza a esteira de
desenvolvimento ponta a ponta (`plan → code → qa → rework → sync`) aplicando
**contexto mínimo** e economia obsessiva de tokens (inspirado no Kiro V5 /
Ponytail), com **loop ReAct autônomo + MCPs** e **dashboard visual local**.

## Instalação

```bash
cd ai-harness
npm install
npm run build
npm link          # expõe o binário global "ai"
```

## Uso (na raiz do SEU repositório)

```bash
ai spec   new|review|approve|list   # levantar e aprovar a spec (gate humano)
ai plan   create <specId>      # desenho + tarefas (waves)     [fase D]
ai build  code <taskId> "<instrução>" --spec <ID>  # implementação (exige G1; G2 se houver risco)
ai build  review|simplify|ship|design|webperf|debug <taskId>
ai verify ready|api            # prontidão e persona de API declaradas pelo alvo
ai verify e2e [--journey nome] # jornadas ponta-a-ponta + digest
ai fix    <rwId> [--verificar] # conduz um rework (fronteira, branch, veredito)
ai ops    dashboard|doctor|models|index
```

A superfície é a de [docs/glossario.md](docs/glossario.md) — fonte única; `npm run
check:cli` reprova quando o CLI e o glossário divergem. Os nomes antigos
(`ai code`, `ai qa`, `ai e2e`, `ai doctor`, …) continuam funcionando, escondidos e
com aviso de depreciação.

Flags comuns: `--provider kiro|openai|claude` · `--templates <path>` ·
`--dry-run` · `--json` · `--max-iterations <n>` · `--mcp-from-kiro`.

Diagnóstico: `ai ops doctor [--probe]` · `ai ops models`.

## Qualidade do proprio harness

```bash
npm run check   # build + typecheck + paridade CLI x docs/glossario.md
```

O hook de commit roda o mesmo comando. Instale uma vez:

```bash
git config core.hooksPath .githooks
```

A superficie do CLI e' a de [docs/glossario.md](docs/glossario.md) — comando
visivel que nao esteja la (ou o contrario) reprova o check.

## Provedores

O harness separa **wire format** (como falar) de **endpoint** (com quem falar).
Só o wire format vem do app; endpoint e credencial são genéricos.

| Wire format | Transporte | Credencial |
|---|---|---|
| **openai** | `chat/completions` — serve OpenAI, Groq, DeepSeek, OpenRouter, Together, Mistral, Cerebras, Ollama `/v1` | `HARNESS_API_KEY` (dispensável em Ollama) |
| **claude** | Messages API (`x-api-key`) | `HARNESS_API_KEY` ou `ANTHROPIC_API_KEY` |
| **kiro** | CLI local (`kiro-cli-chat`) herdando SSO | **nenhuma** |

Trocar de provedor = trocar 3 linhas no `.env`:

```bash
HARNESS_BASE_URL=https://api.deepseek.com
HARNESS_API_KEY=sk-...
HARNESS_MODEL=deepseek-chat
```

Infraestrutura de endpoint:

- `/v1` é anexado quando ausente e um sufixo `/v1/chat/completions` colado é
  removido (`src/providers/url.ts`).
- Nomes de modelo são qualificados por vendor conforme o endpoint
  (`qwen3-32b` → `qwen/qwen3-32b` só no Groq/OpenRouter) — `src/providers/modelSlug.ts`.
- Erros de transporte (ex.: `Premature close`) e `429` têm retry com backoff;
  `401/402/404` falham na hora com mensagem acionável —
  `src/providers/RetryPolicy.ts`.
- `HARNESS_MODEL_FALLBACKS` define modelos de reserva: o orquestrador troca de
  modelo em vez de abortar a task.

Precedência do wire format: `--provider` > `.harness/context.json` >
`HARNESS_PROVIDER` (`auto` = inferir do endpoint) > `kiro`.

Precedência do endpoint: `HARNESS_BASE_URL`/`HARNESS_API_KEY`/`HARNESS_MODEL` >
`OPENAI_*` > `ANTHROPIC_*` > `KIRO_*`.

Fluxo projetado: não há nada específico de uma aplicação no harness. O que muda por
app é o **contexto** que ele publica (`.harness/`) — contrato em
[docs/verificacao-e-testes.md](docs/verificacao-e-testes.md), a esteira de
requisitos em [docs/esteira-de-requisitos.md](docs/esteira-de-requisitos.md) e a
correção em [docs/fluxo-de-rework.md](docs/fluxo-de-rework.md).

## Pasta de Contexto Local (`.harness/`)

Coloque na raiz do seu repositório:

```
.harness/
├── context.json        # provider, regras, comandos, MCP, verificação (e2e)
├── instructions.md     # guias de estilo — anexados ao System Prompt
├── tasks/<id>.json     # memória episódica (gerada automaticamente)
└── tests/<runId>/      # digest de cada execução de `ai verify e2e` (gerado)
```

Veja `.harness/context.json.example` e `.harness/instructions.md.example`. Se não
houver `instructions.md`, o harness usa o **`AGENTS.md`** da raiz (padrão
cross-tool) — uma regra, um arquivo.

## Contexto mínimo

- `steering/core.md` (regra do Ponytail) é **sempre** carregado.
- O restante entra **sob demanda por stage** (persona + skills específicas).
- Templates embarcados em `templates/kiro-v5/` (pode sobrescrever via
  `--templates` ou `KIRO_TEMPLATES_PATH`).

## Loop ReAct + MCP

O orquestrador sobe os servidores MCP do app, expõe suas ferramentas ao modelo,
intercepta *tool calls*, executa-as localmente e realimenta o modelo — até 8
iterações por tarefa (configurável). Subprocessos MCP são encerrados de forma
**antizumbi** (SIGTERM→SIGKILL síncronos) ao final.

## Robustez

- Escrita da memória **atômica e serializada** (fila por task) — sem corrupção.
- Clip inteligente de erros (primeiras 50 + últimas 100 linhas).
- Execução de comandos sem shell + whitelist + timeout.

## Dashboard

`ai ops dashboard` sobe `http://127.0.0.1:3000` com timeline, árvore de transição de
personas, log de pensamento da IA **e o painel "Testes das aplicações"**:
cada execução de `ai verify e2e` / `ai verify ready` aparece com status, duração,
passos (chips), 5xx, erros de console e o caminho do digest — ao vivo, porque o
CLI grava na memória da task a cada passo (auto-refresh 3s, Tailwind via CDN).
API: `GET /api/traces`, `GET /api/tests`, `GET /api/traces/:id`.
