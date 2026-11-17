import { spawnSync } from 'node:child_process';
import { log } from '../core/logger.js';
import { McpClient } from './McpClient.js';
import type { McpRegistry, ServerConfig } from './McpRegistry.js';
import type { ToolDefinition } from '../providers/LLMProvider.js';

/**
 * MCP lifecycle manager.
 *
 * Spawns all configured servers at task start, captures their exposed tools,
 * and — crucially — guarantees a ZOMBIE-FREE teardown.
 *
 * Edge-case #1 (anti-zombie): on process exit / SIGINT / SIGTERM we fire
 * SIGTERM (then SIGKILL) SYNCHRONOUSLY with `spawnSync('kill', ...)` so the
 * Node parent cannot die before its children are reaped from the machine.
 * (Async handlers never run during the `exit` event, so we use sync signals.)
 */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly pids = new Set<number>();
  private tools: ToolDefinition[] = [];
  private teardownHooksInstalled = false;
  /** Tools executadas pelo proprio harness (sem subprocesso MCP). */
  private readonly nativeTools: ToolDefinition[] = [];
  private readonly nativeHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

  constructor(private readonly registry: McpRegistry) {}

  /** Spawn all servers, connect, and collect the tool catalog. */
  async start(): Promise<ToolDefinition[]> {
    this.installTeardownHooks();

    const servers = this.registry.list();
    if (servers.length === 0) {
      log.debug('McpManager: nenhum servidor MCP configurado.');
      return [];
    }

    const tools: ToolDefinition[] = [];

    for (const server of servers) {
      try {
        const client = new McpClient(server);
        await client.connect();
        this.clients.set(server.name, client);

        const pid = client.pid;
        if (pid) this.pids.add(pid);

        const rawTools = await client.listTools();
        for (const t of rawTools) {
          tools.push({
            name: t.name,
            description: t.description ?? '',
            inputSchema: (t.inputSchema as ToolDefinition['inputSchema']) ?? {
              type: 'object',
              properties: {},
            },
            server: server.name,
          });
        }
        log.debug(`McpManager[${server.name}]: ${rawTools.length} ferramenta(s).`);
      } catch (err) {
        log.warn(`McpManager[${server.name}]: falha ao iniciar — ${(err as Error).message}`);
        this.clients.delete(server.name);
      }
    }

    // Tools nativas (repo_map, etc.) nao vem de servidor MCP mas entram no
    // mesmo catalogo, entao o modelo as ve como qualquer outra ferramenta.
    this.tools = [...tools, ...this.nativeTools];
    return this.tools;
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  /**
   * Registra uma tool executada em processo pelo proprio harness.
   * Permite expor capacidades internas (ex.: `repo_map`) sem subir um servidor
   * MCP, mantendo o mesmo catalogo e o mesmo caminho de tool call.
   */
  registerNativeTool(
    def: ToolDefinition,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.nativeTools.push(def);
    this.nativeHandlers.set(`${def.server}__${def.name}`, handler);
    log.debug(`McpManager: tool nativa registrada "${def.server}.${def.name}".`);
  }

  /** Execute a tool on its owning server (or in-process when native). */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Tool nativa: intercepta antes de procurar um cliente MCP.
    const native = this.nativeHandlers.get(`${serverName}__${toolName}`);
    if (native) return native(args);

    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Servidor MCP "${serverName}" nao esta ativo.`);
    }
    return client.callTool(toolName, args);
  }

  /** Close transports and synchronously reap child processes (anti-zombie). */
  async killAll(): Promise<void> {
    // Best-effort async transport close first (frees pipes / sockets).
    await Promise.allSettled([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();

    // Synchronous signal escalation for any surviving stdio children.
    for (const pid of this.pids) {
      this.killPidSync(pid);
    }
    this.pids.clear();
  }

  /** Blocking, synchronous SIGTERM -> SIGKILL escalation for one pid. */
  killPidSync(pid: number): void {
    if (!isAlive(pid)) return;

    spawnSync('kill', ['-TERM', String(pid)], { stdio: 'ignore' });

    // Give it a brief, blocking grace period (sleep is a real child process).
    for (let i = 0; i < 20; i++) {
      if (!isAlive(pid)) return;
      spawnSync('sleep', ['0.1'], { stdio: 'ignore' });
    }

    if (isAlive(pid)) {
      spawnSync('kill', ['-KILL', String(pid)], { stdio: 'ignore' });
    }
  }

  private installTeardownHooks(): void {
    if (this.teardownHooksInstalled) return;
    this.teardownHooksInstalled = true;

    // `exit`: synchronous best-effort reap (no async allowed here).
    process.once('exit', () => {
      for (const pid of this.pids) this.killPidSync(pid);
    });

    // SIGINT / SIGTERM: async close then sync reap, then re-raise default.
    const handle = (signal: NodeJS.Signals) => {
      void this.killAll().finally(() => {
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
        process.exit();
      });
    };
    process.once('SIGINT', () => handle('SIGINT'));
    process.once('SIGTERM', () => handle('SIGTERM'));
  }
}

/** Check whether a pid is still alive (works without extra deps). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we lack permission; treat as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
