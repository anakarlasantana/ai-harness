import { z } from 'zod';

/**
 * Contrato de verificação ponta-a-ponta declarado pela APLICAÇÃO.
 *
 * O harness não conhece Medusa, Next ou Playwright: ele executa o que o alvo
 * declara em `.harness/context.json` → `e2e`. Toda a semântica de stack fica no
 * app; aqui só existe o formato.
 */
export const E2ELogDeclarationSchema = z.object({
  /** Nome do serviço cujo log entra no digest (backend, frontend, ...). */
  name: z.string().min(1),
  /** Comando que imprime o log. `{since}` é substituído pelo início da execução. */
  command: z.string().min(1),
});

export const E2EAllowEntrySchema = z.object({
  status: z.number().int(),
  path: z.string().optional(),
});

export const E2EDeclarationSchema = z.object({
  /** Passos que preparam o alvo (subir stack isolado, seed...). */
  before: z.array(z.string().min(1)).default([]),
  /** O comando que roda as jornadas e escreve a evidência. */
  command: z.string().min(1),
  /** Passos de limpeza; rodam SEMPRE, inclusive em falha. */
  after: z.array(z.string().min(1)).default([]),
  /** Jornada nomeada → comando (ex.: `cliente` → `make e2e-cliente`). */
  journey: z.record(z.string(), z.string().min(1)).default({}),
  timeoutMs: z.number().int().positive().default(15 * 60 * 1000),
  /** Onde o alvo escreve os artefatos da execução. */
  evidenceDir: z.string().default('evidence'),
  /** Nome do resumo legível que o alvo (ou o harness) grava. */
  digest: z.string().default('resumo.md'),
  logs: z.array(E2ELogDeclarationSchema).default([]),
  /** Respostas esperadas que não contam como defeito. */
  allowlist: z.array(E2EAllowEntrySchema).default([]),
});

export type E2EDeclaration = z.infer<typeof E2EDeclarationSchema>;

export type StepStatus = 'passed' | 'failed' | 'skipped';

export interface E2EStep {
  name: string;
  command: string;
  status: StepStatus;
  durationMs: number;
  code: number | null;
  timedOut: boolean;
  /** Últimas linhas relevantes (para o digest e o dashboard). */
  tail: string[];
}

export interface E2ELogTail {
  name: string;
  lines: string[];
}

export interface E2EFacts {
  /** 5xx observados na evidência do alvo. */
  fiveXX: number;
  /** Erros de console observados na evidência do alvo. */
  consoleErrors: number;
}

export interface E2ERunResult {
  ok: boolean;
  runId: string;
  command: string;
  journey?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: E2EStep[];
  logs: E2ELogTail[];
  facts: E2EFacts;
  evidenceDir?: string;
  digestPath?: string;
  /** Conteúdo do digest do alvo, já recortado. */
  digest?: string;
}
