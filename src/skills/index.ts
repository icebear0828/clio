export interface SkillDefinition {
  name: string;
  description: string;
  trigger?: string;
  promptTemplate: string;
  source: "builtin" | "global" | "project";
}

const registry = new Map<string, SkillDefinition>();

export function registerSkill(skill: SkillDefinition): void {
  registry.set(skill.name, skill);
}

export function getSkill(name: string): SkillDefinition | undefined {
  return registry.get(name);
}

export function listSkills(): SkillDefinition[] {
  return [...registry.values()];
}

export function clearSkills(): void {
  registry.clear();
}
