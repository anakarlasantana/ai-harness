import { log } from '../core/logger.js';
import type { ExecutionRecord } from '../core/ExecutionRecord.js';
import { ExecutionMemory } from '../memory/ExecutionMemory.js';
import type { LLMProvider } from '../providers/LLMProvider.js';
import { execSafe, type CommandResult } from './CommandRunner.js';
import type { Orchestrator } from './Orchestrator.js';
import type { StackInfo } from './StackDetector.js';
import type { ChatMessage } from '../providers/LLMProvider.js';

/**
 * Autonomous QA loop with "Loop Engineering".
 *
 * Runs the app's real lint/test commands via CommandRunner. On failure it feeds
 * the smart-clipped error log back to the model (stage `code`, via the shared
 * Orchestrator) to propose/apply a fix, then re-runs — up to `maxAttempts`
 * times. Every failure is recorded in the task's qaFeedbackHistory.
 */
export interface QALoopOptions {
  cwd: string;
  provider: LLMProvider;
  orchestrator: Orchestrator;
  taskMemory: ExecutionMemory;
  task: ExecutionRecord;
  stack: StackInfo;
  systemPrompt: string;
  maxAttempts?: number;
  /** MCP registry/manager wiring is delegated to the orchestrator session. */
  runFix?: (messages: ChatMessage[]) => Promise<string>;
}

export interface QALoopResult {
  passed: boolean;
  attempts: number;
  results: CommandResult[];
  lastOutput: string;
}

export class QALoop {
  async run(opts: QALoopOptions): Promise<QALoopResult> {
    const commands = [opts.stack.lintCmd, opts.stack.testCmd].filter(
      (c): c is string => typeof c === 'string' && c.length > 0,
    );

    if (commands.length === 0) {
      log.warn('QALoop: nenhum comando de lint/test detectado; pulando checagens.');
      await opts.taskMemory.appendQaFeedback(
        opts.task.id,
        'QA: nenhum comando de lint/test configurado (stack não detectada).',
      );
      return { passed: true, attempts: 0, results: [], lastOutput: '' };
    }

    const maxAttempts = opts.maxAttempts ?? 3;
    const results: CommandResult[] = [];
    let lastOutput = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log.info(`QALoop: tentativa ${attempt}/${maxAttempts} — rodando ${commands.join(', ')}`);

      let allOk = true;
      for (const cmd of commands) {
        const res = await execSafe(cmd, opts.cwd);
        results.push(res);
        if (!res.ok) {
          allOk = false;
          lastOutput = `$ ${cmd}\n${res.clipped}`;
          log.warn(`QALoop: "${cmd}" falhou (code=${res.code}, timedOut=${res.timedOut}).`);
          await opts.taskMemory.appendQaFeedback(
            opts.task.id,
            `Falha em "${cmd}" (tentativa ${attempt}):\n${res.clipped.slice(0, 1500)}`,
          );
          break; // stop at first failing command for this attempt
        }
        log.ok(`QALoop: "${cmd}" passou.`);
      }

      if (allOk) {
        await opts.taskMemory.setStatus(opts.task.id, 'qa-passed');
        await opts.taskMemory.appendQaFeedback(opts.task.id, 'QA: todas as checagens passaram.');
        return { passed: true, attempts: attempt, results, lastOutput: '' };
      }

      // Ask the model to fix based on the (smart-clipped) error if a runner exists.
      if (opts.runFix && attempt < maxAttempts) {
        const fixPrompt: ChatMessage[] = [
          { role: 'system', content: opts.systemPrompt },
          {
            role: 'user',
            content:
              'A checagem local falhou. Analise o log abaixo (recortado: primeiras 50 + últimas 100 linhas) e descreva a correção mínima necessária. Seja conciso.\n\n' +
              lastOutput,
          },
        ];
        try {
          await opts.runFix(fixPrompt);
        } catch (err) {
          log.warn(`QALoop: runFix falhou: ${(err as Error).message}`);
        }
      }
    }

    await opts.taskMemory.setStatus(opts.task.id, 'qa-failed');
    return { passed: false, attempts: maxAttempts, results, lastOutput };
  }
}
