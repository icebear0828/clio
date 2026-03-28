import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import type { PermissionMode, ToolContext } from "../types.js";
import { taskStore, formatTaskList, formatTaskDetail, type TaskStatus } from "./tasks.js";
import { getSkill, listSkills } from "../skills/index.js";
import type { McpManager } from "./mcp.js";
import type { SubAgentOptions } from "./subagent.js";
import type { Sandbox } from "../core/sandbox.js";
import type { LspManager } from "./lsp.js";
import { teamRegistry, createMessageHook, type TeamMemberInput } from "./teams.js";

const execAsync = promisify(exec);

let toolContext: ToolContext | null = null;
let previousMode: PermissionMode | null = null;
let mcpManager: McpManager | null = null;

const backgroundAgents = new Map<string, Promise<string>>();
let bgAgentCounter = 0;
let sandbox: Sandbox | null = null;
let lspManager: LspManager | null = null;

export function setMcpManager(manager: McpManager): void {
  mcpManager = manager;
}

export function setSandbox(s: Sandbox): void {
  sandbox = s;
}

export function setLspManager(manager: LspManager): void {
  lspManager = manager;
}

export function setToolContext(ctx: ToolContext): void {
  toolContext = ctx;
}

// ── Workspace restriction ──

let allowOutsideCwd = false;

export function setAllowOutsideCwd(allow: boolean): void {
  allowOutsideCwd = allow;
}

function assertInWorkspace(filePath: string, mode: "read" | "write" = "read"): void {
  if (sandbox) {
    sandbox.assertPathAllowed(filePath, mode);
    return;
  }
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
    description: "Fetches content from a URL, converts HTML to markdown, and processes it with an AI model. Use when you need to retrieve and analyze web content. HTTP URLs are upgraded to HTTPS. Includes a 15-minute cache. When a URL redirects to a different host, the tool will inform you and provide the redirect URL — make a new request with that URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch content from" },
        prompt: { type: "string", description: "The prompt to run on the fetched content" },
      },
      required: ["url", "prompt"],
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
    description: "Searches the web and returns results with titles, URLs, and snippets. Use for accessing information beyond the knowledge cutoff. After answering, include a Sources section listing relevant URLs as markdown hyperlinks.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query to use" },
        allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains" },
        blocked_domains: { type: "array", items: { type: "string" }, description: "Never include results from these domains" },
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
  {
    name: "Skill",
    description: "Execute a skill within the main conversation. Skills provide specialized capabilities and domain knowledge.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill: { type: "string", description: "The skill name (e.g. 'commit', 'pr', 'review')" },
        args: { type: "string", description: "Optional arguments for the skill" },
      },
      required: ["skill"],
    },
  },
  {
    name: "ToolSearch",
    description: "Fetches full schema definitions for deferred tools so they can be called. Query with 'select:Name1,Name2' for exact match, or keywords to search.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Query to find deferred tools. Use 'select:Name1,Name2' for exact match, or keywords to search." },
        max_results: { type: "number", description: "Maximum results to return (default: 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "TeamCreate",
    description: "Create a team of agents to collaborate on a task. Each member runs as a background sub-agent with inter-agent messaging.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Team name" },
        task: { type: "string", description: "The team's overall task" },
        members: {
          type: "array",
          description: "Team members",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Member name" },
              role: { type: "string", description: "Member role description" },
              prompt: { type: "string", description: "Initial task for this member" },
              agent_type: { type: "string", description: "Custom agent type" },
              model: { type: "string", description: "Model override" },
            },
            required: ["name", "prompt"],
          },
        },
      },
      required: ["name", "task", "members"],
    },
  },
  {
    name: "TeamDelete",
    description: "Delete a team and abort all its running agents.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The team ID (e.g. team_1)" },
      },
      required: ["id"],
    },
  },
  {
    name: "SendMessage",
    description: "Send a message to a team member or broadcast to all members. Used for inter-agent coordination.",
    input_schema: {
      type: "object" as const,
      properties: {
        team_id: { type: "string", description: "The team ID" },
        to: { type: "string", description: "Member name or 'all' for broadcast" },
        content: { type: "string", description: "Message content" },
      },
      required: ["team_id", "to", "content"],
    },
  },
];

export const DEFERRED_TOOL_NAMES = new Set([
  "WebFetch", "WebSearch",
  "EnterPlanMode", "ExitPlanMode",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "TeamCreate", "TeamDelete", "SendMessage",
]);

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
      return toolWebFetch(input as { url: string; prompt: string });
    case "Agent":
      return toolAgent(input as { prompt: string; description?: string; subagent_type?: string; isolation?: "worktree"; run_in_background?: boolean; name?: string; model?: string });
    case "WebSearch":
      return toolWebSearch(input as { query: string; allowed_domains?: string[]; blocked_domains?: string[] });
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
    case "Skill":
      return toolSkill(input as { skill: string; args?: string });
    case "ToolSearch":
      return toolToolSearch(input as { query: string; max_results?: number });
    case "TeamCreate":
      return toolTeamCreate(input as { name: string; task: string; members: TeamMemberInput[] });
    case "TeamDelete":
      return toolTeamDelete(input as { id: string });
    case "SendMessage":
      return toolSendMessage(input as { team_id: string; to: string; content: string });
    default:
      if (mcpManager?.isMcpTool(name)) {
        return mcpManager.callTool(name, input);
      }
      return `Unknown tool: ${name}`;
  }
}

async function toolRead(input: { file_path: string; offset?: number; limit?: number }): Promise<string> {
  assertInWorkspace(input.file_path, "read");
  const content = await fs.readFile(input.file_path, "utf-8");

  // Notify LSP servers
  if (lspManager) lspManager.notifyFileOpened(input.file_path, content);

  const lines = content.split("\n");
  const start = Math.max(0, (input.offset ?? 1) - 1);
  const end = input.limit ? start + input.limit : lines.length;

  return lines
    .slice(start, end)
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join("\n");
}

async function toolWrite(input: { file_path: string; content: string }): Promise<string> {
  assertInWorkspace(input.file_path, "write");
  await fs.mkdir(path.dirname(input.file_path), { recursive: true });
  await fs.writeFile(input.file_path, input.content, "utf-8");

  if (lspManager) lspManager.notifyFileChanged(input.file_path, input.content);

  return `Successfully wrote ${input.content.split("\n").length} lines to ${input.file_path}`;
}

async function toolEdit(input: { file_path: string; old_string: string; new_string: string }): Promise<string> {
  assertInWorkspace(input.file_path, "write");
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

  if (lspManager) lspManager.notifyFileChanged(input.file_path, updated);

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

  // Sandbox validation
  if (sandbox) {
    const validation = sandbox.validateCommand(input.command);
    if (!validation.allowed) {
      throw new Error(`Sandbox blocked command: ${validation.reason}`);
    }
  }

  const execOpts = sandbox
    ? (() => { const o = sandbox.buildExecOptions(input.command, timeout); return { timeout: o.timeout, cwd: o.cwd, maxBuffer: o.maxBuffer, env: o.env, shell: o.shell }; })()
    : { timeout, cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" ? "bash" : "/bin/bash" };

  const command = sandbox ? sandbox.buildExecOptions(input.command, timeout).command : input.command;

  try {
    const { stdout, stderr } = await execAsync(command, execOpts);
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

// ── WebFetch cache (15 min TTL) ──
const webFetchCache = new Map<string, { content: string; timestamp: number }>();
const CACHE_TTL = 15 * 60 * 1000;

function htmlToMarkdown(html: string): string {
  let md = html;
  // Remove script/style/nav/footer
  md = md.replace(/<(script|style|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Headings
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
    const clean = text.replace(/<[^>]*>/g, "").trim();
    return "\n" + "#".repeat(Number(level)) + " " + clean + "\n";
  });
  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const clean = text.replace(/<[^>]*>/g, "").trim();
    return `[${clean}](${href})`;
  });
  // Images
  md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)");
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
  // Bold/italic
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  // Code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  // Lists
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  // Paragraphs / line breaks
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<\/p>/gi, "\n\n");
  md = md.replace(/<p[^>]*>/gi, "");
  // Blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) =>
    text.trim().split("\n").map((l: string) => "> " + l).join("\n")
  );
  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, "");
  // Decode entities
  md = md.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
  // Collapse whitespace
  md = md.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
  return md;
}

async function toolWebFetch(input: { url: string; prompt: string }): Promise<string> {
  if (!toolContext) throw new Error("WebFetch requires tool context");

  // Upgrade HTTP to HTTPS
  let url = input.url;
  if (url.startsWith("http://")) {
    url = "https://" + url.slice(7);
  }

  // Check cache
  const cached = webFetchCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return processWithModel(cached.content, input.prompt);
  }
  // Clean expired entries
  for (const [key, val] of webFetchCache) {
    if (Date.now() - val.timestamp >= CACHE_TTL) webFetchCache.delete(key);
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; clio-cli/1.0)" },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });

  // Detect cross-host redirect
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (location) {
      const originalHost = new URL(url).host;
      try {
        const redirectHost = new URL(location, url).host;
        if (redirectHost !== originalHost) {
          const fullUrl = new URL(location, url).href;
          return `The URL redirected to a different host: ${fullUrl}\nPlease make a new WebFetch request with this URL.`;
        }
      } catch { /* fall through to follow redirect manually */ }
      // Same-host redirect — follow it
      const followResp = await fetch(new URL(location, url).href, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; clio-cli/1.0)" },
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });
      if (!followResp.ok) throw new Error(`HTTP ${followResp.status}: ${followResp.statusText}`);
      return processPage(followResp, url, input.prompt);
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return processPage(response, url, input.prompt);
}

async function processPage(response: Response, url: string, prompt: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  let content: string;
  if (contentType.includes("text/html")) {
    content = htmlToMarkdown(raw);
  } else {
    content = raw;
  }

  // Limit content size for model processing
  content = content.slice(0, 100_000);
  webFetchCache.set(url, { content, timestamp: Date.now() });

  return processWithModel(content, prompt);
}

async function processWithModel(content: string, prompt: string): Promise<string> {
  if (!toolContext) throw new Error("WebFetch requires tool context");
  const { apiRequest } = await import("../core/client.js");

  const config: import("../types.js").Config = {
    ...toolContext.config,
    model: "claude-haiku-4-5-20251001",
    thinkingBudget: 0,
  };

  const result = await apiRequest(config, {
    model: config.model,
    max_tokens: 4096,
    system: "You are a helpful assistant that processes web page content. Respond based on the page content and the user's prompt. Be concise and accurate.",
    messages: [{
      role: "user",
      content: `<page_content>\n${content.slice(0, 80_000)}\n</page_content>\n\n${prompt}`,
    }],
  });

  return result.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("")
    .trim();
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

  const BUILTIN_AGENT_TYPES = new Set(["general-purpose", "Explore", "Plan"]);

  let options: SubAgentOptions | undefined;
  if (input.subagent_type && BUILTIN_AGENT_TYPES.has(input.subagent_type)) {
    // Built-in agent type — route via agentType in SubAgentOptions
    options = { agentType: input.subagent_type as "general-purpose" | "Explore" | "Plan" };
  } else if (input.subagent_type) {
    // Custom agent from .clio/agents/
    const { getCustomAgent, listCustomAgents } = await import("../commands/custom-agents.js");
    const def = getCustomAgent(input.subagent_type);
    if (!def) {
      const available = listCustomAgents();
      throw new Error(`Custom agent "${input.subagent_type}" not found. Available: general-purpose, Explore, Plan${available.length > 0 ? ", " + available.join(", ") : ""}`);
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

async function toolWebSearch(input: { query: string; allowed_domains?: string[]; blocked_domains?: string[] }): Promise<string> {
  const maxResults = 10;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; clio-cli/1.0)" },
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
  while ((match = blockRe.exec(html)) !== null && results.length < maxResults) {
    const block = match[1];
    const titleMatch = titleRe.exec(block);
    const snippetMatch = snippetRe.exec(block);
    if (!titleMatch) continue;

    const href = titleMatch[1];
    const title = titleMatch[2].replace(/<[^>]*>/g, "").trim();

    // Domain filtering
    let domain: string;
    try { domain = new URL(href).hostname; } catch { continue; }

    if (input.allowed_domains?.length) {
      if (!input.allowed_domains.some(d => domain === d || domain.endsWith("." + d))) continue;
    }
    if (input.blocked_domains?.length) {
      if (input.blocked_domains.some(d => domain === d || domain.endsWith("." + d))) continue;
    }

    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").trim()
      : "";

    results.push(`${results.length + 1}. [${title}](${href})\n   ${snippet}`);
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

function toolToolSearch(input: { query: string; max_results?: number }): string {
  const maxResults = input.max_results ?? 5;
  const deferredTools = TOOL_DEFINITIONS.filter(t => DEFERRED_TOOL_NAMES.has(t.name));

  let matched: typeof deferredTools;

  if (input.query.startsWith("select:")) {
    const names = input.query.slice(7).split(",").map(n => n.trim());
    matched = deferredTools.filter(t => names.includes(t.name));
  } else {
    const q = input.query.toLowerCase();
    matched = deferredTools
      .filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      .slice(0, maxResults);
  }

  if (matched.length === 0) {
    return "No matching deferred tools found. Available: " + deferredTools.map(t => t.name).join(", ");
  }

  const functions = matched.map(t =>
    `<function>${JSON.stringify({ description: t.description, name: t.name, parameters: t.input_schema })}</function>`
  ).join("\n");

  return `<functions>\n${functions}\n</functions>`;
}

async function toolTeamCreate(input: { name: string; task: string; members: TeamMemberInput[] }): Promise<string> {
  if (!toolContext) throw new Error("TeamCreate requires tool context");

  const team = teamRegistry.create(input.name, input.task, input.members);
  const config = toolContext.config;
  const { executeSubAgent } = await import("./subagent.js");

  for (const memberInput of input.members) {
    const member = team.members.get(memberInput.name)!;
    teamRegistry.updateMemberStatus(team.id, memberInput.name, "running");

    const abort = new AbortController();
    teamRegistry.setMemberAbort(team.id, memberInput.name, abort);

    const messageHook = createMessageHook(team.id, memberInput.name);

    let options: SubAgentOptions = {
      signal: abort.signal,
      messageHook,
    };

    if (memberInput.agent_type) {
      const { getCustomAgent } = await import("../commands/custom-agents.js");
      const def = getCustomAgent(memberInput.agent_type);
      if (def) {
        options = {
          ...options,
          systemPromptOverride: def.systemPrompt,
          allowedTools: def.allowedTools,
          model: def.model,
          maxIterations: def.maxIterations,
        };
      }
    }

    if (memberInput.model) {
      options.model = memberInput.model;
    }

    const systemPreamble = [
      `You are "${memberInput.name}" on team "${team.name}".`,
      memberInput.role ? `Your role: ${memberInput.role}` : "",
      `Team task: ${team.task}`,
      `Other members: ${[...team.members.keys()].filter(n => n !== memberInput.name).join(", ")}`,
      "",
      "You can use the SendMessage tool to communicate with teammates.",
      "Messages from teammates will appear as team-messages in the conversation.",
    ].filter(Boolean).join("\n");

    const fullPrompt = `${systemPreamble}\n\nYour task: ${memberInput.prompt}`;

    // Launch as background
    const promise = executeSubAgent(config, fullPrompt, options)
      .then((result) => {
        teamRegistry.updateMemberStatus(team.id, memberInput.name, "completed", result);
        process.stderr.write(`\n  [team "${team.name}": ${memberInput.name} completed]\n`);
        return result;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        teamRegistry.updateMemberStatus(team.id, memberInput.name, "failed", msg);
        process.stderr.write(`\n  [team "${team.name}": ${memberInput.name} failed: ${msg}]\n`);
        return `Error: ${msg}`;
      });

    backgroundAgents.set(`${team.id}:${memberInput.name}`, promise);
  }

  return teamRegistry.formatTeamStatus(team);
}

async function toolTeamDelete(input: { id: string }): Promise<string> {
  const team = teamRegistry.get(input.id);
  const name = team.name;
  teamRegistry.delete(input.id);
  return `Deleted team "${name}" (${input.id})`;
}

async function toolSendMessage(input: { team_id: string; to: string; content: string }): Promise<string> {
  teamRegistry.sendMessage(input.team_id, "orchestrator", input.to, input.content);
  return `Message sent to ${input.to === "all" ? "all members" : input.to} in team ${input.team_id}`;
}

export function buildToolsForRequest(unlockedDeferred: Set<string>): typeof TOOL_DEFINITIONS {
  return TOOL_DEFINITIONS.filter(t => !DEFERRED_TOOL_NAMES.has(t.name) || unlockedDeferred.has(t.name));
}

function toolSkill(input: { skill: string; args?: string }): string {
  const skill = getSkill(input.skill);
  if (!skill) {
    const available = listSkills().map(s => s.name).join(", ");
    throw new Error(`Skill "${input.skill}" not found. Available: ${available || "(none)"}`);
  }
  const prompt = input.args
    ? skill.promptTemplate.replace(/\{\{args\}\}/g, input.args)
    : skill.promptTemplate;
  return `<skill-instructions>\n${prompt}\n</skill-instructions>`;
}
