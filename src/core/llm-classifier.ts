import { apiRequest } from "./client.js";
import type { Config } from "../types.js";

// ── Types ──

export interface LLMClassifierConfig {
  enabled: boolean;
  model?: string;
  timeout?: number;
}

export type ClassifierResult = "allow" | "deny" | "prompt";

type ClassifierFn = (toolName: string, toolInput: Record<string, unknown>) => Promise<ClassifierResult>;

// ── Classifier ──

const CLASSIFIER_SYSTEM = `You are a security classifier for a CLI coding assistant. Your job is to determine if a tool call is safe to execute automatically without user confirmation.

Respond with exactly one word: ALLOW, DENY, or PROMPT.

ALLOW — The action is clearly safe: reading files, running tests, listing directories, non-destructive git commands, safe build commands.
DENY — The action is clearly dangerous: deleting files, force-pushing, dropping databases, running untrusted scripts, modifying system configs.
PROMPT — Uncertain or context-dependent: writing to files in unfamiliar locations, running commands you're unsure about, network operations.

Consider:
- Is this action reversible?
- Does it affect only the local workspace?
- Could it cause data loss or expose secrets?`;

export function createLLMClassifier(
  config: Config,
  classifierConfig: LLMClassifierConfig,
  getRecentContext: () => string,
): ClassifierFn {
  const model = classifierConfig.model ?? "claude-haiku-4-5-20251001";
  const timeout = classifierConfig.timeout ?? 5000;

  return async (toolName: string, toolInput: Record<string, unknown>): Promise<ClassifierResult> => {
    try {
      const context = getRecentContext();
      const userMessage = [
        `Tool: ${toolName}`,
        `Input: ${JSON.stringify(toolInput, null, 2).slice(0, 2000)}`,
        context ? `\nRecent context:\n${context.slice(0, 1500)}` : "",
      ].join("\n");

      const classifierConfig2: Config = {
        ...config,
        model,
        thinkingBudget: 0,
      };

      const result = await Promise.race([
        apiRequest(classifierConfig2, {
          model,
          max_tokens: 16,
          system: CLASSIFIER_SYSTEM,
          messages: [{ role: "user", content: userMessage }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("classifier timeout")), timeout)
        ),
      ]);

      const text = result.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("")
        .trim()
        .toUpperCase();

      if (text.startsWith("ALLOW")) return "allow";
      if (text.startsWith("DENY")) return "deny";
      return "prompt";
    } catch {
      // On any error (timeout, API failure, etc.), fall back to prompting
      return "prompt";
    }
  };
}
