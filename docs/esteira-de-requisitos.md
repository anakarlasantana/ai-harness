# Esteira de requisitos: spec → aprovação → código

A aplicação publica o requisito; o harness conduz a **pausa** que autoriza o
código. Nada aqui decide *o que* construir — decide *quando* construir.

## 1. Os artefatos (do alvo, em `spec/`)

```
spec/<ID>-<slug>/
├── requisito.md   # frontmatter flat + História, Regras, CA-n (com `prova:`), Não-objetivos
├── desenho.md     # arquivos, contratos, fronteira, riscos
└── tarefas.md     # T-n · escopo · fronteira · cobre · wave
```

`CA-n` + `prova:` é o elo com o teste: `unit:<arquivo>`, `jornada:<nome>@<passo>`
ou `api:<nome>` (fase E). O índice de requisitos e o rastreio são **derivados**
(`gen-requisitos` / `gen-rastreio` no alvo), com `--check` no gate do repo.

## 2. Os comandos

```bash
ai spec new <ID> "<título>"   # abre rascunho
ai spec review <ID>           # laudo de lacunas (advisory)
ai spec approve <ID>          # PAUSA e registra a aprovação
ai spec list                  # id, estado, pasta
```

## 3. O gate (uma decisão por feature)

`approve` mostra o veredito do DoR e para:

```
── RV-042 · Captura do pagamento e reserva de estoque
   5 critério(s) (teto 10) · estado rascunho · sha 3f9c8a1d
  ! CA-3: texto sem condição explícita (EARS recomendado) — aceito como texto-livre
  ok pode aprovar

[a] aprovar   [e] editar   [r] rejeitar   [s] sair
```

| Tecla | Efeito |
| :--- | :--- |
| `a` | grava `aprovado_por/conta/em/sha`, `avisos_aceitos`, `aprovado_terminal` |
| `e` | sai com código 3, nada gravado |
| `r` | pede motivo, grava `estado: rejeitado` |
| `s` | nada |

**Bloqueio não oferece `[a]`**: se houver qualquer ✗ no DoR, nada é aprovado.

## 4. DoR (o que a máquina confere)

1. todo `CA-n` tem `prova:`; 2. nível válido; 3. prova existe (arquivo,
jornada/passo); 4. ids únicos; 5. **≤10 critérios** (acima: divida a feature);
6. avisos: texto sem EARS, critério longo, seção ausente.

## 5. Guardas (o agente não assina)

| Guarda | Por quê |
| :--- | :--- |
| `stdin` é TTY | agente/CI roda com pipe |
| sem `HARNESS_AGENT`, `CLINE_*`, `CI` | é assim que o ambiente se denuncia |
| `--por` grava `aprovado_terminal: false` | aprovação declarada é visível como tal |

Identidade: `git config user.name` / `user.email` + usuário/host do SO.

## 6. Hash: o critério aprovado é o critério usado

`aprovado_sha` = sha256 de `CA-n|texto|prova` (normalização **idêntica** à do
`gen-rastreio` do alvo). Editar qualquer critério depois da aprovação:

- `ai spec review` avisa: *critérios mudaram depois da aprovação (sha A → B)*;
- `make check` do alvo reprova (`gen-rastreio --check`).

Re-aprovar é uma decisão consciente, nunca um efeito colateral.

## 6.1 O segundo gate (G2) — só quando há risco

`ai plan create` escreve `desenho.md` e `tarefas.md` (uma tarefa por critério,
como ponto de partida). `ai plan verify` confere: CA órfão, tarefa sem escopo/
fronteira, `fronteira: teste` tocando produto (e vice-versa), dependência em wave
igual ou posterior.

`ai plan approve` **dispensa o G2** quando o plano tem ≤3 tarefas e não toca
`packages/contrato` nem migration — e nesse caso grava `plano_aprovado_por:
dispensado`. Com risco, abre a mesma pausa do G1 e grava `plano_sha` (editar o
plano depois invalida).

## 7. Limites

- O harness **não escreve** requisito nem código: ele lê, mede e registra.
- Bugfix não passa por aqui: o `RW-*.md` + `ai fix` já são a decisão humana.
- Juiz de LLM não aprova nada — só o humano no terminal.
