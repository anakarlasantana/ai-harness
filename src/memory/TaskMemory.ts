import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createTask, type ExecutionTraceEntry, type Task, type TaskStatus, type TestRun } from '../core/Task.js';
import { log } from '../core/logger.js';

/**
 * Episodic task memory persisted at `<cwd>/.harness/tasks/<taskId>.json`.
 *
 * Edge-case #2 (atomic, serialized writes): every mutation goes through a
 * per-task Promise queue (mutex), so concurrent tool calls returning in
 * parallel can never interleave reads/writes and corrupt the JSON. Each write
 * is atomic via write-temp -> fsync -> rename on the same filesystem.
 */
export class TaskMemory {
  private readonly dir: string;
  /** Per-task serialization queue. */
  private static readonly queues = new Map<string, Promise<unknown>>();

  constructor(cwd: string = process.cwd()) {
    this.dir = path.join(cwd, '.harness', 'tasks');
  }

  private filePath(taskId: string): string {
    // Guard against path traversal in task ids.
    const safe = taskId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  /** Serialize an operation for a given task id (strictly sequential). */
  private enqueue<T>(taskId: string, op: () => Promise<T>): Promise<T> {
    const prev = TaskMemory.queues.get(taskId) ?? Promise.resolve();
    const next = prev.then(op, op); // run op regardless of previous outcome
    // Keep the chain alive but swallow errors for the stored reference.
    TaskMemory.queues.set(
      taskId,
      next.catch(() => undefined),
    );
    return next;
  }

  // ── writes (serialized + atomic) ────────────────────────────────────────────

  async save(task: Task): Promise<void> {
    await this.enqueue(task.id, () => this.writeAtomic(task));
  }

  /** Create-if-missing then mutate. Returns the updated task. */
  async update(taskId: string, mutator: (t: Task) => void): Promise<Task> {
    return this.enqueue(taskId, async () => {
      const task = (await this.readRaw(taskId)) ?? createTask(taskId);
      mutator(task);
      task.updatedAt = new Date().toISOString();
      await this.writeAtomic(task);
      return task;
    });
  }

  async setStatus(taskId: string, status: TaskStatus): Promise<Task> {
    return this.update(taskId, (t) => {
      t.status = status;
    });
  }

  async setArchitectureDecision(taskId: string, decision: string): Promise<Task> {
    return this.update(taskId, (t) => {
      t.architectureDecision = decision;
      t.status = 'planned';
    });
  }

  async addFiles(taskId: string, files: string[]): Promise<Task> {
    return this.update(taskId, (t) => {
      const set = new Set(t.filesChanged);
      for (const f of files) set.add(f);
      t.filesChanged = [...set];
    });
  }

  async appendQaFeedback(taskId: string, feedback: string): Promise<Task> {
    return this.update(taskId, (t) => {
      t.qaFeedbackHistory.push(`[${new Date().toISOString()}] ${feedback}`);
    });
  }

  async appendTrace(taskId: string, entry: ExecutionTraceEntry): Promise<Task> {
    return this.update(taskId, (t) => {
      t.executionTrace.push(entry);
    });
  }

  /**
   * Insere ou atualiza uma execução de verificação.
   *
   * Upsert por `run.id` é o que permite ao dashboard mostrar `running` e depois
   * o resultado — o CLI grava a cada passo em vez de só no fim.
   */
  async upsertTestRun(taskId: string, run: TestRun): Promise<Task> {
    return this.update(taskId, (t) => {
      const i = t.testRuns.findIndex((r) => r.id === run.id);
      if (i >= 0) t.testRuns[i] = run;
      else t.testRuns.unshift(run);
      // Histórico curto: o dashboard é operacional, não arquivo.
      t.testRuns = t.testRuns.slice(0, 20);
    });
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  async load(taskId: string): Promise<Task | null> {
    return this.readRaw(taskId);
  }

  async require(taskId: string): Promise<Task> {
    const task = await this.readRaw(taskId);
    if (!task) throw new Error(`Task "${taskId}" não encontrada em ${this.dir}`);
    return task;
  }

  /** List all task files in the current repo (for the dashboard). */
  async listAll(): Promise<Task[]> {
    try {
      const entries = await fsp.readdir(this.dir);
      const tasks: Task[] = [];
      for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        const full = path.join(this.dir, f);
        try {
          tasks.push(JSON.parse(await fsp.readFile(full, 'utf8')) as Task);
        } catch {
          // skip corrupt/partial files
        }
      }
      return tasks.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    } catch {
      return [];
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async readRaw(taskId: string): Promise<Task | null> {
    const fp = this.filePath(taskId);
    try {
      const txt = await fsp.readFile(fp, 'utf8');
      return JSON.parse(txt) as Task;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      log.warn(`TaskMemory: falha ao ler ${fp}: ${(err as Error).message}`);
      return null;
    }
  }

  private async writeAtomic(task: Task): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const fp = this.filePath(task.id);
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    const data = JSON.stringify(task, null, 2);

    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync(); // fsync for durability before rename
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, fp); // atomic on same filesystem
  }
}

/** Convenience: ensure the tasks directory exists synchronously (used by dashboard). */
export function ensureTasksDirSync(cwd: string): string {
  const dir = path.join(cwd, '.harness', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
