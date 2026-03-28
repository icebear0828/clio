import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import { dim, cyan, boldCyan } from "./render.js";
import type { FileCompleter } from "./file-completions.js";
import { loadKeybindings, resolveAction, identifyKey, type Action } from "./keybindings.js";
import { listSkills } from "../skills/index.js";

const CONTINUATION_PROMPT = "... ";

const BASE_SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/btw",      desc: "Quick side question" },
  { cmd: "/clear",    desc: "Reset conversation" },
  { cmd: "/commit",   desc: "Generate commit message" },
  { cmd: "/compact",  desc: "Compress context" },
  { cmd: "/context",  desc: "Show context usage" },
  { cmd: "/cost",     desc: "Show token usage" },
  { cmd: "/doctor",   desc: "System health check" },
  { cmd: "/exit",     desc: "Save and quit" },
  { cmd: "/help",     desc: "Show commands" },
  { cmd: "/init",     desc: "Generate AGENTS.md" },
  { cmd: "/model",    desc: "Show/switch model" },
  { cmd: "/pr",       desc: "Create pull request" },
  { cmd: "/review",   desc: "Review git diff" },
  { cmd: "/sessions", desc: "List saved sessions" },
  { cmd: "/settings", desc: "Show config" },
  { cmd: "/theme",    desc: "Switch output theme" },
  { cmd: "/quit",     desc: "Quit" },
];

export function getSlashCommands(): Array<{ cmd: string; desc: string }> {
  const commands = [...BASE_SLASH_COMMANDS];
  for (const skill of listSkills()) {
    const cmd = `/${skill.name}`;
    if (!commands.some(c => c.cmd === cmd)) {
      commands.push({ cmd, desc: skill.description });
    }
  }
  return commands.sort((a, b) => a.cmd.localeCompare(b.cmd));
}

/** Strip ANSI escape codes to get visible character count */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

interface UndoSnapshot {
  lines: string[];
  lineIdx: number;
  cursor: number;
}

export class InputReader {
  private history: string[] = [];
  private historyIdx = 0;
  private killRing = "";
  private shiftTabHandler: (() => void) | null = null;
  private ctrlOHandler: (() => void) | null = null;
  private fileCompleter: FileCompleter | null = null;
  private undoStack: UndoSnapshot[] = [];
  private redoStack: UndoSnapshot[] = [];
  private static MAX_UNDO = 1000;
  private keybindingsLoaded = false;

  setShiftTabHandler(handler: () => void): void {
    this.shiftTabHandler = handler;
  }

  setCtrlOHandler(handler: () => void): void {
    this.ctrlOHandler = handler;
  }

  setFileCompleter(fc: FileCompleter): void {
    this.fileCompleter = fc;
    fc.getCompletions("").catch(() => {});
  }

  private captureUndo(lines: string[], lineIdx: number, cursor: number): void {
    if (this.undoStack.length >= InputReader.MAX_UNDO) {
      this.undoStack.shift();
    }
    this.undoStack.push({ lines: [...lines], lineIdx, cursor });
    this.redoStack.length = 0;
  }

  /**
   * Read user input with:
   * - Multi-line: Ctrl+J / Shift+Enter to add lines, Enter to submit
   * - Multi-line paste detection
   * - Up/Down command history (single line) / line navigation (multi-line)
   * - Cursor navigation: Ctrl+A/E, Home/End, Ctrl+Left/Right, Ctrl+W, Ctrl+K
   * - Ctrl+C → null (cancel), Ctrl+D on empty → null (EOF)
   */
  async read(prompt: string): Promise<string | null> {
    if (!this.keybindingsLoaded) {
      await loadKeybindings();
      this.keybindingsLoaded = true;
    }

    if (!stdin.isTTY) {
      return this.readFallback(prompt);
    }

    return new Promise((resolve) => {
      const self = this;
      const lines: string[] = [""];
      let lineIdx = 0;
      let cursor = 0;
      let savedHistoryIdx = this.history.length;
      let resolved = false;

      this.undoStack.length = 0;
      this.redoStack.length = 0;

      // ── Ctrl+R search state ──
      let searchMode = false;
      let searchQuery = "";
      let searchMatches: number[] = []; // indices into this.history
      let searchMatchIdx = -1;
      let savedLinesBeforeSearch: string[] | null = null;
      let savedCursorBeforeSearch = 0;
      let savedLineIdxBeforeSearch = 0;

      const findMatches = () => {
        searchMatches = [];
        if (!searchQuery) return;
        const q = searchQuery.toLowerCase();
        for (let i = this.history.length - 1; i >= 0; i--) {
          if (this.history[i].toLowerCase().includes(q)) {
            searchMatches.push(i);
          }
        }
      };

      const renderSearchPrompt = () => {
        const matchStr = searchMatchIdx >= 0 && searchMatchIdx < searchMatches.length
          ? this.history[searchMatches[searchMatchIdx]]
          : "";
        const display = matchStr.length > 60 ? matchStr.slice(0, 57) + "..." : matchStr;
        stdout.write(`\r\x1b[K${dim(`(reverse-i-search)'${searchQuery}': `)}${display}`);
      };

      const enterSearch = () => {
        searchMode = true;
        searchQuery = "";
        searchMatches = [];
        searchMatchIdx = -1;
        savedLinesBeforeSearch = [...lines];
        savedCursorBeforeSearch = cursor;
        savedLineIdxBeforeSearch = lineIdx;
        renderSearchPrompt();
      };

      const exitSearch = (accept: boolean) => {
        searchMode = false;
        if (accept && searchMatchIdx >= 0 && searchMatchIdx < searchMatches.length) {
          const match = this.history[searchMatches[searchMatchIdx]];
          lines.length = 0;
          lines.push(match);
          lineIdx = 0;
          cursor = match.length;
        } else if (!accept && savedLinesBeforeSearch) {
          lines.length = 0;
          lines.push(...savedLinesBeforeSearch);
          lineIdx = savedLineIdxBeforeSearch;
          cursor = savedCursorBeforeSearch;
        }
        savedLinesBeforeSearch = null;
        stdout.write(`\r\x1b[K`);
        fullRedraw();
      };

      const updateSearch = () => {
        findMatches();
        searchMatchIdx = searchMatches.length > 0 ? 0 : -1;
        renderSearchPrompt();
      };

      stdout.write(prompt);

      stdin.setRawMode(true);
      stdin.resume();

      const done = (result: string | null) => {
        if (resolved) return;
        resolved = true;
        closeMenu();
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

      const positionCursor = () => {
        const p = currentPrompt();
        const vis = visibleLength(p);
        stdout.write(`\r`);
        if (vis + cursor > 0) stdout.write(`\x1b[${vis + cursor}C`);
      };

      const fullRedraw = () => {
        // Move terminal cursor to line 0
        if (lineIdx > 0) stdout.write(`\x1b[${lineIdx}A`);
        // Clear from line 0 to end of screen
        stdout.write(`\r\x1b[J`);
        // Redraw all lines
        for (let l = 0; l < lines.length; l++) {
          const p = l === 0 ? prompt : CONTINUATION_PROMPT;
          if (l > 0) stdout.write("\n");
          stdout.write(`${p}${lines[l]}`);
        }
        // Move back to current line
        const linesBelow = lines.length - 1 - lineIdx;
        if (linesBelow > 0) stdout.write(`\x1b[${linesBelow}A`);
        positionCursor();
      };

      const insertNewLine = () => {
        closeMenu();
        self.captureUndo(lines, lineIdx, cursor);
        const after = lines[lineIdx].slice(cursor);
        lines[lineIdx] = lines[lineIdx].slice(0, cursor);
        lines.splice(lineIdx + 1, 0, after);

        // Clear rest of current line + everything below
        stdout.write("\x1b[K");
        lineIdx++;
        cursor = 0;

        // Write new line and all subsequent lines
        for (let l = lineIdx; l < lines.length; l++) {
          const p = l === 0 ? prompt : CONTINUATION_PROMPT;
          stdout.write(`\n${p}${lines[l]}`);
        }
        // Move back to the inserted line
        const linesBelow = lines.length - 1 - lineIdx;
        if (linesBelow > 0) stdout.write(`\x1b[${linesBelow}A`);
        positionCursor();
      };

      const moveLine = (target: number) => {
        const diff = target - lineIdx;
        if (diff < 0) stdout.write(`\x1b[${-diff}A`);
        else if (diff > 0) stdout.write(`\x1b[${diff}B`);
        lineIdx = target;
        cursor = Math.min(cursor, lines[lineIdx].length);
        positionCursor();
      };

      const wordForward = () => {
        const line = lines[lineIdx];
        let pos = cursor;
        while (pos < line.length && /\W/.test(line[pos])) pos++;
        while (pos < line.length && /\w/.test(line[pos])) pos++;
        cursor = pos;
        redraw();
      };

      const wordBackward = () => {
        const line = lines[lineIdx];
        let pos = cursor;
        while (pos > 0 && /\W/.test(line[pos - 1])) pos--;
        while (pos > 0 && /\w/.test(line[pos - 1])) pos--;
        cursor = pos;
        redraw();
      };

      const deleteWordBackward = () => {
        const line = lines[lineIdx];
        let pos = cursor;
        while (pos > 0 && /\s/.test(line[pos - 1])) pos--;
        while (pos > 0 && /\S/.test(line[pos - 1])) pos--;
        self.killRing = line.slice(pos, cursor);
        self.captureUndo(lines, lineIdx, cursor);
        lines[lineIdx] = line.slice(0, pos) + line.slice(cursor);
        cursor = pos;
        redraw();
      };

      // ── Menu state ──
      let menuOpen = false;
      let menuIdx = 0;
      let menuItems: Array<{ cmd: string; desc: string }> = [];
      let menuMode: "slash" | "file" | null = null;

      const getAtToken = (line: string, cur: number): { start: number; token: string } | null => {
        let start = cur;
        while (start > 0 && !/\s/.test(line[start - 1])) {
          start--;
        }
        const token = line.slice(start, cur);
        if (token.startsWith("@") && token.length > 1) {
          return { start, token };
        }
        return null;
      };

      const getFilteredCommands = (text: string) =>
        getSlashCommands().filter((c) => c.cmd.startsWith(text));

      const renderMenu = () => {
        if (menuItems.length === 0) return;
        for (let m = 0; m < menuItems.length; m++) {
          const item = menuItems[m];
          const isSelected = m === menuIdx;
          const prefix = isSelected ? boldCyan("\u276f") : " ";
          const cmdStr = isSelected ? boldCyan(item.cmd) : dim(item.cmd);
          const descStr = dim(item.desc);
          stdout.write(`\n  ${prefix} ${cmdStr}  ${descStr}`);
        }
        stdout.write(`\x1b[${menuItems.length}A`);
        positionCursor();
      };

      const clearMenu = () => {
        if (menuItems.length === 0) return;
        stdout.write("\x1b7");
        for (let m = 0; m < menuItems.length; m++) {
          stdout.write("\n\x1b[2K");
        }
        stdout.write("\x1b8");
      };

      const openMenu = (text: string) => {
        menuItems = getFilteredCommands(text);
        if (menuItems.length > 0) {
          menuIdx = 0;
          menuOpen = true;
          menuMode = "slash";
          renderMenu();
        } else {
          menuOpen = false;
          menuMode = null;
        }
      };

      const openFileMenu = (items: Array<{ cmd: string; desc: string }>) => {
        if (items.length > 0) {
          menuItems = items;
          menuIdx = 0;
          menuOpen = true;
          menuMode = "file";
          renderMenu();
        }
      };

      const closeMenu = () => {
        if (menuOpen) {
          clearMenu();
          menuOpen = false;
          menuItems = [];
          menuIdx = 0;
          menuMode = null;
        }
      };

      const updateMenu = (text: string) => {
        if (menuOpen) clearMenu();
        menuItems = getFilteredCommands(text);
        if (menuItems.length > 0) {
          menuIdx = Math.min(menuIdx, menuItems.length - 1);
          menuOpen = true;
          menuMode = "slash";
          renderMenu();
        } else {
          menuOpen = false;
          menuMode = null;
        }
      };

      const updateFileMenu = (items: Array<{ cmd: string; desc: string }>) => {
        if (menuOpen) clearMenu();
        if (items.length > 0) {
          menuItems = items;
          menuIdx = Math.min(menuIdx, items.length - 1);
          menuOpen = true;
          menuMode = "file";
          renderMenu();
        } else {
          menuOpen = false;
          menuMode = null;
        }
      };

      // ── CSI sequence handler ──
      const handleCSI = (seq: string) => {
        switch (seq) {
          case "A": // Up
            if (menuOpen) {
              clearMenu();
              menuIdx = (menuIdx - 1 + menuItems.length) % menuItems.length;
              renderMenu();
            } else if (lineIdx > 0) {
              moveLine(lineIdx - 1);
            } else if (lines.length === 1 && savedHistoryIdx > 0) {
              savedHistoryIdx--;
              lines[0] = this.history[savedHistoryIdx];
              cursor = lines[0].length;
              redraw();
            }
            break;
          case "B": // Down
            if (menuOpen) {
              clearMenu();
              menuIdx = (menuIdx + 1) % menuItems.length;
              renderMenu();
            } else if (lineIdx < lines.length - 1) {
              moveLine(lineIdx + 1);
            } else if (lines.length === 1 && savedHistoryIdx < this.history.length) {
              savedHistoryIdx++;
              lines[0] = savedHistoryIdx < this.history.length
                ? this.history[savedHistoryIdx]
                : "";
              cursor = lines[0].length;
              redraw();
            }
            break;
          case "C": // Right
            if (cursor < lines[lineIdx].length) {
              cursor++;
              stdout.write("\x1b[C");
            }
            break;
          case "D": // Left
            if (cursor > 0) {
              cursor--;
              stdout.write("\x1b[D");
            }
            break;
          case "1;5C": // Ctrl+Right — word forward
            wordForward();
            break;
          case "1;5D": // Ctrl+Left — word backward
            wordBackward();
            break;
          case "H": // Home
          case "1~": // Home (alternate)
            cursor = 0;
            redraw();
            break;
          case "F": // End
          case "4~": // End (alternate)
            cursor = lines[lineIdx].length;
            redraw();
            break;
          case "13;2u": // Shift+Enter — insert newline
            insertNewLine();
            break;
          case "Z": // Shift+Tab — permission mode cycle
            if (this.shiftTabHandler) this.shiftTabHandler();
            break;
          case "122;6u": // Ctrl+Shift+Z — redo (kitty protocol)
            if (self.redoStack.length > 0) {
              self.undoStack.push({ lines: [...lines], lineIdx, cursor });
              const snap = self.redoStack.pop()!;
              lines.length = 0;
              lines.push(...snap.lines);
              lineIdx = snap.lineIdx;
              cursor = snap.cursor;
              fullRedraw();
            }
            break;
        }
      };

      const handleAction = (action: Action): boolean => {
        switch (action) {
          case "submit":
            if (menuOpen && menuItems.length > 0) {
              const selected = menuItems[menuIdx].cmd;
              self.captureUndo(lines, lineIdx, cursor);
              if (menuMode === "file") {
                const atToken = getAtToken(lines[lineIdx], cursor);
                if (atToken) {
                  lines[lineIdx] =
                    lines[lineIdx].slice(0, atToken.start) +
                    selected +
                    lines[lineIdx].slice(cursor);
                  cursor = atToken.start + selected.length;
                }
              } else {
                lines[lineIdx] = selected;
                cursor = selected.length;
              }
              closeMenu();
              redraw();
              return true;
            }
            closeMenu();
            done(lines.join("\n"));
            return true;

          case "newline":
            insertNewLine();
            return true;

          case "history-prev":
            if (menuOpen) {
              clearMenu();
              menuIdx = (menuIdx - 1 + menuItems.length) % menuItems.length;
              renderMenu();
            } else if (lineIdx > 0) {
              moveLine(lineIdx - 1);
            } else if (lines.length === 1 && savedHistoryIdx > 0) {
              savedHistoryIdx--;
              lines[0] = self.history[savedHistoryIdx];
              cursor = lines[0].length;
              redraw();
            }
            return true;

          case "history-next":
            if (menuOpen) {
              clearMenu();
              menuIdx = (menuIdx + 1) % menuItems.length;
              renderMenu();
            } else if (lineIdx < lines.length - 1) {
              moveLine(lineIdx + 1);
            } else if (lines.length === 1 && savedHistoryIdx < self.history.length) {
              savedHistoryIdx++;
              lines[0] = savedHistoryIdx < self.history.length
                ? self.history[savedHistoryIdx]
                : "";
              cursor = lines[0].length;
              redraw();
            }
            return true;

          case "cursor-left":
            if (cursor > 0) {
              cursor--;
              stdout.write("\x1b[D");
            }
            return true;

          case "cursor-right":
            if (cursor < lines[lineIdx].length) {
              cursor++;
              stdout.write("\x1b[C");
            }
            return true;

          case "cursor-home":
            cursor = 0;
            redraw();
            return true;

          case "cursor-end":
            cursor = lines[lineIdx].length;
            redraw();
            return true;

          case "word-left":
            wordBackward();
            return true;

          case "word-right":
            wordForward();
            return true;

          case "delete-back":
            if (cursor > 0) {
              self.captureUndo(lines, lineIdx, cursor);
              lines[lineIdx] =
                lines[lineIdx].slice(0, cursor - 1) +
                lines[lineIdx].slice(cursor);
              cursor--;
              redraw();

              const remaining = lines[lineIdx];
              if (remaining.startsWith("/") && lineIdx === 0) {
                updateMenu(remaining);
              } else if (menuMode === "file" && self.fileCompleter) {
                const atToken = getAtToken(remaining, cursor);
                if (atToken) {
                  self.fileCompleter.getCompletions(atToken.token.slice(1)).then((items) => {
                    if (resolved) return;
                    updateFileMenu(items);
                  });
                } else {
                  closeMenu();
                }
              } else {
                closeMenu();
              }
            } else if (lineIdx > 0) {
              closeMenu();
              self.captureUndo(lines, lineIdx, cursor);
              const currentContent = lines[lineIdx];
              lines.splice(lineIdx, 1);
              lineIdx--;
              cursor = lines[lineIdx].length;
              lines[lineIdx] += currentContent;
              fullRedraw();
            }
            return true;

          case "delete-word-back":
            closeMenu();
            deleteWordBackward();
            return true;

          case "delete-to-start":
            closeMenu();
            self.captureUndo(lines, lineIdx, cursor);
            self.killRing = lines[lineIdx].slice(0, cursor);
            lines[lineIdx] = lines[lineIdx].slice(cursor);
            cursor = 0;
            redraw();
            return true;

          case "delete-to-end":
            self.captureUndo(lines, lineIdx, cursor);
            self.killRing = lines[lineIdx].slice(cursor);
            lines[lineIdx] = lines[lineIdx].slice(0, cursor);
            stdout.write("\x1b[K");
            return true;

          case "yank":
            if (self.killRing) {
              self.captureUndo(lines, lineIdx, cursor);
              lines[lineIdx] = lines[lineIdx].slice(0, cursor) + self.killRing + lines[lineIdx].slice(cursor);
              cursor += self.killRing.length;
              redraw();
            }
            return true;

          case "undo":
            if (self.undoStack.length > 0) {
              self.redoStack.push({ lines: [...lines], lineIdx, cursor });
              const snap = self.undoStack.pop()!;
              lines.length = 0;
              lines.push(...snap.lines);
              lineIdx = snap.lineIdx;
              cursor = snap.cursor;
              fullRedraw();
            }
            return true;

          case "redo":
            if (self.redoStack.length > 0) {
              self.undoStack.push({ lines: [...lines], lineIdx, cursor });
              const snap = self.redoStack.pop()!;
              lines.length = 0;
              lines.push(...snap.lines);
              lineIdx = snap.lineIdx;
              cursor = snap.cursor;
              fullRedraw();
            }
            return true;

          case "search-history":
            closeMenu();
            enterSearch();
            return true;

          case "clear-screen":
            stdout.write("\x1b[2J\x1b[H");
            fullRedraw();
            return true;

          case "cancel":
            closeMenu();
            done(null);
            return true;

          case "eof":
            if (lines.every((l) => l === "")) {
              closeMenu();
              done(null);
              return true;
            }
            return false;

          case "escape":
            if (searchMode) { exitSearch(false); return true; }
            if (menuOpen) closeMenu();
            return true;

          case "tab": {
            const currentText = lines[lineIdx];
            if (menuOpen && menuItems.length > 0) {
              const selected = menuItems[menuIdx].cmd;
              self.captureUndo(lines, lineIdx, cursor);
              if (menuMode === "file") {
                const atToken = getAtToken(lines[lineIdx], cursor);
                if (atToken) {
                  lines[lineIdx] =
                    lines[lineIdx].slice(0, atToken.start) +
                    selected +
                    lines[lineIdx].slice(cursor);
                  cursor = atToken.start + selected.length;
                }
              } else {
                lines[lineIdx] = selected;
                cursor = selected.length;
              }
              closeMenu();
              redraw();
            } else if (currentText.startsWith("/") && lineIdx === 0) {
              const matches = getFilteredCommands(currentText);
              if (matches.length === 1) {
                self.captureUndo(lines, lineIdx, cursor);
                lines[lineIdx] = matches[0].cmd;
                cursor = matches[0].cmd.length;
                redraw();
              } else if (matches.length > 1) {
                openMenu(currentText);
              }
            } else if (self.fileCompleter) {
              const atToken = getAtToken(currentText, cursor);
              if (atToken) {
                const partial = atToken.token.slice(1);
                self.fileCompleter.getCompletions(partial).then((matches) => {
                  if (resolved) return;
                  if (matches.length === 1) {
                    self.captureUndo(lines, lineIdx, cursor);
                    lines[lineIdx] =
                      lines[lineIdx].slice(0, atToken.start) +
                      matches[0].cmd +
                      lines[lineIdx].slice(cursor);
                    cursor = atToken.start + matches[0].cmd.length;
                    redraw();
                  } else if (matches.length > 1) {
                    openFileMenu(matches);
                  }
                });
              } else {
                self.captureUndo(lines, lineIdx, cursor);
                lines[lineIdx] =
                  currentText.slice(0, cursor) +
                  "  " +
                  currentText.slice(cursor);
                cursor += 2;
                redraw();
              }
            } else {
              self.captureUndo(lines, lineIdx, cursor);
              lines[lineIdx] =
                currentText.slice(0, cursor) +
                "  " +
                currentText.slice(cursor);
              cursor += 2;
              redraw();
            }
            return true;
          }

          case "shift-tab":
            if (self.shiftTabHandler) self.shiftTabHandler();
            return true;

          case "verbose-toggle":
            if (self.ctrlOHandler) self.ctrlOHandler();
            return true;

          default:
            return false;
        }
      };

      const onData = (chunk: Buffer) => {
        const data = chunk.toString("utf-8");

        // ── Paste detection: multi-char chunk with newlines ──
        if (data.length > 1 && data.includes("\n")) {
          closeMenu();
          const parts = data.split(/\r?\n/);

          const before = lines[lineIdx].slice(0, cursor);
          const after = lines[lineIdx].slice(cursor);
          self.captureUndo(lines, lineIdx, cursor);
          lines[lineIdx] = before + parts[0];

          for (let p = 1; p < parts.length - 1; p++) {
            lines.splice(lineIdx + p, 0, parts[p]);
          }

          const lastPart = parts[parts.length - 1];
          lines.splice(lineIdx + parts.length - 1, 0, lastPart + after);

          lineIdx = lineIdx + parts.length - 1;
          cursor = lastPart.length;

          // Display pasted content
          stdout.write(parts[0]);
          for (let p = 1; p < parts.length; p++) {
            stdout.write(`\n${CONTINUATION_PROMPT}${parts[p]}`);
          }
          if (after.length > 0) {
            stdout.write(after);
            stdout.write(`\x1b[${after.length}D`);
          }

          // Auto-submit if paste ended with trailing newline
          if (lastPart === "" && after === "") {
            lines.splice(lineIdx, 1);
            lineIdx = Math.max(0, lineIdx - 1);
            done(lines.join("\n"));
          }
          return;
        }

        // ── Single-character processing ──
        for (let i = 0; i < data.length; i++) {
          const ch = data[i];
          const code = data.charCodeAt(i);

          if (!searchMode) {
            const identified = identifyKey(data, i);
            if (identified) {
              const action = resolveAction(identified.key);
              if (action) {
                const handled = handleAction(action);
                if (handled) {
                  i += identified.consumed - 1;
                  if (resolved) return;
                  continue;
                }
              }
            }
          }

          // ── CSI escape sequences (\x1b[ params finalByte) ──
          if (ch === "\x1b" && i + 1 < data.length && data[i + 1] === "[") {
            i += 2; // skip \x1b[
            let params = "";
            while (i < data.length && data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) {
              params += data[i];
              i++;
            }
            if (i >= data.length) continue;
            const finalByte = data[i];
            handleCSI(params + finalByte);
            continue;
          }

          // Bare Escape key (close menu or cancel search)
          if (code === 27) {
            if (searchMode) { exitSearch(false); continue; }
            if (menuOpen) closeMenu();
            continue;
          }

          // ── Search mode intercept ──
          if (searchMode) {
            if (code === 18) { // Ctrl+R again — next match
              if (searchMatchIdx < searchMatches.length - 1) {
                searchMatchIdx++;
                renderSearchPrompt();
              }
              continue;
            }
            if (ch === "\r") { // Enter — accept match
              exitSearch(true);
              continue;
            }
            if (code === 3) { // Ctrl+C — cancel search and exit
              exitSearch(false);
              done(null);
              return;
            }
            if (code === 7) { // Ctrl+G — cancel search
              exitSearch(false);
              continue;
            }
            if (code === 127 || code === 8) { // Backspace
              if (searchQuery.length > 0) {
                searchQuery = searchQuery.slice(0, -1);
                updateSearch();
              }
              continue;
            }
            if (code >= 32) { // Printable char
              searchQuery += ch;
              updateSearch();
              continue;
            }
            continue;
          }

          // Ctrl+C
          if (code === 3) {
            closeMenu();
            done(null);
            return;
          }

          // Ctrl+D on empty buffer
          if (code === 4 && lines.every((l) => l === "")) {
            closeMenu();
            done(null);
            return;
          }

          // Ctrl+A — move to line start
          if (code === 1) {
            cursor = 0;
            redraw();
            continue;
          }

          // Ctrl+E — move to line end
          if (code === 5) {
            cursor = lines[lineIdx].length;
            redraw();
            continue;
          }

          // Ctrl+J (LF) — insert newline
          if (code === 10) {
            insertNewLine();
            continue;
          }

          // Ctrl+K — clear to end of line
          if (code === 11) {
            self.captureUndo(lines, lineIdx, cursor);
            self.killRing = lines[lineIdx].slice(cursor);
            lines[lineIdx] = lines[lineIdx].slice(0, cursor);
            stdout.write("\x1b[K");
            continue;
          }

          // Ctrl+L — clear screen
          if (code === 12) {
            stdout.write("\x1b[2J\x1b[H");
            fullRedraw();
            continue;
          }

          // Ctrl+R — reverse history search
          if (code === 18) {
            closeMenu();
            enterSearch();
            continue;
          }

          // Ctrl+U — clear to start of line
          if (code === 21) {
            closeMenu();
            self.captureUndo(lines, lineIdx, cursor);
            self.killRing = lines[lineIdx].slice(0, cursor);
            lines[lineIdx] = lines[lineIdx].slice(cursor);
            cursor = 0;
            redraw();
            continue;
          }

          // Ctrl+W — delete word backward
          if (code === 23) {
            closeMenu();
            deleteWordBackward();
            continue;
          }

          // Ctrl+Y — yank (paste from kill ring)
          if (code === 25) {
            if (self.killRing) {
              self.captureUndo(lines, lineIdx, cursor);
              lines[lineIdx] = lines[lineIdx].slice(0, cursor) + self.killRing + lines[lineIdx].slice(cursor);
              cursor += self.killRing.length;
              redraw();
            }
            continue;
          }

          // Ctrl+Z — undo
          if (code === 26) {
            if (self.undoStack.length > 0) {
              self.redoStack.push({ lines: [...lines], lineIdx, cursor });
              const snap = self.undoStack.pop()!;
              lines.length = 0;
              lines.push(...snap.lines);
              lineIdx = snap.lineIdx;
              cursor = snap.cursor;
              fullRedraw();
            }
            continue;
          }

          // Ctrl+O — external handler
          if (code === 15) {
            if (this.ctrlOHandler) this.ctrlOHandler();
            continue;
          }

          // Backspace (0x7f or 0x08)
          if (code === 127 || code === 8) {
            if (cursor > 0) {
              self.captureUndo(lines, lineIdx, cursor);
              lines[lineIdx] =
                lines[lineIdx].slice(0, cursor - 1) +
                lines[lineIdx].slice(cursor);
              cursor--;
              redraw();

              const remaining = lines[lineIdx];
              if (remaining.startsWith("/") && lineIdx === 0) {
                updateMenu(remaining);
              } else if (menuMode === "file" && this.fileCompleter) {
                const atToken = getAtToken(remaining, cursor);
                if (atToken) {
                  this.fileCompleter.getCompletions(atToken.token.slice(1)).then((items) => {
                    if (resolved) return;
                    updateFileMenu(items);
                  });
                } else {
                  closeMenu();
                }
              } else {
                closeMenu();
              }
            } else if (lineIdx > 0) {
              // Backspace at start of line: merge with previous line
              closeMenu();
              self.captureUndo(lines, lineIdx, cursor);
              const currentContent = lines[lineIdx];
              lines.splice(lineIdx, 1);
              lineIdx--;
              cursor = lines[lineIdx].length;
              lines[lineIdx] += currentContent;
              fullRedraw();
            }
            continue;
          }

          // Enter (CR) — submit
          if (ch === "\r") {
            if (menuOpen && menuItems.length > 0) {
              const selected = menuItems[menuIdx].cmd;
              self.captureUndo(lines, lineIdx, cursor);
              if (menuMode === "file") {
                const atToken = getAtToken(lines[lineIdx], cursor);
                if (atToken) {
                  lines[lineIdx] =
                    lines[lineIdx].slice(0, atToken.start) +
                    selected +
                    lines[lineIdx].slice(cursor);
                  cursor = atToken.start + selected.length;
                }
              } else {
                lines[lineIdx] = selected;
                cursor = selected.length;
              }
              closeMenu();
              redraw();
              continue;
            }

            closeMenu();
            done(lines.join("\n"));
            return;
          }

          // Tab — slash command completion, @file completion, or 2 spaces
          if (code === 9) {
            const currentText = lines[lineIdx];
            if (menuOpen && menuItems.length > 0) {
              const selected = menuItems[menuIdx].cmd;
              self.captureUndo(lines, lineIdx, cursor);
              if (menuMode === "file") {
                const atToken = getAtToken(lines[lineIdx], cursor);
                if (atToken) {
                  lines[lineIdx] =
                    lines[lineIdx].slice(0, atToken.start) +
                    selected +
                    lines[lineIdx].slice(cursor);
                  cursor = atToken.start + selected.length;
                }
              } else {
                lines[lineIdx] = selected;
                cursor = selected.length;
              }
              closeMenu();
              redraw();
            } else if (currentText.startsWith("/") && lineIdx === 0) {
              const matches = getFilteredCommands(currentText);
              if (matches.length === 1) {
                self.captureUndo(lines, lineIdx, cursor);
                lines[lineIdx] = matches[0].cmd;
                cursor = matches[0].cmd.length;
                redraw();
              } else if (matches.length > 1) {
                openMenu(currentText);
              }
            } else if (this.fileCompleter) {
              const atToken = getAtToken(currentText, cursor);
              if (atToken) {
                const partial = atToken.token.slice(1);
                this.fileCompleter.getCompletions(partial).then((matches) => {
                  if (resolved) return;
                  if (matches.length === 1) {
                    self.captureUndo(lines, lineIdx, cursor);
                    lines[lineIdx] =
                      lines[lineIdx].slice(0, atToken.start) +
                      matches[0].cmd +
                      lines[lineIdx].slice(cursor);
                    cursor = atToken.start + matches[0].cmd.length;
                    redraw();
                  } else if (matches.length > 1) {
                    openFileMenu(matches);
                  }
                });
              } else {
                self.captureUndo(lines, lineIdx, cursor);
                lines[lineIdx] =
                  currentText.slice(0, cursor) +
                  "  " +
                  currentText.slice(cursor);
                cursor += 2;
                redraw();
              }
            } else {
              self.captureUndo(lines, lineIdx, cursor);
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
            self.captureUndo(lines, lineIdx, cursor);
            lines[lineIdx] =
              lines[lineIdx].slice(0, cursor) +
              ch +
              lines[lineIdx].slice(cursor);
            cursor++;
            redraw();

            const currentText = lines[lineIdx];
            if (currentText.startsWith("/") && lineIdx === 0) {
              if (menuOpen) {
                updateMenu(currentText);
              } else {
                openMenu(currentText);
              }
            } else if (this.fileCompleter) {
              const atToken = getAtToken(currentText, cursor);
              if (atToken) {
                this.fileCompleter.getCompletions(atToken.token.slice(1)).then((items) => {
                  if (resolved) return;
                  if (menuMode === "file") {
                    updateFileMenu(items);
                  } else if (!menuOpen) {
                    openFileMenu(items);
                  }
                });
              } else if (menuMode === "file") {
                closeMenu();
              }
            } else if (menuOpen) {
              closeMenu();
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
