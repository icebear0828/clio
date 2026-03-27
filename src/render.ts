// ANSI color helpers — no dependencies
// Respects NO_COLOR (https://no-color.org) and --no-color flag

let colorsEnabled =
  process.stdout.isTTY !== false &&
  !process.env.NO_COLOR &&
  !process.argv.includes("--no-color");

export function setColorsEnabled(enabled: boolean): void {
  colorsEnabled = enabled;
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
  const params = Object.entries(input)
    .filter(([, v]) => typeof v === "string" && (v as string).length < 120)
    .map(([k, v]) => `${dim(k + "=")}${cyan(JSON.stringify(v))}`)
    .join(" ");

  process.stderr.write(`\n  ${boldMagenta("⚡")} ${bold(name)} ${params}\n`);
}

export function renderToolResult(result: string, isError: boolean): void {
  const lines = result.split("\n");
  const MAX_LINES = 20;
  const display = lines.length > MAX_LINES
    ? [...lines.slice(0, MAX_LINES), dim(`  ... (${lines.length - MAX_LINES} more lines)`)]
    : lines;

  const prefix = isError ? red("✗") : green("✓");
  const colorFn = isError ? red : dim;

  process.stderr.write(`  ${prefix} `);
  if (display.length === 1) {
    process.stderr.write(colorFn(display[0]) + "\n");
  } else {
    process.stderr.write("\n");
    for (const line of display) {
      process.stderr.write(`    ${colorFn(line)}\n`);
    }
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
