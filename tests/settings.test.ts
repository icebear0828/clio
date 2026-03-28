import { describe, it, expect } from "vitest";
import { mergeSettings } from "../src/core/settings.js";
import type { Settings } from "../src/core/settings.js";
import type { StatusBarField } from "../src/ui/statusbar.js";

describe("mergeSettings", () => {
  it("returns base when override is empty", () => {
    const base: Settings = { model: "opus", apiKey: "key1" };
    expect(mergeSettings(base, {})).toEqual(base);
  });

  it("overrides scalar values", () => {
    const base: Settings = { model: "opus", apiKey: "key1" };
    const override: Settings = { model: "sonnet" };
    const result = mergeSettings(base, override);
    expect(result.model).toBe("sonnet");
    expect(result.apiKey).toBe("key1");
  });

  it("concatenates allowRules arrays", () => {
    const base: Settings = { allowRules: ["git *"] };
    const override: Settings = { allowRules: ["npm *"] };
    const result = mergeSettings(base, override);
    expect(result.allowRules).toEqual(["git *", "npm *"]);
  });

  it("concatenates denyRules arrays", () => {
    const base: Settings = { denyRules: ["rm -rf *"] };
    const override: Settings = { denyRules: ["sudo *"] };
    const result = mergeSettings(base, override);
    expect(result.denyRules).toEqual(["rm -rf *", "sudo *"]);
  });

  it("creates allowRules from empty base", () => {
    const result = mergeSettings({}, { allowRules: ["git *"] });
    expect(result.allowRules).toEqual(["git *"]);
  });

  it("merges mcpServers objects", () => {
    const base: Settings = { mcpServers: { a: { command: "a" } } };
    const override: Settings = { mcpServers: { b: { command: "b" } } };
    const result = mergeSettings(base, override);
    expect(result.mcpServers).toEqual({ a: { command: "a" }, b: { command: "b" } });
  });

  it("overrides mcpServer with same key", () => {
    const base: Settings = { mcpServers: { a: { command: "old" } } };
    const override: Settings = { mcpServers: { a: { command: "new" } } };
    const result = mergeSettings(base, override);
    expect(result.mcpServers?.a.command).toBe("new");
  });

  it("merges hooks by concatenating pre/post arrays", () => {
    const base: Settings = {
      hooks: { pre: [{ command: "echo pre1" }] },
    };
    const override: Settings = {
      hooks: { pre: [{ command: "echo pre2" }], post: [{ command: "echo post1" }] },
    };
    const result = mergeSettings(base, override);
    expect(result.hooks?.pre).toHaveLength(2);
    expect(result.hooks?.post).toHaveLength(1);
  });

  it("merges autoClassifier with pattern concatenation", () => {
    const base: Settings = {
      autoClassifier: { enabled: true, safePatterns: ["ls *"] },
    };
    const override: Settings = {
      autoClassifier: { enabled: true, safePatterns: ["cat *"], dangerousPatterns: ["rm *"] },
    };
    const result = mergeSettings(base, override);
    expect(result.autoClassifier?.safePatterns).toEqual(["ls *", "cat *"]);
    expect(result.autoClassifier?.dangerousPatterns).toEqual(["rm *"]);
  });

  it("skips undefined values", () => {
    const base: Settings = { model: "opus" };
    const override: Settings = { model: undefined };
    const result = mergeSettings(base, override);
    expect(result.model).toBe("opus");
  });

  it("merges statusBar shallowly", () => {
    const base: Settings = { statusBar: { fields: ["model" as StatusBarField] } };
    const override: Settings = { statusBar: {} };
    const result = mergeSettings(base, override);
    expect(result.statusBar?.fields).toEqual(["model"]);
  });
});
