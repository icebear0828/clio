import { stdin } from "node:process";
import * as readline from "node:readline/promises";
import { bold, dim } from "../ui/render.js";
import type { PermissionMode } from "../types.js";

type ToolCategory = "safe" | "dangerous" | "write";

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: "safe",
  Glob: "safe",
  Grep: "safe",
  WebFetch: "safe",
  Bash: "dangerous",
  Write: "write",
  Edit: "write",
  WebSearch: "safe",
  AskUserQuestion: "safe",
  Agent: "dangerous",
  TaskCreate: "safe",
  TaskUpdate: "safe",
  TaskList: "safe",
  TaskGet: "safe",
};

function compileRules(rules: string[]): RegExp[] {
  return rules.map((rule) => {
    const escaped = rule
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  });
}

export interface AutoClassifierConfig {
  enabled: boolean;
  safePatterns?: string[];
  dangerousPatterns?: string[];
}

export class PermissionManager {
  private alwaysAllowed = new Set<string>();
  private allowPatterns: RegExp[];
  private denyPatterns: RegExp[];
  private classifierEnabled = false;
  private safeBashPatterns: RegExp[] = [];
  private dangerousBashPatterns: RegExp[] = [];

  private static readonly DEFAULT_SAFE_PATTERNS = [
    "git status*", "git log*", "git diff*", "git branch*", "git show*", "git remote*",
    "ls *", "ls", "cat *", "head *", "tail *", "wc *",
    "find *", "grep *", "rg *",
    "echo *", "pwd", "whoami", "which *", "type *", "where *",
    "node --version", "npm --version", "npx tsc --noEmit*",
    "date", "uname*", "hostname",
  ];

  private static readonly DEFAULT_DANGEROUS_PATTERNS = [
    "rm -rf *", "rm -r *",
    "git push --force*", "git push -f *",
    "git reset --hard*",
    "git clean -f*",
    "curl * | bash*", "curl * | sh*",
    "wget * | bash*", "wget * | sh*",
    "> /dev/null*",
    "chmod 777*",
    "sudo *",
  ];

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  constructor(private mode: PermissionMode, allowRules: string[] = [], denyRules: string[] = []) {
    this.allowPatterns = compileRules(allowRules);
    this.denyPatterns = compileRules(denyRules);
  }

  setAutoClassifier(config: AutoClassifierConfig): void {
    this.classifierEnabled = config.enabled;
    if (config.enabled) {
      const safeRules = [...PermissionManager.DEFAULT_SAFE_PATTERNS, ...(config.safePatterns ?? [])];
      const dangerousRules = [...PermissionManager.DEFAULT_DANGEROUS_PATTERNS, ...(config.dangerousPatterns ?? [])];
      this.safeBashPatterns = compileRules(safeRules);
      this.dangerousBashPatterns = compileRules(dangerousRules);
    }
  }

  async check(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<"allow" | "deny"> {
    if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") return "allow";

    // Deny rules — checked before everything else (safety constraint)
    if (toolName === "Bash" && typeof toolInput.command === "string") {
      if (this.matchesDenyRule(toolInput.command)) return "deny";
    }

    if (this.mode === "auto") {
      if (!this.classifierEnabled) return "allow";
      return this.classifyAutoMode(toolName, toolInput);
    }

    const category = TOOL_CATEGORIES[toolName] ?? "dangerous";

    if (category === "safe") return "allow";

    if (this.mode === "plan") return "deny";

    if (this.alwaysAllowed.has(toolName)) return "allow";

    if (toolName === "Bash" && typeof toolInput.command === "string") {
      if (this.matchesAllowRule(toolInput.command)) return "allow";
    }

    // MCP tools — check allow rules by tool name
    if (toolName.startsWith("mcp__") && this.matchesAllowRule(toolName)) return "allow";

    return this.promptUser(toolName);
  }

  private async classifyAutoMode(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<"allow" | "deny"> {
    const category = TOOL_CATEGORIES[toolName] ?? "dangerous";

    if (category === "safe") return "allow";

    if (toolName === "Bash" && typeof toolInput.command === "string") {
      const cmd = toolInput.command;
      if (this.dangerousBashPatterns.some((re) => re.test(cmd))) {
        return this.promptUser(toolName);
      }
      if (this.safeBashPatterns.some((re) => re.test(cmd))) {
        return "allow";
      }
      return this.promptUser(toolName);
    }

    if (category === "write") return this.promptUser(toolName);

    if (toolName === "Agent") return "allow";

    return this.promptUser(toolName);
  }

  private matchesAllowRule(value: string): boolean {
    return this.allowPatterns.some((re) => re.test(value));
  }

  private matchesDenyRule(command: string): boolean {
    return this.denyPatterns.some((re) => re.test(command));
  }

  private async promptUser(toolName: string): Promise<"allow" | "deny"> {
    const label = `  Allow ${bold(toolName)}? ${dim("[Y]es / [n]o / [a]lways")} `;
    process.stderr.write(label);

    // Non-TTY fallback
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: process.stderr });
      try {
        const answer = await rl.question("");
        const ch = answer.trim().toLowerCase();
        if (ch === "n" || ch === "no") return "deny";
        if (ch === "a" || ch === "always") { this.alwaysAllowed.add(toolName); return "allow"; }
        return "allow";
      } finally {
        rl.close();
      }
    }

    // Raw-mode single keypress
    return new Promise((resolve) => {
      const wasRaw = stdin.isRaw;
      if (!wasRaw) {
        stdin.setRawMode(true);
        stdin.resume();
      }

      const onData = (buf: Buffer) => {
        stdin.removeListener("data", onData);
        if (!wasRaw) {
          stdin.setRawMode(false);
          stdin.pause();
        }

        const ch = buf.toString().toLowerCase().trim();

        if (ch === "n" || ch === "\x03") {
          process.stderr.write(dim("no") + "\n");
          resolve("deny");
        } else if (ch === "a") {
          this.alwaysAllowed.add(toolName);
          process.stderr.write(dim("always") + "\n");
          resolve("allow");
        } else {
          process.stderr.write(dim("yes") + "\n");
          resolve("allow");
        }
      };

      stdin.on("data", onData);
    });
  }
}
