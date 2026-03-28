// ANSI color helpers — no dependencies
// Respects NO_COLOR (https://no-color.org) and --no-color flag

let colorsEnabled =
  process.stdout.isTTY !== false &&
  !process.env.NO_COLOR &&
  !process.argv.includes("--no-color");

const defaultColorsEnabled = colorsEnabled;

export function setColorsEnabled(enabled: boolean): void {
  colorsEnabled = enabled;
}

// ── Theme ──

export type Theme = "default" | "minimal" | "plain";

let currentTheme: Theme = "default";

export function getTheme(): Theme {
  return currentTheme;
}

export function setTheme(theme: Theme): void {
  currentTheme = theme;
  colorsEnabled = theme === "plain" ? false : defaultColorsEnabled;
}

// ── Verbose toggle ──

let verboseOutput = false;

export function isVerbose(): boolean {
  return verboseOutput;
}

export function toggleVerbose(): boolean {
  verboseOutput = !verboseOutput;
  return verboseOutput;
}

const esc = (code: string) => (s: string) =>
  colorsEnabled ? `\x1b[${code}m${s}\x1b[0m` : s;

export const dim = esc("2");
export const bold = esc("1");
export const red = esc("31");
export const green = esc("32");
export const yellow = esc("33");
export const cyan = esc("36");
export const magenta = esc("35");
export const blue = esc("34");
export const boldCyan = (s: string) =>
  colorsEnabled ? `\x1b[1;36m${s}\x1b[0m` : s;
export const boldMagenta = (s: string) =>
  colorsEnabled ? `\x1b[1;35m${s}\x1b[0m` : s;
export const boldGreen = (s: string) =>
  colorsEnabled ? `\x1b[1;32m${s}\x1b[0m` : s;
export const boldYellow = (s: string) =>
  colorsEnabled ? `\x1b[1;33m${s}\x1b[0m` : s;
export const bgCyan = (s: string) =>
  colorsEnabled ? `\x1b[46;30m${s}\x1b[0m` : s;
export const dimCyan = (s: string) =>
  colorsEnabled ? `\x1b[2;36m${s}\x1b[0m` : s;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function startSpinner(message: string): () => void {
  if (!colorsEnabled) {
    process.stderr.write(`  ${message}\n`);
    return () => {};
  }

  let i = 0;
  const interval = setInterval(() => {
    process.stderr.write(`\r\x1b[2K    ${dimCyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${dim(message)}`);
  }, 80);

  return () => {
    clearInterval(interval);
    process.stderr.write("\r\x1b[2K");
  };
}

// ── Box drawing ──

function boxHeader(label: string, detail?: string): string {
  const detailStr = detail ? ` ${dim(detail)}` : "";
  return `  ${dimCyan("╭─")} ${boldCyan(label)}${detailStr}`;
}

function boxLine(content: string): string {
  return `  ${dimCyan("│")} ${content}`;
}

function boxFooter(): string {
  return `  ${dimCyan("╰─")}`;
}

// ── Tool call display ──

function formatToolDetail(name: string, input: Record<string, unknown>): { label: string; detail: string; body?: string } {
  switch (name) {
    case "Read": {
      const fp = (input.file_path as string) ?? "";
      const range = input.offset
        ? ` ${dim(`(${input.offset}${input.limit ? `-${(input.offset as number) + (input.limit as number)}` : ""}`)}`
        : "";
      return { label: "Read", detail: `${fp}${range}` };
    }
    case "Bash": {
      const cmd = (input.command as string) ?? "";
      const truncated = cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
      return { label: "Bash", detail: "", body: `${dim("$")} ${truncated}` };
    }
    case "Edit": {
      const fp = (input.file_path as string) ?? "";
      return { label: "Edit", detail: fp };
    }
    case "Write": {
      const fp = (input.file_path as string) ?? "";
      return { label: "Write", detail: fp };
    }
    case "Glob": {
      const pattern = (input.pattern as string) ?? "";
      return { label: "Glob", detail: pattern };
    }
    case "Grep": {
      const pattern = (input.pattern as string) ?? "";
      const sp = input.path as string | undefined;
      return { label: "Grep", detail: `${pattern}${sp ? dim(` in ${sp}`) : ""}` };
    }
    case "WebFetch": {
      const url = (input.url as string) ?? "";
      const prompt = (input.prompt as string) ?? "";
      const shortPrompt = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      return { label: "Fetch", detail: `${url}${shortPrompt ? dim(" → ") + shortPrompt : ""}` };
    }
    case "Agent": {
      const desc = (input.description ?? input.prompt ?? "") as string;
      const agentType = input.subagent_type as string | undefined;
      const label = agentType ? `Agent:${agentType}` : "Agent";
      const truncated = desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
      return { label, detail: truncated };
    }
    case "WebSearch":
      return { label: "Search", detail: (input.query as string) ?? "" };
    case "AskUserQuestion": {
      const q = (input.question as string) ?? "";
      return { label: "Ask", detail: q.length > 120 ? q.slice(0, 117) + "..." : q };
    }
    case "EnterPlanMode":
      return { label: "Mode", detail: "entering plan mode" };
    case "ExitPlanMode":
      return { label: "Mode", detail: "exiting plan mode" };
    case "TaskCreate": {
      const desc = (input.description as string) ?? "";
      return { label: "Task", detail: `+ ${desc.length > 100 ? desc.slice(0, 97) + "..." : desc}` };
    }
    case "TaskUpdate": {
      const id = (input.id as string) ?? "";
      const status = input.status as string | undefined;
      return { label: "Task", detail: `${id}${status ? ` → ${status}` : ""}` };
    }
    case "TaskList":
      return { label: "Task", detail: "list" };
    case "TaskGet":
      return { label: "Task", detail: (input.id as string) ?? "" };
    default: {
      const params = Object.entries(input)
        .filter(([, v]) => typeof v === "string" && (v as string).length < 120)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      return { label: name, detail: params };
    }
  }
}

export function renderToolCall(name: string, input: Record<string, unknown>): void {
  const { label, detail, body } = formatToolDetail(name, input);
  process.stderr.write(`\n${boxHeader(label, detail)}\n`);
  if (body) {
    process.stderr.write(`${boxLine(body)}\n`);
  }
}

export function renderToolResult(result: string, isError: boolean): void {
  if (isError) {
    const lines = result.split("\n");
    const MAX_LINES = 20;
    const display = lines.length > MAX_LINES
      ? [...lines.slice(0, MAX_LINES), `... (${lines.length - MAX_LINES} more lines)`]
      : lines;

    process.stderr.write(`${boxLine(`${red("✗")} ${red(display[0])}`)}\n`);
    for (let i = 1; i < display.length; i++) {
      process.stderr.write(`${boxLine(`  ${red(display[i])}`)}\n`);
    }
    process.stderr.write(`${boxFooter()}\n`);
  } else if (verboseOutput) {
    const lines = result.split("\n");
    const MAX_VERBOSE = 100;
    const display = lines.length > MAX_VERBOSE
      ? [...lines.slice(0, MAX_VERBOSE), `... (${lines.length - MAX_VERBOSE} more lines)`]
      : lines;
    process.stderr.write(`${boxLine(`${green("✓")}`)}\n`);
    for (const line of display) {
      process.stderr.write(`${boxLine(`  ${dim(line)}`)}\n`);
    }
    process.stderr.write(`${boxFooter()}\n`);
  } else {
    const lines = result.split("\n");
    const first = lines[0].length > 100 ? lines[0].slice(0, 97) + "..." : lines[0];
    const suffix = lines.length > 1 ? dim(` (+${lines.length - 1} lines)`) : "";
    process.stderr.write(`${boxLine(`${green("✓")} ${dim(first)}${suffix}`)}\n`);
    process.stderr.write(`${boxFooter()}\n`);
  }
}

export function renderPermissionDenied(toolName: string): void {
  process.stderr.write(`${boxLine(`${yellow("⊘")} ${dim(`Permission denied: ${toolName}`)}`)}\n`);
  process.stderr.write(`${boxFooter()}\n`);
}

export function renderDiff(oldStr: string, newStr: string): void {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  for (const line of oldLines) {
    process.stderr.write(`${boxLine(red("- " + line))}\n`);
  }
  for (const line of newLines) {
    process.stderr.write(`${boxLine(green("+ " + line))}\n`);
  }
}

export function renderError(message: string): void {
  process.stderr.write(`\n${red("Error:")} ${message}\n`);
}

// ── Thinking block borders ──

export function renderThinkingStart(): void {
  process.stderr.write(`\n${boxHeader("thinking")}\n`);
}

export function renderThinkingEnd(): void {
  process.stderr.write(`${boxFooter()}\n`);
}

export function renderThinkingLine(text: string): string {
  // Format thinking text to have box line prefix on each line
  let out = "";
  for (const c of text) {
    out += c;
  }
  return out;
}

// ── Permission prompt (box-integrated) ──

export function renderPermissionPrompt(toolName: string): string {
  return `${boxLine(`${yellow("?")} Allow ${bold(toolName)}? ${dim("[Y]es / [n]o / [a]lways")} `)}`;
}

export function renderPermissionResponse(response: string): void {
  process.stderr.write(dim(response) + "\n");
}

// ── Startup banner ──

export function renderBanner(opts: {
  model: string;
  apiUrl: string;
  cwd: string;
  sessionId: string;
  mode: string;
  mcpServers?: string[];
  lspServers?: string[];
  agents?: string[];
  resumed?: { id: string; messageCount: number };
  forked?: { fromId: string; messageCount: number };
}): void {
  const w = Math.min(process.stdout.columns ?? 60, 60);
  const line = "─".repeat(w - 4);

  console.log();
  console.log(`  ${dimCyan(line)}`);
  console.log();
  console.log(`  ${boldCyan("◆")} ${bold("Claude Code")} ${dim(`(${opts.model})`)}`);
  console.log();

  const info: [string, string][] = [
    ["cwd", opts.cwd],
    ["session", opts.sessionId],
    ["mode", opts.mode],
  ];

  if (opts.apiUrl !== "https://api.anthropic.com") {
    info.unshift(["gateway", opts.apiUrl]);
  }
  if (opts.mcpServers?.length) info.push(["mcp", opts.mcpServers.join(", ")]);
  if (opts.lspServers?.length) info.push(["lsp", opts.lspServers.join(", ")]);
  if (opts.agents?.length) info.push(["agents", opts.agents.join(", ")]);
  if (opts.resumed) info.push(["resumed", `${opts.resumed.id} (${opts.resumed.messageCount} messages)`]);
  if (opts.forked) info.push(["forked", `from ${opts.forked.fromId} (${opts.forked.messageCount} messages)`]);

  const maxLabel = Math.max(...info.map(([k]) => k.length));
  for (const [label, value] of info) {
    console.log(`  ${dimCyan("│")} ${dim(label.padEnd(maxLabel))}  ${dim(value)}`);
  }

  console.log();
  console.log(`  ${dim("Type")} ${boldCyan("/help")} ${dim("for commands, Shift+Tab to switch mode")}`);
  console.log(`  ${dimCyan(line)}`);
  console.log();
}
