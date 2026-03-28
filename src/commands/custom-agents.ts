import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface CustomAgentDef {
  name: string;
  systemPrompt: string;
  allowedTools?: string[];
  model?: string;
  maxIterations?: number;
}

const registry = new Map<string, CustomAgentDef>();

export function getCustomAgent(name: string): CustomAgentDef | undefined {
  return registry.get(name);
}

export function listCustomAgents(): string[] {
  return [...registry.keys()];
}

function parseFrontMatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!content.startsWith("---")) return { meta, body: content };

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return { meta, body: content };

  const frontMatter = content.slice(3, endIdx).trim();
  for (const line of frontMatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) meta[key] = value;
  }

  const body = content.slice(endIdx + 3).trim();
  return { meta, body };
}

function parseAgentFile(name: string, content: string): CustomAgentDef {
  const { meta, body } = parseFrontMatter(content);

  const def: CustomAgentDef = { name, systemPrompt: body };

  if (meta.tools) {
    def.allowedTools = meta.tools.split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (meta.model) {
    def.model = meta.model;
  }
  if (meta.max_iterations) {
    const n = parseInt(meta.max_iterations, 10);
    if (!isNaN(n) && n > 0) def.maxIterations = n;
  }

  return def;
}

async function scanDir(dirPath: string): Promise<Map<string, CustomAgentDef>> {
  const result = new Map<string, CustomAgentDef>();
  try {
    const entries = await fs.readdir(dirPath);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -3);
      const filePath = path.join(dirPath, entry);
      const content = await fs.readFile(filePath, "utf-8");
      result.set(name, parseAgentFile(name, content));
    }
  } catch {
    // Directory doesn't exist, that's fine
  }
  return result;
}

export async function loadCustomAgents(): Promise<void> {
  registry.clear();

  const globalDir = path.join(os.homedir(), ".clio", "agents");
  const globalAgents = await scanDir(globalDir);
  for (const [name, def] of globalAgents) {
    registry.set(name, def);
  }

  const projectDir = path.resolve(".clio", "agents");
  const projectAgents = await scanDir(projectDir);
  for (const [name, def] of projectAgents) {
    registry.set(name, def);
  }
}
