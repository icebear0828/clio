import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type Action =
  | "submit" | "newline" | "history-prev" | "history-next"
  | "cursor-left" | "cursor-right" | "cursor-home" | "cursor-end"
  | "word-left" | "word-right"
  | "delete-back" | "delete-word-back" | "delete-to-start" | "delete-to-end"
  | "yank" | "undo" | "redo"
  | "search-history" | "clear-screen"
  | "cancel" | "eof" | "escape"
  | "tab" | "shift-tab"
  | "verbose-toggle";

interface KeyBindingEntry {
  key: string;
  action: Action;
}

const DEFAULT_BINDINGS: KeyBindingEntry[] = [
  { key: "enter", action: "submit" },
  { key: "ctrl+j", action: "newline" },
  { key: "shift+enter", action: "newline" },
  { key: "up", action: "history-prev" },
  { key: "down", action: "history-next" },
  { key: "left", action: "cursor-left" },
  { key: "right", action: "cursor-right" },
  { key: "home", action: "cursor-home" },
  { key: "end", action: "cursor-end" },
  { key: "ctrl+a", action: "cursor-home" },
  { key: "ctrl+e", action: "cursor-end" },
  { key: "ctrl+left", action: "word-left" },
  { key: "ctrl+right", action: "word-right" },
  { key: "backspace", action: "delete-back" },
  { key: "ctrl+w", action: "delete-word-back" },
  { key: "ctrl+u", action: "delete-to-start" },
  { key: "ctrl+k", action: "delete-to-end" },
  { key: "ctrl+y", action: "yank" },
  { key: "ctrl+z", action: "undo" },
  { key: "ctrl+shift+z", action: "redo" },
  { key: "ctrl+r", action: "search-history" },
  { key: "ctrl+l", action: "clear-screen" },
  { key: "ctrl+c", action: "cancel" },
  { key: "ctrl+d", action: "eof" },
  { key: "escape", action: "escape" },
  { key: "tab", action: "tab" },
  { key: "shift+tab", action: "shift-tab" },
  { key: "ctrl+o", action: "verbose-toggle" },
];

let bindingMap: Map<string, Action> | null = null;

export async function loadKeybindings(): Promise<Map<string, Action>> {
  const map = new Map<string, Action>();

  for (const b of DEFAULT_BINDINGS) {
    map.set(b.key, b.action);
  }

  const configPath = path.join(os.homedir(), ".clio", "keybindings.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const entries = JSON.parse(raw) as KeyBindingEntry[];
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (e.key && e.action) {
          map.set(e.key, e.action as Action);
        }
      }
    }
  } catch {
  }

  bindingMap = map;
  return map;
}

export function getBindingMap(): Map<string, Action> {
  if (!bindingMap) {
    bindingMap = new Map<string, Action>();
    for (const b of DEFAULT_BINDINGS) {
      bindingMap.set(b.key, b.action);
    }
  }
  return bindingMap;
}

export function resolveAction(keyName: string): Action | undefined {
  return getBindingMap().get(keyName);
}

export function identifyKey(data: string, offset: number): { key: string; consumed: number } | null {
  const ch = data[offset];

  if (ch === "\x1b") {
    if (offset + 1 < data.length && data[offset + 1] === "[") {
      let i = offset + 2;
      let params = "";
      while (i < data.length && data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) {
        params += data[i++];
      }
      if (i >= data.length) return { key: "escape", consumed: 1 };
      const finalByte = data[i];
      const consumed = i - offset + 1;

      switch (params + finalByte) {
        case "A": return { key: "up", consumed };
        case "B": return { key: "down", consumed };
        case "C": return { key: "right", consumed };
        case "D": return { key: "left", consumed };
        case "H": case "1~": return { key: "home", consumed };
        case "F": case "4~": return { key: "end", consumed };
        case "1;5C": return { key: "ctrl+right", consumed };
        case "1;5D": return { key: "ctrl+left", consumed };
        case "13;2u": return { key: "shift+enter", consumed };
        case "122;6u": return { key: "ctrl+shift+z", consumed };
        case "Z": return { key: "shift+tab", consumed };
        case "3~": return { key: "delete", consumed };
        default: return { key: `csi:${params}${finalByte}`, consumed };
      }
    }
    return { key: "escape", consumed: 1 };
  }

  const code = ch.charCodeAt(0);
  if (code < 32) {
    switch (code) {
      case 0x01: return { key: "ctrl+a", consumed: 1 };
      case 0x02: return { key: "ctrl+b", consumed: 1 };
      case 0x03: return { key: "ctrl+c", consumed: 1 };
      case 0x04: return { key: "ctrl+d", consumed: 1 };
      case 0x05: return { key: "ctrl+e", consumed: 1 };
      case 0x06: return { key: "ctrl+f", consumed: 1 };
      case 0x07: return { key: "ctrl+g", consumed: 1 };
      case 0x08: return { key: "backspace", consumed: 1 };
      case 0x09: return { key: "tab", consumed: 1 };
      case 0x0a: return { key: "ctrl+j", consumed: 1 };
      case 0x0b: return { key: "ctrl+k", consumed: 1 };
      case 0x0c: return { key: "ctrl+l", consumed: 1 };
      case 0x0d: return { key: "enter", consumed: 1 };
      case 0x0e: return { key: "ctrl+n", consumed: 1 };
      case 0x0f: return { key: "ctrl+o", consumed: 1 };
      case 0x10: return { key: "ctrl+p", consumed: 1 };
      case 0x12: return { key: "ctrl+r", consumed: 1 };
      case 0x15: return { key: "ctrl+u", consumed: 1 };
      case 0x17: return { key: "ctrl+w", consumed: 1 };
      case 0x19: return { key: "ctrl+y", consumed: 1 };
      case 0x1a: return { key: "ctrl+z", consumed: 1 };
    }
  }

  if (code === 0x7f) return { key: "backspace", consumed: 1 };

  return null;
}
