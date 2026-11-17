import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../core/logger.js';

/**
 * MCP server configuration normalized from either:
 *  - .harness/context.json `mcpServers` (per-app, source of truth)
 *  - ~/.kiro/settings/mcp.json (global, opt-in via --mcp-from-kiro)
 *
 * Supports stdio servers (command/args/env) and streamable HTTP (url).
 */
export interface StdioServerConfig {
  transport: 'stdio';
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoApprove?: string[];
}

export interface HttpServerConfig {
  transport: 'http';
  name: string;
  url: string;
  /** Extra headers (e.g. Authorization: Bearer <FIGMA_ACCESS_TOKEN>). */
  headers?: Record<string, string>;
  autoApprove?: string[];
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

interface RawServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  autoApprove?: string[];
  disabled?: boolean;
}

/** Tools que alteram estado de forma irreversivel ou perigosa. */
const DESTRUCTIVE_TOOLS = new Set([
  'git_reset',
  'git_clean',
  'git_checkout',
  'git_revert',
  'git_push',
  'git_merge',
  'git_rebase',
  'git_add',
  'git_commit',
  'write_file',
  'edit_file',
  'move_file',
  'delete_file',
  'delete_directory',
  'create_directory',
]);

export class McpRegistry {
  private readonly servers = new Map<string, ServerConfig>();

  /** Load servers from .harness/context.json and/or the global Kiro config. */
  static load(opts: { cwd: string; fromKiro?: boolean; localServers?: Record<string, unknown> }): McpRegistry {
    const registry = new McpRegistry();

    // 1) Global Kiro config (opt-in).
    if (opts.fromKiro) {
      const globalPath = path.join(os.homedir(), '.kiro', 'settings', 'mcp.json');
      registry.ingestFile(globalPath);
    }

    // 2) Per-app servers from .harness/context.json (highest priority).
    if (opts.localServers) {
      registry.ingestRaw(opts.localServers, '.harness/context.json');
    }

    return registry;
  }

  private ingestFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const json = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        mcpServers?: Record<string, RawServerEntry>;
      };
      if (json.mcpServers) this.ingestRaw(json.mcpServers, filePath);
    } catch (err) {
      log.warn(`McpRegistry: falha ao ler ${filePath}: ${(err as Error).message}`);
    }
  }

  private ingestRaw(raw: Record<string, unknown>, source: string): void {
    for (const [name, value] of Object.entries(raw)) {
      const cfg = normalizeServer(name, value as RawServerEntry);
      if (!cfg) continue;
      this.servers.set(name, cfg); // later sources override earlier (local wins)
    }
    log.debug(`McpRegistry: ${this.servers.size} servidor(es) de ${source}.`);
  }

  list(): ServerConfig[] {
    return [...this.servers.values()];
  }

  get(name: string): ServerConfig | undefined {
    return this.servers.get(name);
  }

  /**
   * Decide se uma tool pode executar sem aprovacao humana.
   *
   * Politica (defense in depth):
   *  1. Tool nativa do harness -> sempre explicita (codigo nosso).
   *  2. `autoApprove` do servidor contem a tool OU `*` -> libera.
   *  3. `autoApprove` ausente -> comportamento legado (libera), mas as tools
   *     destrutivas abaixo continuam exigindo lista explicita.
   *  4. Tool destrutiva fora da lista -> bloqueia.
   *
   * Sem isso, `autoApprove` era campo decorativo e o modelo podia chamar
   * `git_clean`/`git_reset` em `main` sem qualquer barreira.
   */
  isToolApproved(serverName: string, toolName: string): { approved: boolean; reason: string } {
    if (serverName === 'harness') {
      return { approved: true, reason: 'tool nativa do harness' };
    }

    const server = this.servers.get(serverName);
    if (!server) {
      return { approved: false, reason: `servidor "${serverName}" desconhecido` };
    }

    const list = server.autoApprove ?? [];
    const bare = toolName.includes('.') ? toolName.split('.').pop() ?? toolName : toolName;
    const matches = list.includes('*') || list.includes(toolName) || list.includes(bare);

    if (matches) return { approved: true, reason: 'listada em autoApprove' };

    // Tools destrutivas NUNCA passam por padrao. Precisam estar explicitas.
    if (DESTRUCTIVE_TOOLS.has(bare) || /^(git_(reset|clean|checkout|push|merge|rebase)|write_file|delete_|remove_|move_file|create_directory)/.test(bare)) {
      return {
        approved: false,
        reason: `"${bare}" e destrutiva e nao esta em autoApprove do servidor "${serverName}"`,
      };
    }

    // autoApprove ausente em servidor de leitura: comportamento legado.
    if (server.autoApprove === undefined) {
      return { approved: true, reason: 'servidor sem autoApprove (politica permissiva)' };
    }

    return { approved: false, reason: `"${bare}" nao esta em autoApprove` };
  }

  /** Resolve the owning server for a tool given as `server.tool` or `server__tool`. */
  resolveServerForTool(toolName: string): string | undefined {
    const sep = toolName.includes('.') ? '.' : toolName.includes('__') ? '__' : null;
    const serverPart = sep ? toolName.split(sep)[0] : undefined;
    if (serverPart && this.servers.has(serverPart)) return serverPart;

    // Tool nativa do harness (ex.: `harness.repo_map`): nao ha servidor MCP
    // correspondente, e o fallback abaixo a rotearia para o PRIMEIRO servidor
    // (filesystem), fazendo a chamada falhar. Preserva o prefixo.
    if (serverPart === 'harness') return 'harness';

    // Fallback: first server (single-server apps).
    const first = this.servers.keys().next();
    return first.done ? undefined : first.value;
  }
}

function normalizeServer(name: string, entry: RawServerEntry): ServerConfig | null {
  if (!entry || entry.disabled === true) return null;

  if (entry.url || entry.type === 'streamableHttp' || entry.type === 'sse') {
    if (!entry.url) return null;
    // Merge explicit headers with an auto-injected Figma Bearer token.
    const headers: Record<string, string> = { ...(entry.headers ?? {}) };
    if (/figma/i.test(name) && process.env.FIGMA_ACCESS_TOKEN && !headers.Authorization) {
      headers.Authorization = `Bearer ${process.env.FIGMA_ACCESS_TOKEN}`;
    }
    return {
      transport: 'http',
      name,
      url: entry.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      autoApprove: entry.autoApprove,
    };
  }

  if (entry.command) {
    return {
      transport: 'stdio',
      name,
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env,
      autoApprove: entry.autoApprove,
    };
  }

  return null;
}
