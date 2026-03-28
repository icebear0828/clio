import type { HooksConfig } from "../tools/hooks.js";
import type { McpServerConfig } from "../core/settings.js";

// ── Plugin manifest (compatible with CC plugin.json schema) ──

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name: string; email?: string; url?: string };

  skills?: string | string[];
  agents?: string | string[];
  hooks?: string | HooksConfig;
  mcpServers?: string | Record<string, McpServerConfig>;
  lspServers?: Record<string, LspServerConfig>;
  commands?: Record<string, CommandDef>;
  settings?: Record<string, unknown>;
}

export interface LspServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  extensionToLanguage: Record<string, string>;
  transport?: "stdio" | "socket";
}

export interface CommandDef {
  source?: string;
  content?: string;
  description?: string;
  trigger?: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  source: "global" | "project";
}

export interface PluginContributions {
  mcpServers: Record<string, McpServerConfig>;
  hooks: HooksConfig;
  lspServers: Record<string, LspServerConfig>;
}
