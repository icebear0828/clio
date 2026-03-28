import { describe, it, expect } from "vitest";
import { runHooks, type HooksConfig } from "../src/tools/hooks.js";

describe("runHooks", () => {
  it("returns ok=true with empty output when no hooks configured", async () => {
    const result = await runHooks(undefined, "post", "Edit", {});
    expect(result).toEqual({ ok: true, output: "" });
  });

  it("returns ok=true with empty output for empty hook list", async () => {
    const hooks: HooksConfig = { post: [] };
    const result = await runHooks(hooks, "post", "Edit", {});
    expect(result).toEqual({ ok: true, output: "" });
  });

  it("captures stdout from successful post-hook", async () => {
    const hooks: HooksConfig = {
      post: [{ command: "echo hook-output-test" }],
    };
    const result = await runHooks(hooks, "post", "Edit", {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hook-output-test");
  });

  it("captures stderr from failing post-hook, ok stays true", async () => {
    const hooks: HooksConfig = {
      post: [{ command: "echo tsc-error >&2 && exit 1" }],
    };
    const result = await runHooks(hooks, "post", "Edit", {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("tsc-error");
  });

  it("pre-hook failure returns ok=false with captured output", async () => {
    const hooks: HooksConfig = {
      pre: [{ command: "echo blocked-reason && exit 1" }],
    };
    const result = await runHooks(hooks, "pre", "Bash", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("blocked-reason");
  });

  it("respects tools filter — skips non-matching tools", async () => {
    const hooks: HooksConfig = {
      post: [{ command: "echo should-not-run", tools: ["Write"] }],
    };
    const result = await runHooks(hooks, "post", "Edit", {});
    expect(result.ok).toBe(true);
    expect(result.output).toBe("");
  });

  it("runs hook when tools filter matches", async () => {
    const hooks: HooksConfig = {
      post: [{ command: "echo matched", tools: ["Edit"] }],
    };
    const result = await runHooks(hooks, "post", "Edit", {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("matched");
  });

  it("accumulates output from multiple hooks", async () => {
    const hooks: HooksConfig = {
      post: [
        { command: "echo first" },
        { command: "echo second" },
      ],
    };
    const result = await runHooks(hooks, "post", "Edit", {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("first");
    expect(result.output).toContain("second");
  });
});
