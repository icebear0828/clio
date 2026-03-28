import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readManifest } from "./manifest.js";
import type { LoadedPlugin } from "./types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

async function scanPluginDir(
  baseDir: string,
  source: "global" | "project",
): Promise<LoadedPlugin[]> {
  const plugins: LoadedPlugin[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return plugins;
  }

  for (const entry of entries) {
    const pluginDir = path.join(baseDir, entry);
    const stat = await fs.stat(pluginDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    try {
      const manifest = await readManifest(pluginDir);
      plugins.push({ manifest, dir: pluginDir, source });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ${dim(`Plugin load error (${entry}): ${msg}`)}\n`);
    }
  }

  return plugins;
}

/**
 * Discover plugins from global (~/.clio/plugins/) and project (.clio/plugins/) directories.
 * Project plugins override global plugins with the same name.
 */
export async function discoverPlugins(): Promise<LoadedPlugin[]> {
  const globalDir = path.join(os.homedir(), ".clio", "plugins");
  const projectDir = path.resolve(".clio", "plugins");

  const [globalPlugins, projectPlugins] = await Promise.all([
    scanPluginDir(globalDir, "global"),
    scanPluginDir(projectDir, "project"),
  ]);

  // Project plugins override global by name
  const byName = new Map<string, LoadedPlugin>();
  for (const p of globalPlugins) byName.set(p.manifest.name, p);
  for (const p of projectPlugins) byName.set(p.manifest.name, p);

  return [...byName.values()];
}
