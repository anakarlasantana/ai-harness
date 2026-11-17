import { z } from 'zod';

/**
 * Lifecycle status of a task as it moves through the delivery pipeline.
 * Mirrors the CLI stages: plan -> code -> qa -> (rework loop) -> sync.
 */
export const TASK_STATUSES = [
  'planned',
  'coded',
  'qa-passed',
  'qa-failed',
  'reworked',
  'synced',
  'error',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * One entry in the structured execution trace that powers the local
 * dashboard (timeline, persona transitions, AI "thought" log).
 */
export const ExecutionTraceEntrySchema = z.object({
  timestamp: z.string(),
  activePersona: z.string(),
  status: z.enum(['thinking', 'tool_executed', 'success', 'error']),
  toolCalled: z.string().optional(),
  thought: z.string().optional(),
  /** Model used for this iteration (cost visibility). */
  model: z.string().optional(),
});

export type ExecutionTraceEntry = z.infer<typeof ExecutionTraceEntrySchema>;

/**
 * Um passo de verificação (prontidão ou jornada). É o que o dashboard mostra
 * linha a linha — e o que sobrevive ao `evidence/` descartável.
 */
export const TestStepSchema = z.object({
  name: z.string(),
  status: z.enum(['running', 'passed', 'failed', 'skipped']),
  durationMs: z.number().optional(),
  detail: z.string().optional(),
});

/** Uma execução de verificação de uma aplicação. */
export const TestRunSchema = z.object({
  id: z.string(),
  /** `readiness` = gates do repositório; `e2e` = jornada ponta-a-ponta. */
  kind: z.enum(['readiness', 'e2e']),
  journey: z.string().optional(),
  command: z.string().default(''),
  status: z.enum(['running', 'passed', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  steps: z.array(TestStepSchema).default([]),
  facts: z
    .object({
      fiveXX: z.number().default(0),
      consoleErrors: z.number().default(0),
    })
    .default({ fiveXX: 0, consoleErrors: 0 }),
  evidenceDir: z.string().optional(),
  digestPath: z.string().optional(),
  /** Resumo curto para o card do dashboard. */
  headline: z.string().optional(),
});

export type TestRun = z.infer<typeof TestRunSchema>;

/**
 * The episodic memory record persisted at `.harness/tasks/<taskId>.json`.
 *
 * This is the long-term, low-cost memory that lets a very old task be
 * reworked later without re-reading the whole repository: it remembers the
 * architecture decision, which files were touched, the full QA feedback
 * timeline, and the step-by-step execution trace.
 */
export const TaskSchema = z.object({
  id: z.string().min(1),
  status: z.enum(TASK_STATUSES),
  description: z.string().default(''),
  /** Output of the planning (plan) stage. */
  architectureDecision: z.string().default(''),
  /** Files the harness manipulated across all stages. */
  filesChanged: z.array(z.string()).default([]),
  /** Timeline of reworks / bugs reported by QA. */
  qaFeedbackHistory: z.array(z.string()).default([]),
  /** Structured trace per ReAct iteration (dashboard). */
  executionTrace: z.array(ExecutionTraceEntrySchema).default([]),
  /** Execuções de verificação (prontidão e ponta-a-ponta) desta task. */
  testRuns: z.array(TestRunSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Task = z.infer<typeof TaskSchema>;

/** Build a fresh task record with sane defaults. */
export function createTask(id: string, description = ''): Task {
  const now = new Date().toISOString();
  return {
    id,
    status: 'planned',
    description,
    architectureDecision: '',
    filesChanged: [],
    qaFeedbackHistory: [],
    executionTrace: [],
    testRuns: [],
    createdAt: now,
    updatedAt: now,
  };
}
