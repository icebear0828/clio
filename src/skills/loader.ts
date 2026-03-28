import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { registerSkill, clearSkills, type SkillDefinition } from "./index.js";

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

async function scanSkillDir(dir: string, source: "global" | "project"): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = path.join(dir, entry.name);
      const content = await fs.readFile(filePath, "utf-8");
      const { meta, body } = parseFrontMatter(content);
      const name = meta.name || path.basename(entry.name, ".md");
      skills.push({
        name,
        description: meta.description || name,
        trigger: meta.trigger,
        promptTemplate: body.trim(),
        source,
      });
    }
  } catch {
  }
  return skills;
}

export async function loadSkills(): Promise<void> {
  clearSkills();

  const { builtinSkills } = await import("./builtins/index.js");
  for (const skill of builtinSkills) {
    registerSkill(skill);
  }

  const globalDir = path.join(os.homedir(), ".clio", "skills");
  const globalSkills = await scanSkillDir(globalDir, "global");
  for (const skill of globalSkills) {
    registerSkill(skill);
  }

  const projectDir = path.join(process.cwd(), ".clio", "skills");
  const projectSkills = await scanSkillDir(projectDir, "project");
  for (const skill of projectSkills) {
    registerSkill(skill);
  }
}
