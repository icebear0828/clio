import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

function sanitizeCwd(cwd: string): string {
  return path.resolve(cwd).replace(/[:\\/]/g, "-").replace(/^-+/, "");
}

export function getProjectMemoryDir(cwd: string): string {
  return path.join(os.homedir(), ".clio", "projects", sanitizeCwd(cwd), "memory");
}

export async function loadMemoryIndex(cwd: string): Promise<string | null> {
  const dir = getProjectMemoryDir(cwd);
  const indexPath = path.join(dir, "MEMORY.md");

  try {
    const content = await fs.readFile(indexPath, "utf-8");
    return `You have a persistent, file-based memory system at \`${dir.replace(/\\/g, "/")}/\`.

The following is your memory index (MEMORY.md), loaded automatically each conversation:

${content.trim()}

To read a specific memory file, use the Read tool with the full path. To create or update memories, use Write/Edit on files in this directory and keep MEMORY.md updated as an index.`;
  } catch {
    return `You have a persistent, file-based memory system at \`${dir.replace(/\\/g, "/")}/\`. This directory may not exist yet — it will be created when you first write a memory file using the Write tool.

No memories saved yet. When you learn important information about the user, project, or receive feedback worth preserving across sessions, save it as a markdown file in the memory directory with YAML frontmatter (name, description, type) and add a one-line entry to MEMORY.md as an index.`;
  }
}
