import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { PermissionMode, ApiFormat } from "./types.js";
import type { HooksConfig } from "./hooks.js";
import type { StatusBarField } from "./statusbar.js";

// ~/.c2a/
const GLOBAL_DIR = path.join(os.homedir(), ".c2a");
const GLOBAL_SETTINGS = path.join(GLOBAL_DIR, "settings.json");
const GLOBAL_LOCAL = path.join(GLOBAL_DIR, "settings.local.json");

// .c2a/ in project root
const PROJECT_DIR = ".c2a";
const PROJECT_SETTINGS = path.join(PROJECT_DIR, "settings.json");
const PROJECT_LOCAL = path.join(PROJECT_DIR, "settings.local.json");

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Settings {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  apiFormat?: ApiFormat;
  permissionMode?: PermissionMode;
  thinkingBudget?: number;
  allowRules?: string[];
  denyRules?: string[];
  allowOutsideCwd?: boolean;
  hooks?: HooksConfig;
  mcpServers?: Record<string, McpServerConfig>;
  statusBar?: {
    fields?: StatusBarField[];
  };
  autoClassifier?: {
    enabled?: boolean;
    safePatterns?: string[];
    dangerousPatterns?: string[];
  };
}

async function readJson(filePath: string): Promise<Settings> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as Settings;
  } catch {
    return {};
  }
}

/**
 * Deep merge two Settings objects.
 * Arrays (allowRules) are concatenated, objects (hooks) are merged,
 * scalars are overwritten by the later source.
 */
function mergeSettings(base: Settings, override: Settings): Settings {
  const result = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;

    if (key === "allowRules" && Array.isArray(value)) {
      result.allowRules = [...(result.allowRules ?? []), ...value];
    } else if (key === "denyRules" && Array.isArray(value)) {
      result.denyRules = [...(result.denyRules ?? []), ...value];
    } else if (key === "mcpServers" && typeof value === "object" && !Array.isArray(value)) {
      result.mcpServers = { ...(result.mcpServers ?? {}), ...(value as Record<string, McpServerConfig>) };
    } else if (key === "autoClassifier" && typeof value === "object" && !Array.isArray(value)) {
      const baseAc = result.autoClassifier ?? {};
      const overAc = value as NonNullable<Settings["autoClassifier"]>;
      result.autoClassifier = {
        ...baseAc,
        ...overAc,
        safePatterns: [...(baseAc.safePatterns ?? []), ...(overAc.safePatterns ?? [])],
        dangerousPatterns: [...(baseAc.dangerousPatterns ?? []), ...(overAc.dangerousPatterns ?? [])],
      };
    } else if (key === "hooks" && typeof value === "object") {
      const baseHooks = result.hooks ?? {};
      const overHooks = value as HooksConfig;
      result.hooks = {
        pre: [...(baseHooks.pre ?? []), ...(overHooks.pre ?? [])],
        post: [...(baseHooks.post ?? []), ...(overHooks.post ?? [])],
      };
    } else if (key === "statusBar") {
      result.statusBar = { ...(result.statusBar ?? {}), ...(override.statusBar ?? {}) };
    } else {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}

/**
 * Load settings with 4-level merge hierarchy:
 *
 *   ~/.c2a/settings.json          (global, committed)
 *   ~/.c2a/settings.local.json    (global, gitignored — secrets)
 *   .c2a/settings.json            (project, committed)
 *   .c2a/settings.local.json      (project, gitignored — secrets)
 *
 * Later files override earlier ones. Arrays concatenate.
 */
export async function loadSettings(): Promise<Settings> {
  const layers = await Promise.all([
    readJson(GLOBAL_SETTINGS),
    readJson(GLOBAL_LOCAL),
    readJson(path.resolve(PROJECT_SETTINGS)),
    readJson(path.resolve(PROJECT_LOCAL)),
  ]);

  let result: Settings = {};
  for (const layer of layers) {
    result = mergeSettings(result, layer);
  }
  return result;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  await fs.writeFile(GLOBAL_SETTINGS, JSON.stringify(settings, null, 2), "utf-8");
}

/** Return all settings file paths and which exist */
export async function getSettingsInfo(): Promise<Array<{ path: string; exists: boolean; level: string }>> {
  const files = [
    { path: GLOBAL_SETTINGS, level: "global" },
    { path: GLOBAL_LOCAL, level: "global (local)" },
    { path: path.resolve(PROJECT_SETTINGS), level: "project" },
    { path: path.resolve(PROJECT_LOCAL), level: "project (local)" },
  ];

  return Promise.all(
    files.map(async (f) => {
      try {
        await fs.access(f.path);
        return { ...f, exists: true };
      } catch {
        return { ...f, exists: false };
      }
    })
  );
}
