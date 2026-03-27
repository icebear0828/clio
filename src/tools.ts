import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";

const execAsync = promisify(exec);

// ── Workspace restriction ──

let allowOutsideCwd = false;

export function setAllowOutsideCwd(allow: boolean): void {
  allowOutsideCwd = allow;
}

function assertInWorkspace(filePath: string): void {
  if (allowOutsideCwd) return;
  const resolved = path.resolve(filePath);
  const cwd = process.cwd();
  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
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
    description: "Fast file pattern matching tool.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files" },
        path: { type: "string", description: "Directory to search in" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description: "Search file contents with regex.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory to search in" },
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
      return toolGlob(input as { pattern: string; path?: string });
    case "Grep":
      return toolGrep(input as { pattern: string; path?: string });
    case "WebFetch":
      return toolWebFetch(input as { url: string; max_length?: number });
    default:
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
    return result || "(no output)";
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    let result = e.stdout ?? "";
    if (e.stderr) result += (result ? "\n" : "") + `STDERR:\n${e.stderr}`;
    return result || e.message;
  }
}

async function toolGlob(input: { pattern: string; path?: string }): Promise<string> {
  const cwd = input.path ?? process.cwd();
  const files = await fg(input.pattern, {
    cwd,
    ignore: ["**/node_modules/**", "**/.git/**"],
    dot: true,
  });
  return files.join("\n") || "No files matched";
}

async function toolGrep(input: { pattern: string; path?: string }): Promise<string> {
  const searchPath = input.path ?? process.cwd();

  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern);
  } catch {
    throw new Error(`Invalid regex pattern: ${input.pattern}`);
  }

  const stat = await fs.stat(searchPath).catch(() => null);
  if (!stat) throw new Error(`Path not found: ${searchPath}`);

  // Single file
  if (stat.isFile()) {
    const content = await fs.readFile(searchPath, "utf-8");
    return content
      .split("\n")
      .map((line, i) => (regex.test(line) ? `${i + 1}:${line}` : null))
      .filter(Boolean)
      .join("\n") || "No matches found";
  }

  // Directory — find files, search each
  const files = await fg("**/*", {
    cwd: searchPath,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    absolute: true,
    onlyFiles: true,
  });

  const results: string[] = [];
  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf-8");
      // Skip binary-looking files
      if (content.includes("\0")) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${path.relative(searchPath, file)}:${i + 1}:${lines[i]}`);
          if (results.length >= 300) return results.join("\n");
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return results.join("\n") || "No matches found";
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
