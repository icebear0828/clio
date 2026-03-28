import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HooksConfig } from "../tools/hooks.js";
import type { McpServerConfig, Settings } from "../core/settings.js";
import { registerSkill } from "../skills/index.js";
import { registerAgent, parseAgentFile } from "../commands/custom-agents.js";
import { discoverPlugins } from "./loader.js";
import { resolvePluginPath } from "./manifest.js";
import type { LoadedPlugin, PluginContributions, LspServerConfig } from "./types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

let loadedPlugins: LoadedPlugin[] = [];

export function getLoadedPlugins(): LoadedPlugin[] {
  return loadedPlugins;
}

// ── Skill injection ──

function parseFrontMatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { meta, body: match[2] };
}

async function injectSkills(plugin: LoadedPlugin): Promise<void> {
  const dirs = typeof plugin.manifest.skills === "string"
    ? [plugin.manifest.skills]
    : plugin.manifest.skills ?? ["skills"];

  for (const rel of dirs) {
    const dir = resolvePluginPath(plugin.dir, rel);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const content = await fs.readFile(path.join(dir, entry), "utf-8");
      const { meta, body } = parseFrontMatter(content);
      const name = meta.name || path.basename(entry, ".md");
      registerSkill({
        name,
        description: meta.description || name,
        trigger: meta.trigger,
        promptTemplate: body.trim(),
        source: "plugin",
        pluginName: plugin.manifest.name,
      });
    }
  }
}

// ── Agent injection ──

async function injectAgents(plugin: LoadedPlugin): Promise<void> {
  const paths = typeof plugin.manifest.agents === "string"
    ? [plugin.manifest.agents]
    : plugin.manifest.agents ?? ["agents"];

  for (const rel of paths) {
    const target = resolvePluginPath(plugin.dir, rel);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const entries = await fs.readdir(target);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const content = await fs.readFile(path.join(target, entry), "utf-8");
        const name = path.basename(entry, ".md");
        registerAgent(name, parseAgentFile(name, content));
      }
    } else if (stat.isFile() && target.endsWith(".md")) {
      const content = await fs.readFile(target, "utf-8");
      const name = path.basename(target, ".md");
      registerAgent(name, parseAgentFile(name, content));
    }
  }
}

// ── Command injection (registered as skills) ──

async function injectCommands(plugin: LoadedPlugin): Promise<void> {
  if (!plugin.manifest.commands) return;

  for (const [name, cmd] of Object.entries(plugin.manifest.commands)) {
    let promptTemplate: string;
    if (cmd.content) {
      promptTemplate = cmd.content;
    } else if (cmd.source) {
      const filePath = resolvePluginPath(plugin.dir, cmd.source);
      const content = await fs.readFile(filePath, "utf-8");
      const { body } = parseFrontMatter(content);
      promptTemplate = body.trim();
    } else {
      continue;
    }

    registerSkill({
      name,
      description: cmd.description || name,
      trigger: cmd.trigger,
      promptTemplate,
      source: "plugin",
      pluginName: plugin.manifest.name,
    });
  }
}

// ── Hooks collection ──

async function collectHooks(plugin: LoadedPlugin): Promise<HooksConfig> {
  const raw = plugin.manifest.hooks;
  if (!raw) return {};

  if (typeof raw === "string") {
    const filePath = resolvePluginPath(plugin.dir, raw);
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    const hooks = content.hooks ?? content;
    return hooks as HooksConfig;
  }

  return raw;
}

// ── MCP collection ──

async function collectMcpServers(
  plugin: LoadedPlugin,
): Promise<Record<string, McpServerConfig>> {
  const raw = plugin.manifest.mcpServers;
  if (!raw) return {};

  if (typeof raw === "string") {
    const filePath = resolvePluginPath(plugin.dir, raw);
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    return content as Record<string, McpServerConfig>;
  }

  return raw;
}

// ── LSP collection ──

function collectLspServers(plugin: LoadedPlugin): Record<string, LspServerConfig> {
  return plugin.manifest.lspServers ?? {};
}

// ── Main entry point ──

/**
 * Discover all plugins, inject skills/agents/commands into their registries,
 * and return aggregated hooks/mcpServers/lspServers for main() to merge.
 */
export async function initPlugins(settings: Settings): Promise<PluginContributions> {
  loadedPlugins = await discoverPlugins();

  const contributions: PluginContributions = {
    mcpServers: {},
    hooks: { pre: [], post: [] },
    lspServers: {},
  };

  for (const plugin of loadedPlugins) {
    try {
      // Inject into registries
      if (plugin.manifest.skills) await injectSkills(plugin);
      if (plugin.manifest.agents) await injectAgents(plugin);
      if (plugin.manifest.commands) await injectCommands(plugin);

      // Collect for deferred initialization
      const hooks = await collectHooks(plugin);
      if (hooks.pre) contributions.hooks.pre!.push(...hooks.pre);
      if (hooks.post) contributions.hooks.post!.push(...hooks.post);

      const mcp = await collectMcpServers(plugin);
      Object.assign(contributions.mcpServers, mcp);

      const lsp = collectLspServers(plugin);
      Object.assign(contributions.lspServers, lsp);

      process.stderr.write(`  ${dim(`Plugin loaded: ${plugin.manifest.name}`)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ${dim(`Plugin error (${plugin.manifest.name}): ${msg}`)}\n`);
    }
  }

  if (loadedPlugins.length > 0) {
    process.stderr.write(`  ${dim(`${loadedPlugins.length} plugin(s) loaded`)}\n`);
  }

  return contributions;
}
