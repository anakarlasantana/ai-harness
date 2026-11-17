import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from '../core/logger.js';
import type { ServerConfig } from './McpRegistry.js';

export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Thin wrapper around a single MCP server connection using the official SDK.
 * Handles stdio (spawn) and streamable-HTTP transports. The underlying stdio
 * transport keeps the spawned child PID on `.transport.pid` so McpManager can
 * guarantee a zombie-free teardown.
 */
export class McpClient {
  readonly serverName: string;
  private readonly config: ServerConfig;
  private client: Client | null = null;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private connected = false;

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverName = config.name;
  }

  /** The OS pid of the spawned child (stdio only), if available. */
  get pid(): number | undefined {
    const t = this.transport;
    if (t instanceof StdioClientTransport) {
      return (t as unknown as { pid?: number }).pid;
    }
    return undefined;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const client = new Client({ name: `ai-harness:${this.serverName}`, version: '0.1.0' });

    if (this.config.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
        stderr: 'ignore',
      });
      this.transport = transport;
      await client.connect(transport);
    } else {
      const opts =
        this.config.headers && Object.keys(this.config.headers).length > 0
          ? { requestInit: { headers: this.config.headers } }
          : undefined;
      const transport = new StreamableHTTPClientTransport(new URL(this.config.url), opts);
      this.transport = transport;
      await client.connect(transport);
    }

    this.client = client;
    this.connected = true;
    log.debug(`McpClient[${this.serverName}]: conectado (${this.config.transport}).`);
  }

  async listTools(): Promise<RawTool[]> {
    if (!this.client) await this.connect();
    const res = await this.client!.listTools();
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) await this.connect();
    const res = await this.client!.callTool({ name, arguments: args });
    return res;
  }

  async close(): Promise<void> {
    try {
      if (this.transport) await this.transport.close();
    } catch (err) {
      log.debug(`McpClient[${this.serverName}]: erro ao fechar transport: ${(err as Error).message}`);
    }
    this.connected = false;
  }
}
