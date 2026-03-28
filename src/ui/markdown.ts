import { bold, dim, cyan, yellow, green, magenta, getTheme } from "./render.js";
import { highlightLine } from "./highlight.js";

/**
 * Line-buffered markdown renderer for streaming terminal output.
 * Buffers text until newlines, then renders each complete line
 * with ANSI formatting. Tracks code block state across lines.
 */
export class MarkdownRenderer {
  private buffer = "";
  private inCodeBlock = false;
  private codeLang = "";

  private pendingLen = 0; // how many chars of current partial line we already wrote raw

  /** Feed a text chunk (may be partial line). Renders complete lines immediately, partial lines raw. */
  write(text: string): void {
    this.buffer += text;

    let nlIdx: number;
    while ((nlIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);

      // Erase the raw partial text we already printed for this line
      if (this.pendingLen > 0) {
        // Move cursor back and clear
        process.stdout.write(`\r\x1b[2K`);
        this.pendingLen = 0;
      }

      this.renderLine(line);
      process.stdout.write("\n");
    }

    // Print remaining partial buffer immediately (raw, no formatting) for streaming feel
    if (this.buffer.length > this.pendingLen) {
      const newChars = this.buffer.slice(this.pendingLen);
      process.stdout.write(newChars);
      this.pendingLen = this.buffer.length;
    }
  }

  /** Flush remaining buffer (last line with no trailing newline). */
  flush(): void {
    if (this.buffer) {
      // Erase raw partial text, then render with formatting
      if (this.pendingLen > 0) {
        process.stdout.write(`\r\x1b[2K`);
        this.pendingLen = 0;
      }
      this.renderLine(this.buffer);
      this.buffer = "";
    }
  }

  /** Reset state between messages. */
  reset(): void {
    this.buffer = "";
    this.inCodeBlock = false;
    this.codeLang = "";
    this.pendingLen = 0;
  }

  private renderLine(line: string): void {
    const theme = getTheme();

    // ── Code block fences ──
    if (line.trimStart().startsWith("```")) {
      if (this.inCodeBlock) {
        this.inCodeBlock = false;
        this.codeLang = "";
        if (theme === "default") process.stdout.write(dim("  ╰─"));
      } else {
        this.inCodeBlock = true;
        const lang = line.trimStart().slice(3).trim();
        this.codeLang = lang.toLowerCase();
        if (theme === "default") process.stdout.write(dim(`  ╭─ ${lang ? magenta(lang) : ""}`));
      }
      return;
    }

    // ── Inside code block ──
    if (this.inCodeBlock) {
      const highlighted = this.codeLang ? highlightLine(line, this.codeLang) : green(line);
      if (theme === "default") {
        process.stdout.write(`  ${dim("│")} ${highlighted}`);
      } else {
        process.stdout.write(`  ${highlighted}`);
      }
      return;
    }

    // ── Headings ──
    const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headerMatch) {
      process.stdout.write(bold(headerMatch[2]));
      return;
    }

    // ── Blockquotes ──
    if (line.startsWith("> ")) {
      process.stdout.write(`${dim("│")} ${dim(this.inlineFormat(line.slice(2)))}`);
      return;
    }

    // ── Horizontal rule ──
    if (/^[-*_]{3,}\s*$/.test(line)) {
      process.stdout.write(dim("─".repeat(40)));
      return;
    }

    // ── List items ──
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      process.stdout.write(`${ulMatch[1]}${dim("•")} ${this.inlineFormat(ulMatch[2])}`);
      return;
    }

    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      process.stdout.write(`${olMatch[1]}${dim(olMatch[2] + ".")} ${this.inlineFormat(olMatch[3])}`);
      return;
    }

    // ── Regular text ──
    process.stdout.write(this.inlineFormat(line));
  }

  /** Apply inline formatting: bold, italic, inline code, strikethrough. */
  private inlineFormat(text: string): string {
    // Inline code (must come first to avoid formatting inside code)
    text = text.replace(/`([^`]+)`/g, (_, code: string) => cyan(code));
    // Bold + italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_, s: string) => bold(s));
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, (_, s: string) => bold(s));
    // Italic (single *)
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, s: string) => dim(s));
    // Strikethrough
    text = text.replace(/~~(.+?)~~/g, (_, s: string) => dim(s));

    return text;
  }
}
