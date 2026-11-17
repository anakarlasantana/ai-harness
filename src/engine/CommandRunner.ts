import { spawn } from 'node:child_process';
import { clipSmart } from '../core/tokens.js';

/**
 * Safe local command runner.
 *
 * - Runs WITHOUT a shell (no injection surface).
 * - Whitelists the first token to lint/test/build-like commands.
 * - Enforces a timeout.
 * - Clips verbose output with the smart 50/100-line heuristic (edge-case #3).
 */
export interface CommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Smart-clipped combined output for feeding back to the model. */
  clipped: string;
  timedOut: boolean;
}

const ALLOWED_ROOTS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'node',
  'go',
  'cargo',
  'python',
  'python3',
  'pytest',
  'ruff',
  'mvn',
  'gradle',
  './mvnw',
  './gradlew',
  'make',
  'tsc',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  // Necessários para a verificação ponta-a-ponta declarada pelo alvo:
  // `docker compose logs` (log no digest) e `git rev-parse` (commit no digest).
  'docker',
  'git',
]);

export async function execSafe(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const argv = tokenize(command);
  const root = argv[0] ?? '';
  const isAllowed =
    ALLOWED_ROOTS.has(root) ||
    root.startsWith('./mvnw') ||
    root.startsWith('./gradlew') ||
    // allow `<manager> run <script>` and `npx <tool>` forms
    (root === 'npm' || root === 'pnpm' || root === 'yarn');

  if (!isAllowed) {
    throw new Error(`Comando não permitido pela whitelist: "${root}"`);
  }

  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(root, argv.slice(1), {
      cwd,
      shell: false,
      env: { ...process.env, ...opts.env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}\n${err.message}`;
      resolve({
        command,
        ok: false,
        code: null,
        stdout,
        stderr: stderr + err.message,
        clipped: clipSmart(combined),
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      resolve({
        command,
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        clipped: clipSmart(combined),
        timedOut,
      });
    });
  });
}

/** Split a command string into argv, honoring simple quotes. No shell eval. */
function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
