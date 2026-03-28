import { spawn, type ChildProcess } from "node:child_process";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

// ── Types ──

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── McpClient (one per MCP server) ──

class McpClient {
  private serverName: string;
  private config: McpServerConfig;
  private process: ChildProcess | null = null;
  private alive = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.config.env ?? {}) },
      shell: process.platform === "win32",
    });

    this.process = child;
    this.alive = true;

    child.stdout!.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split("\n");
      // Keep the last incomplete line in the buffer
      this.stdoutBuffer = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.handleLine(trimmed);
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) {
        process.stderr.write(dim(`[mcp:${this.serverName}] ${text}`) + "\n");
      }
    });

    child.on("exit", (_code, _signal) => {
      this.alive = false;
      for (const [id, req] of this.pending) {
        req.reject(new Error(`MCP server '${this.serverName}' exited unexpectedly`));
        clearTimeout(req.timer);
        this.pending.delete(id);
      }
    });

    // Send initialize request
    const initResult = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "clio", version: "0.0.1" },
    });

    if (!initResult) {
      throw new Error(`MCP server '${this.serverName}' returned empty initialize response`);
    }

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolSchema[]> {
    const result = await this.sendRequest("tools/list", {});
    const typed = result as { tools?: McpToolSchema[] };
    return typed.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return result as McpToolResult;
  }

  async stop(): Promise<void> {
    this.alive = false;
    for (const [id, req] of this.pending) {
      req.reject(new Error(`MCP server '${this.serverName}' is stopping`));
      clearTimeout(req.timer);
      this.pending.delete(id);
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.alive || !this.process?.stdin) {
        reject(new Error(`MCP server '${this.serverName}' is not running`));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0" as const,
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' to '${this.serverName}' timed out (30s)`));
      }, 30_000);

      this.pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + "\n";
      this.process.stdin.write(payload);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.alive || !this.process?.stdin) return;

    const notification = {
      jsonrpc: "2.0" as const,
      method,
      params,
    };

    this.process.stdin.write(JSON.stringify(notification) + "\n");
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Not valid JSON — ignore (could be debug output)
      return;
    }

    // Only handle responses with an id
    if (parsed.id == null) return;

    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.error) {
      pending.reject(
        new Error(`MCP error (${parsed.error.code}): ${parsed.error.message}`)
      );
    } else {
      pending.resolve(parsed.result);
    }
  }
}

// ── McpManager (singleton, coordinates all servers) ──

class McpManager {
  private clients = new Map<string, McpClient>();
  private toolMap = new Map<string, { server: string; originalName: string }>();
  private toolDefinitions: ToolDefinition[] = [];

  async startAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers);

    for (const [serverName, config] of entries) {
      try {
        const client = new McpClient(serverName, config);
        await client.start();
        this.clients.set(serverName, client);

        const tools = await client.listTools();
        for (const tool of tools) {
          const prefixedName = `mcp__${serverName}__${tool.name}`;
          this.toolMap.set(prefixedName, { server: serverName, originalName: tool.name });
          this.toolDefinitions.push({
            name: prefixedName,
            description: tool.description ?? "",
            input_schema: {
              type: "object" as const,
              properties: tool.inputSchema.properties ?? {},
              required: (tool.inputSchema.required ?? []) as string[],
            },
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(dim(`[mcp] Failed to start server '${serverName}': ${message}`) + "\n");
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.stop();
      } catch {
        // Tolerate failures during shutdown
      }
    }
    this.clients.clear();
    this.toolMap.clear();
    this.toolDefinitions = [];
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.toolDefinitions;
  }

  getServerNames(): string[] {
    return [...this.clients.keys()];
  }

  isMcpTool(name: string): boolean {
    return this.toolMap.has(name);
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    const mapping = this.toolMap.get(prefixedName);
    if (!mapping) {
      throw new Error(`Unknown MCP tool: ${prefixedName}`);
    }

    const client = this.clients.get(mapping.server);
    if (!client) {
      throw new Error(`MCP server '${mapping.server}' is not running`);
    }

    const result = await client.callTool(mapping.originalName, args);

    // Format result as string
    const parts: string[] = [];
    for (const item of result.content) {
      if (item.text) {
        parts.push(item.text);
      }
    }

    const text = parts.join("\n") || "(no output)";
    if (result.isError) {
      return `MCP tool error: ${text}`;
    }
    return text;
  }
}

// ── Module-level exports ──

let globalManager: McpManager | null = null;

export function setGlobalMcpManager(manager: McpManager): void {
  globalManager = manager;
}

export function getMcpToolDefinitions(): ToolDefinition[] {
  return globalManager?.getToolDefinitions() ?? [];
}

export { McpManager, type McpServerConfig };
