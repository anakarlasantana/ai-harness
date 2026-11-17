import fs from 'node:fs';
import path from 'node:path';
import type { LocalContextConfig } from '../context/LocalContextLoader.js';

/**
 * Detects the current repository stack and the commands to lint / test / build.
 * Local `.harness/context.json` overrides always win over detection defaults.
 */
export interface StackInfo {
  name: string;
  /** Human hint injected into the prompt. */
  hint: string;
  lintCmd?: string;
  testCmd?: string;
  buildCmd?: string;
  /** "Definition of done" declarado pelo repositório (`.harness/context.json`). */
  readinessCmd?: string;
  readinessTimeoutMs?: number;
}

interface Detector {
  file: string;
  detect: (cwd: string) => StackInfo;
}

const DETECTORS: Detector[] = [
  {
    file: 'package.json',
    detect: (cwd) => {
      const pkg = safeReadJson(path.join(cwd, 'package.json')) as {
        scripts?: Record<string, string>;
        name?: string;
      } | null;
      const scripts = pkg?.scripts ?? {};
      const runner = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : fs.existsSync(path.join(cwd, 'yarn.lock'))
          ? 'yarn'
          : 'npm';
      return {
        name: `node (${runner})${pkg?.name ? ` — ${pkg.name}` : ''}`,
        hint: `Projeto Node.js/TypeScript. Gerenciador: ${runner}. Scripts: ${Object.keys(scripts).join(', ') || 'nenhum'}.`,
        lintCmd: scripts['lint'] ? `${runner} run lint` : undefined,
        testCmd: scripts['test'] ? `${runner} ${runner === 'npm' ? 'test' : 'test'}` : undefined,
        buildCmd: scripts['build'] ? `${runner} run build` : undefined,
      };
    },
  },
  {
    file: 'go.mod',
    detect: () => ({
      name: 'go',
      hint: 'Projeto Go (go.mod).',
      lintCmd: 'go vet ./...',
      testCmd: 'go test ./...',
      buildCmd: 'go build ./...',
    }),
  },
  {
    file: 'pom.xml',
    detect: () => ({
      name: 'java (maven)',
      hint: 'Projeto Java/Maven (pom.xml).',
      testCmd: './mvnw test || mvn test',
      buildCmd: './mvnw -q -DskipTests package || mvn -q -DskipTests package',
    }),
  },
  {
    file: 'build.gradle',
    detect: () => ({
      name: 'java (gradle)',
      hint: 'Projeto Java/Gradle (build.gradle).',
      testCmd: './gradlew test || gradle test',
      buildCmd: './gradlew build -x test || gradle build -x test',
    }),
  },
  {
    file: 'Cargo.toml',
    detect: () => ({
      name: 'rust',
      hint: 'Projeto Rust (Cargo.toml).',
      lintCmd: 'cargo clippy',
      testCmd: 'cargo test',
      buildCmd: 'cargo build',
    }),
  },
  {
    file: 'pyproject.toml',
    detect: () => ({
      name: 'python',
      hint: 'Projeto Python (pyproject.toml).',
      lintCmd: 'ruff check .',
      testCmd: 'pytest -q',
      buildCmd: 'python -m build',
    }),
  },
];

export function detectStack(cwd: string, local?: LocalContextConfig): StackInfo {
  let base: StackInfo = { name: 'unknown', hint: 'Stack não identificada.' };

  for (const d of DETECTORS) {
    if (fs.existsSync(path.join(cwd, d.file))) {
      try {
        base = d.detect(cwd);
        break;
      } catch {
        // try next detector
      }
    }
  }

  // Local overrides.
  if (local) {
    if (local.lintCommand) base.lintCmd = local.lintCommand;
    if (local.testCommand) base.testCmd = local.testCommand;
    if (local.buildCommand) base.buildCmd = local.buildCommand;

    // A prontidão declarada vence a detecção: é o comando que o time já usa como
    // "está pronto", e o harness não deve adivinhar outra coisa.
    const readiness = local.verification?.readiness;
    if (readiness?.command) {
      base.readinessCmd = readiness.command;
      base.readinessTimeoutMs = readiness.timeoutMs;
    }
  }

  return base;
}

function safeReadJson(fp: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}
