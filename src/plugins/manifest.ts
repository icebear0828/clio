import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { HooksConfig } from "../tools/hooks.js";
import type { McpServerConfig } from "../core/settings.js";
import type { PluginManifest, LspServerConfig, CommandDef } from "./types.js";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class ManifestError extends Error {
  constructor(pluginDir: string, detail: string) {
    super(`Plugin "${path.basename(pluginDir)}": ${detail}`);
  }
}

/**
 * Resolve a relative path within a plugin directory.
 * Rejects paths that escape the plugin root (traversal protection).
 */
export function resolvePluginPath(pluginDir: string, relPath: string): string {
  const resolved = path.resolve(pluginDir, relPath);
  if (!resolved.startsWith(pluginDir + path.sep) && resolved !== pluginDir) {
    throw new ManifestError(pluginDir, `path traversal blocked: ${relPath}`);
  }
  return resolved;
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringOrArray(v: unknown): string | string[] | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

function parseHooksField(raw: unknown, pluginDir: string): string | HooksConfig | undefined {
  if (typeof raw === "string") return resolvePluginPath(pluginDir, raw);
  if (isStringRecord(raw)) return raw as HooksConfig;
  return undefined;
}

function parseMcpField(
  raw: unknown,
  pluginDir: string,
): string | Record<string, McpServerConfig> | undefined {
  if (typeof raw === "string") return resolvePluginPath(pluginDir, raw);
  if (isStringRecord(raw)) {
    const result: Record<string, McpServerConfig> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!isStringRecord(v) || typeof v.command !== "string") continue;
      result[k] = {
        command: v.command as string,
        args: Array.isArray(v.args) ? (v.args as string[]) : undefined,
        env: isStringRecord(v.env) ? (v.env as Record<string, string>) : undefined,
      };
    }
    return result;
  }
  return undefined;
}

function parseLspField(raw: unknown): Record<string, LspServerConfig> | undefined {
  if (!isStringRecord(raw)) return undefined;
  const result: Record<string, LspServerConfig> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isStringRecord(v) || typeof v.command !== "string") continue;
    const ext = v.extensionToLanguage;
    if (!isStringRecord(ext)) continue;
    result[k] = {
      command: v.command as string,
      args: Array.isArray(v.args) ? (v.args as string[]) : undefined,
      env: isStringRecord(v.env) ? (v.env as Record<string, string>) : undefined,
      extensionToLanguage: ext as Record<string, string>,
      transport: v.transport === "socket" ? "socket" : "stdio",
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseCommandsField(raw: unknown): Record<string, CommandDef> | undefined {
  if (!isStringRecord(raw)) return undefined;
  const result: Record<string, CommandDef> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      result[k] = { source: v };
    } else if (isStringRecord(v)) {
      result[k] = {
        source: typeof v.source === "string" ? v.source : undefined,
        content: typeof v.content === "string" ? v.content : undefined,
        description: typeof v.description === "string" ? v.description : undefined,
        trigger: typeof v.trigger === "string" ? v.trigger : undefined,
      };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse and validate a raw JSON object as a PluginManifest.
 */
export function parseManifest(raw: unknown, pluginDir: string): PluginManifest {
  if (!isStringRecord(raw)) {
    throw new ManifestError(pluginDir, "plugin.json must be a JSON object");
  }

  const name = raw.name;
  if (typeof name !== "string" || !KEBAB_RE.test(name)) {
    throw new ManifestError(pluginDir, `"name" must be kebab-case, got: ${JSON.stringify(name)}`);
  }

  const manifest: PluginManifest = { name };

  if (typeof raw.version === "string") manifest.version = raw.version;
  if (typeof raw.description === "string") manifest.description = raw.description;
  if (isStringRecord(raw.author) && typeof raw.author.name === "string") {
    manifest.author = {
      name: raw.author.name as string,
      email: typeof raw.author.email === "string" ? raw.author.email : undefined,
      url: typeof raw.author.url === "string" ? raw.author.url : undefined,
    };
  }

  const skills = asStringOrArray(raw.skills);
  if (skills !== undefined) manifest.skills = skills;

  const agents = asStringOrArray(raw.agents);
  if (agents !== undefined) manifest.agents = agents;

  const hooks = parseHooksField(raw.hooks, pluginDir);
  if (hooks !== undefined) manifest.hooks = hooks;

  const mcp = parseMcpField(raw.mcpServers, pluginDir);
  if (mcp !== undefined) manifest.mcpServers = mcp;

  const lsp = parseLspField(raw.lspServers);
  if (lsp !== undefined) manifest.lspServers = lsp;

  const cmds = parseCommandsField(raw.commands);
  if (cmds !== undefined) manifest.commands = cmds;

  if (isStringRecord(raw.settings)) manifest.settings = raw.settings as Record<string, unknown>;

  return manifest;
}

/**
 * Read and parse plugin.json from a plugin directory.
 */
export async function readManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = path.join(pluginDir, "plugin.json");
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  return parseManifest(raw, pluginDir);
}
