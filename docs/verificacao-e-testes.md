# Verificação: prontidão e ponta-a-ponta

O harness **não conhece** a stack de nenhuma aplicação. Ele executa o que o alvo
declara, digere o resultado e registra a execução. É o que permite o mesmo
`ai verify e2e` servir para apps diferentes sem uma linha de código nova aqui.

## 1. O que a aplicação declara (`.harness/context.json`)

```jsonc
{
  "verification": {
    // O "definition of done" do repositório em UM comando.
    "readiness": { "command": "make ready", "timeoutMs": 300000 }
  },
  "e2e": {
    "before":  ["make e2e-up"],           // prepara (stack, seed, fixtures)
    "command": "make e2e",                // roda as jornadas e escreve evidência
    "after":   ["make e2e-down"],         // roda SEMPRE (finally)
    "journey": { "cliente": "make e2e-cliente" },
    "timeoutMs": 900000,
    "evidenceDir": "evidence",            // onde o alvo grava os artefatos
    "digest": "resumo.md",                // resumo legível do alvo
    "logs": [
      { "name": "backend",  "command": "docker compose -p app_e2e logs --since {since} backend" }
    ],
    "allowlist": [{ "status": 404, "path": "/store/locales" }]
  }
}
```

`{since}` é substituído pelo início da execução. Tudo é comando declarado — o
harness nunca adivinha stack, container ou porta.

## 2. Os dois comandos

| Comando | O que roda | Quando usar |
| :--- | :--- | :--- |
| `ai verify ready` | `verification.readiness.command` | antes de commitar (o gate do repo) |
| `ai verify e2e [--journey nome]` | `before → command → logs → after` | jornada de ponta-a-ponta |
| `ai verify e2e --keep` | mantém a stack de pé (não roda `after`) | investigar depois da falha |
| `ai verify e2e --skip-before` | pula o preparo | **só** com a stack já aquecida |

Ordem dentro da jornada: `before` → jornada → **logs** → `after`. Os logs são
lidos **antes** da limpeza de propósito: `after` costuma ser `compose down`, que
remove o container — e o log com ele. Os passos aparecem no digest na ordem em
que rodaram *e* a seção `## logs` traz o que interessa de cada serviço.

`ai qa` também passa a preferir `verification.readiness` sobre a detecção de
stack: um "pronto" no repo, um comando.

## 3. Saída (o contrato que o agente lê)

```
e2e · cliente · minha-app   PASSOU  (46,2s)
  4 passo(s) · 5xx 0 · console 0 · task e2e-cliente-202611172001
  digest: .harness/tests/2026-11-17T20-01-16-915Z/digest.md
```

O **digest** tem teto de 60 linhas: passos, fatos (5xx, console), allowlist,
últimas linhas de log por serviço e onde olhar. É o que substitui mandar trace
bruto para o modelo.

## 4. Observabilidade

- `.harness/tasks/<id>.json` → `testRuns[]`: cada execução com passos,
  duração, fatos, `evidenceDir` e `digestPath`.
- `.harness/tests/<runId>/digest.md`: o resumo da execução.
- **Dashboard** (`ai dashboard`): painel "Testes das aplicações" com status,
  chips por passo, 5xx/console e digest. O CLI grava a cada passo, então a
  execução aparece **em andamento**, não só o resultado.
- API: `GET /api/tests` (todas as execuções), `GET /api/traces` (tasks).

## 5. Onboarding de um alvo novo (4 itens, ~30 min)

1. `AGENTS.md` na raiz (regras e limites; o harness lê como instruções).
2. `.harness/context.json` com `verification.readiness` e/ou `e2e`.
3. O comando de prontidão tem de existir no repositório (`make ready`,
   `npm run lint && npx jest`, `./tests/e2e/run.sh`…).
4. A raiz do alvo é onde o CLI roda (`package.json` + `.git`).

Sem cadastro no harness: o contrato é declarativo por desenho.

## 6. Limites (declarados)

- **Sem auto-merge**: o `ai verify e2e` para no veredito; merge é decisão humana.
- **Sem corrigir o alvo**: quem conserta é `ai rework`, com o digest na mão.
- **Sem esconder falha**: `--skip-before` é diagnóstico, não caminho feliz —
  sem o preparo, o alvo pode falhar por ambiente e o digest diz isso.
