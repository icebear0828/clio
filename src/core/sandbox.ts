import * as path from "node:path";
import * as os from "node:os";

// ── Types ──

export interface SandboxFilesystemConfig {
  allowedPaths?: string[];
  deniedPaths?: string[];
  readOnlyPaths?: string[];
}

export interface SandboxNetworkConfig {
  enabled?: boolean;
}

export interface SandboxEnvironmentConfig {
  passthrough?: string[];
  block?: string[];
  override?: Record<string, string>;
}

export interface SandboxResourceConfig {
  maxMemoryMB?: number;
  maxCpuSeconds?: number;
}

export interface SandboxConfig {
  filesystem?: SandboxFilesystemConfig;
  network?: SandboxNetworkConfig;
  environment?: SandboxEnvironmentConfig;
  resources?: SandboxResourceConfig;
}

// ── Constants ──

const DEFAULT_BLOCKED_ENV = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "CLIO_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

const ESSENTIAL_ENV = ["PATH", "HOME", "TERM", "SHELL", "USER", "LANG", "TMPDIR", "TMP", "TEMP"];

const NETWORK_COMMANDS = [
  /\bcurl\b/, /\bwget\b/, /\bssh\b/, /\bnc\b/, /\bncat\b/,
  /\btelnet\b/, /\bftp\b/, /\bscp\b/, /\brsync\b/,
];

// ── Helpers ──

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.resolve(os.homedir(), p.slice(2));
  }
  return path.resolve(p);
}

function isUnder(filePath: string, dir: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(dir);
  const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
  return resolvedFile === resolvedDir || resolvedFile.startsWith(prefix);
}

// ── Sandbox ──

export class Sandbox {
  private allowedPaths: string[];
  private deniedPaths: string[];
  private readOnlyPaths: string[];
  private networkEnabled: boolean;
  private envConfig: SandboxEnvironmentConfig;
  private resourceConfig: SandboxResourceConfig;

  constructor(private config: SandboxConfig, private cwd: string) {
    this.allowedPaths = (config.filesystem?.allowedPaths ?? []).map(resolvePath);
    this.deniedPaths = (config.filesystem?.deniedPaths ?? []).map(resolvePath);
    this.readOnlyPaths = (config.filesystem?.readOnlyPaths ?? []).map(resolvePath);
    this.networkEnabled = config.network?.enabled !== false;
    this.envConfig = config.environment ?? {};
    this.resourceConfig = config.resources ?? {};
  }

  assertPathAllowed(filePath: string, mode: "read" | "write"): void {
    const resolved = path.resolve(filePath);

    // Denied paths — highest priority
    for (const denied of this.deniedPaths) {
      if (isUnder(resolved, denied)) {
        throw new Error(`Sandbox: path denied: ${filePath}`);
      }
    }

    // Read-only check
    if (mode === "write") {
      for (const ro of this.readOnlyPaths) {
        if (isUnder(resolved, ro)) {
          throw new Error(`Sandbox: path is read-only: ${filePath}`);
        }
      }
    }

    // Must be under cwd or an allowed path
    if (isUnder(resolved, this.cwd)) return;

    for (const allowed of this.allowedPaths) {
      if (isUnder(resolved, allowed)) return;
    }

    throw new Error(`Sandbox: path outside workspace: ${filePath} (cwd: ${this.cwd}). Add to sandbox.filesystem.allowedPaths to override.`);
  }

  buildEnvironment(extra?: Record<string, string>): Record<string, string> {
    const base = process.env;
    let result: Record<string, string> = {};

    if (this.envConfig.passthrough && this.envConfig.passthrough.length > 0) {
      // Whitelist mode: only pass through listed vars + essentials
      const allowed = new Set([...ESSENTIAL_ENV, ...this.envConfig.passthrough]);
      for (const key of allowed) {
        if (base[key] !== undefined) {
          result[key] = base[key]!;
        }
      }
    } else {
      // Blacklist mode: pass everything except blocked vars
      const blocked = new Set([...DEFAULT_BLOCKED_ENV, ...(this.envConfig.block ?? [])]);
      for (const [key, value] of Object.entries(base)) {
        if (!blocked.has(key) && value !== undefined) {
          result[key] = value;
        }
      }
    }

    // Apply overrides
    if (this.envConfig.override) {
      result = { ...result, ...this.envConfig.override };
    }

    // Apply extra env vars (e.g. hook vars)
    if (extra) {
      result = { ...result, ...extra };
    }

    return result;
  }

  validateCommand(command: string): { allowed: boolean; reason?: string } {
    if (!this.networkEnabled) {
      for (const re of NETWORK_COMMANDS) {
        if (re.test(command)) {
          return { allowed: false, reason: `network access disabled; command contains "${re.source}"` };
        }
      }
    }
    return { allowed: true };
  }

  buildExecOptions(command: string, timeout: number): {
    command: string;
    timeout: number;
    cwd: string;
    maxBuffer: number;
    env: Record<string, string>;
    shell: string;
  } {
    let finalCommand = command;
    const isWin = process.platform === "win32";

    // Resource limits via ulimit (Linux/Mac only)
    if (!isWin) {
      const limits: string[] = [];
      if (this.resourceConfig.maxMemoryMB) {
        limits.push(`ulimit -v ${this.resourceConfig.maxMemoryMB * 1024}`);
      }
      if (this.resourceConfig.maxCpuSeconds) {
        limits.push(`ulimit -t ${this.resourceConfig.maxCpuSeconds}`);
      }
      if (limits.length > 0) {
        finalCommand = `${limits.join("; ")}; ${command}`;
      }
    }

    return {
      command: finalCommand,
      timeout,
      cwd: this.cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: this.buildEnvironment(),
      shell: isWin ? "bash" : "/bin/bash",
    };
  }
}
