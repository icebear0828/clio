import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import type { PermissionMode, ToolContext } from "./types.js";
import { taskStore, formatTaskList, formatTaskDetail, type TaskStatus } from "./tasks.js";
import type { McpManager } from "./mcp.js";
import type { SubAgentOptions } from "./subagent.js";

const execAsync = promisify(exec);

let toolContext: ToolContext | null = null;
let previousMode: PermissionMode | null = null;
let mcpManager: McpManager | null = null;

const backgroundAgents = new Map<string, Promise<string>>();
let bgAgentCounter = 0;

export function setMcpManager(manager: McpManager): void {
  mcpManager = manager;
}

export function setToolContext(ctx: ToolContext): void {
  toolContext = ctx;
}

// ── Workspace restriction ──

let allowOutsideCwd = false;

export function setAllowOutsideCwd(allow: boolean): void {
  allowOutsideCwd = allow;
}

function assertInWorkspace(filePath: string): void {
  if (allowOutsideCwd) return;
  const resolved = path.resolve(filePath);
  const cwd = process.cwd();
  const prefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  if (!resolved.startsWith(prefix) && resolved !== cwd) {
    throw new Error(`Path outside workspace: ${filePath} (cwd: ${cwd}). Use --allow-outside-cwd to override.`);
  }
}

// ── Tool definitions (sent to API so gateway sees clientHadTools=true) ──

export const TOOL_DEFINITIONS = [
  {
    name: "Read",
    description: "Reads a file from the local filesystem.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to read" },
        offset: { type: "number", description: "Line number to start reading from" },
        limit: { type: "number", description: "Number of lines to read" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Write",
    description: "Writes a file to the local filesystem.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Edit",
    description: "Performs exact string replacements in files.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to modify" },
        old_string: { type: "string", description: "The text to replace" },
        new_string: { type: "string", description: "The replacement text" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "Bash",
    description: "Executes a bash command and returns its output.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds" },
      },
      required: ["command"],
    },
  },
  {
    name: "Glob",
    description: "Fast file pattern matching. Returns matching file paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files" },
        path: { type: "string", description: "Directory to search in (defaults to cwd)" },
        head_limit: { type: "number", description: "Max files to return (default: 250)" },
        offset: { type: "number", description: "Skip first N results" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description: "Search file contents using regex patterns.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory to search in (defaults to cwd)" },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Output format (default: files_with_matches)",
        },
        head_limit: { type: "number", description: "Max results to return (default: 250)" },
        offset: { type: "number", description: "Skip first N results" },
        glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
        type: { type: "string", description: "File type filter (e.g. 'ts', 'js', 'py')" },
        "-A": { type: "number", description: "Lines to show after each match" },
        "-B": { type: "number", description: "Lines to show before each match" },
        "-C": { type: "number", description: "Context lines before and after each match" },
        "-i": { type: "boolean", description: "Case insensitive search" },
        "-n": { type: "boolean", description: "Show line numbers (default: true)" },
        multiline: { type: "boolean", description: "Enable multiline matching" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "WebFetch",
    description: "Fetches a URL and returns its content as text. Useful for reading documentation, APIs, or web pages.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        max_length: { type: "number", description: "Max characters to return (default 50000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "Agent",
    description: "Launch a sub-agent to handle complex tasks autonomously.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "Task for the agent to perform" },
        description: { type: "string", description: "Short description (3-5 words)" },
        subagent_type: { type: "string", description: "Agent type (e.g. custom agent name)" },
        isolation: { type: "string", enum: ["worktree"], description: "Run in isolated git worktree" },
        run_in_background: { type: "boolean", description: "Run agent in background, notify on completion" },
        name: { type: "string", description: "Name to identify the background agent" },
        model: { type: "string", description: "Model override for this agent" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "WebSearch",
    description: "Searches the web using DuckDuckGo and returns results with titles, URLs, and snippets.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Max results to return (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "AskUserQuestion",
    description: "Asks the user a question and waits for their response. Use when you need clarification or a decision.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "The question to ask the user" },
      },
      required: ["question"],
    },
  },
  {
    name: "EnterPlanMode",
    description: "Switches to plan mode where only read-only tools (Read, Glob, Grep, WebFetch, WebSearch) are allowed. Use for exploration and planning before making changes.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ExitPlanMode",
    description: "Exits plan mode and restores the previous permission mode, re-enabling write and dangerous tools.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "TaskCreate",
    description: "Creates a new task to track progress on a multi-step workflow.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "What this task should accomplish" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Initial status (default: pending)" },
      },
      required: ["description"],
    },
  },
  {
    name: "TaskUpdate",
    description: "Updates the status or adds a progress message to an existing task.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The task ID (e.g. task_1)" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "New status" },
        message: { type: "string", description: "Progress note to append" },
      },
      required: ["id"],
    },
  },
  {
    name: "TaskList",
    description: "Lists all tasks with their current statuses.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "TaskGet",
    description: "Gets full details of a specific task including progress messages.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The task ID (e.g. task_1)" },
      },
      required: ["id"],
    },
  },
];

// ── Tool execution ──

export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "Read":
      return toolRead(input as { file_path: string; offset?: number; limit?: number });
    case "Write":
      return toolWrite(input as { file_path: string; content: string });
    case "Edit":
      return toolEdit(input as { file_path: string; old_string: string; new_string: string });
    case "Bash":
      return toolBash(input as { command: string; timeout?: number });
    case "Glob":
      return toolGlob(input as { pattern: string; path?: string; head_limit?: number; offset?: number });
    case "Grep":
      return toolGrep(input as unknown as GrepInput);
    case "WebFetch":
      return toolWebFetch(input as { url: string; max_length?: number });
    case "Agent":
      return toolAgent(input as { prompt: string; description?: string; subagent_type?: string; isolation?: "worktree"; run_in_background?: boolean; name?: string; model?: string });
    case "WebSearch":
      return toolWebSearch(input as { query: string; limit?: number });
    case "AskUserQuestion":
      return toolAskUser(input as { question: string });
    case "EnterPlanMode":
      return toolEnterPlanMode();
    case "ExitPlanMode":
      return toolExitPlanMode();
    case "TaskCreate":
      return toolTaskCreate(input as { description: string; status?: TaskStatus });
    case "TaskUpdate":
      return toolTaskUpdate(input as { id: string; status?: TaskStatus; message?: string });
    case "TaskList":
      return toolTaskList();
    case "TaskGet":
      return toolTaskGet(input as { id: string });
    default:
      if (mcpManager?.isMcpTool(name)) {
        return mcpManager.callTool(name, input);
      }
      return `Unknown tool: ${name}`;
  }
}

async function toolRead(input: { file_path: string; offset?: number; limit?: number }): Promise<string> {
  assertInWorkspace(input.file_path);
  const content = await fs.readFile(input.file_path, "utf-8");
  const lines = content.split("\n");
  const start = Math.max(0, (input.offset ?? 1) - 1);
  const end = input.limit ? start + input.limit : lines.length;

  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join("\n");
}

async function toolWrite(input: { file_path: string; content: string }): Promise<string> {
  assertInWorkspace(input.file_path);
  await fs.mkdir(path.dirname(input.file_path), { recursive: true });
  await fs.writeFile(input.file_path, input.content, "utf-8");
  return `Successfully wrote ${input.content.split("\n").length} lines to ${input.file_path}`;
}

async function toolEdit(input: { file_path: string; old_string: string; new_string: string }): Promise<string> {
  assertInWorkspace(input.file_path);
  const content = await fs.readFile(input.file_path, "utf-8");
  const idx = content.indexOf(input.old_string);
  if (idx === -1) {
    throw new Error(`old_string not found in ${input.file_path}`);
  }
  // Check uniqueness
  if (content.indexOf(input.old_string, idx + 1) !== -1) {
    throw new Error(`old_string is not unique in ${input.file_path} — provide more context`);
  }
  const updated = content.slice(0, idx) + input.new_string + content.slice(idx + input.old_string.length);
  await fs.writeFile(input.file_path, updated, "utf-8");
  return `Successfully edited ${input.file_path}`;
}

function truncateOutput(text: string, maxLines = 500): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, 200);
  const tail = lines.slice(-100);
  const skipped = lines.length - 300;
  return [...head, `\n[... ${skipped} lines truncated ...]\n`, ...tail].join("\n");
}

async function toolBash(input: { command: string; timeout?: number }): Promise<string> {
  const timeout = input.timeout ?? 120_000;
  try {
    const { stdout, stderr } = await execAsync(input.command, {
      timeout,
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32" ? "bash" : "/bin/bash",
    });
    let result = stdout;
    if (stderr) result += (result ? "\n" : "") + `STDERR:\n${stderr}`;
    return truncateOutput(result || "(no output)");
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    let result = e.stdout ?? "";
    if (e.stderr) result += (result ? "\n" : "") + `STDERR:\n${e.stderr}`;
    return truncateOutput(result || e.message);
  }
}

async function toolGlob(input: { pattern: string; path?: string; head_limit?: number; offset?: number }): Promise<string> {
  const cwd = input.path ?? process.cwd();
  const files = await fg(input.pattern, {
    cwd,
    ignore: ["**/node_modules/**", "**/.git/**"],
    dot: true,
  });
  const offset = input.offset ?? 0;
  const limit = input.head_limit ?? 250;
  const sliced = files.slice(offset, offset + limit);
  const remaining = files.length - offset - sliced.length;
  let result = sliced.join("\n") || "No files matched";
  if (remaining > 0) result += `\n(${remaining} more files not shown)`;
  return result;
}

interface GrepInput {
  pattern: string;
  path?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  head_limit?: number;
  offset?: number;
  glob?: string;
  type?: string;
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  "-i"?: boolean;
  "-n"?: boolean;
  multiline?: boolean;
}

const GREP_TYPE_MAP: Record<string, string> = {
  ts: "**/*.{ts,tsx}", js: "**/*.{js,jsx}", py: "**/*.py",
  rust: "**/*.rs", go: "**/*.go", java: "**/*.java",
  css: "**/*.css", html: "**/*.html", json: "**/*.json",
  md: "**/*.md", yaml: "**/*.{yml,yaml}", sh: "**/*.sh",
};

async function toolGrep(input: GrepInput): Promise<string> {
  const searchPath = input.path ?? process.cwd();
  const outputMode = input.output_mode ?? "files_with_matches";
  const headLimit = input.head_limit ?? 250;
  const offset = input.offset ?? 0;
  const showLineNumbers = input["-n"] !== false;
  const contextAfter = input["-C"] ?? input["-A"] ?? 0;
  const contextBefore = input["-C"] ?? input["-B"] ?? 0;

  let flags = input.multiline ? "gms" : "gm";
  if (input["-i"]) flags += "i";

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch {
    throw new Error(`Invalid regex pattern: ${input.pattern}`);
  }

  const stat = await fs.stat(searchPath).catch(() => null);
  if (!stat) throw new Error(`Path not found: ${searchPath}`);

  let filesToSearch: string[];
  if (stat.isFile()) {
    filesToSearch = [searchPath];
  } else {
    let globPattern = "**/*";
    if (input.type && GREP_TYPE_MAP[input.type]) {
      globPattern = GREP_TYPE_MAP[input.type];
    } else if (input.glob) {
      globPattern = input.glob.includes("/") ? input.glob : `**/${input.glob}`;
    }
    filesToSearch = await fg(globPattern, {
      cwd: searchPath,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      absolute: true,
      onlyFiles: true,
    });
  }

  const allResults: string[] = [];
  const fileCounts: Map<string, number> = new Map();
  const matchedFiles: Set<string> = new Set();

  for (const file of filesToSearch) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;

    const lines = content.split("\n");
    const relPath = stat.isFile() ? path.basename(file) : path.relative(searchPath, file);
    let fileMatchCount = 0;

    if (input.multiline) {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      const matchedLineSet = new Set<number>();
      while ((m = regex.exec(content)) !== null) {
        fileMatchCount++;
        matchedFiles.add(relPath);
        const lineIdx = content.slice(0, m.index).split("\n").length - 1;
        matchedLineSet.add(lineIdx);
        if (!regex.global) break;
      }
      if (outputMode === "content") {
        for (const i of matchedLineSet) {
          const prefix = showLineNumbers ? `${relPath}:${i + 1}:` : `${relPath}:`;
          allResults.push(`${prefix}${lines[i]}`);
        }
      }
    } else {
      let lastContextEnd = -1;
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          fileMatchCount++;
          matchedFiles.add(relPath);

          if (outputMode === "content") {
            const startCtx = Math.max(0, i - contextBefore);
            const endCtx = Math.min(lines.length - 1, i + contextAfter);

            if (contextBefore > 0 || contextAfter > 0) {
              const effectiveStart = Math.max(startCtx, lastContextEnd + 1);
              if (effectiveStart > lastContextEnd + 1 && lastContextEnd >= 0) {
                allResults.push("--");
              }
              for (let j = effectiveStart; j <= endCtx; j++) {
                const sep = j === i ? ":" : "-";
                const prefix = showLineNumbers ? `${relPath}:${j + 1}${sep}` : `${relPath}${sep}`;
                allResults.push(`${prefix}${lines[j]}`);
              }
              lastContextEnd = endCtx;
            } else {
              const prefix = showLineNumbers ? `${relPath}:${i + 1}:` : `${relPath}:`;
              allResults.push(`${prefix}${lines[i]}`);
            }
          }
        }
      }
    }

    if (fileMatchCount > 0) {
      fileCounts.set(relPath, fileMatchCount);
    }
  }

  let output: string[];
  switch (outputMode) {
    case "files_with_matches":
      output = [...matchedFiles];
      break;
    case "count":
      output = [...fileCounts.entries()].map(([f, c]) => `${f}:${c}`);
      break;
    case "content":
    default:
      output = allResults;
      break;
  }

  const sliced = output.slice(offset, offset + headLimit);
  const remaining = output.length - offset - sliced.length;
  let result = sliced.join("\n");
  if (remaining > 0) result += `\n(${remaining} more results not shown)`;
  return result || "No matches found";
}

async function toolWebFetch(input: { url: string; max_length?: number }): Promise<string> {
  const maxLen = input.max_length ?? 50_000;

  const response = await fetch(input.url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; c2a-cli/0.1)" },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  // For HTML, strip tags to extract readable text
  if (contentType.includes("text/html")) {
    const text = raw
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, maxLen);
  }

  return raw.slice(0, maxLen);
}

async function toolAgent(input: {
  prompt: string;
  description?: string;
  subagent_type?: string;
  isolation?: "worktree";
  run_in_background?: boolean;
  name?: string;
  model?: string;
}): Promise<string> {
  if (!toolContext) throw new Error("Agent tool requires tool context");
  const { executeSubAgent } = await import("./subagent.js");

  let options: SubAgentOptions | undefined;
  if (input.subagent_type) {
    const { getCustomAgent, listCustomAgents } = await import("./custom-agents.js");
    const def = getCustomAgent(input.subagent_type);
    if (!def) {
      const available = listCustomAgents();
      throw new Error(`Custom agent "${input.subagent_type}" not found. Available: ${available.length > 0 ? available.join(", ") : "(none)"}`);
    }
    options = {
      systemPromptOverride: def.systemPrompt,
      allowedTools: def.allowedTools,
      model: def.model,
      maxIterations: def.maxIterations,
    };
  }

  if (input.model) {
    options = { ...(options ?? {}), model: input.model };
  }

  const config = toolContext.config;

  if (input.isolation === "worktree") {
    const { createWorktree, hasChanges, cleanupWorktree } = await import("./worktree.js");
    const wt = await createWorktree();
    const wtOptions: SubAgentOptions = { ...(options ?? {}), workdir: wt.worktreePath };

    if (input.run_in_background) {
      const agentName = input.name ?? `agent-${++bgAgentCounter}`;
      const promise = executeSubAgent(config, input.prompt, wtOptions)
        .then(async (result) => {
          const changed = await hasChanges(wt.worktreePath);
          if (!changed) await cleanupWorktree(wt);
          process.stderr.write(`\n  [background agent "${agentName}" completed${changed ? ` — changes on ${wt.branchName}` : ""}]\n`);
          return changed
            ? `${result}\n\n---\nChanges in worktree:\n  Branch: ${wt.branchName}\n  Path: ${wt.worktreePath}`
            : result;
        })
        .catch(async (err) => {
          await cleanupWorktree(wt).catch(() => {});
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`\n  [background agent "${agentName}" failed: ${msg}]\n`);
          return `Error: ${msg}`;
        });
      backgroundAgents.set(agentName, promise);
      return `Background agent "${agentName}" launched in worktree ${wt.branchName}. It will notify on completion.`;
    }

    const result = await executeSubAgent(config, input.prompt, wtOptions);

    const changed = await hasChanges(wt.worktreePath);
    if (changed) {
      return `${result}\n\n---\nChanges made in worktree:\n  Branch: ${wt.branchName}\n  Path: ${wt.worktreePath}\nUse \`git merge ${wt.branchName}\` to incorporate changes.`;
    }
    await cleanupWorktree(wt);
    return result;
  }

  if (input.run_in_background) {
    const agentName = input.name ?? `agent-${++bgAgentCounter}`;
    const promise = executeSubAgent(config, input.prompt, options)
      .then((result) => {
        process.stderr.write(`\n  [background agent "${agentName}" completed]\n`);
        return result;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\n  [background agent "${agentName}" failed: ${msg}]\n`);
        return `Error: ${msg}`;
      });
    backgroundAgents.set(agentName, promise);
    return `Background agent "${agentName}" launched. It will notify on completion.`;
  }

  return executeSubAgent(config, input.prompt, options);
}

async function toolWebSearch(input: { query: string; limit?: number }): Promise<string> {
  const limit = input.limit ?? 5;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; c2a-cli/1.0)" },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`Search failed: HTTP ${resp.status}`);
  const html = await resp.text();

  const results: string[] = [];
  const blockRe = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  const titleRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null && results.length < limit) {
    const block = match[1];
    const titleMatch = titleRe.exec(block);
    const snippetMatch = snippetRe.exec(block);
    if (titleMatch) {
      const href = titleMatch[1];
      const title = titleMatch[2].replace(/<[^>]*>/g, "").trim();
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim()
        : "";
      results.push(`${results.length + 1}. ${title}\n   ${href}\n   ${snippet}`);
    }
  }

  if (results.length === 0) return "No results found.";
  return results.join("\n\n");
}

async function toolAskUser(input: { question: string }): Promise<string> {
  if (!toolContext?.askUser) {
    throw new Error("AskUserQuestion is not available in this context");
  }
  return toolContext.askUser(input.question);
}

async function toolEnterPlanMode(): Promise<string> {
  if (!toolContext?.permissionControl) {
    throw new Error("Plan mode tools require permission control");
  }
  const current = toolContext.permissionControl.getMode();
  if (current === "plan") return "Already in plan mode.";
  previousMode = current;
  toolContext.permissionControl.setMode("plan");
  return "Entered plan mode. Only read-only tools are now allowed.";
}

async function toolExitPlanMode(): Promise<string> {
  if (!toolContext?.permissionControl) {
    throw new Error("Plan mode tools require permission control");
  }
  const current = toolContext.permissionControl.getMode();
  if (current !== "plan") return "Not currently in plan mode.";
  const restore = previousMode ?? "default";
  toolContext.permissionControl.setMode(restore);
  previousMode = null;
  return `Exited plan mode. Restored to ${restore} mode.`;
}

async function toolTaskCreate(input: { description: string; status?: TaskStatus }): Promise<string> {
  const task = taskStore.create(input.description, input.status);
  return `Created ${task.id}: ${task.description}`;
}

async function toolTaskUpdate(input: { id: string; status?: TaskStatus; message?: string }): Promise<string> {
  const task = taskStore.update(input.id, input.status, input.message);
  const parts = [`Updated ${task.id}`];
  if (input.status) parts.push(`status: ${input.status}`);
  if (input.message) parts.push(`note: "${input.message}"`);
  return parts.join(" — ");
}

async function toolTaskList(): Promise<string> {
  return formatTaskList(taskStore.list());
}

async function toolTaskGet(input: { id: string }): Promise<string> {
  return formatTaskDetail(taskStore.get(input.id));
}
