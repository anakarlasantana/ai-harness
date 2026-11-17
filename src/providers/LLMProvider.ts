/**
 * Provider-agnostic contracts.
 *
 * Every provider (Kiro/OpenAI/Claude) implements the same `LLMProvider`
 * interface, so the ReAct orchestrator stays completely identical regardless
 * of provider. The translation between tool-calling formats (OpenAI
 * `tool_calls`, Anthropic `tool_use`, Kiro pseudo-tools) is the sole
 * responsibility of each provider class.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on `tool` messages: id of the tool call this result answers. */
  toolCallId?: string;
  /** Present on `tool` messages: the tool/function name. */
  name?: string;
  /**
   * Present on `assistant` messages that requested tools: the original calls.
   *
   * The OpenAI/DeepSeek wire format REQUIRES every `role:'tool'` message to
   * answer a preceding assistant message that carries `tool_calls` — otherwise
   * the request fails with HTTP 400 ("Messages with role 'tool' must be a
   * response to a preceding message with 'tool_calls'"). Groq is lenient here;
   * DeepSeek is not, so the calls must survive the round-trip.
   */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

/** Minimal JSON-schema shape accepted by model tool declarations. */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/** A tool exposed by a local MCP server, normalized for all providers. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  /** Name of the MCP server that owns this tool (e.g. `postgres_sin`). */
  server: string;
}

/** A request from the model to execute a tool. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Normalized model response: either final text or one/more tool calls. */
export interface ProviderResponse {
  type: 'text' | 'tool_calls';
  text?: string;
  toolCalls?: ToolCall[];
  /** Optional reasoning/thoughts the provider exposes (used by the trace). */
  reasoning?: string;
  raw?: unknown;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * Tool catalog to advertise to the model. When omitted/empty, providers
   * fall back to a plain text completion (no tool calling).
   */
  tools?: ToolDefinition[];
  /** Free-form system prompt if the caller does not pre-pend it as a message. */
  systemPrompt?: string;
  /**
   * Model to use for THIS call, overriding the provider's default. This is how
   * the harness assigns different models per stage/persona (cost optimization).
   */
  model?: string;
}

export interface LLMProvider {
  /** Stable provider identifier, e.g. `kiro` | `openai` | `claude`. */
  readonly name: string;
  /**
   * Run a single completion turn.
   * @returns either final text or a set of tool calls to execute.
   */
  completion(messages: ChatMessage[], options?: CompletionOptions): Promise<ProviderResponse>;
}
