#!/usr/bin/env node

import { runAgentLoop } from "./agent.js";
import { compactConversation } from "./compact.js";
import { initClaudeMd } from "./init.js";
import { commitCommand, prCommand, reviewCommand } from "./git-commands.js";
import { SessionManager } from "./session.js";
import { bold, dim, red, boldCyan, dimCyan } from "./render.js";
import { PermissionManager } from "./permissions.js";
import { InputReader } from "./input.js";
import { loadSettings, getSettingsInfo, type Settings } from "./settings.js";
import { setAllowOutsideCwd } from "./tools.js";
import { parseInputWithImages } from "./image.js";
import { StatusBar } from "./statusbar.js";
import type { ApiFormat, Config, Message, PermissionMode, UsageStats } from "./types.js";

const VALID_MODES: PermissionMode[] = ["default", "auto", "plan"];

function loadConfig(settings: Settings): { config: Config; resumeId?: string; cliAllowRules: string[] } {
  const config: Config = {
    apiUrl: settings.apiUrl ?? process.env.CLAUDE2API_URL ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    apiKey: settings.apiKey ?? process.env.CLAUDE2API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    model: settings.model ?? process.env.CLAUDE2API_MODEL ?? "claude-sonnet-4-20250514",
    permissionMode: settings.permissionMode ?? "default",
    thinkingBudget: settings.thinkingBudget ?? 0,
    apiFormat: settings.apiFormat ?? "anthropic",
  };
  let resumeId: string | undefined;
  const cliAllowRules: string[] = [];

  // CLI args override settings file
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api-url" && args[i + 1]) config.apiUrl = args[++i];
    else if (args[i] === "--api-key" && args[i + 1]) config.apiKey = args[++i];
    else if (args[i] === "--model" && args[i + 1]) config.model = args[++i];
    else if (args[i] === "--resume" && args[i + 1]) resumeId = args[++i];
    else if (args[i] === "--thinking" && args[i + 1]) config.thinkingBudget = parseInt(args[++i], 10);
    else if (args[i] === "--api-format" && args[i + 1]) config.apiFormat = args[++i] as ApiFormat;
    else if (args[i] === "--allow" && args[i + 1]) cliAllowRules.push(args[++i]);
    else if (args[i] === "--allow-outside-cwd") setAllowOutsideCwd(true);
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
      console.log("c2a 0.0.1");
      process.exit(0);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: c2a [options]

Options:
  --api-url <url>          API base URL (env: CLAUDE2API_URL or ANTHROPIC_BASE_URL)
  --api-key <key>          API key    (env: CLAUDE2API_KEY or ANTHROPIC_API_KEY)
  --model   <model>        Model name (env: CLAUDE2API_MODEL, default: claude-sonnet-4-20250514)
  --resume  <id>           Resume a previous session
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
    console.error(red("Error: API key required. Set CLAUDE2API_KEY env var or use --api-key"));
    process.exit(1);
  }

  return { config, resumeId, cliAllowRules };
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  const { config, resumeId, cliAllowRules } = loadConfig(settings);

  // Merge allow rules: settings file + CLI flags
  const allowRules = [...(settings.allowRules ?? []), ...cliAllowRules];

  // Apply workspace restriction setting
  if (settings.allowOutsideCwd) setAllowOutsideCwd(true);
  const permissionManager = new PermissionManager(config.permissionMode, allowRules);
  const reader = new InputReader();
  const messages: Message[] = [];
  const sessionUsage: UsageStats = { inputTokens: 0, outputTokens: 0 };
  const session = new SessionManager(config.model);
  const statusBar = new StatusBar();

  // Resume previous session
  if (resumeId) {
    const restored = await SessionManager.restore(resumeId);
    if (restored) {
      messages.push(...restored.messages);
      sessionUsage.inputTokens = restored.usage.inputTokens;
      sessionUsage.outputTokens = restored.usage.outputTokens;
      console.log(dim(`  Resumed session ${resumeId} (${messages.length} messages)\n`));
    } else {
      console.error(red(`  Session ${resumeId} not found.\n`));
    }
  }

  console.clear();

  // ── Beautiful startup banner ──
  const cols = process.stdout.columns ?? 80;
  const width = Math.min(cols - 4, 56);
  const line = "─".repeat(width - 2);

  console.log();
  console.log(dimCyan(`  ╭${line}╮`));
  console.log(dimCyan("  │") + " ".repeat(width - 2) + dimCyan("│"));

  const title = `◆ Claude Code`;
  const modelTag = `(${config.model})`;
  const titleLine = `  ${boldCyan(title)} ${dim(modelTag)}`;
  const titleLen = title.length + 1 + modelTag.length;
  const titlePad = Math.max(0, width - 2 - titleLen);
  console.log(dimCyan("  │") + ` ${boldCyan("◆")} ${bold("Claude Code")} ${dim(modelTag)}` + " ".repeat(titlePad) + dimCyan("│"));

  console.log(dimCyan("  │") + " ".repeat(width - 2) + dimCyan("│"));

  const infoLines = [
    [`  ${dim("Gateway")}`, dim(config.apiUrl)],
    [`  ${dim("cwd")}    `, dim(process.cwd())],
    [`  ${dim("session")} `, dim(session.getId())],
    [`  ${dim("mode")}   `, dim(config.permissionMode)],
  ];

  for (const [label, value] of infoLines) {
    const content = `${label}  ${value}`;
    // Rough visible length (strip ANSI)
    const visible = content.replace(/\x1b\[[0-9;]*m/g, "").length;
    const pad = Math.max(0, width - 2 - visible);
    console.log(dimCyan("  │") + content + " ".repeat(pad) + dimCyan("│"));
  }

  console.log(dimCyan("  │") + " ".repeat(width - 2) + dimCyan("│"));
  const helpHint = `  ${dim("Type")} ${boldCyan("/help")} ${dim("for commands")}`;
  const helpVisible = "  Type /help for commands".length;
  const helpPad = Math.max(0, width - 2 - helpVisible);
  console.log(dimCyan("  │") + helpHint + " ".repeat(helpPad) + dimCyan("│"));
  console.log(dimCyan(`  ╰${line}╯`));
  console.log();

  statusBar.init(config.model, session.getId());

  const promptStr = `${boldCyan("❯")} `;

  while (true) {
    const input = await reader.read(promptStr);

    // null = Ctrl+C or Ctrl+D
    if (input === null) break;

    const trimmed = input.trim();
    if (!trimmed) continue;

    // ── Slash commands ──
    if (trimmed === "/exit" || trimmed === "/quit") break;

    if (trimmed === "/clear") {
      messages.length = 0;
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
      console.log(`
  ${bold("Session usage:")}
    Input:  ${sessionUsage.inputTokens.toLocaleString()} tokens
    Output: ${sessionUsage.outputTokens.toLocaleString()} tokens
    Total:  ${totalK}k tokens
`);
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
      console.log(`    hooks:           ${s.hooks ? `pre:${s.hooks.pre?.length ?? 0} post:${s.hooks.post?.length ?? 0}` : dim("(none)")}`);
      console.log();
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
        const onSigint = () => abort.abort();
        process.on("SIGINT", onSigint);
        try {
          const turnUsage = await runAgentLoop(config, messages, permissionManager, abort.signal, settings.hooks);
          sessionUsage.inputTokens += turnUsage.inputTokens;
          sessionUsage.outputTokens += turnUsage.outputTokens;
          statusBar.update(sessionUsage);
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            process.stderr.write(dim("\n  Interrupted.\n"));
          } else {
            console.error(red(`\nError: ${err instanceof Error ? err.message : err}`));
          }
          while (messages.length > 0 && messages[messages.length - 1].role === "assistant") messages.pop();
          messages.pop();
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
        await session.save(messages, sessionUsage).catch(() => {});
        console.log();
      }
      continue;
    }

    if (trimmed === "/init") {
      process.stderr.write(dim("  Scanning project and generating CLAUDE.md...\n"));
      try {
        const filePath = await initClaudeMd(config);
        console.log(dim(`  Created ${filePath}\n`));
      } catch (err) {
        console.error(red(`  ${err instanceof Error ? err.message : err}\n`));
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
    /clear      Reset conversation
    /commit     Generate commit message and commit
    /compact    Compress conversation context
    /cost       Show token usage
    /init       Generate CLAUDE.md for this project
    /model [m]  Show or switch model
    /pr         Generate and create pull request
    /review     Code review current changes
    /sessions   List saved sessions
    /settings   Show config file
    /exit       Quit
    /help       Show this help

  ${bold("Input:")}
    \\          Line continuation (backslash at end)
    Ctrl+C     Cancel input / interrupt running request
    Up/Down    Command history
`);
      continue;
    }

    // ── Send message (with optional image detection) ──
    const userContent = await parseInputWithImages(trimmed);
    messages.push({ role: "user", content: userContent });

    console.log(); // blank line before response

    const abort = new AbortController();
    const onSigint = () => abort.abort();
    process.on("SIGINT", onSigint);

    try {
      const turnUsage = await runAgentLoop(config, messages, permissionManager, abort.signal, settings.hooks);
      sessionUsage.inputTokens += turnUsage.inputTokens;
      sessionUsage.outputTokens += turnUsage.outputTokens;
      statusBar.update(sessionUsage);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        process.stderr.write(dim("\n  Interrupted.\n"));
      } else {
        console.error(red(`\nError: ${err instanceof Error ? err.message : err}`));
      }
      // Remove partial assistant + failed user message
      while (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        messages.pop();
      }
      messages.pop();
    } finally {
      process.removeListener("SIGINT", onSigint);
    }

    // Auto-save after each turn
    await session.save(messages, sessionUsage).catch(() => {});

    console.log(); // blank line after response
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
