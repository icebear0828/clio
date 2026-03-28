import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadSettings } from "./settings.js";

const execAsync = promisify(exec);

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function checkGit(): Promise<CheckResult> {
  try {
    const { stdout } = await execAsync("git --version");
    return { name: "Git", status: "ok", detail: stdout.trim() };
  } catch {
    return { name: "Git", status: "fail", detail: "git not found in PATH" };
  }
}

async function checkNode(): Promise<CheckResult> {
  const version = process.version;
  const major = parseInt(version.slice(1));
  return {
    name: "Node.js",
    status: major >= 18 ? "ok" : "warn",
    detail: `${version}${major < 18 ? " (recommend 18+)" : ""}`,
  };
}

async function checkApi(apiUrl: string, apiKey: string): Promise<CheckResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${apiUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { name: "API", status: res.ok || res.status === 400 ? "ok" : "warn", detail: `${apiUrl} → ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "API", status: "fail", detail: `${apiUrl} → ${msg}` };
  }
}

async function checkSettings(): Promise<CheckResult> {
  try {
    const settings = await loadSettings();
    const keys = Object.keys(settings);
    return { name: "Settings", status: "ok", detail: `${keys.length} keys loaded` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: "Settings", status: "warn", detail: msg };
  }
}

async function checkCwd(): Promise<CheckResult> {
  const cwd = process.cwd();
  const gitDir = await fs.stat(path.join(cwd, ".git")).catch(() => null);
  return { name: "Working Dir", status: "ok", detail: `${cwd}${gitDir ? " (git repo)" : ""}` };
}

export async function runDoctor(apiUrl: string, apiKey: string): Promise<string> {
  const checks = await Promise.all([
    checkGit(),
    checkNode(),
    checkApi(apiUrl, apiKey),
    checkSettings(),
    checkCwd(),
  ]);

  const icons: Record<string, string> = { ok: "+", warn: "!", fail: "x" };
  const lines = checks.map((c) => `  [${icons[c.status]}] ${c.name}: ${c.detail}`);

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;

  lines.push("");
  if (fails > 0) {
    lines.push(`  ${fails} issue(s) found.`);
  } else if (warns > 0) {
    lines.push(`  All checks passed with ${warns} warning(s).`);
  } else {
    lines.push("  All checks passed.");
  }

  return lines.join("\n");
}
