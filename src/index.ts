#!/usr/bin/env node

import { runAgentLoop, getContextLimit } from "./core/agent.js";
import { compactConversation } from "./core/compact.js";
import { initClaudeMd } from "./commands/init.js";
import { commitCommand, prCommand, reviewCommand } from "./commands/git-commands.js";
import { SessionManager } from "./core/session.js";
import { bold, dim, red, green, yellow, cyan, blue, magenta, boldCyan, dimCyan, toggleVerbose, getTheme, setTheme, renderBanner, type Theme } from "./ui/render.js";
import { estimateCost, formatUSD } from "./core/pricing.js";
import { streamRequest } from "./core/client.js";
import { buildSystemPrompt } from "./core/context.js";
import { MarkdownRenderer } from "./ui/markdown.js";
import { PermissionManager } from "./core/permissions.js";
import { InputReader } from "./ui/input.js";
import { loadKeybindings } from "./ui/keybindings.js";
import { loadSettings, getSettingsInfo, saveGlobalLocalSettings, type Settings } from "./core/settings.js";
import { setAllowOutsideCwd, setToolContext, setMcpManager, setSandbox, setLspManager } from "./tools/index.js";
import { McpManager, setGlobalMcpManager } from "./tools/mcp.js";
import { LspManager, setGlobalLspManager } from "./tools/lsp.js";
import { Sandbox } from "./core/sandbox.js";
import { createLLMClassifier } from "./core/llm-classifier.js";
import { setHookSandbox } from "./tools/hooks.js";
import { taskStore } from "./tools/tasks.js";
import { loadCustomAgents, listCustomAgents } from "./commands/custom-agents.js";
import { loadSkills } from "./skills/loader.js";
import { getSkill } from "./skills/index.js";
import { parseInputWithImages } from "./ui/image.js";
import { StatusBar } from "./ui/statusbar.js";
import { FileCompleter, resolveFileReferences } from "./ui/file-completions.js";
import { CheckpointManager } from "./tools/checkpoint.js";
import { historyCommand, undoCommand } from "./commands/history.js";
import { SectionCache } from "./core/section-cache.js";
import { initPlugins } from "./plugins/index.js";
import { stdin } from "node:process";
import type { ApiFormat, Config, Message, PermissionMode, UsageStats } from "./types.js";

type OutputFormat = "text" | "json";

interface ProviderPreset {
  name: string;
  apiUrl: string;
  model: string;
  apiFormat: ApiFormat;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: "Anthropic",  apiUrl: "https://api.anthropic.com",         model: "claude-sonnet-4-20250514", apiFormat: "anthropic" },
  { name: "OpenAI",     apiUrl: "https://api.openai.com/v1",         model: "gpt-4o",                   apiFormat: "openai" },
  { name: "Google",     apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", apiFormat: "openai" },
];

function arrowSelect(items: string[], title: string): Promise<number> {
  return new Promise((resolve) => {
    let selected = 0;
    let escBuf = ""; // buffer for multi-byte escape sequences
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    process.stderr.write(`  ${title}\n\n`);
    process.stderr.write("\x1b[s"); // save cursor anchor

    const render = () => {
      process.stderr.write("\x1b[u");
      for (let i = 0; i < items.length; i++) {
        const prefix = i === selected ? boldCyan("❯ ") : "  ";
        const label = i === selected ? bold(items[i]) : dim(items[i]);
        process.stderr.write(`\x1b[2K  ${prefix}${label}\n`);
      }
      process.stderr.write(`\x1b[2K\n`);
      process.stderr.write(`\x1b[2K  ${dim("↑/↓ to move, Enter to select")}`);
    };

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    };

    const confirm = () => {
      cleanup();
      process.stderr.write("\x1b[u");
      for (let i = 0; i < items.length + 2; i++) {
        process.stderr.write(`\x1b[2K\n`);
      }
      process.stderr.write("\x1b[u");
      process.stderr.write(`${dim("Provider:")} ${bold(items[selected])}\n\n`);
      resolve(selected);
    };

    const processSeq = (seq: string) => {
      if (seq === "\x1b[A") {
        selected = (selected - 1 + items.length) % items.length;
        render();
      } else if (seq === "\x1b[B") {
        selected = (selected + 1) % items.length;
        render();
      }
      // other sequences silently ignored
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString();

      // If we're accumulating an escape sequence
      if (escBuf) {
        escBuf += s;
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        // CSI sequences end with a letter
        if (/\x1b\[.+[A-Za-z~]/.test(escBuf)) {
          processSeq(escBuf);
          escBuf = "";
        } else {
          // Wait for more bytes
          escTimer = setTimeout(() => { escBuf = ""; }, 50);
        }
        return;
      }

      // Full escape sequence in one chunk (common case)
      if (s.startsWith("\x1b[") && s.length >= 3) {
        processSeq(s);
        return;
      }

      // Bare ESC — start accumulating or exit on timeout
      if (s === "\x1b") {
        escBuf = s;
        escTimer = setTimeout(() => {
          // Standalone Esc pressed — exit
          cleanup();
          process.exit(0);
        }, 100);
        return;
      }

      if (s === "\r" || s === "\n") { confirm(); return; }
      if (s === "\x03") { cleanup(); process.exit(0); }
      if (s === "k" || s === "K") {
        selected = (selected - 1 + items.length) % items.length;
        render();
      } else if (s === "j" || s === "J") {
        selected = (selected + 1) % items.length;
        render();
      }
    };

    render();
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let secret = "";

    stdin.setRawMode(true);
    stdin.resume();

    const onData = (buf: Buffer) => {
      // Process byte-by-byte, ignore escape sequences
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === 0x0d || b === 0x0a) {
          // Enter
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          resolve(secret.trim());
          return;
        } else if (b === 0x03) {
          // Ctrl+C
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.exit(0);
        } else if (b === 0x1b) {
          // Skip escape sequences entirely
          if (i + 1 < buf.length && buf[i + 1] === 0x5b) {
            // CSI: skip until letter
            i += 2;
            while (i < buf.length && !(buf[i] >= 0x40 && buf[i] <= 0x7e)) i++;
          }
        } else if (b === 0x7f || b === 0x08) {
          // Backspace
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            process.stderr.write("\b \b");
          }
        } else if (b >= 0x20 && b < 0x7f) {
          // Printable ASCII
          secret += String.fromCharCode(b);
          process.stderr.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let line = "";

    stdin.setRawMode(true);
    stdin.resume();

    const onData = (buf: Buffer) => {
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === 0x0d || b === 0x0a) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          resolve(line.trim());
          return;
        } else if (b === 0x03) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.exit(0);
        } else if (b === 0x1b) {
          if (i + 1 < buf.length && buf[i + 1] === 0x5b) {
            i += 2;
            while (i < buf.length && !(buf[i] >= 0x40 && buf[i] <= 0x7e)) i++;
          }
        } else if (b === 0x7f || b === 0x08) {
          if (line.length > 0) {
            line = line.slice(0, -1);
            process.stderr.write("\b \b");
          }
        } else if (b >= 0x20 && b < 0x7f) {
          line += String.fromCharCode(b);
          process.stderr.write(String.fromCharCode(b));
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function runSetupWizard(): Promise<{ apiUrl: string; apiKey: string; model: string; apiFormat: ApiFormat }> {
  process.stderr.write("\n");
  process.stderr.write(boldCyan("  ── Welcome to Clio ──\n\n"));
  process.stderr.write("  No API key configured. Let's set one up.\n\n");

  const options = [
    ...PROVIDER_PRESETS.map(p => p.name),
    "Custom (any OpenAI-compatible endpoint)",
  ];

  const choice = await arrowSelect(options, "Choose a provider:");

  let apiUrl: string;
  let apiKey: string;
  let model: string;
  let apiFormat: ApiFormat;

  if (choice < PROVIDER_PRESETS.length) {
    const preset = PROVIDER_PRESETS[choice];
    apiUrl = preset.apiUrl;
    model = preset.model;
    apiFormat = preset.apiFormat;
    process.stderr.write(`  ${dim("Model:")}    ${model}\n\n`);
    apiKey = await readSecret(dim("  API Key: "));
  } else {
    apiUrl = await readLine(dim("  API URL: "));
    apiKey = await readSecret(dim("  API Key: "));
    model = await readLine(dim("  Model:   "));
    const fmtAnswer = await readLine(dim("  Format (anthropic/openai) [openai]: "));
    apiFormat = fmtAnswer === "anthropic" ? "anthropic" : "openai";
  }

  const missing: string[] = [];
  if (!apiKey) missing.push("API Key");
  if (!apiUrl) missing.push("API URL");
  if (!model) missing.push("Model");
  if (missing.length > 0) {
    process.stderr.write(red(`\n  Error: ${missing.join(", ")} cannot be empty.\n`));
    process.exit(1);
  }

  const settings: Settings = { apiUrl, apiKey, model, apiFormat };
  await saveGlobalLocalSettings(settings);
  process.stderr.write(green(`\n  ✓ Saved to ~/.clio/settings.local.json\n\n`));

  return { apiUrl, apiKey, model, apiFormat };
}

interface PrintModeConfig {
  prompt: string;
  outputFormat: OutputFormat;
}

interface EscapeHandler {
  cleanup: () => void;
  pause: () => void;
  resume: () => void;
}

function withEscapeInterrupt(
  abort: AbortController,
  onDoubleEscape?: () => void,
): EscapeHandler {
  const noop: EscapeHandler = { cleanup() {}, pause() {}, resume() {} };
  if (!stdin.isTTY) return noop;

  let paused = false;
  let lastEscTime = 0;
  let escTimer: ReturnType<typeof setTimeout> | null = null;

  const onData = (buf: Buffer) => {
    if (paused) return;
    if (buf.length === 1 && buf[0] === 3) {
      abort.abort();
      return;
    }
    if (buf.length === 1 && buf[0] === 0x1b) {
      const now = Date.now();
      if (now - lastEscTime < 500 && onDoubleEscape) {
        if (escTimer) clearTimeout(escTimer);
        escTimer = null;
        onDoubleEscape();
      } else {
        lastEscTime = now;
        escTimer = setTimeout(() => {
          escTimer = null;
          abort.abort();
        }, 500);
      }
      return;
    }
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);

  return {
    cleanup() {
      if (escTimer) clearTimeout(escTimer);
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    },
    pause() {
      paused = true;
      stdin.setRawMode(false);
    },
    resume() {
      paused = false;
      stdin.setRawMode(true);
    },
  };
}

let escapeControl: EscapeHandler | null = null;

async function promptRollback(cm: CheckpointManager): Promise<boolean> {
  const files = cm.getModifiedFiles();
  process.stderr.write(`\n  ${boldCyan("── Rollback ──")}\n`);
  for (const f of files) {
    const icon = f.isNew ? green("+") : yellow("M");
    process.stderr.write(`    ${icon} ${dim(f.filePath)}\n`);
  }
  process.stderr.write(`\n  ${dim("Roll back file changes?")} ${boldCyan("[y/N]")} `);

  return new Promise<boolean>((resolve) => {
    if (!stdin.isTTY) { resolve(false); return; }
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (buf: Buffer) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      const ch = buf.toString();
      const yes = ch === "y" || ch === "Y";
      process.stderr.write(yes ? "y\n" : "n\n");
      resolve(yes);
    };
    stdin.on("data", onData);
  });
}

const VALID_MODES: PermissionMode[] = ["default", "auto", "plan"];

function loadConfig(settings: Settings): { config: Config; resumeId?: string; forkSessionId?: string; cliAllowRules: string[]; printMode?: PrintModeConfig } {
  const config: Config = {
    apiUrl: settings.apiUrl ?? process.env.CLIO_API_URL ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    apiKey: settings.apiKey ?? process.env.CLIO_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    model: settings.model ?? process.env.CLIO_MODEL ?? "claude-sonnet-4-20250514",
    permissionMode: settings.permissionMode ?? "default",
    thinkingBudget: settings.thinkingBudget ?? 0,
    apiFormat: settings.apiFormat ?? "anthropic",
  };
  let resumeId: string | undefined;
  let forkSessionId: string | undefined;
  const cliAllowRules: string[] = [];
  let printPrompt: string | undefined;
  let outputFormat: OutputFormat = "text";

  // CLI args override settings file
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api-url" && args[i + 1]) config.apiUrl = args[++i];
    else if (args[i] === "--api-key" && args[i + 1]) config.apiKey = args[++i];
    else if (args[i] === "--model" && args[i + 1]) config.model = args[++i];
    else if (args[i] === "--resume" && args[i + 1]) resumeId = args[++i];
    else if (args[i] === "--fork-session" && args[i + 1]) forkSessionId = args[++i];
    else if (args[i] === "--thinking" && args[i + 1]) config.thinkingBudget = parseInt(args[++i], 10);
    else if (args[i] === "--api-format" && args[i + 1]) config.apiFormat = args[++i] as ApiFormat;
    else if (args[i] === "--allow" && args[i + 1]) cliAllowRules.push(args[++i]);
    else if (args[i] === "--allow-outside-cwd") setAllowOutsideCwd(true);
    else if ((args[i] === "-p" || args[i] === "--print") && args[i + 1]) printPrompt = args[++i];
    else if (args[i] === "--output-format" && args[i + 1]) outputFormat = args[++i] as OutputFormat;
    else if (args[i] === "--permission-mode" && args[i + 1]) {
      const mode = args[++i] as PermissionMode;
      if (!VALID_MODES.includes(mode)) {
        console.error(red(`Invalid permission mode: ${mode}. Must be one of: ${VALID_MODES.join(", ")}`));
        process.exit(1);
      }
      config.permissionMode = mode;
    } else if (args[i] === "--dangerously-skip-permissions") {
      config.permissionMode = "auto";
    } else if (args[i] === "--version" || args[i] === "-v") {
      console.log("clio 0.0.1");
      process.exit(0);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: clio [options]
       clio -p "prompt"          Non-interactive mode
       echo "prompt" | clio -p   Pipe mode (reads stdin)

Options:
  -p, --print <prompt>     Run non-interactively: execute prompt, print result, exit
  --output-format <fmt>    Output format for -p mode: text | json (default: text)
  --api-url <url>          API base URL (env: CLIO_API_URL or ANTHROPIC_BASE_URL)
  --api-key <key>          API key    (env: CLIO_API_KEY or ANTHROPIC_API_KEY)
  --model   <model>        Model name (env: CLIO_MODEL, default: claude-sonnet-4-20250514)
  --resume  <id>           Resume a previous session
  --fork-session <id>      Fork from an existing session
  --thinking <tokens>      Enable extended thinking with budget (e.g. 10000)
  --api-format <fmt>       API format: anthropic | openai (default: anthropic)
  --permission-mode <mode> Permission mode: default, auto, plan (default: default)
  --allow <pattern>        Auto-allow Bash commands matching pattern (repeatable)
  --dangerously-skip-permissions  Shorthand for --permission-mode auto
  --no-color               Disable colored output
  -v, --version            Show version
  -h, --help               Show this help`);
      process.exit(0);
    }
  }

  if (!config.apiKey) {
    // Will be handled by setup wizard in main()
    config.apiKey = "";
  }

  // Build printMode if -p was given or stdin is piped
  let printMode: PrintModeConfig | undefined;
  if (printPrompt !== undefined) {
    printMode = { prompt: printPrompt, outputFormat };
  }

  return { config, resumeId, forkSessionId, cliAllowRules, printMode };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function runPrintMode(
  printMode: PrintModeConfig,
  config: Config,
  settings: Settings,
  permissionManager: PermissionManager,
): Promise<void> {
  // Read from stdin pipe if prompt is empty
  let prompt = printMode.prompt;
  if (!prompt && !stdin.isTTY) {
    prompt = await readStdin();
  }
  if (!prompt) {
    console.error(red("Error: no prompt provided. Use -p \"prompt\" or pipe via stdin."));
    process.exit(1);
  }

  const messages: Message[] = [{ role: "user", content: prompt }];
  const sectionCache = new SectionCache();

  // In JSON mode, suppress streaming stdout from MarkdownRenderer
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  if (printMode.outputFormat === "json") {
    process.stdout.write = (() => true) as typeof process.stdout.write;
  }

  const usage = await runAgentLoop(config, messages, permissionManager, undefined, settings.hooks, undefined, sectionCache);

  // Restore stdout
  process.stdout.write = origStdoutWrite;

  // Extract final assistant text
  const lastMsg = messages[messages.length - 1];
  let resultText = "";
  if (lastMsg?.role === "assistant") {
    if (typeof lastMsg.content === "string") {
      resultText = lastMsg.content;
    } else {
      resultText = lastMsg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    }
  }

  if (printMode.outputFormat === "json") {
    const output = {
      result: resultText,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens,
      },
      model: config.model,
      num_turns: messages.filter((m) => m.role === "assistant").length,
    };
    // JSON output goes to stdout, bypassing any markdown rendering
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  }
  // text format: runAgentLoop already streamed text to stdout via MarkdownRenderer
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  await loadKeybindings();
  await loadCustomAgents();
  await loadSkills();

  // Load plugins — injects skills/agents/commands, collects hooks/MCP/LSP
  const pluginContribs = await initPlugins(settings);

  const { config, resumeId, forkSessionId, cliAllowRules, printMode } = loadConfig(settings);

  // First-run setup wizard when no API key is configured
  if (!config.apiKey) {
    if (!stdin.isTTY) {
      console.error(red("Error: API key required. Set CLIO_API_KEY env var or use --api-key"));
      process.exit(1);
    }
    const setup = await runSetupWizard();
    config.apiKey = setup.apiKey;
    config.apiUrl = setup.apiUrl;
    config.model = setup.model;
    config.apiFormat = setup.apiFormat;
  }

  // Merge allow rules: settings file + CLI flags
  const allowRules = [...(settings.allowRules ?? []), ...cliAllowRules];

  // Apply workspace restriction setting
  if (settings.allowOutsideCwd) setAllowOutsideCwd(true);

  // Initialize sandbox
  if (settings.sandbox) {
    const sb = new Sandbox(settings.sandbox, process.cwd());
    setSandbox(sb);
    setHookSandbox(sb);
  }

  const denyRules = [...(settings.denyRules ?? [])];
  const permissionManager = new PermissionManager(config.permissionMode, allowRules, denyRules);

  if (settings.autoClassifier?.enabled) {
    permissionManager.setAutoClassifier({
      enabled: true,
      safePatterns: settings.autoClassifier.safePatterns,
      dangerousPatterns: settings.autoClassifier.dangerousPatterns,
    });

    if (settings.autoClassifier.llmClassifier?.enabled) {
      const messages: Message[] = [];
      const classifier = createLLMClassifier(
        config,
        settings.autoClassifier.llmClassifier,
        () => {
          // Extract recent context from last few messages
          const recent = messages.slice(-4);
          return recent
            .map((m) => {
              if (typeof m.content === "string") return m.content.slice(0, 500);
              return "(tool interaction)";
            })
            .join("\n");
        },
      );
      permissionManager.setLLMClassifier(classifier);
    }
  }

  // Merge plugin hooks into settings
  if (pluginContribs.hooks.pre?.length || pluginContribs.hooks.post?.length) {
    settings.hooks = {
      pre: [...(settings.hooks?.pre ?? []), ...(pluginContribs.hooks.pre ?? [])],
      post: [...(settings.hooks?.post ?? []), ...(pluginContribs.hooks.post ?? [])],
    };
  }

  // Start MCP servers (settings + plugin contributions)
  const allMcpServers = { ...(settings.mcpServers ?? {}), ...pluginContribs.mcpServers };
  let mcpMgr: McpManager | null = null;
  if (Object.keys(allMcpServers).length > 0) {
    mcpMgr = new McpManager();
    await mcpMgr.startAll(allMcpServers);
    setMcpManager(mcpMgr);
    setGlobalMcpManager(mcpMgr);
  }
  // Start LSP servers (settings + plugin contributions)
  const allLspServers = { ...(settings.lspServers ?? {}), ...pluginContribs.lspServers };
  let lspMgr: LspManager | null = null;
  if (Object.keys(allLspServers).length > 0) {
    lspMgr = new LspManager();
    await lspMgr.startAllWithConfigs(allLspServers);
    setLspManager(lspMgr);
    setGlobalLspManager(lspMgr);
  }

  // ── Non-interactive print mode ──
  if (printMode) {
    if (!process.argv.includes("--permission-mode")) {
      permissionManager.setMode("auto");
      config.permissionMode = "auto";
    }
    setToolContext({ config, permissionControl: permissionManager });
    await runPrintMode(printMode, config, settings, permissionManager);
    if (mcpMgr) await mcpMgr.stopAll();
    if (lspMgr) await lspMgr.stopAll();
    return;
  }

  const reader = new InputReader();
  const messages: Message[] = [];
  const sessionUsage: UsageStats = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

  // Wire permission prompts to pause/resume escape handler
  permissionManager.setPromptHooks(
    () => escapeControl?.pause(),
    () => escapeControl?.resume(),
  );
  const sectionCache = new SectionCache();
  let session = new SessionManager(config.model);
  const statusBar = new StatusBar();
  const checkpointManager = new CheckpointManager();
  const fileCompleter = new FileCompleter(process.cwd());
  reader.setFileCompleter(fileCompleter);

  setToolContext({
    config,
    permissionControl: permissionManager,
    askUser: async (question: string) => {
      process.stderr.write(`\n  ${boldCyan("?")} ${question}\n`);
      escapeControl?.pause();
      try {
        const answer = await reader.read(`  ${dim(">")} `);
        return answer ?? "(no answer)";
      } finally {
        escapeControl?.resume();
      }
    },
  });

  console.clear();

  // Resume previous session
  if (resumeId) {
    const restored = await SessionManager.restore(resumeId);
    if (restored) {
      messages.push(...restored.messages);
      sessionUsage.inputTokens = restored.usage.inputTokens;
      sessionUsage.outputTokens = restored.usage.outputTokens;
    } else {
      console.error(red(`  Session ${resumeId} not found.\n`));
    }
  }

  // Fork from existing session
  if (forkSessionId) {
    const forked = await SessionManager.fork(forkSessionId, config.model);
    if (forked) {
      session = forked.manager;
      messages.push(...forked.messages);
      sessionUsage.inputTokens = forked.usage.inputTokens;
      sessionUsage.outputTokens = forked.usage.outputTokens;
    } else {
      console.error(red(`  Session ${forkSessionId} not found.\n`));
    }
  }

  // ── Startup banner ──
  const customAgents = listCustomAgents();
  renderBanner({
    model: config.model,
    apiUrl: config.apiUrl,
    cwd: process.cwd(),
    sessionId: session.getId(),
    mode: config.permissionMode,
    mcpServers: mcpMgr?.getServerNames(),
    lspServers: lspMgr?.getServerNames(),
    agents: customAgents.length > 0 ? customAgents : undefined,
    resumed: resumeId && messages.length > 0 ? { id: resumeId, messageCount: messages.length } : undefined,
    forked: forkSessionId && messages.length > 0 ? { fromId: forkSessionId, messageCount: messages.length } : undefined,
  });

  statusBar.init(config.model, session.getId(), config.permissionMode);
    if (settings.statusBar?.fields) {
      statusBar.setFields(settings.statusBar.fields);
    }

  const MODES: PermissionMode[] = ["default", "auto", "plan"];
  reader.setShiftTabHandler(() => {
    const current = permissionManager.getMode();
    const nextIdx = (MODES.indexOf(current) + 1) % MODES.length;
    const next = MODES[nextIdx];
    permissionManager.setMode(next);
    config.permissionMode = next;
    statusBar.updateMode(next);
  });

  reader.setCtrlOHandler(() => {
    const verbose = toggleVerbose();
    statusBar.updateVerbose(verbose);
  });

  const promptStr = `${boldCyan("❯")} `;

  while (true) {
    const input = await reader.read(promptStr);

    // null = Ctrl+C or Ctrl+D
    if (input === null) break;

    const trimmed = input.trim();
    if (!trimmed) continue;

    // ── Slash commands ──
    if (trimmed === "/exit" || trimmed === "/quit") break;

    if (trimmed.startsWith("/btw ")) {
      const question = trimmed.slice(5).trim();
      if (!question) {
        console.log(dim("  Usage: /btw <question>\n"));
        continue;
      }

      const sysPrompt = await buildSystemPrompt();
      const sideBody: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: "user", content: question }],
        max_tokens: 4096,
        system: sysPrompt,
      };

      process.stderr.write(`\n${dim("  (side question)")}\n\n`);

      try {
        const md = new MarkdownRenderer();
        for await (const event of streamRequest(config, sideBody)) {
          const type = event.type as string;
          if (type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown>;
            if (delta.type === "text_delta") {
              md.write(delta.text as string);
            }
          }
        }
        md.flush();
      } catch (err) {
        console.error(red(`  ${err instanceof Error ? err.message : String(err)}`));
      }
      console.log();
      continue;
    }

    if (trimmed === "/clear" || trimmed === "/new") {
      messages.length = 0;
      taskStore.clear();
      sectionCache.clear();
      console.log(dim("  Conversation cleared.\n"));
      continue;
    }

    if (trimmed === "/compact") {
      if (messages.length === 0) {
        console.log(dim("  Nothing to compact.\n"));
        continue;
      }
      process.stderr.write(dim("  Compacting conversation...\n"));
      try {
        const summary = await compactConversation(config, messages);
        const oldCount = messages.length;
        messages.length = 0;
        messages.push({ role: "user", content: "Here is a summary of our conversation so far:\n\n" + summary });
        messages.push({ role: "assistant", content: "Understood. I have the context from our previous conversation. How can I help you next?" });
        console.log(dim(`  Compacted ${oldCount} messages → 2 (summary + ack)\n`));
      } catch (err) {
        console.error(red(`  Compact failed: ${err instanceof Error ? err.message : err}\n`));
      }
      continue;
    }

    if (trimmed === "/cost") {
      const totalK = ((sessionUsage.inputTokens + sessionUsage.outputTokens) / 1000).toFixed(1);
      const cost = estimateCost(config.model, sessionUsage.inputTokens, sessionUsage.outputTokens);
      console.log(`
  ${bold("Session usage:")}
    Input:  ${sessionUsage.inputTokens.toLocaleString()} tokens${cost ? `  (${formatUSD(cost.input)})` : ""}
    Output: ${sessionUsage.outputTokens.toLocaleString()} tokens${cost ? `  (${formatUSD(cost.output)})` : ""}
    Total:  ${totalK}k tokens${cost ? `  ${bold(formatUSD(cost.total))}` : ""}
    Model:  ${config.model}${!cost ? dim("  (pricing unavailable)") : ""}
`);
      continue;
    }

    if (trimmed === "/context") {
      const sysPrompt = await buildSystemPrompt();
      const sysTokens = Math.ceil(sysPrompt.length / 4);
      let userTextTokens = 0;
      let assistantTextTokens = 0;
      let toolCallTokens = 0;
      let toolResultTokens = 0;

      for (const msg of messages) {
        if (typeof msg.content === "string") {
          const t = Math.ceil(msg.content.length / 4);
          if (msg.role === "user") userTextTokens += t;
          else assistantTextTokens += t;
        } else {
          for (const block of msg.content) {
            if (block.type === "text") {
              const t = Math.ceil((block.text?.length ?? 0) / 4);
              if (msg.role === "assistant") assistantTextTokens += t;
              else userTextTokens += t;
            } else if (block.type === "tool_use") {
              toolCallTokens += Math.ceil((JSON.stringify(block.input ?? {}).length + (block.name?.length ?? 0)) / 4);
            } else if (block.type === "tool_result") {
              toolResultTokens += Math.ceil((block.content?.length ?? 0) / 4);
            }
          }
        }
      }

      const capacity = getContextLimit(config.model);
      const total = sysTokens + userTextTokens + assistantTextTokens + toolCallTokens + toolResultTokens;
      const remaining = Math.max(0, capacity - total);
      const barWidth = 30;
      const bar = (tokens: number) => "\u2588".repeat(Math.round((tokens / capacity) * barWidth));
      const pct = (tokens: number) => ((tokens / capacity) * 100).toFixed(1) + "%";
      const fmtK = (n: number) => (n / 1000).toFixed(1) + "k";

      console.log(`
  ${bold("Context window:")}  ${fmtK(total)} / ${fmtK(capacity)} tokens (${pct(total)} used)

    ${magenta("System prompt")}    ${fmtK(sysTokens).padStart(7)}  ${pct(sysTokens).padStart(6)}  ${magenta(bar(sysTokens))}
    ${cyan("User messages")}    ${fmtK(userTextTokens).padStart(7)}  ${pct(userTextTokens).padStart(6)}  ${cyan(bar(userTextTokens))}
    ${green("Assistant text")}   ${fmtK(assistantTextTokens).padStart(7)}  ${pct(assistantTextTokens).padStart(6)}  ${green(bar(assistantTextTokens))}
    ${yellow("Tool calls")}       ${fmtK(toolCallTokens).padStart(7)}  ${pct(toolCallTokens).padStart(6)}  ${yellow(bar(toolCallTokens))}
    ${blue("Tool results")}     ${fmtK(toolResultTokens).padStart(7)}  ${pct(toolResultTokens).padStart(6)}  ${blue(bar(toolResultTokens))}
    ${dim("Remaining")}        ${fmtK(remaining).padStart(7)}  ${pct(remaining).padStart(6)}  ${dim("\u2591".repeat(Math.round((remaining / capacity) * barWidth)))}

    Messages: ${messages.length}  \u2502  Auto-compact at: ${fmtK(capacity * 0.85)}
`);
      continue;
    }

    if (trimmed.startsWith("/search ")) {
      const query = trimmed.slice(8).trim();
      if (!query) {
        console.log(dim("  Usage: /search <query>\n"));
        continue;
      }
      const results = await SessionManager.search(query);
      if (results.length === 0) {
        console.log(dim(`  No sessions matching "${query}".\n`));
      } else {
        console.log(`\n  ${bold(`Search results for "${query}":`)}`);
        for (const r of results) {
          const date = new Date(r.updatedAt).toLocaleString();
          console.log(`    ${boldCyan(r.id)} ${dim(r.model)} ${dim(`${r.messageCount} msgs`)} ${dim(date)}`);
          console.log(`         ${dim(r.cwd)}`);
          for (const m of r.matches) {
            console.log(`         ${dim("›")} ${m}`);
          }
        }
        console.log(dim(`\n  Resume with: --resume <id>\n`));
      }
      continue;
    }

    if (trimmed === "/sessions") {
      const list = await SessionManager.list();
      if (list.length === 0) {
        console.log(dim("  No saved sessions.\n"));
      } else {
        console.log(`\n  ${bold("Recent sessions:")}`);
        for (const s of list) {
          const date = new Date(s.updatedAt).toLocaleString();
          console.log(`    ${boldCyan(s.id)} ${dim(s.model)} ${dim(`${s.messageCount} msgs`)} ${dim(date)}`);
          console.log(`         ${dim(s.cwd)}`);
        }
        console.log(dim(`\n  Resume with: --resume <id>\n`));
      }
      continue;
    }

    if (trimmed === "/history") {
      await historyCommand(checkpointManager);
      continue;
    }

    if (trimmed.startsWith("/undo")) {
      const id = trimmed.slice(5).trim();
      await undoCommand(checkpointManager, id, messages);
      continue;
    }

    if (trimmed === "/settings") {
      const s = await loadSettings();
      const info = await getSettingsInfo();
      console.log(`\n  ${bold("Settings files:")}`);
      for (const f of info) {
        const status = f.exists ? boldCyan("✓") : dim("·");
        console.log(`    ${status} ${dim(f.level + ":")} ${f.path}`);
      }
      console.log(`\n  ${bold("Merged config:")}`);
      console.log(`    model:           ${s.model ?? dim("(default)")}`);
      console.log(`    permissionMode:  ${s.permissionMode ?? dim("(default)")}`);
      console.log(`    thinkingBudget:  ${s.thinkingBudget ?? dim("0")}`);
      console.log(`    allowRules:      ${s.allowRules?.length ? s.allowRules.join(", ") : dim("(none)")}`);
      console.log(`    allowOutsideCwd: ${s.allowOutsideCwd ?? dim("false")}`);
      console.log(`    denyRules:       ${s.denyRules?.length ? s.denyRules.join(", ") : dim("(none)")}`);
      console.log(`    hooks:           ${s.hooks ? `pre:${s.hooks.pre?.length ?? 0} post:${s.hooks.post?.length ?? 0}` : dim("(none)")}`);
      console.log(`    mcpServers:      ${s.mcpServers ? Object.keys(s.mcpServers).join(", ") : dim("(none)")}`);
      console.log(`    theme:           ${getTheme()}`);
      console.log();
      continue;
    }

    if (trimmed === "/doctor") {
      const { runDoctor } = await import("./commands/doctor.js");
      const result = await runDoctor(config.apiUrl, config.apiKey);
      process.stderr.write(result + "\n");
      continue;
    }

    if (trimmed === "/commit") {
      try {
        await commitCommand(config);
      } catch (err) {
        console.error(red(`  ${err instanceof Error ? err.message : err}\n`));
      }
      continue;
    }

    if (trimmed === "/pr") {
      try {
        await prCommand(config);
      } catch (err) {
        console.error(red(`  ${err instanceof Error ? err.message : err}\n`));
      }
      continue;
    }

    if (trimmed === "/review") {
      const reviewPrompt = await reviewCommand(config);
      if (reviewPrompt) {
        messages.push({ role: "user", content: reviewPrompt });
        console.log();
        const abort = new AbortController();
        checkpointManager.begin(messages.length - 1);
        let rollbackRequested = false;
        const escHandler = withEscapeInterrupt(abort, () => {
          rollbackRequested = true;
          abort.abort();
        });
        escapeControl = escHandler;
        try {
          const turnUsage = await runAgentLoop(config, messages, permissionManager, abort.signal, settings.hooks, checkpointManager, sectionCache);
          sessionUsage.inputTokens += turnUsage.inputTokens;
          sessionUsage.outputTokens += turnUsage.outputTokens;
          sessionUsage.cacheCreationInputTokens += turnUsage.cacheCreationInputTokens;
          sessionUsage.cacheReadInputTokens += turnUsage.cacheReadInputTokens;
          statusBar.update(sessionUsage);
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            process.stderr.write(dim("\n  Interrupted.\n"));
          } else {
            console.error(red(`\nError: ${err instanceof Error ? err.message : err}`));
          }
          if (!rollbackRequested) {
            while (messages.length > 0 && messages[messages.length - 1].role === "assistant") messages.pop();
            messages.pop();
          }
        } finally {
          escapeControl = null;
          escHandler.cleanup();
        }
        if (rollbackRequested && checkpointManager.getModifiedFiles().length > 0) {
          const confirmed = await promptRollback(checkpointManager);
          if (confirmed) {
            const restored = await checkpointManager.rollback();
            messages.length = checkpointManager.getMessageCountBefore();
            process.stderr.write(dim(`  Rolled back ${restored.length} file(s).\n`));
          } else {
            await checkpointManager.commit();
          }
        } else {
          await checkpointManager.commit();
        }
        await session.save(messages, sessionUsage).catch(() => {});
        console.log();
      }
      continue;
    }

    if (trimmed === "/init") {
      process.stderr.write(dim("  Scanning project and generating AGENTS.md...\n"));
      try {
        const filePath = await initClaudeMd(config);
        console.log(dim(`  Created ${filePath}\n`));
      } catch (err) {
        console.error(red(`  ${err instanceof Error ? err.message : err}\n`));
      }
      continue;
    }

    if (trimmed.startsWith("/theme")) {
      const newTheme = trimmed.slice(7).trim();
      if (newTheme) {
        const validThemes: Theme[] = ["default", "minimal", "plain"];
        if (validThemes.includes(newTheme as Theme)) {
          setTheme(newTheme as Theme);
          console.log(dim(`  Theme set to: ${newTheme}\n`));
        } else {
          console.log(red(`  Unknown theme: ${newTheme}. Options: default, minimal, plain\n`));
        }
      } else {
        console.log(dim(`  Current theme: ${getTheme()}\n`));
      }
      continue;
    }

    if (trimmed.startsWith("/model")) {
      const newModel = trimmed.slice(7).trim();
      if (newModel) {
        config.model = newModel;
        statusBar.updateModel(newModel);
        console.log(dim(`  Model set to: ${newModel}\n`));
      } else {
        console.log(dim(`  Current model: ${config.model}\n`));
      }
      continue;
    }

    if (trimmed === "/help") {
      console.log(`
  ${bold("Commands:")}
    /btw <q>      Quick side question (won't affect conversation)
    /clear        Reset conversation
    /commit       Generate commit message and commit
    /compact      Compress conversation context
    /context      Show context window usage
    /cost         Show token usage and cost
    /doctor       System health check
    /init         Generate AGENTS.md for this project
    /model [m]    Show or switch model
    /new          New conversation (same as /clear)
    /pr           Generate and create pull request
    /review       Code review current changes
    /search <q>   Search conversation history
    /sessions     List saved sessions
    /settings     Show config file
    /theme [name] Switch theme (default, minimal, plain)
    /exit         Quit
    /help         Show this help

  ${bold("Input:")}
    Enter               Submit message
    Ctrl+J / Shift+Enter New line
    Escape              Interrupt generation
    Esc-Esc             Rollback file changes (double-tap)
    Ctrl+C              Cancel / interrupt
    Up/Down             History (single line) / navigate lines
    Ctrl+A / Home       Line start
    Ctrl+E / End        Line end
    Ctrl+W              Delete word backward
    Ctrl+K              Clear to end of line
    Ctrl+U              Clear to start of line
    Ctrl+R              Search history
    Ctrl+L              Clear screen
    Ctrl+Left/Right     Word jump
    Ctrl+O              Toggle verbose tool output
    Ctrl+Y              Yank (paste last kill)
    Shift+Tab           Cycle permission mode
    @file + Tab         File path completion

  ${bold("Shell:")}
    !command      Run shell command directly
`);
      continue;
    }

    // ── Catch-all skill routing ──
    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const cmdName = parts[0].slice(1);
      const skill = getSkill(cmdName);
      if (skill) {
        const args = parts.slice(1).join(" ");
        const prompt = args
          ? skill.promptTemplate.replace(/\{\{args\}\}/g, args)
          : skill.promptTemplate;
        messages.push({ role: "user", content: prompt });
        console.log();
        const abort = new AbortController();
        checkpointManager.begin(messages.length - 1);
        let rollbackRequested = false;
        const escHandler = withEscapeInterrupt(abort, () => {
          rollbackRequested = true;
          abort.abort();
        });
        escapeControl = escHandler;
        try {
          const turnUsage = await runAgentLoop(config, messages, permissionManager, abort.signal, settings.hooks, checkpointManager, sectionCache);
          sessionUsage.inputTokens += turnUsage.inputTokens;
          sessionUsage.outputTokens += turnUsage.outputTokens;
          sessionUsage.cacheCreationInputTokens += turnUsage.cacheCreationInputTokens;
          sessionUsage.cacheReadInputTokens += turnUsage.cacheReadInputTokens;
          statusBar.update(sessionUsage);
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            process.stderr.write(dim("\n  Interrupted.\n"));
          } else {
            console.error(red(`\nError: ${err instanceof Error ? err.message : err}`));
          }
          if (!rollbackRequested) {
            while (messages.length > 0 && messages[messages.length - 1].role === "assistant") messages.pop();
            messages.pop();
          }
        } finally {
          escapeControl = null;
          escHandler.cleanup();
        }
        if (rollbackRequested && checkpointManager.getModifiedFiles().length > 0) {
          const confirmed = await promptRollback(checkpointManager);
          if (confirmed) {
            const restored = await checkpointManager.rollback();
            messages.length = checkpointManager.getMessageCountBefore();
            process.stderr.write(dim(`  Rolled back ${restored.length} file(s).\n`));
          } else {
            await checkpointManager.commit();
          }
        } else {
          await checkpointManager.commit();
        }
        await session.save(messages, sessionUsage).catch(() => {});
        console.log();
        continue;
      }
    }

    // ── Shell escape: !command ──
    if (trimmed.startsWith("!")) {
      const shellCmd = trimmed.slice(1).trim();
      if (shellCmd) {
        try {
          const { execSync } = await import("node:child_process");
          execSync(shellCmd, {
          cwd: process.cwd(),
          stdio: "inherit",
          shell: process.platform === "win32" ? "bash" : "/bin/bash",
          timeout: 120_000,
        });
        } catch {
          // execSync with stdio: "inherit" already displayed output
        }
        console.log();
      }
      continue;
    }

    // ── Resolve @file references and send message ──
    const resolved = await resolveFileReferences(trimmed, process.cwd());
    const userContent = await parseInputWithImages(resolved);
    messages.push({ role: "user", content: userContent });

    console.log(); // blank line before response

    const abort = new AbortController();
    checkpointManager.begin(messages.length - 1);
    let rollbackRequested = false;
    const escHandler = withEscapeInterrupt(abort, () => {
      rollbackRequested = true;
      abort.abort();
    });
    escapeControl = escHandler;

    try {
      const turnUsage = await runAgentLoop(config, messages, permissionManager, abort.signal, settings.hooks, checkpointManager, sectionCache);
      sessionUsage.inputTokens += turnUsage.inputTokens;
      sessionUsage.outputTokens += turnUsage.outputTokens;
      sessionUsage.cacheCreationInputTokens += turnUsage.cacheCreationInputTokens;
      sessionUsage.cacheReadInputTokens += turnUsage.cacheReadInputTokens;
      statusBar.update(sessionUsage);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        process.stderr.write(dim("\n  Interrupted.\n"));
      } else {
        console.error(red(`\nError: ${err instanceof Error ? err.message : err}`));
      }
      if (!rollbackRequested) {
        while (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
          messages.pop();
        }
        messages.pop();
      }
    } finally {
      escapeControl = null;
      escHandler.cleanup();
    }

    // Handle Esc-Esc rollback
    if (rollbackRequested && checkpointManager.getModifiedFiles().length > 0) {
      const confirmed = await promptRollback(checkpointManager);
      if (confirmed) {
        const restored = await checkpointManager.rollback();
        messages.length = checkpointManager.getMessageCountBefore();
        process.stderr.write(dim(`  Rolled back ${restored.length} file(s).\n`));
      } else {
        await checkpointManager.commit();
      }
    } else {
      await checkpointManager.commit();
    }

    // Auto-save after each turn
    await session.save(messages, sessionUsage).catch(() => {});

    console.log(); // blank line after response
  }

  // Shutdown MCP & LSP servers
  if (mcpMgr) {
    await mcpMgr.stopAll();
  }
  if (lspMgr) {
    await lspMgr.stopAll();
  }

  // Save on exit
  await session.save(messages, sessionUsage).catch(() => {});
  statusBar.destroy();
  console.log(dimCyan(`\n  💾 Session saved: ${session.getId()}`));
  console.log(dimCyan("  👋 Bye!\n"));
}

main().catch((err) => {
  console.error(red(err.message));
  process.exit(1);
});
