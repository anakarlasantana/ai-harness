import { log } from '../core/logger.js';
import type { ExecutionTraceEntry, ExecutionRecord } from '../core/ExecutionRecord.js';
import { ExecutionMemory } from '../memory/ExecutionMemory.js';
import { McpManager } from '../mcp/McpManager.js';
import type { McpRegistry } from '../mcp/McpRegistry.js';
import type {
  ChatMessage,
  LLMProvider,
  ProviderResponse,
  ToolDefinition,
} from '../providers/LLMProvider.js';
import type { StageName } from '../context/stages.js';

/**
 * ReAct orchestrator (Reasoning + Acting).
 *
 * Unifies the LLM provider with the dynamic tools of the app's local MCP
 * servers, in a bounded autonomous loop:
 *
 *   spawnAll(servers) -> tools = listTools()
 *   loop (<= maxIterations):
 *     resp = provider.completion(messages, tools)
 *     if text         -> success, persist, return
 *     for each toolCall:
 *        try   exec on owning MCP server -> append role:'tool' msg
 *        catch append role:'tool' with error -> model can adapt next turn
 *   finally killAll(servers)  (zombie-free)
 *
 * Every iteration is persisted to the task's `executionTrace` (dashboard).
 */
export interface RunOptions {
  provider: LLMProvider;
  systemPrompt: string;
  userTask: string;
  persona: string;
  stage: StageName;
  taskMemory: ExecutionMemory;
  task: ExecutionRecord;
  mcp: McpManager;
  registry: McpRegistry;
  maxIterations?: number;
  enableTools?: boolean;
  /** Model for this stage/persona (resolved by caller from local config). */
  model?: string;
  /**
   * Reserve models tried (in order) when the primary model fails with a
   * credential-agnostic error (unknown model, exhausted quota). Configured via
   * `HARNESS_MODEL_FALLBACKS`. Keeps a task alive instead of aborting on the
   * first provider hiccup (see the 'envok' incident).
   */
  modelFallbacks?: string[];
  /** Sampling overrides for this stage. */
  tuning?: { maxTokens?: number; temperature?: number };
  /** Whitelist of MCP tool names for this stage (undefined = all). */
  mcpTools?: string[];
}

export interface RunResult {
  finalText: string;
  iterations: number;
  toolCallsExecuted: number;
  hitIterationCap: boolean;
  filesTouched: string[];
}

export class Orchestrator {
  async run(opts: RunOptions): Promise<RunResult> {
    const maxIterations = opts.maxIterations ?? 8;
    const enableTools = opts.enableTools ?? true;

    let tools: ToolDefinition[] = [];
    if (enableTools) {
      tools = await opts.mcp.start();
      // Apply the stage's MCP tool whitelist (if provided).
      if (opts.mcpTools && opts.mcpTools.length > 0) {
        const allowed = new Set(opts.mcpTools.map((t) => t.replace('.', '__')));
        tools = tools.filter(
          (t) =>
            allowed.has(`${t.server}__${t.name}`) ||
            opts.mcpTools!.includes(`${t.server}.${t.name}`) ||
            opts.mcpTools!.includes(t.name),
        );
      }
      log.debug(
        `Orchestrator: ${tools.length} ferramenta(s) MCP disponível(is)` +
          (opts.mcpTools ? ` (whitelist ${opts.mcpTools.length})` : '') +
          '.',
      );
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userTask },
    ];

    let toolCallsExecuted = 0;

    // Models to try, primary first. On a model-level failure we move down the
    // list instead of killing the task; transport retries already happened
    // inside the provider.
    const modelChain = [opts.model, ...(opts.modelFallbacks ?? [])].filter(
      (m, i, arr): m is string => typeof m === 'string' && m.length > 0 && arr.indexOf(m) === i,
    );
    let chainIndex = 0;

    try {
      for (let i = 1; i <= maxIterations; i++) {
        await this.trace(opts, {
          timestamp: new Date().toISOString(),
          activePersona: opts.persona,
          status: 'thinking',
          thought: `Iteração ${i}/${maxIterations}: raciocinando...`,
          model: modelChain[chainIndex] ?? opts.model,
        });

        let resp: ProviderResponse;
        try {
          resp = await opts.provider.completion(messages, {
            tools,
            model: modelChain[chainIndex] ?? opts.model,
            ...opts.tuning,
          });
        } catch (err) {
          const msg = (err as Error).message;

          // Model-level failure with a reserve available -> switch and retry
          // the same iteration instead of aborting the whole task.
          const next = chainIndex + 1;
          if (isModelLevelFailure(msg) && next < modelChain.length) {
            const from = modelChain[chainIndex];
            const to = modelChain[next];
            chainIndex = next;
            await this.trace(opts, {
              timestamp: new Date().toISOString(),
              activePersona: opts.persona,
              status: 'error',
              thought: `Modelo "${from}" falhou (${msg.slice(0, 160)}); alternando para "${to}".`,
              model: to,
            });
            log.warn(`Orchestrator: modelo "${from}" falhou; usando reserva "${to}".`);
            i--; // do not consume an iteration for the switch
            continue;
          }

          await this.trace(opts, {
            timestamp: new Date().toISOString(),
            activePersona: opts.persona,
            status: 'error',
            thought: `Falha do provedor: ${msg}`,
          });
          return {
            finalText: `Falha do provedor na iteração ${i}: ${msg}`,
            iterations: i,
            toolCallsExecuted,
            hitIterationCap: false,
            filesTouched: [],
          };
        }

        if (resp.type === 'text' || !resp.toolCalls || resp.toolCalls.length === 0) {
          const text = resp.text ?? '';
          await this.trace(opts, {
            timestamp: new Date().toISOString(),
            activePersona: opts.persona,
            status: 'success',
            thought: 'Resposta final produzida.',
          });
          return {
            finalText: text,
            iterations: i,
            toolCallsExecuted,
            hitIterationCap: false,
            filesTouched: [],
          };
        }

        // Record the assistant turn WITH its tool calls. `executeOne` then pushes
        // the matching `role:'tool'` results; without this anchor DeepSeek rejects
        // the next request with HTTP 400 (Groq silently tolerated it).
        messages.push({
          role: 'assistant',
          content: resp.text ?? '',
          toolCalls: resp.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.arguments),
          })),
        });

        for (const call of resp.toolCalls) {
          await this.executeOne(opts, messages, call, () => {
            toolCallsExecuted++;
          });
        }
      }

      await this.trace(opts, {
        timestamp: new Date().toISOString(),
        activePersona: opts.persona,
        status: 'error',
        thought: `Teto de ${maxIterations} iterações atingido sem resposta final.`,
      });
      return {
        finalText: `⚠ Teto de ${maxIterations} iterações atingido sem resposta final.`,
        iterations: maxIterations,
        toolCallsExecuted,
        hitIterationCap: true,
        filesTouched: [],
      };
    } finally {
      if (enableTools) await opts.mcp.killAll();
    }
  }

  private async executeOne(
    opts: RunOptions,
    messages: ChatMessage[],
    call: { id: string; name: string; arguments: Record<string, unknown> },
    onSuccess: () => void,
  ): Promise<void> {
    const serverName = opts.registry.resolveServerForTool(call.name) ?? call.name;
    const bareName = call.name.includes('.')
      ? call.name.split('.').slice(1).join('.')
      : call.name.includes('__')
        ? call.name.split('__').slice(1).join('__')
        : call.name;

    let toolContent: string;
    let ok = true;

    // Barreira de aprovacao: `autoApprove` do .harness/context.json deixa de ser
    // decorativo. Tools destrutivas (git_reset, git_clean, write_file...) so
    // executam quando listadas explicitamente. O modelo recebe o motivo como
    // resultado e pode escolher outro caminho.
    const approval = opts.registry.isToolApproved(serverName, bareName);
    if (!approval.approved) {
      ok = false;
      toolContent = `TOOL_BLOCKED: ${approval.reason}. Use outra ferramenta ou peca aprovacao ao usuario.`;
      log.warn(`Orchestrator: ${call.name} bloqueada — ${approval.reason}.`);
    } else {
      try {
        const result = await opts.mcp.callTool(serverName, bareName, call.arguments);
        toolContent = JSON.stringify(result);
        onSuccess();
      } catch (err) {
        ok = false;
        toolContent = `TOOL_ERROR: ${(err as Error).message}`;
      }
    }

    messages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: toolContent,
    });

    await this.trace(opts, {
      timestamp: new Date().toISOString(),
      activePersona: opts.persona,
      status: ok ? 'tool_executed' : 'error',
      toolCalled: call.name,
      thought: ok
        ? `Ferramenta ${call.name} executada.`
        : `Ferramenta ${call.name} falhou; erro devolvido ao modelo.`,
    });
  }

  private async trace(opts: RunOptions, entry: ExecutionTraceEntry): Promise<void> {
    try {
      await opts.taskMemory.appendTrace(opts.task.id, entry);
    } catch (err) {
      log.warn(`Orchestrator: falha ao gravar trace: ${(err as Error).message}`);
    }
  }

  /**
   * Fan-out: run the primary agent plus optional specialists and fuse the
   * results. `specialists` run in parallel by default (fast) or sequentially
   * when `sequential` is true (cheaper on tokens/credits).
   */
  async runFanOut(
    opts: RunOptions,
    specialists: Array<{ persona: string; systemPrompt: string }> = [],
    sequential = false,
  ): Promise<RunResult> {
    if (specialists.length === 0) return this.run(opts);

    const runOne = (spec: { persona: string; systemPrompt: string }): Promise<RunResult> =>
      this.run({
        ...opts,
        persona: spec.persona,
        systemPrompt: spec.systemPrompt,
        stage: opts.stage,
        // Specialists generally don't need MCP tools; keep it text-only + cheap.
        enableTools: false,
      });

    let specResults: RunResult[] = [];
    if (sequential) {
      for (const s of specialists) specResults.push(await runOne(s));
    } else {
      specResults = await Promise.all(specialists.map(runOne));
    }

    const primary = await this.run(opts);

    // Fuse: primary answer + specialist reports appended for a coherent verdict.
    const fused =
      primary.finalText +
      '\n\n--- Relatórios dos especialistas ---\n' +
      specResults
        .map((r, i) => `### ${specialists[i]?.persona ?? `especialista-${i + 1}`}\n${r.finalText}`)
        .join('\n\n');

    await this.trace(opts, {
      timestamp: new Date().toISOString(),
      activePersona: opts.persona,
      status: 'success',
      thought: `Fan-out concluído com ${specialists.length} especialista(s) ${sequential ? '(sequencial)' : '(paralelo)'}.`,
    });

    return {
      ...primary,
      finalText: fused,
      toolCallsExecuted:
        primary.toolCallsExecuted + specResults.reduce((a, r) => a + r.toolCallsExecuted, 0),
    };
  }
}

/** Extract file paths mentioned in a model answer (best-effort). */
export function extractFilesFromText(text: string): string[] {
  const matches = text.match(
    /[\w./-]+\.(?:ts|tsx|js|jsx|json|go|py|java|kt|rs|md|yml|yaml|sql|css|html)/g,
  );
  return matches ? [...new Set(matches)] : [];
}

/**
 * True when a provider error is about the MODEL rather than the transport or the
 * task. Those are the only failures worth retrying with a different model.
 */
export function isModelLevelFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('model_not_found') ||
    m.includes('no longer available') ||
    m.includes('decommissioned') ||
    m.includes('does not exist') ||
    m.includes('unknown model') ||
    m.includes('invalid model') ||
    m.includes('model not found') ||
    m.includes('[rate_limit]') ||
    m.includes('rate limit') ||
    m.includes('tokens per day') ||
    m.includes('quota')
  );
}

