import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { LspServerConfig } from "../plugins/types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

// ── Types ──

interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: 1 | 2 | 3 | 4; // Error, Warning, Info, Hint
  message: string;
  source?: string;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SEVERITY_LABELS = ["", "error", "warning", "info", "hint"] as const;

// ── LspClient (one per LSP server) ──

class LspClient {
  private process: ChildProcess | null = null;
  private alive = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private headerBuffer = "";
  private bodyBuffer = Buffer.alloc(0);
  private expectedLength = -1;
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private openDocuments = new Map<string, number>(); // uri -> version

  constructor(
    private serverName: string,
    private config: LspServerConfig,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.config.env ?? {}) },
      shell: process.platform === "win32",
    });

    this.process = child;
    this.alive = true;

    child.stdout!.on("data", (chunk: Buffer) => {
      this.handleData(chunk);
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) {
        process.stderr.write(dim(`[lsp:${this.serverName}] ${text}`) + "\n");
      }
    });

    child.on("exit", () => {
      this.alive = false;
      for (const [id, req] of this.pending) {
        req.reject(new Error(`LSP server '${this.serverName}' exited unexpectedly`));
        clearTimeout(req.timer);
        this.pending.delete(id);
      }
    });

    // Initialize handshake
    const initResult = await this.sendRequest("initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false },
        },
      },
      rootUri: pathToFileURL(process.cwd()).href,
      clientInfo: { name: "clio", version: "0.0.1" },
    });

    if (!initResult) {
      throw new Error(`LSP server '${this.serverName}' returned empty initialize response`);
    }

    this.sendNotification("initialized", {});
  }

  async stop(): Promise<void> {
    if (!this.alive) return;
    try {
      await this.sendRequest("shutdown", null);
      this.sendNotification("exit", null);
    } catch {
      // Best-effort
    }
    this.alive = false;
    for (const [id, req] of this.pending) {
      req.reject(new Error(`LSP server '${this.serverName}' is stopping`));
      clearTimeout(req.timer);
      this.pending.delete(id);
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  didOpen(filePath: string, languageId: string, text: string): void {
    const uri = pathToFileURL(path.resolve(filePath)).href;
    if (this.openDocuments.has(uri)) {
      this.didChange(filePath, text);
      return;
    }
    this.openDocuments.set(uri, 1);
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  didChange(filePath: string, text: string): void {
    const uri = pathToFileURL(path.resolve(filePath)).href;
    const version = (this.openDocuments.get(uri) ?? 0) + 1;
    this.openDocuments.set(uri, version);
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didClose(filePath: string): void {
    const uri = pathToFileURL(path.resolve(filePath)).href;
    if (!this.openDocuments.has(uri)) return;
    this.openDocuments.delete(uri);
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  getDiagnostics(): Map<string, LspDiagnostic[]> {
    return this.diagnostics;
  }

  // ── Content-Length framing ──

  private handleData(chunk: Buffer): void {
    this.bodyBuffer = Buffer.concat([this.bodyBuffer, chunk]);

    while (this.bodyBuffer.length > 0) {
      if (this.expectedLength === -1) {
        // Looking for headers
        const headerEnd = this.bodyBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // Need more data

        const headerStr = this.bodyBuffer.subarray(0, headerEnd).toString("utf-8");
        const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
        if (!match) {
          // Skip malformed header
          this.bodyBuffer = this.bodyBuffer.subarray(headerEnd + 4);
          continue;
        }

        this.expectedLength = parseInt(match[1], 10);
        this.bodyBuffer = this.bodyBuffer.subarray(headerEnd + 4);
      }

      if (this.bodyBuffer.length < this.expectedLength) return; // Need more data

      const jsonStr = this.bodyBuffer.subarray(0, this.expectedLength).toString("utf-8");
      this.bodyBuffer = this.bodyBuffer.subarray(this.expectedLength);
      this.expectedLength = -1;

      this.handleMessage(jsonStr);
    }
  }

  private handleMessage(json: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(json) as JsonRpcMessage;
    } catch {
      return;
    }

    // Response to a request
    if (msg.id != null && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`LSP error (${msg.error.code}): ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Notification from server
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
      if (params.diagnostics.length === 0) {
        this.diagnostics.delete(params.uri);
      } else {
        this.diagnostics.set(params.uri, params.diagnostics);
      }
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.alive || !this.process?.stdin) {
        reject(new Error(`LSP server '${this.serverName}' is not running`));
        return;
      }

      const id = this.nextId++;
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const message = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' to '${this.serverName}' timed out (30s)`));
      }, 30_000);

      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(message);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.alive || !this.process?.stdin) return;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    const message = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    this.process.stdin.write(message);
  }
}

// ── LspManager (coordinates all servers) ──

class LspManager {
  private clients = new Map<string, LspClient>();
  private extensionMap = new Map<string, string[]>(); // extension -> serverNames

  async startAll(servers: Record<string, LspServerConfig>): Promise<void> {
    for (const [serverName, config] of Object.entries(servers)) {
      try {
        const client = new LspClient(serverName, config);
        await client.start();
        this.clients.set(serverName, client);

        // Build extension -> server mapping
        for (const ext of Object.keys(config.extensionToLanguage)) {
          const existing = this.extensionMap.get(ext) ?? [];
          existing.push(serverName);
          this.extensionMap.set(ext, existing);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(dim(`[lsp] Failed to start server '${serverName}': ${message}`) + "\n");
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.stop();
      } catch {
        // Tolerate failures during shutdown
      }
    }
    this.clients.clear();
    this.extensionMap.clear();
  }

  notifyFileOpened(filePath: string, content: string): void {
    const ext = path.extname(filePath);
    const serverNames = this.extensionMap.get(ext);
    if (!serverNames) return;

    for (const name of serverNames) {
      const client = this.clients.get(name);
      if (!client) continue;
      // Find language ID from the server config
      const config = this.getConfig(name);
      const languageId = config?.extensionToLanguage[ext] ?? ext.slice(1);
      client.didOpen(filePath, languageId, content);
    }
  }

  notifyFileChanged(filePath: string, content: string): void {
    const ext = path.extname(filePath);
    const serverNames = this.extensionMap.get(ext);
    if (!serverNames) return;

    for (const name of serverNames) {
      const client = this.clients.get(name);
      if (client) client.didChange(filePath, content);
    }
  }

  getAllDiagnostics(): Map<string, LspDiagnostic[]> {
    const merged = new Map<string, LspDiagnostic[]>();
    for (const client of this.clients.values()) {
      for (const [uri, diags] of client.getDiagnostics()) {
        const existing = merged.get(uri) ?? [];
        existing.push(...diags);
        merged.set(uri, existing);
      }
    }
    return merged;
  }

  getServerNames(): string[] {
    return [...this.clients.keys()];
  }

  private configCache = new Map<string, LspServerConfig>();

  private getConfig(serverName: string): LspServerConfig | undefined {
    return this.configCache.get(serverName);
  }

  // Store configs during startAll for later lookup
  async startAllWithConfigs(servers: Record<string, LspServerConfig>): Promise<void> {
    for (const [name, config] of Object.entries(servers)) {
      this.configCache.set(name, config);
    }
    await this.startAll(servers);
  }
}

// ── Diagnostics summary for system prompt ──

const MAX_DIAGNOSTICS = 50;

function formatDiagnostics(allDiags: Map<string, LspDiagnostic[]>): string | null {
  if (allDiags.size === 0) return null;

  // Flatten and sort by severity (errors first)
  const entries: Array<{ file: string; diag: LspDiagnostic }> = [];
  for (const [uri, diags] of allDiags) {
    // Convert file URI to relative path
    let filePath: string;
    try {
      const url = new URL(uri);
      filePath = path.relative(process.cwd(), decodeURIComponent(url.pathname));
    } catch {
      filePath = uri;
    }
    // Fix Windows path: remove leading / from /C:/...
    if (process.platform === "win32" && filePath.startsWith("/")) {
      filePath = filePath.slice(1);
    }
    for (const diag of diags) {
      entries.push({ file: filePath, diag });
    }
  }

  entries.sort((a, b) => (a.diag.severity ?? 4) - (b.diag.severity ?? 4));
  const limited = entries.slice(0, MAX_DIAGNOSTICS);

  const lines: string[] = [];
  let currentFile = "";
  for (const { file, diag } of limited) {
    if (file !== currentFile) {
      currentFile = file;
      lines.push(file + ":");
    }
    const severity = SEVERITY_LABELS[diag.severity ?? 4] ?? "hint";
    const line = diag.range.start.line + 1;
    const source = diag.source ? ` (${diag.source})` : "";
    lines.push(`  Line ${line}: ${severity}: ${diag.message}${source}`);
  }

  if (entries.length > MAX_DIAGNOSTICS) {
    lines.push(`\n(${entries.length - MAX_DIAGNOSTICS} more diagnostics not shown)`);
  }

  return lines.join("\n");
}

// ── Module-level exports ──

let globalManager: LspManager | null = null;

export function setGlobalLspManager(manager: LspManager): void {
  globalManager = manager;
}

export function getLspManager(): LspManager | null {
  return globalManager;
}

export function getLspDiagnosticsSummary(): string | null {
  if (!globalManager) return null;
  return formatDiagnostics(globalManager.getAllDiagnostics());
}

export { LspManager, type LspServerConfig as LspServerConfigType, type LspDiagnostic };
