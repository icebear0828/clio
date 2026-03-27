import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import { dim } from "./render.js";

const CONTINUATION_PROMPT = "... ";

const SLASH_COMMANDS = [
  "/clear", "/commit", "/compact", "/cost", "/exit",
  "/help", "/init", "/model", "/pr", "/review",
  "/sessions", "/settings", "/quit",
];

/** Strip ANSI escape codes to get visible character count */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export class InputReader {
  private history: string[] = [];
  private historyIdx = 0;

  /**
   * Read user input with:
   * - Multi-line paste detection
   * - Backslash (`\`) line continuation
   * - Up/Down command history
   * - Ctrl+C → null (cancel)
   * - Ctrl+D on empty → null (EOF)
   *
   * Returns the input string, or null for cancel/EOF.
   */
  async read(prompt: string): Promise<string | null> {
    // Non-TTY fallback (piped input)
    if (!stdin.isTTY) {
      return this.readFallback(prompt);
    }

    return new Promise((resolve) => {
      const lines: string[] = [""];
      let lineIdx = 0;
      let cursor = 0;
      let savedHistoryIdx = this.history.length;
      let resolved = false;

      stdout.write(prompt);

      stdin.setRawMode(true);
      stdin.resume();

      const done = (result: string | null) => {
        if (resolved) return;
        resolved = true;
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write("\n");

        if (result !== null && result.trim()) {
          this.history.push(result);
        }
        this.historyIdx = this.history.length;
        resolve(result);
      };

      const currentPrompt = () => (lineIdx === 0 ? prompt : CONTINUATION_PROMPT);

      const redraw = () => {
        const line = lines[lineIdx];
        const p = currentPrompt();
        stdout.write(`\r\x1b[K${p}${line}`);
        const back = line.length - cursor;
        if (back > 0) stdout.write(`\x1b[${back}D`);
      };

      const onData = (chunk: Buffer) => {
        const data = chunk.toString("utf-8");

        // ── Paste detection: multi-char chunk with newlines ──
        if (data.length > 1 && data.includes("\n")) {
          const parts = data.split(/\r?\n/);

          // Insert first part at cursor position on current line
          const before = lines[lineIdx].slice(0, cursor);
          const after = lines[lineIdx].slice(cursor);
          lines[lineIdx] = before + parts[0];

          // Add middle parts as new lines
          for (let i = 1; i < parts.length - 1; i++) {
            lines.push(parts[i]);
          }

          // Last part + remainder of original line
          const lastPart = parts[parts.length - 1];
          lines.push(lastPart + after);

          lineIdx = lines.length - 1;
          cursor = lastPart.length;

          // Display pasted content
          stdout.write(parts[0]);
          for (let i = 1; i < parts.length; i++) {
            stdout.write(`\n${CONTINUATION_PROMPT}${parts[i]}`);
          }
          // Position cursor correctly
          if (after.length > 0) {
            stdout.write(after);
            stdout.write(`\x1b[${after.length}D`);
          }

          // If paste ended with a trailing newline, auto-submit
          if (lastPart === "" && after === "") {
            lines.pop();
            done(lines.join("\n"));
          }
          return;
        }

        // ── Single-character processing ──
        for (let i = 0; i < data.length; i++) {
          const ch = data[i];
          const code = data.charCodeAt(i);

          // Escape sequences (\x1b[X)
          if (ch === "\x1b" && i + 2 < data.length && data[i + 1] === "[") {
            const seq = data[i + 2];
            i += 2;

            if (seq === "A") {
              // Up — history (only on first line)
              if (lineIdx === 0 && savedHistoryIdx > 0) {
                savedHistoryIdx--;
                lines[0] = this.history[savedHistoryIdx];
                lineIdx = 0;
                cursor = lines[0].length;
                redraw();
              }
            } else if (seq === "B") {
              // Down — history
              if (lineIdx === 0 && savedHistoryIdx < this.history.length) {
                savedHistoryIdx++;
                lines[0] =
                  savedHistoryIdx < this.history.length
                    ? this.history[savedHistoryIdx]
                    : "";
                cursor = lines[0].length;
                redraw();
              }
            } else if (seq === "C") {
              // Right
              if (cursor < lines[lineIdx].length) {
                cursor++;
                stdout.write("\x1b[C");
              }
            } else if (seq === "D") {
              // Left
              if (cursor > 0) {
                cursor--;
                stdout.write("\x1b[D");
              }
            }
            // Skip other escape sequences
            continue;
          }

          // Ctrl+C
          if (code === 3) {
            done(null);
            return;
          }

          // Ctrl+D on empty buffer
          if (code === 4 && lines.every((l) => l === "")) {
            done(null);
            return;
          }

          // Backspace (0x7f or 0x08)
          if (code === 127 || code === 8) {
            if (cursor > 0) {
              lines[lineIdx] =
                lines[lineIdx].slice(0, cursor - 1) +
                lines[lineIdx].slice(cursor);
              cursor--;
              redraw();
            }
            continue;
          }

          // Enter
          if (ch === "\r" || ch === "\n") {
            const currentLine = lines[lineIdx];

            // Backslash continuation
            if (currentLine.endsWith("\\")) {
              lines[lineIdx] = currentLine.slice(0, -1);
              lines.push("");
              lineIdx++;
              cursor = 0;
              stdout.write(`\n${CONTINUATION_PROMPT}`);
              continue;
            }

            // Submit
            done(lines.join("\n"));
            return;
          }

          // Ctrl+U — clear to start of line
          if (code === 21) {
            lines[lineIdx] = lines[lineIdx].slice(cursor);
            cursor = 0;
            redraw();
            continue;
          }

          // Tab → slash command completion or 2 spaces
          if (code === 9) {
            const currentText = lines[lineIdx];
            if (currentText.startsWith("/") && lineIdx === 0) {
              const matches = SLASH_COMMANDS.filter((c) => c.startsWith(currentText));
              if (matches.length === 1) {
                lines[lineIdx] = matches[0];
                cursor = matches[0].length;
                redraw();
              } else if (matches.length > 1) {
                // Show candidates
                stdout.write(`\n${dim(matches.join("  "))}\n`);
                const p = currentPrompt();
                stdout.write(`${p}${currentText}`);
              }
            } else {
              lines[lineIdx] =
                currentText.slice(0, cursor) +
                "  " +
                currentText.slice(cursor);
              cursor += 2;
              redraw();
            }
            continue;
          }

          // Printable character
          if (code >= 32) {
            lines[lineIdx] =
              lines[lineIdx].slice(0, cursor) +
              ch +
              lines[lineIdx].slice(cursor);
            cursor++;
            redraw();

            // Auto-show slash commands when typing "/" on empty first line
            if (ch === "/" && lineIdx === 0 && lines[0] === "/") {
              stdout.write(`\n${dim(SLASH_COMMANDS.join("  "))}\n`);
              const p = currentPrompt();
              stdout.write(`${p}${lines[lineIdx]}`);
            }
          }
        }
      };

      stdin.on("data", onData);
    });
  }

  /** Simple readline fallback for non-TTY (piped) input */
  private async readFallback(prompt: string): Promise<string | null> {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const line = await rl.question(prompt);
      return line;
    } catch {
      return null;
    } finally {
      rl.close();
    }
  }
}
