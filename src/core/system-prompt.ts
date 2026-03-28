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
  getAgentToolInstructions,
  getMemoryInstructions,
} from "./prompts.js";
import { loadMemoryIndex } from "./memory.js";
import { listSkills } from "../skills/index.js";
import { getLspDiagnosticsSummary } from "../tools/lsp.js";

// ── Dynamic section registration (for plugins) ──
const extraSections: SystemPromptSection[] = [];

export function registerSystemSection(section: SystemPromptSection): void {
  extraSections.push(section);
}

function createSectionRegistry(): SystemPromptSection[] {
  const cwd = process.cwd();

  return [
    // ── Static sections (cached for session, global scope) ──
    { name: "tool-instructions", cacheBreak: false, scope: "global", compute: getToolInstructions },
    { name: "coding-guidelines", cacheBreak: false, scope: "global", compute: getCodingGuidelines },
    { name: "safety",            cacheBreak: false, scope: "global", compute: getSafetyInstructions },
    { name: "tone-style",        cacheBreak: false, scope: "global", compute: getToneStyle },
    { name: "output-efficiency", cacheBreak: false, scope: "global", compute: getOutputEfficiency },
    { name: "agent-tool",        cacheBreak: false, scope: "global", compute: getAgentToolInstructions },
    { name: "memory",            cacheBreak: false, scope: "global", compute: getMemoryInstructions },
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
    { name: "memory-index", cacheBreak: true, compute: () => loadMemoryIndex(cwd) },
    {
      name: "lsp-diagnostics",
      cacheBreak: true,
      compute: () => {
        const summary = getLspDiagnosticsSummary();
        return Promise.resolve(
          summary ? `<lsp-diagnostics>\n${summary}\n</lsp-diagnostics>` : null
        );
      },
    },

    // ── Plugin-registered sections ──
    ...extraSections,
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

export function getSubAgentSystemPrompt(agentType?: string): string {
  if (agentType === "Explore") {
    return `You are a fast codebase exploration agent for Claude Code.
Your job is to quickly find files, search code, and answer questions about the codebase structure.

Guidelines:
- Use Glob to find files by pattern (e.g., "src/**/*.tsx")
- Use Grep to search code content (e.g., "export class", "API_URL")
- Use Read to examine specific files when needed
- Be thorough but efficient — try multiple search strategies if the first doesn't find what you need
- Consider different naming conventions (camelCase, snake_case, kebab-case, PascalCase)
- Search in common locations: src/, lib/, packages/, apps/, test/, tests/
- When the user asks for "very thorough" exploration, check ALL directories and naming patterns
- Return results organized by relevance, with absolute file paths
- Do not modify any files — this is a read-only exploration agent
- Do not use emojis
- Be concise in your final report`;
  }

  if (agentType === "Plan") {
    return `You are a software architect agent for Claude Code.
Your job is to design implementation plans for coding tasks.

Guidelines:
- Read relevant files to understand the current architecture before planning
- Use Glob and Grep to discover the codebase structure and patterns
- Return a step-by-step implementation plan with:
  1. Files that need to be created or modified (with absolute paths)
  2. Key changes in each file
  3. Dependencies between steps (what must happen first)
  4. Potential risks or trade-offs
  5. Testing strategy
- Consider existing patterns and conventions in the codebase
- Identify critical files that must not be broken
- Do not write any code or modify any files — this is a planning-only agent
- Do not use emojis
- Keep the plan actionable and specific, not vague`;
  }

  return `You are an agent for Claude Code, Anthropic's official CLI for Claude.
Given the user's message, you should use the tools available to complete the task.
Complete the task fully — don't gold-plate, but don't leave it half-done.
When you complete the task, respond with a concise report covering what was done and any key findings.

Notes:
- In your final response, share file paths (always absolute, never relative) that are relevant to the task.
- Do not use emojis.
- Do not use a colon before tool calls.`;
}
