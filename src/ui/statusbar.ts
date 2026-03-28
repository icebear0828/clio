import { dim, cyan } from "./render.js";
import { estimateCost, formatUSD } from "../core/pricing.js";
import type { PermissionMode, UsageStats } from "../types.js";

export type StatusBarField = "model" | "mode" | "cost" | "tokens" | "session" | "verbose";

const DEFAULT_FIELDS: StatusBarField[] = ["model", "mode", "verbose", "cost", "tokens", "session"];

export class StatusBar {
  private model = "";
  private sessionId = "";
  private mode: PermissionMode = "default";
  private verbose = false;
  private usage: UsageStats = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  private fields: StatusBarField[] = DEFAULT_FIELDS;
  private enabled: boolean;

  constructor() {
    this.enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;
  }

  /** Initialize scroll region (reserve bottom line). */
  init(model: string, sessionId: string, mode?: PermissionMode): void {
    if (!this.enabled) return;
    this.model = model;
    this.sessionId = sessionId;
    if (mode) this.mode = mode;

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

  updateMode(mode: PermissionMode): void {
    this.mode = mode;
    this.render();
  }

  updateVerbose(verbose: boolean): void {
    this.verbose = verbose;
    this.render();
  }

  setFields(fields: StatusBarField[]): void {
    this.fields = fields;
    this.render();
  }

  private render(): void {
    if (!this.enabled) return;

    const rows = process.stdout.rows ?? 24;
    const cols = process.stdout.columns ?? 80;

    const left: string[] = [];
    const right: string[] = [];

    for (const field of this.fields) {
      switch (field) {
        case "model":
          left.push(this.model);
          break;
        case "mode":
          if (this.mode !== "default") left.push(`[${this.mode}]`);
          break;
        case "verbose":
          if (this.verbose) left.push("[verbose]");
          break;
        case "cost": {
          const cost = estimateCost(this.model, this.usage.inputTokens, this.usage.outputTokens);
          if (cost) right.push(formatUSD(cost.total));
          break;
        }
        case "tokens": {
          const totalK = ((this.usage.inputTokens + this.usage.outputTokens) / 1000).toFixed(1);
          right.push(`${totalK}k tokens`);
          break;
        }
        case "session":
          right.push(this.sessionId);
          break;
      }
    }

    const leftStr = ` ${left.join(" ")}`;
    const rightStr = `${right.join("  ")} `;
    const padding = Math.max(0, cols - leftStr.length - rightStr.length);
    const bar = dim(leftStr + " ".repeat(padding) + rightStr);

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
