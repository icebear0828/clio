import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";

const execAsync = promisify(exec);

/**
 * Walk up from cwd to find all CLAUDE.md files (closest first).
 * Also checks for .claude/CLAUDE.md in each directory.
 */
async function findClaudeMdFiles(cwd: string): Promise<string[]> {
  const found: string[] = [];
  let dir = path.resolve(cwd);

  while (true) {
    for (const name of ["CLAUDE.md", path.join(".claude", "CLAUDE.md")]) {
      const filePath = path.join(dir, name);
      try {
        await fs.access(filePath);
        found.push(filePath);
      } catch {
        // not found
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  // Reverse: root-level first, closest last (so closest takes precedence)
  return found.reverse();
}

/**
 * Load and concatenate all CLAUDE.md content.
 */
export async function loadClaudeMd(cwd: string): Promise<string | null> {
  const files = await findClaudeMdFiles(cwd);
  if (files.length === 0) return null;

  const sections: string[] = [];
  for (const file of files) {
    try {
      const content = (await fs.readFile(file, "utf-8")).trim();
      if (content) {
        const rel = path.relative(cwd, file);
        sections.push(`# Instructions from ${rel}\n\n${content}`);
      }
    } catch {
      // skip unreadable
    }
  }

  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

/**
 * Collect git context: branch, status, recent commits.
 * Returns null if not in a git repo.
 */
export async function loadGitContext(cwd: string): Promise<string | null> {
  try {
    const run = (cmd: string) =>
      execAsync(cmd, { cwd, timeout: 5000 }).then((r) => r.stdout.trim());

    const [branch, status, log] = await Promise.all([
      run("git rev-parse --abbrev-ref HEAD"),
      run("git status --short"),
      run("git log --oneline -5"),
    ]);

    const lines = [`# Git Context`, `- Branch: ${branch}`];

    if (status) {
      const fileCount = status.split("\n").length;
      lines.push(`- Working tree: ${fileCount} changed file(s)`);
      lines.push("```\n" + status + "\n```");
    } else {
      lines.push("- Working tree: clean");
    }

    if (log) {
      lines.push("\nRecent commits:");
      lines.push("```\n" + log + "\n```");
    }

    return lines.join("\n");
  } catch {
    return null; // not a git repo or git not available
  }
}

/**
 * Environment info section.
 */
export function getEnvironmentInfo(): Promise<string | null> {
  const cwd = process.cwd();
  return Promise.resolve(
    [
      "# Environment",
      `- Working directory: ${cwd}`,
      `- Platform: ${os.platform()} ${os.release()}`,
      `- Shell: bash`,
      `- User: ${os.userInfo().username}`,
    ].join("\n"),
  );
}

/**
 * Build the full system prompt with environment, CLAUDE.md, and git context.
 * Kept for backward compatibility (/btw, /context, etc.)
 */
export async function buildSystemPrompt(): Promise<string> {
  const cwd = process.cwd();

  const sections: string[] = [];

  const [env, claudeMd, gitCtx] = await Promise.all([
    getEnvironmentInfo(),
    loadClaudeMd(cwd),
    loadGitContext(cwd),
  ]);

  if (env) sections.push(env);
  if (gitCtx) sections.push(gitCtx);
  if (claudeMd) sections.push(claudeMd);

  return sections.join("\n\n");
}
