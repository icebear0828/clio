import type { SystemPromptSection, SystemPromptBlock } from "../types.js";
import { DEFERRED_TOOL_NAMES } from "../tools/index.js";
import { SectionCache } from "./section-cache.js";
import { getEnvironmentInfo, loadClaudeMd, loadGitContext } from "./context.js";
import { createBillingHeader } from "./billing.js";
import {
  getIdentity,
  getToolInstructions,
  getCodingGuidelines,
  getSafetyInstructions,
  getToneStyle,
  getOutputEfficiency,
} from "./prompts.js";
import { listSkills } from "../skills/index.js";

function createSectionRegistry(): SystemPromptSection[] {
  const cwd = process.cwd();

  return [
    // ── Static sections (cached for session, global scope) ──
    { name: "tool-instructions", cacheBreak: false, scope: "global", compute: getToolInstructions },
    { name: "coding-guidelines", cacheBreak: false, scope: "global", compute: getCodingGuidelines },
    { name: "safety",            cacheBreak: false, scope: "global", compute: getSafetyInstructions },
    { name: "tone-style",        cacheBreak: false, scope: "global", compute: getToneStyle },
    { name: "output-efficiency", cacheBreak: false, scope: "global", compute: getOutputEfficiency },
    {
      name: "deferred-tools",
      cacheBreak: false,
      scope: "global",
      compute: () => Promise.resolve(
        DEFERRED_TOOL_NAMES.size > 0
          ? `<available-deferred-tools>\nThe following deferred tools are available via ToolSearch:\n${[...DEFERRED_TOOL_NAMES].join(", ")}\n</available-deferred-tools>`
          : null
      ),
    },

    {
      name: "available-skills",
      cacheBreak: true,
      compute: () => {
        const skills = listSkills();
        if (skills.length === 0) return Promise.resolve(null);
        const lines = skills.map(s => {
          let line = `- ${s.name}: ${s.description}`;
          if (s.trigger) line += `\n  TRIGGER when: ${s.trigger}`;
          return line;
        });
        return Promise.resolve(
          `The following skills are available for use with the Skill tool:\n\n${lines.join("\n")}`
        );
      },
    },

    // ── Dynamic sections (recomputed every turn) ──
    { name: "environment",  cacheBreak: true, compute: getEnvironmentInfo },
    { name: "git-context",  cacheBreak: true, compute: () => loadGitContext(cwd) },
    { name: "claude-md",    cacheBreak: true, compute: () => loadClaudeMd(cwd) },
  ];
}

export async function buildSystemSections(
  cache: SectionCache,
): Promise<SystemPromptBlock[]> {
  const billing = createBillingHeader();

  const identityText = await getIdentity();
  const identity: SystemPromptBlock = { type: "text", text: identityText ?? "" };

  const sections = createSectionRegistry();
  const blocks = await cache.processSections(sections);

  return [billing, identity, ...blocks];
}

export function getSubAgentSystemPrompt(): string {
  return [
    "You are an agent for Claude Code, Anthropic's official CLI for Claude.",
    "Given the user's message, you should use the tools available to complete the task.",
    "Complete the task fully — don't gold-plate, but don't leave it half-done.",
    "When you complete the task, respond with a concise report covering what was done and any key findings.",
    "",
    "Notes:",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task.",
    "- Do not use emojis.",
    "- Do not use a colon before tool calls.",
  ].join("\n");
}
