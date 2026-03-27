import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { apiRequest } from "./client.js";
import type { Config } from "./types.js";

const execAsync = promisify(exec);

const INIT_PROMPT = `Based on the project context below, generate a CLAUDE.md file that gives an AI assistant the essential information it needs to work on this project.

Include:
- Project overview (1-2 sentences)
- Tech stack
- Key commands (build, test, lint, dev server)
- Project structure (important directories)
- Code conventions and patterns specific to this project
- Any gotchas or important context

Keep it concise — bullet points, not paragraphs. Only include information derivable from the project files shown.`;

async function gatherProjectContext(cwd: string): Promise<string> {
  const sections: string[] = [];

  // package.json
  for (const name of ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt"]) {
    try {
      const content = await fs.readFile(path.join(cwd, name), "utf-8");
      sections.push(`## ${name}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``);
    } catch { /* not found */ }
  }

  // README (first 2000 chars)
  for (const name of ["README.md", "README.rst", "README.txt", "README"]) {
    try {
      const content = await fs.readFile(path.join(cwd, name), "utf-8");
      sections.push(`## ${name}\n${content.slice(0, 2000)}`);
      break;
    } catch { /* not found */ }
  }

  // Directory structure (top 2 levels)
  try {
    const files = await fg("**/*", {
      cwd,
      deep: 2,
      onlyFiles: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/__pycache__/**"],
    });
    sections.push(`## Directory structure\n${files.slice(0, 80).join("\n")}`);
  } catch { /* glob failed */ }

  // Git info
  try {
    const { stdout: remotes } = await execAsync("git remote -v", { cwd, timeout: 3000 });
    if (remotes.trim()) sections.push(`## Git remotes\n${remotes.trim()}`);
  } catch { /* not a git repo */ }

  // Existing config files
  for (const name of ["tsconfig.json", ".eslintrc.json", "vite.config.ts", "next.config.js", "Makefile"]) {
    try {
      const content = await fs.readFile(path.join(cwd, name), "utf-8");
      sections.push(`## ${name}\n\`\`\`\n${content.slice(0, 1500)}\n\`\`\``);
    } catch { /* not found */ }
  }

  return sections.join("\n\n");
}

export async function initClaudeMd(config: Config): Promise<string> {
  const cwd = process.cwd();
  const target = path.join(cwd, "CLAUDE.md");

  // Check if already exists
  try {
    await fs.access(target);
    throw new Error("CLAUDE.md already exists. Delete it first or edit manually.");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const context = await gatherProjectContext(cwd);

  const result = await apiRequest(config, {
    model: config.model,
    max_tokens: 4096,
    messages: [{ role: "user", content: `${INIT_PROMPT}\n\n---\n\n${context}` }],
  });

  const content = result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (!content) throw new Error("Empty response from API");

  await fs.writeFile(target, content, "utf-8");
  return target;
}
