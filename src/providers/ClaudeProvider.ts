import type { AppEnv } from '../config/env.js';
import { log } from '../core/logger.js';
import type { EndpointProfile } from './EndpointProfile.js';
import { resolveEndpoint } from './EndpointResolver.js';
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
 * Claude (Anthropic) provider.
 *
 * Speaks the Messages API directly over HTTP (no extra SDK dependency).
 * Demonstrates format isolation: tools become Anthropic `tools`; tool calls
 * come back as `tool_use` content blocks, translated to normalized ToolCalls.
 *
 * Endpoint + credential come from the `EndpointProfile` (HARNESS_* first, then
 * ANTHROPIC_*), so pointing the harness at an Anthropic-compatible gateway is a
 * URL change only.
 */
interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly label: string;
  private readonly maxTries: number;

  constructor(env: AppEnv, profile?: EndpointProfile) {
    const resolved = profile ?? resolveEndpoint(env).profile;
    this.label = resolved.label;

    if (!resolved.apiKey) {
      throw new Error(
        `${resolved.label} requer uma credencial: defina HARNESS_API_KEY (ou ANTHROPIC_API_KEY) no .env`,
      );
    }
    const base = resolved.baseUrl ?? 'https://api.anthropic.com';

    this.apiKey = resolved.apiKey;
    this.model = resolved.defaultModel ?? 'claude-3-5-sonnet-latest';
    // Accept both `https://host` and `https://host/v1` (docs and SDK differ).
    const normalized = base.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.endpoint = `${normalized}/v1/messages`;
    this.maxTries = env.HARNESS_PROVIDER_RETRIES;
    log.debug(`${resolved.label}: modelo "${this.model}" @ ${this.endpoint}`);
  }


  async completion(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<ProviderResponse> {
    const tools = options?.tools ?? [];
    const systemPrompt = messages.find((m) => m.role === 'system')?.content;
    const convo = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: options?.model ?? this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: this.toAnthropicMessages(convo),
      ...(systemPrompt ? { system: systemPrompt } : {}),
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              name: `${t.server}__${t.name}`,
              description: t.description,
              input_schema: t.inputSchema,
            })),
          }
        : {}),
    };

    const resp = await withRetry(
      this.label,
      async () => {
        const raw = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });

        if (!raw.ok) {
          const txt = await raw.text().catch(() => '');
          // Shape the failure so RetryPolicy can classify 429/5xx/401/404.
          throw Object.assign(new Error(`HTTP ${raw.status}: ${txt.slice(0, 500)}`), {
            status: raw.status,
          });
        }
        return raw;
      },
      this.maxTries,
    );

    const data = (await resp.json()) as { content?: AnthropicContentBlock[]; stop_reason?: string };
    const blocks = data.content ?? [];

    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (toolUses.length > 0) {
      const calls: ToolCall[] = toolUses.map((b, i) => ({
        id: b.id ?? `claude_${Date.now()}_${i}`,
        name: (b.name ?? '').replace('__', '.'),
        arguments: b.input ?? {},
      }));
      return { type: 'tool_calls', toolCalls: calls, raw: data };
    }

    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();
    return { type: 'text', text: stripToolArtifacts(text), raw: data };
  }

  private toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId ?? 'unknown',
              content: m.content,
            },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });
  }
}
