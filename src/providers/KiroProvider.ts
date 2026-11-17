import { spawnSync } from 'node:child_process';
import type { AppEnv } from '../config/env.js';
import { log } from '../core/logger.js';
import { stripAnsi } from '../core/tokens.js';
import type {
  ChatMessage,
  CompletionOptions,
  LLMProvider,
  ProviderResponse,
  ToolCall,
  ToolDefinition,
} from './LLMProvider.js';

/**
 * Kiro provider.
 *
 * PRIMARY strategy — reuse the local Kiro CLI session via SSO:
 *   The enterprise Kiro install is authenticated with IAM Identity Center.
 *   Running the local CLI binary inherits that session automatically, so no
 *   API key is ever needed. We dispatch the prompt synchronously with
 *   `spawnSync` and parse the answer out of stdout.
 *
 * FALLBACK strategy — generic HTTP gateway:
 *   Used ONLY when the local binary is not found on PATH. Requires
 *   KIRO_GATEWAY_URL (+ optional KIRO_SESSION_TOKEN).
 *
 * Tool-calling: because the CLI is a plain text interface, tools are
 * advertised as a strict text protocol and the model is asked to answer with
 * a single JSON object `{"tool_calls":[...]}` to request a call. This is parsed
 * back into normalized ToolCalls. The translation stays inside this class.
 */

const CANDIDATE_BINARIES = ['kiro-cli-chat', 'kiro-cli', 'kiro'];

function whichSync(bin: string): string | null {
  // Avoid shell:true (DEP0190 / injection). `sh -c` with a fixed script is safe
  // because `bin` is validated against a fixed candidate list by the caller.
  const res = spawnSync('/bin/sh', ['-c', `command -v ${shellQuote(bin)}`], {
    encoding: 'utf8',
  });
  if (res.status === 0) {
    const out = (res.stdout || '').trim();
    if (out) return out;
  }
  return null;
}

/** Minimal single-quote shell escaping for the trusted candidate binaries. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class KiroProvider implements LLMProvider {
  readonly name = 'kiro';
  private readonly binPath: string | null;
  private readonly gatewayUrl?: string;
  private readonly sessionToken?: string;

  constructor(env: AppEnv) {
    const explicit = env.KIRO_CLI_BIN?.trim();
    const candidates = explicit ? [explicit, ...CANDIDATE_BINARIES] : CANDIDATE_BINARIES;

    let found: string | null = null;
    for (const bin of candidates) {
      const resolved = whichSync(bin);
      if (resolved) {
        found = resolved;
        break;
      }
    }
    this.binPath = found;
    this.gatewayUrl = env.KIRO_GATEWAY_URL;
    this.sessionToken = env.KIRO_SESSION_TOKEN;

    if (this.binPath) {
      log.debug(`KiroProvider: usando CLI local "${this.binPath}" (sessão SSO herdada).`);
    } else if (this.gatewayUrl) {
      log.warn('KiroProvider: CLI local não encontrado; usando fallback HTTP.');
    } else {
      log.warn('KiroProvider: nem CLI local nem KIRO_GATEWAY_URL disponíveis.');
    }
  }

  async completion(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<ProviderResponse> {
    const prompt = this.buildPrompt(messages, options);

    if (this.binPath) {
      return this.completionViaCli(prompt, options);
    }
    if (this.gatewayUrl) {
      return this.completionViaHttp(messages, options);
    }
    throw new Error(
      'KiroProvider indisponível: instale o Kiro CLI ou defina KIRO_GATEWAY_URL.',
    );
  }

  // ── Prompt assembly ────────────────────────────────────────────────────────

  private buildPrompt(messages: ChatMessage[], options?: CompletionOptions): string {
    const parts: string[] = [];

    if (options?.tools && options.tools.length > 0) {
      parts.push(this.renderToolProtocol(options.tools));
    }

    for (const m of messages) {
      switch (m.role) {
        case 'system':
          parts.push(`### SYSTEM\n${m.content}`);
          break;
        case 'user':
          parts.push(`### USER\n${m.content}`);
          break;
        case 'assistant':
          parts.push(`### ASSISTANT\n${m.content}`);
          break;
        case 'tool':
          parts.push(
            `### TOOL RESULT (${m.name ?? m.toolCallId ?? 'tool'})\n${m.content}`,
          );
          break;
      }
    }

    parts.push(
      '### INSTRUCTION\nResponda no formato exigido acima. Se não precisar de ferramentas, responda com o texto final.',
    );
    return parts.join('\n\n');
  }

  private renderToolProtocol(tools: ToolDefinition[]): string {
    const catalog = tools
      .map((t) => {
        const schema = JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} });
        return `- ${t.server}.${t.name}: ${t.description} | inputSchema=${schema}`;
      })
      .join('\n');

    return [
      '### TOOLS',
      'Você pode chamar ferramentas locais. Catálogo (nome = servidor.ferramenta):',
      catalog,
      '',
      'Para solicitar UMA OU MAIS chamadas, responda APENAS com JSON:',
      '{"tool_calls":[{"name":"<servidor>.<ferramenta>","arguments":{ ... }}]}',
      'Caso contrário, responda normalmente com o texto final.',
    ].join('\n');
  }

  // ── CLI execution (primary) ─────────────────────────────────────────────────

  private completionViaCli(prompt: string, options?: CompletionOptions): ProviderResponse {
    const bin = this.binPath as string;
    const args = ['chat', '--no-interactive', '-w', 'never'];
    if (options?.model) args.push('--model', options.model);
    args.push(prompt);

    log.debug(
      `KiroProvider: spawnSync ${bin}${options?.model ? ` --model ${options.model}` : ''} (prompt ${prompt.length} chars).`,
    );
    const res = spawnSync(bin, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      env: { ...process.env },
    });

    if (res.error) {
      throw new Error(`KiroProvider CLI falhou ao executar: ${res.error.message}`);
    }

    const raw = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    const cleaned = cleanKiroOutput(raw);

    if (res.status !== 0 && cleaned.trim() === '') {
      throw new Error(`KiroProvider CLI saiu com código ${res.status} e sem saída.`);
    }

    return this.parseModelOutput(cleaned, options);
  }

  // ── HTTP execution (fallback) ───────────────────────────────────────────────

  private async completionViaHttp(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<ProviderResponse> {
    const url = this.gatewayUrl as string;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.sessionToken) headers.Authorization = `Bearer ${this.sessionToken}`;

    const body = JSON.stringify({
      model: 'kiro',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: options?.tools ?? undefined,
      system: options?.systemPrompt,
    });

    let resp: Response;
    try {
      resp = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      throw new Error(`KiroProvider HTTP falhou: ${(err as Error).message}`);
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`KiroProvider HTTP ${resp.status}: ${txt.slice(0, 500)}`);
    }

    const data = (await resp.json()) as {
      content?: string;
      tool_calls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
    };

    if (data.tool_calls && data.tool_calls.length > 0) {
      return {
        type: 'tool_calls',
        toolCalls: data.tool_calls.map((tc, i) => ({
          id: tc.id ?? `kiro_http_${Date.now()}_${i}`,
          name: tc.name,
          arguments: tc.arguments ?? {},
        })),
        raw: data,
      };
    }
    return this.parseModelOutput(data.content ?? '', options);
  }

  // ── Output parsing ──────────────────────────────────────────────────────────

  private parseModelOutput(text: string, options?: CompletionOptions): ProviderResponse {
    const trimmed = text.trim();
    const toolsAvailable = (options?.tools?.length ?? 0) > 0;

    if (toolsAvailable) {
      const call = tryParseToolCallJson(trimmed);
      if (call) return { type: 'tool_calls', toolCalls: call, raw: text };
    }

    return { type: 'text', text: trimmed, raw: text };
  }
}

/**
 * Extract the actual assistant answer from raw Kiro CLI output, stripping:
 *  - ANSI escapes
 *  - MCP loading banners ("Not all mcp servers loaded", "------" fences)
 *  - the echoed prompt line ("› ..." / "> ...")
 *  - the credits footer ("Credits: 0.10 • Time: 1s")
 */
export function cleanKiroOutput(raw: string): string {
  const out = stripAnsi(raw);
  const lines = out.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    let t = line.trim();

    if (/Not all mcp servers loaded/i.test(t)) continue;
    if (/mcp server did not load/i.test(t)) continue;
    if (/kiro-chat\.log/i.test(t)) continue;
    if (/^WARNING:/i.test(t)) continue;
    if (/trust-tools/i.test(t)) continue;
    if (/^[-]{3,}$/.test(t)) continue;
    // Credits/Time footer (possibly with ▸/• glyphs).
    if (/Credits:.*Time:/i.test(t)) continue;
    if (/^[▸›>•●\s]*Credits:/i.test(t)) continue;
    if (/^EXIT=\d+$/.test(t)) continue;

    // Strip a leading prompt marker ("› ", "> ", "▸ ") but KEEP the text after
    // it — the CLI echoes the prompt and prints the answer on the same line.
    t = t.replace(/^[▸›>]\s+/, '');
    if (t === '') continue;

    kept.push(t);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Try to parse a `{tool_calls:[...]}` or `{tool,arguments}` JSON from text. */
function tryParseToolCallJson(text: string): ToolCall[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  const toCall = (rawIn: unknown, idx: number): ToolCall | null => {
    if (typeof rawIn !== 'object' || rawIn === null) return null;
    const r = rawIn as Record<string, unknown>;
    const name =
      typeof r.name === 'string' ? r.name : typeof r.tool === 'string' ? r.tool : null;
    if (!name) return null;
    const args =
      typeof r.arguments === 'object' && r.arguments !== null
        ? (r.arguments as Record<string, unknown>)
        : typeof r.args === 'object' && r.args !== null
          ? (r.args as Record<string, unknown>)
          : {};
    const id = typeof r.id === 'string' ? r.id : `kiro_call_${Date.now()}_${idx}`;
    return { id, name, arguments: args };
  };

  if (Array.isArray(obj.tool_calls)) {
    const calls = obj.tool_calls
      .map((c, i) => toCall(c, i))
      .filter((c): c is ToolCall => c !== null);
    return calls.length > 0 ? calls : null;
  }

  const single = toCall(obj, 0);
  return single ? [single] : null;
}
