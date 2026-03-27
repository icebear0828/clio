import { dim, cyan } from "./render.js";
import type { UsageStats } from "./types.js";

/**
 * Bottom status bar — fixed at the last terminal line.
 * Uses ANSI scroll region to reserve the bottom row.
 */
export class StatusBar {
  private model = "";
  private sessionId = "";
  private usage: UsageStats = { inputTokens: 0, outputTokens: 0 };
  private enabled: boolean;

  constructor() {
    const isWindows = process.platform === "win32";
    this.enabled = process.stdout.isTTY === true && !process.env.NO_COLOR && !isWindows;
  }

  /** Initialize scroll region (reserve bottom line). */
  init(model: string, sessionId: string): void {
    if (!this.enabled) return;
    this.model = model;
    this.sessionId = sessionId;

    const rows = process.stdout.rows ?? 24;
    // Set scroll region to rows-1, leaving last line for status
    process.stderr.write(`\x1b[1;${rows - 1}r`);
    this.render();

    // Re-setup on terminal resize
    process.stdout.on("resize", () => {
      const r = process.stdout.rows ?? 24;
      process.stderr.write(`\x1b[1;${r - 1}r`);
      this.render();
    });
  }

  /** Update usage stats and re-render. */
  update(usage: UsageStats): void {
    this.usage = usage;
    this.render();
  }

  updateModel(model: string): void {
    this.model = model;
    this.render();
  }

  /** Render status bar at the bottom line. */
  private render(): void {
    if (!this.enabled) return;

    const rows = process.stdout.rows ?? 24;
    const cols = process.stdout.columns ?? 80;

    const totalK = ((this.usage.inputTokens + this.usage.outputTokens) / 1000).toFixed(1);
    const left = ` ${this.model}`;
    const right = `${totalK}k tokens  ${this.sessionId} `;
    const padding = Math.max(0, cols - left.length - right.length);

    const bar = dim(left + " ".repeat(padding) + right);

    // Save cursor, move to last row, clear line, write bar, restore cursor
    process.stderr.write(`\x1b7\x1b[${rows};1H\x1b[K${bar}\x1b8`);
  }

  /** Restore terminal state (clear scroll region). */
  destroy(): void {
    if (!this.enabled) return;
    // Reset scroll region to full terminal
    process.stderr.write("\x1b[r");
    // Clear the status bar line
    const rows = process.stdout.rows ?? 24;
    process.stderr.write(`\x1b[${rows};1H\x1b[K`);
  }
}
