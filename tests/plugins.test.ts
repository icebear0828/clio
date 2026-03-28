import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseManifest, resolvePluginPath, ManifestError } from "../src/plugins/manifest.js";
import { initPlugins, getLoadedPlugins } from "../src/plugins/index.js";
import { getSkill, listSkills, clearSkills } from "../src/skills/index.js";
import { getCustomAgent } from "../src/commands/custom-agents.js";
import { registerSystemSection } from "../src/core/system-prompt.js";
import type { PluginManifest } from "../src/plugins/types.js";
import type { SystemPromptSection } from "../src/types.js";

// ── resolvePluginPath ──

describe("resolvePluginPath", () => {
  const pluginDir = path.resolve("/tmp/plugins/my-plugin");

  it("resolves relative paths within plugin dir", () => {
    const result = resolvePluginPath(pluginDir, "skills");
    expect(result).toBe(path.join(pluginDir, "skills"));
  });

  it("resolves nested relative paths", () => {
    const result = resolvePluginPath(pluginDir, "hooks/hooks.json");
    expect(result).toBe(path.join(pluginDir, "hooks", "hooks.json"));
  });

  it("blocks path traversal with ..", () => {
    expect(() => resolvePluginPath(pluginDir, "../other-plugin/evil")).toThrow(ManifestError);
  });

  it("blocks absolute path escape", () => {
    expect(() => resolvePluginPath(pluginDir, "/etc/passwd")).toThrow(ManifestError);
  });
});

// ── parseManifest ──

describe("parseManifest", () => {
  const pluginDir = path.resolve("/tmp/plugins/test-plugin");

  it("parses minimal manifest with just name", () => {
    const result = parseManifest({ name: "my-plugin" }, pluginDir);
    expect(result.name).toBe("my-plugin");
    expect(result.version).toBeUndefined();
    expect(result.skills).toBeUndefined();
  });

  it("rejects missing name", () => {
    expect(() => parseManifest({}, pluginDir)).toThrow(ManifestError);
  });

  it("rejects non-kebab-case name", () => {
    expect(() => parseManifest({ name: "MyPlugin" }, pluginDir)).toThrow(ManifestError);
    expect(() => parseManifest({ name: "my plugin" }, pluginDir)).toThrow(ManifestError);
    expect(() => parseManifest({ name: "my_plugin" }, pluginDir)).toThrow(ManifestError);
  });

  it("accepts valid kebab-case names", () => {
    expect(parseManifest({ name: "my-plugin" }, pluginDir).name).toBe("my-plugin");
    expect(parseManifest({ name: "plugin123" }, pluginDir).name).toBe("plugin123");
    expect(parseManifest({ name: "a-b-c" }, pluginDir).name).toBe("a-b-c");
  });

  it("rejects non-object input", () => {
    expect(() => parseManifest("string", pluginDir)).toThrow(ManifestError);
    expect(() => parseManifest(null, pluginDir)).toThrow(ManifestError);
    expect(() => parseManifest(42, pluginDir)).toThrow(ManifestError);
  });

  it("parses version and description", () => {
    const result = parseManifest({
      name: "test",
      version: "1.0.0",
      description: "A test plugin",
    }, pluginDir);
    expect(result.version).toBe("1.0.0");
    expect(result.description).toBe("A test plugin");
  });

  it("parses author field", () => {
    const result = parseManifest({
      name: "test",
      author: { name: "Test Author", email: "test@example.com" },
    }, pluginDir);
    expect(result.author?.name).toBe("Test Author");
    expect(result.author?.email).toBe("test@example.com");
  });

  it("parses skills as string", () => {
    const result = parseManifest({ name: "test", skills: "my-skills" }, pluginDir);
    expect(result.skills).toBe("my-skills");
  });

  it("parses skills as array", () => {
    const result = parseManifest({ name: "test", skills: ["dir1", "dir2"] }, pluginDir);
    expect(result.skills).toEqual(["dir1", "dir2"]);
  });

  it("parses agents as string", () => {
    const result = parseManifest({ name: "test", agents: "agents" }, pluginDir);
    expect(result.agents).toBe("agents");
  });

  it("parses inline hooks", () => {
    const hooks = { pre: [{ command: "echo test" }] };
    const result = parseManifest({ name: "test", hooks }, pluginDir);
    expect(result.hooks).toEqual(hooks);
  });

  it("parses hooks as file path", () => {
    const result = parseManifest({ name: "test", hooks: "hooks/hooks.json" }, pluginDir);
    expect(result.hooks).toBe(path.join(pluginDir, "hooks", "hooks.json"));
  });

  it("parses inline mcpServers", () => {
    const mcp = {
      myserver: { command: "npx", args: ["-y", "my-mcp-server"] },
    };
    const result = parseManifest({ name: "test", mcpServers: mcp }, pluginDir);
    expect(result.mcpServers).toEqual({
      myserver: { command: "npx", args: ["-y", "my-mcp-server"], env: undefined },
    });
  });

  it("parses mcpServers as file path", () => {
    const result = parseManifest({ name: "test", mcpServers: ".mcp.json" }, pluginDir);
    expect(result.mcpServers).toBe(path.join(pluginDir, ".mcp.json"));
  });

  it("parses lspServers", () => {
    const lsp = {
      typescript: {
        command: "typescript-language-server",
        args: ["--stdio"],
        extensionToLanguage: { ".ts": "typescript", ".tsx": "typescriptreact" },
      },
    };
    const result = parseManifest({ name: "test", lspServers: lsp }, pluginDir);
    expect(result.lspServers).toEqual({
      typescript: {
        command: "typescript-language-server",
        args: ["--stdio"],
        env: undefined,
        extensionToLanguage: { ".ts": "typescript", ".tsx": "typescriptreact" },
        transport: "stdio",
      },
    });
  });

  it("skips lspServers without extensionToLanguage", () => {
    const lsp = {
      bad: { command: "some-server" },
    };
    const result = parseManifest({ name: "test", lspServers: lsp }, pluginDir);
    expect(result.lspServers).toBeUndefined();
  });

  it("parses commands with inline content", () => {
    const cmds = {
      greet: { content: "Say hello to {{args}}", description: "Greeting command" },
    };
    const result = parseManifest({ name: "test", commands: cmds }, pluginDir);
    expect(result.commands?.greet.content).toBe("Say hello to {{args}}");
    expect(result.commands?.greet.description).toBe("Greeting command");
  });

  it("parses commands with source path", () => {
    const cmds = {
      review: { source: "commands/review.md", description: "Code review" },
    };
    const result = parseManifest({ name: "test", commands: cmds }, pluginDir);
    expect(result.commands?.review.source).toBe("commands/review.md");
  });

  it("parses string shorthand for commands", () => {
    const cmds = { deploy: "commands/deploy.md" };
    const result = parseManifest({ name: "test", commands: cmds }, pluginDir);
    expect(result.commands?.deploy.source).toBe("commands/deploy.md");
  });

  it("parses settings field", () => {
    const result = parseManifest({
      name: "test",
      settings: { agent: { maxIterations: 50 } },
    }, pluginDir);
    expect(result.settings).toEqual({ agent: { maxIterations: 50 } });
  });

  it("ignores unknown fields gracefully", () => {
    const result = parseManifest({
      name: "test",
      unknownField: "should be ignored",
      anotherField: 42,
    }, pluginDir);
    expect(result.name).toBe("test");
    expect((result as Record<string, unknown>).unknownField).toBeUndefined();
  });
});

// ── Plugin discovery (filesystem integration) ──

describe("plugin discovery", async () => {
  const { discoverPlugins } = await import("../src/plugins/loader.js");
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clio-plugin-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no plugin directories exist", async () => {
    const plugins = await discoverPlugins();
    expect(plugins).toEqual([]);
  });

  it("discovers project-level plugins", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "my-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "my-plugin", description: "Test" }),
    );

    const plugins = await discoverPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("my-plugin");
    expect(plugins[0].source).toBe("project");
  });

  it("skips directories without plugin.json", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "no-manifest");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "README.md"), "hello");

    const plugins = await discoverPlugins();
    expect(plugins).toEqual([]);
  });

  it("skips plugins with invalid manifest", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "bad-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "INVALID NAME" }),
    );

    const plugins = await discoverPlugins();
    expect(plugins).toEqual([]);
  });
});

// ── initPlugins integration (skills, agents, commands injection) ──

describe("initPlugins", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clio-init-plugin-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    clearSkills();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("injects plugin skills into the skill registry", async () => {
    // Create plugin with a skill
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-skills");
    const skillsDir = path.join(pluginDir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "test-skills", skills: "skills" }),
    );
    await fs.writeFile(
      path.join(skillsDir, "greet.md"),
      "---\nname: greet\ndescription: Greeting skill\ntrigger: when user says hello\n---\nSay hello to {{args}}",
    );

    const contribs = await initPlugins({});
    const skill = getSkill("greet");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("greet");
    expect(skill!.description).toBe("Greeting skill");
    expect(skill!.trigger).toBe("when user says hello");
    expect(skill!.promptTemplate).toBe("Say hello to {{args}}");
    expect(skill!.source).toBe("plugin");
    expect(skill!.pluginName).toBe("test-skills");
  });

  it("injects plugin agents into the agent registry", async () => {
    // Create plugin with an agent
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-agents");
    const agentsDir = path.join(pluginDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "test-agents", agents: "agents" }),
    );
    await fs.writeFile(
      path.join(agentsDir, "researcher.md"),
      "---\ntools: Read,Grep,Glob\nmodel: haiku\n---\nYou are a research agent.",
    );

    await initPlugins({});
    const agent = getCustomAgent("researcher");
    expect(agent).toBeDefined();
    expect(agent!.systemPrompt).toBe("You are a research agent.");
    expect(agent!.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(agent!.model).toBe("haiku");
  });

  it("injects plugin commands as skills", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-commands");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "test-commands",
        commands: {
          deploy: {
            content: "Deploy the application to {{args}}",
            description: "Deploy command",
            trigger: "when user says deploy",
          },
        },
      }),
    );

    await initPlugins({});
    const skill = getSkill("deploy");
    expect(skill).toBeDefined();
    expect(skill!.promptTemplate).toBe("Deploy the application to {{args}}");
    expect(skill!.source).toBe("plugin");
    expect(skill!.pluginName).toBe("test-commands");
  });

  it("collects plugin hooks into contributions", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-hooks");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "test-hooks",
        hooks: {
          pre: [{ command: "echo pre-hook", tools: ["Bash"] }],
          post: [{ command: "echo post-hook" }],
        },
      }),
    );

    const contribs = await initPlugins({});
    expect(contribs.hooks.pre).toHaveLength(1);
    expect(contribs.hooks.pre![0].command).toBe("echo pre-hook");
    expect(contribs.hooks.pre![0].tools).toEqual(["Bash"]);
    expect(contribs.hooks.post).toHaveLength(1);
    expect(contribs.hooks.post![0].command).toBe("echo post-hook");
  });

  it("collects plugin MCP servers into contributions", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-mcp");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "test-mcp",
        mcpServers: {
          myserver: { command: "npx", args: ["-y", "my-mcp"] },
        },
      }),
    );

    const contribs = await initPlugins({});
    expect(contribs.mcpServers.myserver).toBeDefined();
    expect(contribs.mcpServers.myserver.command).toBe("npx");
    expect(contribs.mcpServers.myserver.args).toEqual(["-y", "my-mcp"]);
  });

  it("collects plugin LSP servers into contributions", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-lsp");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "test-lsp",
        lspServers: {
          typescript: {
            command: "typescript-language-server",
            args: ["--stdio"],
            extensionToLanguage: { ".ts": "typescript" },
          },
        },
      }),
    );

    const contribs = await initPlugins({});
    expect(contribs.lspServers.typescript).toBeDefined();
    expect(contribs.lspServers.typescript.command).toBe("typescript-language-server");
  });

  it("loads hooks from external file", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-hook-file");
    const hooksDir = path.join(pluginDir, "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "test-hook-file", hooks: "hooks/hooks.json" }),
    );
    await fs.writeFile(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify({ hooks: { pre: [{ command: "echo from-file" }] } }),
    );

    const contribs = await initPlugins({});
    expect(contribs.hooks.pre).toHaveLength(1);
    expect(contribs.hooks.pre![0].command).toBe("echo from-file");
  });

  it("loads MCP servers from external file", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-mcp-file");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "test-mcp-file", mcpServers: "mcp.json" }),
    );
    await fs.writeFile(
      path.join(pluginDir, "mcp.json"),
      JSON.stringify({ external: { command: "external-server" } }),
    );

    const contribs = await initPlugins({});
    expect(contribs.mcpServers.external).toBeDefined();
    expect(contribs.mcpServers.external.command).toBe("external-server");
  });

  it("loads command from .md source file", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "test-cmd-file");
    const cmdDir = path.join(pluginDir, "commands");
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "test-cmd-file",
        commands: { review: { source: "commands/review.md", description: "Code review" } },
      }),
    );
    await fs.writeFile(
      path.join(cmdDir, "review.md"),
      "---\nname: review\n---\nReview the code in {{args}}",
    );

    await initPlugins({});
    const skill = getSkill("review");
    expect(skill).toBeDefined();
    expect(skill!.promptTemplate).toBe("Review the code in {{args}}");
  });

  it("getLoadedPlugins returns discovered plugins", async () => {
    const pluginDir = path.join(tmpDir, ".clio", "plugins", "tracker");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "tracker", description: "Test" }),
    );

    await initPlugins({});
    const loaded = getLoadedPlugins();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].manifest.name).toBe("tracker");
  });

  it("handles multiple plugins merging contributions", async () => {
    // Plugin A: skill + pre-hook
    const dirA = path.join(tmpDir, ".clio", "plugins", "plugin-a");
    const skillsA = path.join(dirA, "skills");
    await fs.mkdir(skillsA, { recursive: true });
    await fs.writeFile(
      path.join(dirA, "plugin.json"),
      JSON.stringify({
        name: "plugin-a",
        skills: "skills",
        hooks: { pre: [{ command: "echo a" }] },
      }),
    );
    await fs.writeFile(
      path.join(skillsA, "alpha.md"),
      "---\nname: alpha\ndescription: Alpha skill\n---\nAlpha prompt",
    );

    // Plugin B: different skill + post-hook + mcp
    const dirB = path.join(tmpDir, ".clio", "plugins", "plugin-b");
    const skillsB = path.join(dirB, "skills");
    await fs.mkdir(skillsB, { recursive: true });
    await fs.writeFile(
      path.join(dirB, "plugin.json"),
      JSON.stringify({
        name: "plugin-b",
        skills: "skills",
        hooks: { post: [{ command: "echo b" }] },
        mcpServers: { srv: { command: "srv-cmd" } },
      }),
    );
    await fs.writeFile(
      path.join(skillsB, "beta.md"),
      "---\nname: beta\ndescription: Beta skill\n---\nBeta prompt",
    );

    const contribs = await initPlugins({});

    // Both skills registered
    expect(getSkill("alpha")).toBeDefined();
    expect(getSkill("beta")).toBeDefined();

    // Hooks merged
    expect(contribs.hooks.pre).toHaveLength(1);
    expect(contribs.hooks.post).toHaveLength(1);

    // MCP collected
    expect(contribs.mcpServers.srv).toBeDefined();
  });
});

// ── registerSystemSection ──

describe("registerSystemSection", () => {
  it("registers a dynamic section that can compute content", async () => {
    const section: SystemPromptSection = {
      name: "test-plugin-section",
      cacheBreak: true,
      compute: () => Promise.resolve("Plugin injected content"),
    };
    // Should not throw
    registerSystemSection(section);
    // Verify compute works
    const content = await section.compute();
    expect(content).toBe("Plugin injected content");
  });

  it("supports null-returning sections (disabled)", async () => {
    const section: SystemPromptSection = {
      name: "disabled-section",
      cacheBreak: false,
      compute: () => Promise.resolve(null),
    };
    registerSystemSection(section);
    const content = await section.compute();
    expect(content).toBeNull();
  });
});
