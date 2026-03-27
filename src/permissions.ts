import * as readline from "node:readline/promises";
import { bold, dim } from "./render.js";
import type { PermissionMode } from "./types.js";

type ToolCategory = "safe" | "dangerous" | "write";

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: "safe",
  Glob: "safe",
  Grep: "safe",
  WebFetch: "safe",
  Bash: "dangerous",
  Write: "write",
  Edit: "write",
};

export class PermissionManager {
  private alwaysAllowed = new Set<string>();
  private allowPatterns: RegExp[];

  constructor(private mode: PermissionMode, allowRules: string[] = []) {
    this.allowPatterns = allowRules.map((rule) => {
      // Convert glob-like pattern to regex: "npm *" → /^npm .*$/
      const escaped = rule
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(`^${escaped}$`);
    });
  }

  async check(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<"allow" | "deny"> {
    if (this.mode === "auto") return "allow";

    const category = TOOL_CATEGORIES[toolName] ?? "dangerous";

    if (category === "safe") return "allow";

    if (this.mode === "plan") return "deny";

    if (this.alwaysAllowed.has(toolName)) return "allow";

    // Check allow patterns for Bash commands
    if (toolName === "Bash" && typeof toolInput.command === "string") {
      if (this.matchesAllowRule(toolInput.command)) return "allow";
    }

    return this.promptUser(toolName);
  }

  private matchesAllowRule(command: string): boolean {
    return this.allowPatterns.some((re) => re.test(command));
  }

  private async promptUser(toolName: string): Promise<"allow" | "deny"> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    try {
      const answer = await new Promise<string>((resolve) => {
        rl.once("close", () => resolve("\x03"));

        const label = `  Allow ${bold(toolName)}? ${dim("[Y]es / [n]o / [a]lways")} > `;
        rl.question(label).then(resolve).catch(() => resolve("\x03"));
      });

      const normalized = answer.trim().toLowerCase();

      if (normalized === "\x03" || normalized === "n" || normalized === "no") {
        return "deny";
      }

      if (normalized === "a" || normalized === "always") {
        this.alwaysAllowed.add(toolName);
        return "allow";
      }

      return "allow";
    } finally {
      rl.close();
    }
  }
}
