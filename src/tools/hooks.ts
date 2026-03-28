import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dim, yellow } from "../ui/render.js";
import type { Sandbox } from "../core/sandbox.js";

const execAsync = promisify(exec);

export interface HookConfig {
  command: string;
  tools?: string[];   // tool names to match, empty = all tools
  timeout?: number;   // ms, default 10s
}

export interface HooksConfig {
  pre?: HookConfig[];
  post?: HookConfig[];
}

/**
 * Run matching hooks for a given phase and tool.
 * Pre-hooks: return false if any hook exits non-zero (blocks tool execution).
 * Post-hooks: always run, non-zero exits are logged but don't block.
 *
 * Hook commands receive env vars:
 *   CLIO_TOOL_NAME, CLIO_TOOL_INPUT (JSON), CLIO_HOOK_PHASE
 */
let hookSandbox: Sandbox | null = null;

export function setHookSandbox(s: Sandbox): void {
  hookSandbox = s;
}

export async function runHooks(
  hooks: HooksConfig | undefined,
  phase: "pre" | "post",
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<boolean> {
  const hookList = phase === "pre" ? hooks?.pre : hooks?.post;
  if (!hookList || hookList.length === 0) return true;

  const hookExtra = {
    CLIO_TOOL_NAME: toolName,
    CLIO_TOOL_INPUT: JSON.stringify(toolInput),
    CLIO_HOOK_PHASE: phase,
  };

  const env = hookSandbox
    ? hookSandbox.buildEnvironment(hookExtra)
    : { ...process.env, ...hookExtra };

  for (const hook of hookList) {
    // Check if this hook applies to the current tool
    if (hook.tools && hook.tools.length > 0 && !hook.tools.includes(toolName)) {
      continue;
    }

    try {
      await execAsync(hook.command, {
        timeout: hook.timeout ?? 10_000,
        cwd: process.cwd(),
        env,
        shell: process.platform === "win32" ? "bash" : "/bin/bash",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (phase === "pre") {
        process.stderr.write(`  ${yellow("⊘")} ${dim(`Pre-hook blocked ${toolName}: ${hook.command}`)}\n`);
        return false; // block tool execution
      }

      // Post-hook failure is just a warning
      process.stderr.write(`  ${dim(`Post-hook warning: ${msg.slice(0, 100)}`)}\n`);
    }
  }

  return true;
}
