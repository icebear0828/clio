import { describe, it, expect } from "vitest";
import { parseFrontMatter, parseAgentFile } from "../src/commands/custom-agents.js";

describe("parseFrontMatter", () => {
  it("parses YAML frontmatter", () => {
    const content = "---\ntools: Read, Grep\nmodel: opus\n---\nSystem prompt here";
    const { meta, body } = parseFrontMatter(content);
    expect(meta.tools).toBe("Read, Grep");
    expect(meta.model).toBe("opus");
    expect(body).toBe("System prompt here");
  });

  it("returns empty meta when no frontmatter", () => {
    const content = "Just a prompt with no frontmatter.";
    const { meta, body } = parseFrontMatter(content);
    expect(Object.keys(meta)).toHaveLength(0);
    expect(body).toBe(content);
  });

  it("returns empty meta when frontmatter is not closed", () => {
    const content = "---\ntools: Read\nNo closing delimiter";
    const { meta, body } = parseFrontMatter(content);
    expect(Object.keys(meta)).toHaveLength(0);
    expect(body).toBe(content);
  });

  it("handles empty values", () => {
    const content = "---\nkey:\n---\nbody";
    const { meta } = parseFrontMatter(content);
    // Empty value should be skipped (key && value check)
    expect(meta.key).toBeUndefined();
  });

  it("handles colons in values", () => {
    const content = "---\nurl: http://example.com:8080\n---\nbody";
    const { meta } = parseFrontMatter(content);
    expect(meta.url).toBe("http://example.com:8080");
  });
});

describe("parseAgentFile", () => {
  it("parses full agent definition", () => {
    const content = "---\ntools: Read, Grep, Bash\nmodel: claude-sonnet-4-20250514\nmax_iterations: 10\n---\nYou are a reviewer.";
    const def = parseAgentFile("reviewer", content);
    expect(def.name).toBe("reviewer");
    expect(def.systemPrompt).toBe("You are a reviewer.");
    expect(def.allowedTools).toEqual(["Read", "Grep", "Bash"]);
    expect(def.model).toBe("claude-sonnet-4-20250514");
    expect(def.maxIterations).toBe(10);
  });

  it("handles missing optional fields", () => {
    const content = "---\nmodel: opus\n---\nJust a prompt.";
    const def = parseAgentFile("simple", content);
    expect(def.name).toBe("simple");
    expect(def.systemPrompt).toBe("Just a prompt.");
    expect(def.allowedTools).toBeUndefined();
    expect(def.maxIterations).toBeUndefined();
  });

  it("handles no frontmatter", () => {
    const content = "A plain prompt.";
    const def = parseAgentFile("plain", content);
    expect(def.name).toBe("plain");
    expect(def.systemPrompt).toBe("A plain prompt.");
  });

  it("ignores invalid max_iterations", () => {
    const content = "---\nmax_iterations: abc\n---\nbody";
    const def = parseAgentFile("test", content);
    expect(def.maxIterations).toBeUndefined();
  });

  it("ignores negative max_iterations", () => {
    const content = "---\nmax_iterations: -5\n---\nbody";
    const def = parseAgentFile("test", content);
    expect(def.maxIterations).toBeUndefined();
  });

  it("trims whitespace from tool names", () => {
    const content = "---\ntools:  Read ,  Grep , Bash \n---\nbody";
    const def = parseAgentFile("test", content);
    expect(def.allowedTools).toEqual(["Read", "Grep", "Bash"]);
  });
});
