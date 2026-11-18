import OpenAI from 'openai';
import type { AppEnv } from '../config/env.js';
import { log } from '../core/logger.js';
import type { EndpointProfile } from './EndpointProfile.js';
import { resolveEndpoint } from './EndpointResolver.js';
import { detectSlug, qualifyModel, type ProviderSlug } from './model-slug.js';
import { withRetry } from './RetryPolicy.js';
import { stripToolArtifacts } from './sanitize-tool-artifacts.js';
import type {
  ChatMessage,
  CompletionOptions,
  LLMProvider,
  ProviderResponse,
  ToolCall,
} from './LLMProvider.js';

/**
 * OpenAI-compatible provider.
 *
 * Speaks the `chat/completions` wire format used by OpenAI, Groq, DeepSeek,
 * OpenRouter, Together, Mistral, Cerebras, vLLM and Ollama's `/v1` surface, so a
 * single class serves every one of them. What changes between vendors is only
 * the base URL, the credential and the model naming — all of that lives in the
 * `EndpointProfile`, never in this class.
 *
 * Tool translation (ToolDefinition -> OpenAI function tools; OpenAI `tool_calls`
 * -> normalized ToolCalls) also lives here, keeping the orchestrator agnostic.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly label: string;
  private readonly slug: ProviderSlug;
  private readonly maxTries: number;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly extraHeaders?: Record<string, string>;
  private readonly timeoutMs = 120_000;

  constructor(env: AppEnv, profile?: EndpointProfile) {
    const resolved = profile ?? resolveEndpoint(env).profile;
    this.label = resolved.label;
    this.slug = resolved.slug ?? detectSlug(resolved.baseUrl);

    if (resolved.requiresApiKey && !resolved.apiKey) {
      throw new Error(
        `${resolved.label} requer uma credencial: defina HARNESS_API_KEY (ou OPENAI_API_KEY) no .env`,
      );
    }
    if (!resolved.baseUrl) {
      throw new Error(
        `${resolved.label}: HARNESS_BASE_URL (ou OPENAI_BASE_URL) não configurada`,
      );
    }

    this.client = new OpenAI({
      // Local daemons (Ollama) accept any placeholder; the SDK rejects empty.
      apiKey: resolved.apiKey ?? 'not-required',
      baseURL: resolved.baseUrl,
      ...(resolved.extraHeaders ? { defaultHeaders: resolved.extraHeaders } : {}),
    });
    this.baseUrl = resolved.baseUrl.replace(/\/+$/, '');
    this.apiKey = resolved.apiKey;
    this.extraHeaders = resolved.extraHeaders;
    this.model = resolved.defaultModel ?? 'gpt-4o-mini';
    this.maxTries = env.HARNESS_PROVIDER_RETRIES;
    log.debug(
      `OpenAIProvider: ${resolved.label} · modelo "${this.model}" @ ${resolved.baseUrl}` +
        (resolved.slug ? ` (slug=${resolved.slug})` : ''),
    );
  }

  /** Label of the concrete endpoint (e.g. "Groq"), for logs and traces. */
  get endpointLabel(): string {
    return this.label;
  }

  async completion(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<ProviderResponse> {
    const tools = options?.tools ?? [];
    const hasTools = tools.length > 0;

    // Model resolution: explicit per-stage name > provider default, always
    // qualified for the endpoint that will serve it.
    const requested = options?.model ?? this.model;
    const model = this.qualify(requested);

    const payload = {
      model,
      messages: this.toOpenAIMessages(messages),
      ...(hasTools
        ? {
            tools: tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: `${t.server}__${t.name}`,
                description: t.description,
                parameters: t.inputSchema,
              },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    };

    // Types are intentionally loose here to avoid coupling to SDK unions.
    // The thunk resolves to a ProviderResponse directly so the native-fetch
    // fallback path never has to impersonate an SDK response object.
    const result = await withRetry<ProviderResponse>(
      this.label,
      async () => {
        try {
          const sdkResp = await this.client.chat.completions.create(payload as never);
          return this.parseChatCompletion(sdkResp as unknown as ChatCompletionPayload);
        } catch (err) {
          // The SDK's bundled HTTP agent can fail with `Premature close` in
          // environments that inject a custom CA / corporate proxy
          // (NODE_EXTRA_CA_CERTS), while plain `fetch` to the SAME URL works.
          // Fall back to native fetch before spending a retry on it.
          if (isAgentLevelFailure(err)) {
            log.debug(
              `OpenAIProvider: SDK falhou (${(err as Error).message.slice(0, 120)}); usando fetch nativo.`,
            );
            return await this.completionViaFetch(model, payload);
          }
          throw err;
        }
      },
      this.maxTries,
    );

    return result;
  }

  /** Qualify a model name for this endpoint's naming convention. */
  private qualify(model: string): string {
    return qualifyModel(model, this.slug);
  }

  /**
   * Fallback transport using native `fetch` (Node 18+ global).
   * Produces the same normalized `ProviderResponse` as the SDK path, so the
   * orchestrator never notices which transport served the turn.
   */
  private async completionViaFetch(
    model: string,
    payload: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...(this.extraHeaders ?? {}),
      },
      body: JSON.stringify({ ...payload, model }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`), {
        status: res.status,
      });
    }

    return this.parseChatCompletion((await res.json()) as ChatCompletionPayload);
  }

  /** Translate an OpenAI `chat.completion` body into a ProviderResponse. */
  private parseChatCompletion(data: ChatCompletionPayload): ProviderResponse {
    const choice = data.choices?.[0];
    if (!choice) return { type: 'text', text: '', raw: data };

    const toolCalls = choice.message?.tool_calls ?? [];
    if (toolCalls.length > 0) {
      const calls: ToolCall[] = toolCalls.map((tc) => ({
        id: tc.id,
        // Restore the `server.tool` convention from the flattened name.
        name: tc.function.name.replace('__', '.'),
        arguments: safeJsonParse(tc.function.arguments),
      }));
      return { type: 'tool_calls', toolCalls: calls, raw: data };
    }

    return { type: 'text', text: stripToolArtifacts(choice.message?.content ?? ''), raw: data };
  }

  private toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.toolCallId ?? 'unknown',
          content: m.content,
        };
      }
      // An assistant turn that requested tools MUST keep `tool_calls`, otherwise
      // the following `role:'tool'` message has no valid anchor (HTTP 400 on
      // DeepSeek and OpenAI).
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name.replace('.', '__'), arguments: tc.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }
}

function safeJsonParse(input: string): Record<string, unknown> {
  try {
    const v = JSON.parse(input);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Minimal shape of an OpenAI `chat.completion` response body. */
interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}

/**
 * True when the failure comes from the SDK's HTTP agent rather than the
 * provider: typically a TLS/proxy mismatch caused by an injected CA bundle.
 * A native `fetch` to the same URL usually succeeds in these setups.
 */
function isAgentLevelFailure(err: unknown): boolean {
  const e = err as { message?: string; status?: number; cause?: { code?: string } };
  if (e?.status !== undefined) return false; // HTTP-level error: not agent-level.
  const text = `${e?.message ?? ''} ${e?.cause?.code ?? ''}`.toLowerCase();
  return (
    text.includes('premature close') ||
    text.includes('socket hang up') ||
    text.includes('econnreset') ||
    text.includes('und_err_socket') ||
    text.includes('fetch failed')
  );
}
