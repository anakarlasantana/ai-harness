# Fluxo de rework: do relato ao patch verificado

O `ai e2e` produz o achado; este fluxo o leva até um patch **verificado**, sem
que o agente que corrige seja o mesmo que julga — e sem que ele conserte as
próprias regras.

## 1. O registro (do alvo, formato do harness)

Onde ele mora é decisão do app: `.harness/context.json` → `rework.dir`
(ex.: `docs/real-valor/laudos/reworks`). Um arquivo por achado (`RW-AAAA-NNN.md`),
com frontmatter YAML (contrato em `src/engine/rework/ReworkRecord.ts`) e corpo
**append-only**.

Máquina de estados:

```
relatado → triado → aplicado → verificado → fechado
                 ↘ bloqueado (3 tentativas)   ↘ descartado (não era código)
```

## 2. Os dois comandos

```bash
ai fix RW-2026-007              # triagem: fronteira, branch, dossiê
ai fix RW-2026-007 --verificar  # gates + fronteira do patch + veredito no registro
```

| Etapa | O que o harness faz | O que ele **não** faz |
| :--- | :--- | :--- |
| triagem | valida a classificação, exige árvore limpa, abre `fix/<id>-<slug>`, escreve o dossiê, marca `triado` | editar código |
| verificação | confere o que o patch tocou, roda a prontidão e a jornada declaradas, grava gates e veredito | commitar, abrir PR, dar merge |

Quem escreve o código é o agente de edição (Cline), com aprovação humana. O
harness é a régua — e é o que impede "consertar o teste para o bug sumir".

## 3. Fronteira por classificação

| classificação | pode tocar | bloqueia |
| :--- | :--- | :--- |
| `teste` | `e2e/**`, `__tests__/**`, `*.spec.*`, `*.test.*` | qualquer arquivo de produto |
| `produto` | `backend/`, `frontend/`, `admin/`, `packages/`, `scripts/`, `docs/` | `e2e/**` |
| `ambiente` / `dado` / `indefinido` | nada (não é correção de código) | tudo — exige `--forcar` |

Sempre bloqueado, em qualquer classificação: `AGENTS.md`, `.clinerules/**`,
`.harness/context.json`. **Regra que o agente edita não é regra.**

Artefatos do próprio harness (`.harness/**`, `evidence/**`, `.run/**`) e o
registro de rework não contam como patch.

## 4. O dossiê (contexto mínimo para corrigir)

`.harness/rework/<id>/dossie.md`, ≤ 60 linhas: sintoma, causa provável,
evidências, **fronteira**, critério de aceite, comandos de verificação e o
próximo passo. É o que evita o agente reler o repositório.

## 5. Veredito

`--verificar` grava no registro:

```yaml
gates: { ready: pronto, e2e: verde }
tentativas: 1
estado: verificado
```

e anexa uma seção `## Veredito (harness) — tentativa N` com os comandos, o
tempo e o resultado. Não fecha: com 3 tentativas sem sucesso, vira `bloqueado`
(escala para humano).

## 6. Limites declarados

- **Sem auto-merge** e sem commit automático: o PR é seu.
- **Sem `--no-verify`** e sem editar as regras do próprio alvo.
- O harness **não escreve código**: ele conduz, mede e registra.
