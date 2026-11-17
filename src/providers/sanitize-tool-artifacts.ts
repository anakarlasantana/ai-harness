/**
 * Limpeza de artefatos de tool-calling vazados em texto puro.
 *
 * Alguns modelos (DeepSeek v4 em particular) emitem a sintaxe INTERNA de
 * chamada de funcao dentro do `content` quando nao recebem o campo `tools`:
 *
 *   <|DSML|tool_calls>
 *   <|DSML|invoke name="bash">
 *   <|DSML|parameter name="command" string="true">ls</|DSML|parameter>
 *   </|DSML|invoke>
 *   </|DSML|tool_calls>
 *
 * Isso nao e texto que o usuario deve ver: contamina o trace, o
 * `architectureDecision` e a resposta final. Removemos o bloco inteiro.
 */

/** Marcador do DeepSeek (pode vir com pipe unicode ou ASCII). */
const DSML_OPEN = /<\s*[|｜]{1,2}\s*DSML\s*[|｜]{1,2}/;

/** Padroes de bloco completo, removidos por inteiro. */
const BLOCK_PATTERNS: RegExp[] = [
  // <|DSML|tool_calls> ... </|DSML|tool_calls>  (com qualquer variacao de pipe)
  /<\s*[|｜]{1,2}\s*DSML\s*[|｜]{1,2}[\s\S]*?<\s*\/\s*[|｜]{1,2}\s*DSML\s*[|｜]{1,2}[\s\S]*?>/g,
  // Bloco DSML sem fechamento (modelo truncou no meio)
  /<\s*[|｜]{1,2}\s*DSML\s*[|｜]{1,2}[\s\S]*$/g,
  // <invoke ...> ... </invoke>
  /<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi,
  // <function_call> ... </function_call>
  /<function_call\b[^>]*>[\s\S]*?<\/function_call>/gi,
  // <tool_call> ... </tool_call>
  /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi,
];

/** Cercas de codigo que contem apenas uma chamada de funcao serializada. */
const FENCED_CALL = /```(?:tool_call|tool_calls|function_call|json)?\s*\{\s*"(?:tool_calls|function|name)"[\s\S]*?```/gi;

/**
 * Remove artefatos de tool calling do texto do modelo.
 * Texto normal passa intacto (funcao idempotente e barata).
 */
export function stripToolArtifacts(input: string): string {
  if (!input) return input;

  // Atalho: nada a fazer na esmagadora maioria dos casos.
  if (!DSML_OPEN.test(input) && !/<invoke\b|<function_call\b|<tool_call\b|```tool_call/i.test(input)) {
    return input;
  }

  let out = input;
  for (const re of BLOCK_PATTERNS) out = out.replace(re, '');
  out = out.replace(FENCED_CALL, '');

  // Colapsa linhas em branco deixadas pela remocao.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Verdadeiro quando o texto contem algum artefato (util em testes/trace). */
export function hasToolArtifacts(input: string): boolean {
  return stripToolArtifacts(input) !== input;
}
