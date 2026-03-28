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
    process.stderr.write(`\r  ${cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${dim(message)}`);
  }, 80);

  return () => {
    clearInterval(interval);
    process.stderr.write("\r\x1b[K");
  };
}

export function renderToolCall(name: string, input: Record<string, unknown>): void {
  let display: string;

  switch (name) {
    case "Read": {
      const fp = (input.file_path as string) ?? "";
      const range = input.offset
        ? ` ${dim(`(${input.offset}${input.limit ? `-${(input.offset as number) + (input.limit as number)}` : ""}`)}`
        : "";
      display = `${dim("Read")} ${cyan(fp)}${range}`;
      break;
    }
    case "Bash": {
      const cmd = (input.command as string) ?? "";
      const truncated = cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
      display = `${dim("$")} ${truncated}`;
      break;
    }
    case "Edit": {
      const fp = (input.file_path as string) ?? "";
      display = `${dim("Edit")} ${cyan(fp)}`;
      break;
    }
    case "Write": {
      const fp = (input.file_path as string) ?? "";
      display = `${dim("Write")} ${cyan(fp)}`;
      break;
    }
    case "Glob": {
      const pattern = (input.pattern as string) ?? "";
      display = `${dim("Glob")} ${cyan(pattern)}`;
      break;
    }
    case "Grep": {
      const pattern = (input.pattern as string) ?? "";
      const sp = input.path as string | undefined;
      display = `${dim("Grep")} ${cyan(pattern)}${sp ? dim(` in ${sp}`) : ""}`;
      break;
    }
    case "WebFetch": {
      const url = (input.url as string) ?? "";
      const prompt = (input.prompt as string) ?? "";
      const shortPrompt = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      display = `${dim("Fetch")} ${cyan(url)}${shortPrompt ? dim(" → ") + shortPrompt : ""}`;
      break;
    }
    case "Agent": {
      const desc = (input.description ?? input.prompt ?? "") as string;
      const agentType = input.subagent_type as string | undefined;
      const label = desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
      const prefix = agentType ? `Agent:${agentType}` : "Agent";
      display = `${dim(prefix)} ${cyan(label)}`;
      break;
    }
    case "WebSearch": {
      display = `${dim("Search")} ${cyan((input.query as string) ?? "")}`;
      break;
    }
    case "AskUserQuestion": {
      const q = (input.question as string) ?? "";
      display = `${dim("Ask")} ${cyan(q.length > 120 ? q.slice(0, 117) + "..." : q)}`;
      break;
    }
    case "EnterPlanMode": {
      display = `${dim("Mode")} ${cyan("entering plan mode")}`;
      break;
    }
    case "ExitPlanMode": {
      display = `${dim("Mode")} ${cyan("exiting plan mode")}`;
      break;
    }
    case "TaskCreate": {
      const desc = (input.description as string) ?? "";
      const truncated = desc.length > 100 ? desc.slice(0, 97) + "..." : desc;
      display = `${dim("Task")} ${cyan("+")} ${truncated}`;
      break;
    }
    case "TaskUpdate": {
      const id = (input.id as string) ?? "";
      const status = input.status as string | undefined;
      const parts = [id];
      if (status) parts.push(`-> ${status}`);
      display = `${dim("Task")} ${cyan(parts.join(" "))}`;
      break;
    }
    case "TaskList": {
      display = `${dim("Task")} ${cyan("list")}`;
      break;
    }
    case "TaskGet": {
      const id = (input.id as string) ?? "";
      display = `${dim("Task")} ${cyan(id)}`;
      break;
    }
    default: {
      const params = Object.entries(input)
        .filter(([, v]) => typeof v === "string" && (v as string).length < 120)
        .map(([k, v]) => `${dim(k + "=")}${cyan(JSON.stringify(v))}`)
        .join(" ");
      display = `${boldMagenta("⚡")} ${bold(name)} ${params}`;
    }
  }

  process.stderr.write(`\n  ${display}\n`);
}

export function renderToolResult(result: string, isError: boolean): void {
  if (isError) {
    const lines = result.split("\n");
    const MAX_LINES = 20;
    const display = lines.length > MAX_LINES
      ? [...lines.slice(0, MAX_LINES), dim(`  ... (${lines.length - MAX_LINES} more lines)`)]
      : lines;

    process.stderr.write(`  ${red("✗")} `);
    if (display.length === 1) {
      process.stderr.write(red(display[0]) + "\n");
    } else {
      process.stderr.write("\n");
      for (const line of display) {
        process.stderr.write(`    ${red(line)}\n`);
      }
    }
  } else if (verboseOutput) {
    const lines = result.split("\n");
    const MAX_VERBOSE = 100;
    const display = lines.length > MAX_VERBOSE
      ? [...lines.slice(0, MAX_VERBOSE), `  ... (${lines.length - MAX_VERBOSE} more lines)`]
      : lines;
    process.stderr.write(`  ${green("✓")}\n`);
    for (const line of display) {
      process.stderr.write(`    ${dim(line)}\n`);
    }
  } else {
    const lines = result.split("\n");
    const first = lines[0].length > 100 ? lines[0].slice(0, 97) + "..." : lines[0];
    const suffix = lines.length > 1 ? dim(` (+${lines.length - 1} lines)`) : "";
    process.stderr.write(`  ${green("✓")} ${dim(first)}${suffix}\n`);
  }
}

export function renderPermissionDenied(toolName: string): void {
  process.stderr.write(`  ${yellow("⊘")} ${dim(`Permission denied: ${toolName}`)}\n`);
}

export function renderDiff(oldStr: string, newStr: string): void {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  for (const line of oldLines) {
    process.stderr.write(`    ${red("- " + line)}\n`);
  }
  for (const line of newLines) {
    process.stderr.write(`    ${green("+ " + line)}\n`);
  }
}

export function renderError(message: string): void {
  process.stderr.write(`\n${red("Error:")} ${message}\n`);
}
