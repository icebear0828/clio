import { stdin } from "node:process";
import * as readline from "node:readline/promises";
import { bold, dim, renderPermissionPrompt, renderPermissionResponse } from "../ui/render.js";
import type { PermissionMode } from "../types.js";
import type { ClassifierResult } from "./llm-classifier.js";

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
  private llmClassifier: ((toolName: string, toolInput: Record<string, unknown>) => Promise<ClassifierResult>) | null = null;
  private onBeforePrompt: (() => void) | null = null;
  private onAfterPrompt: (() => void) | null = null;

  setPromptHooks(before: () => void, after: () => void): void {
    this.onBeforePrompt = before;
    this.onAfterPrompt = after;
  }

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

  setLLMClassifier(fn: (toolName: string, toolInput: Record<string, unknown>) => Promise<ClassifierResult>): void {
    this.llmClassifier = fn;
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
      // Stage 1 uncertain → try Stage 2 LLM classifier
      return this.classifyStage2(toolName, toolInput);
    }

    if (category === "write") {
      return this.classifyStage2(toolName, toolInput);
    }

    if (toolName === "Agent") return "allow";

    return this.classifyStage2(toolName, toolInput);
  }

  private async classifyStage2(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<"allow" | "deny"> {
    if (!this.llmClassifier) return this.promptUser(toolName);

    const result = await this.llmClassifier(toolName, toolInput);
    if (result === "allow") return "allow";
    if (result === "deny") return "deny";
    return this.promptUser(toolName);
  }

  private matchesAllowRule(value: string): boolean {
    return this.allowPatterns.some((re) => re.test(value));
  }

  private matchesDenyRule(command: string): boolean {
    return this.denyPatterns.some((re) => re.test(command));
  }

  private async promptUser(toolName: string): Promise<"allow" | "deny"> {
    process.stderr.write(renderPermissionPrompt(toolName));

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

    // Pause escape handler so it doesn't steal keystrokes
    this.onBeforePrompt?.();

    // Raw-mode single keypress
    return new Promise((resolve) => {
      stdin.setRawMode(true);
      stdin.resume();

      const onData = (buf: Buffer) => {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();

        const ch = buf.toString().toLowerCase().trim();

        if (ch === "n" || ch === "\x03") {
          renderPermissionResponse("no");
          this.onAfterPrompt?.();
          resolve("deny");
        } else if (ch === "a") {
          this.alwaysAllowed.add(toolName);
          renderPermissionResponse("always");
          this.onAfterPrompt?.();
          resolve("allow");
        } else {
          renderPermissionResponse("yes");
          this.onAfterPrompt?.();
          resolve("allow");
        }
      };

      stdin.on("data", onData);
    });
  }
}
