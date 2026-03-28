import { describe, it, expect } from "vitest";
import { identifyKey, resolveAction } from "../src/ui/keybindings.js";

describe("identifyKey", () => {
  describe("control characters", () => {
    it("identifies ctrl+a (0x01)", () => {
      expect(identifyKey("\x01", 0)).toEqual({ key: "ctrl+a", consumed: 1 });
    });

    it("identifies ctrl+c (0x03)", () => {
      expect(identifyKey("\x03", 0)).toEqual({ key: "ctrl+c", consumed: 1 });
    });

    it("identifies ctrl+d (0x04)", () => {
      expect(identifyKey("\x04", 0)).toEqual({ key: "ctrl+d", consumed: 1 });
    });

    it("identifies ctrl+z (0x1a)", () => {
      expect(identifyKey("\x1a", 0)).toEqual({ key: "ctrl+z", consumed: 1 });
    });

    it("identifies enter (0x0d)", () => {
      expect(identifyKey("\x0d", 0)).toEqual({ key: "enter", consumed: 1 });
    });

    it("identifies tab (0x09)", () => {
      expect(identifyKey("\x09", 0)).toEqual({ key: "tab", consumed: 1 });
    });

    it("identifies backspace (0x08)", () => {
      expect(identifyKey("\x08", 0)).toEqual({ key: "backspace", consumed: 1 });
    });

    it("identifies delete (0x7f) as backspace", () => {
      expect(identifyKey("\x7f", 0)).toEqual({ key: "backspace", consumed: 1 });
    });
  });

  describe("ANSI escape sequences", () => {
    it("identifies up arrow", () => {
      expect(identifyKey("\x1b[A", 0)).toEqual({ key: "up", consumed: 3 });
    });

    it("identifies down arrow", () => {
      expect(identifyKey("\x1b[B", 0)).toEqual({ key: "down", consumed: 3 });
    });

    it("identifies right arrow", () => {
      expect(identifyKey("\x1b[C", 0)).toEqual({ key: "right", consumed: 3 });
    });

    it("identifies left arrow", () => {
      expect(identifyKey("\x1b[D", 0)).toEqual({ key: "left", consumed: 3 });
    });

    it("identifies Home (H)", () => {
      expect(identifyKey("\x1b[H", 0)).toEqual({ key: "home", consumed: 3 });
    });

    it("identifies End (F)", () => {
      expect(identifyKey("\x1b[F", 0)).toEqual({ key: "end", consumed: 3 });
    });

    it("identifies ctrl+right", () => {
      expect(identifyKey("\x1b[1;5C", 0)).toEqual({ key: "ctrl+right", consumed: 6 });
    });

    it("identifies ctrl+left", () => {
      expect(identifyKey("\x1b[1;5D", 0)).toEqual({ key: "ctrl+left", consumed: 6 });
    });

    it("identifies shift+tab", () => {
      expect(identifyKey("\x1b[Z", 0)).toEqual({ key: "shift+tab", consumed: 3 });
    });

    it("identifies shift+enter", () => {
      expect(identifyKey("\x1b[13;2u", 0)).toEqual({ key: "shift+enter", consumed: 7 });
    });

    it("identifies ctrl+shift+z", () => {
      expect(identifyKey("\x1b[122;6u", 0)).toEqual({ key: "ctrl+shift+z", consumed: 8 });
    });

    it("identifies delete key", () => {
      expect(identifyKey("\x1b[3~", 0)).toEqual({ key: "delete", consumed: 4 });
    });

    it("returns escape for lone ESC", () => {
      expect(identifyKey("\x1b", 0)).toEqual({ key: "escape", consumed: 1 });
    });

    it("returns escape for incomplete CSI sequence", () => {
      // ESC [ but no final byte
      expect(identifyKey("\x1b[", 0)).toEqual({ key: "escape", consumed: 1 });
    });
  });

  describe("offset parameter", () => {
    it("reads from specified offset", () => {
      const data = "abc\x0d";
      expect(identifyKey(data, 3)).toEqual({ key: "enter", consumed: 1 });
    });
  });

  describe("printable characters", () => {
    it("returns null for regular characters", () => {
      expect(identifyKey("a", 0)).toBeNull();
      expect(identifyKey("Z", 0)).toBeNull();
      expect(identifyKey("5", 0)).toBeNull();
    });
  });
});

describe("resolveAction", () => {
  it("resolves enter to submit", () => {
    expect(resolveAction("enter")).toBe("submit");
  });

  it("resolves ctrl+c to cancel", () => {
    expect(resolveAction("ctrl+c")).toBe("cancel");
  });

  it("resolves ctrl+z to undo", () => {
    expect(resolveAction("ctrl+z")).toBe("undo");
  });

  it("resolves ctrl+shift+z to redo", () => {
    expect(resolveAction("ctrl+shift+z")).toBe("redo");
  });

  it("resolves escape to escape", () => {
    expect(resolveAction("escape")).toBe("escape");
  });

  it("returns undefined for unbound keys", () => {
    expect(resolveAction("f12")).toBeUndefined();
    expect(resolveAction("ctrl+q")).toBeUndefined();
  });
});
