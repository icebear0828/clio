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

export interface HookResult {
  ok: boolean;       // false = a pre-hook blocked execution
  output: string;    // captured stdout+stderr from all hooks
}

let hookSandbox: Sandbox | null = null;

export function setHookSandbox(s: Sandbox): void {
  hookSandbox = s;
}

/**
 * Run matching hooks for a given phase and tool.
 * Pre-hooks: non-zero exit → blocks tool execution (ok=false).
 * Post-hooks: non-zero exit → warning only (ok=true).
 * All stdout/stderr is captured in result.output so the model can see it.
 */
export async function runHooks(
  hooks: HooksConfig | undefined,
  phase: "pre" | "post",
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<HookResult> {
  const hookList = phase === "pre" ? hooks?.pre : hooks?.post;
  if (!hookList || hookList.length === 0) return { ok: true, output: "" };

  const hookExtra = {
    CLIO_TOOL_NAME: toolName,
    CLIO_TOOL_INPUT: JSON.stringify(toolInput),
    CLIO_HOOK_PHASE: phase,
  };

  const env = hookSandbox
    ? hookSandbox.buildEnvironment(hookExtra)
    : { ...process.env, ...hookExtra };

  let output = "";

  for (const hook of hookList) {
    if (hook.tools && hook.tools.length > 0 && !hook.tools.includes(toolName)) {
      continue;
    }

    try {
      const { stdout, stderr } = await execAsync(hook.command, {
        timeout: hook.timeout ?? 10_000,
        cwd: process.cwd(),
        env,
        shell: process.platform === "win32" ? "bash" : "/bin/bash",
      });
      if (stdout) output += stdout;
      if (stderr) output += stderr;
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      if (execErr.stdout) output += execErr.stdout;
      if (execErr.stderr) output += execErr.stderr;

      if (phase === "pre") {
        process.stderr.write(`  ${yellow("⊘")} ${dim(`Pre-hook blocked ${toolName}: ${hook.command}`)}\n`);
        return { ok: false, output };
      }

      process.stderr.write(`  ${dim(`Post-hook warning: ${(execErr.message ?? "").slice(0, 100)}`)}\n`);
    }
  }

  return { ok: true, output };
}
