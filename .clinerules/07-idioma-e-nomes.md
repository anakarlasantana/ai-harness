---
paths:
  - "src/**"
  - "scripts/**"
---
# Idioma e nomenclatura

Aplicam-se a **todo código** deste repositório (o harness é genérico: quem lê é
outra pessoa, em outro sistema).

## Idioma

- Código em **inglês**: arquivo, tipo, função, variável, flag, chave de contrato.
- **pt-BR**: comentários, mensagens de CLI, logs, documentação.
- Exemplo do que é certo: `SpecReadiness.ts` / `evaluateSpecReadiness` com
  comentário em português.
- Errado: `Dor.ts`, `Prova.ts`, `avaliarDor`, `escopo`. Nome em português no
  código é erro de revisão, não preferência.

## Nomenclatura

| Regra | Certo | Errado |
| :--- | :--- | :--- |
| nome diz o que o arquivo **é/faz** | `ProofResolver`, `PatchScope` | `Utils`, `Helpers`, `Prova` |
| um conceito por arquivo | `SpecDocument` + `SpecReadiness` | `SpecStuff` |
| PascalCase para tipo/classe | `HumanApproval.ts` | `humanApproval.ts` |
| kebab-case para módulo | `model-slug.ts`, `check-file-names.mjs` | `modelSlug.ts` |
| plural no CLI que registra vários | `spec-commands.ts` | `spec-command.ts` |
| sigla só se universal | `E2E`, `CLI`, `HTTP` | `DoR`, `DTC` |

O gate é `scripts/check-file-names.mjs` no `npm run check`: reprova nome fora de
PascalCase/kebab-case e palavra em português no nome do arquivo.

## Nomes de função

Verbo + objeto, em inglês: `evaluateSpecReadiness`, `checkCodeGates`,
`resolveProof`, `parseTaskPlan`, `applyApproval`, `findScopeViolations`.
Se o nome precisa de comentário para ser entendido, troque o nome.
