# Clio — Claude Code CLI

A feature-rich Claude Code clone that runs in your terminal. Connects to the Anthropic API (or any compatible endpoint) and provides an interactive agentic coding assistant with local tool execution.

28 source files, ~5900 lines of TypeScript. Zero external runtime dependencies beyond `fast-glob`.

## Quick Start

```bash
# Install dependencies
npm install

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-xxx

# Run directly (no build needed)
cd your-project
npx tsx /path/to/clio/src/index.ts

# Or build first
npx tsc
node dist/index.js
```

## Features

- **Agent Loop** — Multi-turn tool calling: Claude reads files, writes code, runs commands, iterates until done
- **16 Tools** — Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode, TaskCreate/Update/List/Get
- **Streaming** — Real-time markdown rendering with syntax-highlighted code blocks, headers, lists, inline formatting
- **Prompt Caching** — `cache_control` on system prompt, tools, and message history for ~90% input token savings
- **Model-aware Context** — Dynamic context limits per model (opus 1M, sonnet/haiku 200k), auto-compact at 85%
- **Permissions** — Three modes (default/auto/plan), Y/n/a prompts, regex allow + deny rules, auto classifier, Shift+Tab to cycle
- **Context** — Auto-loads CLAUDE.md files (upward traversal) + git branch/status/commits into system prompt
- **Sessions** — Auto-save conversations, resume with `--resume <id>`, fork with `--fork-session <id>`
- **Git Workflow** — `/commit`, `/pr`, `/review` commands with AI-generated messages
- **MCP Support** — JSON-RPC 2.0 over stdio, server lifecycle management, tool discovery with `mcp__` prefix
- **Custom Agents** — Define agents in `.clio/agents/*.md` with front-matter (tools, model, max_iterations)
- **Background Agents** — `run_in_background` for async sub-agent execution with completion notifications
- **Worktree Isolation** — Run sub-agents in isolated git worktrees
- **Extended Thinking** — Show Claude's reasoning process with `--thinking`
- **Image Input** — Paste image file paths to send screenshots to Claude
- **Hooks** — Pre/post tool execution hooks via settings.json with env vars and tool filtering
- **Status Bar** — Configurable bottom bar (model/tokens/cost/mode/verbose/session)
- **Syntax Highlighting** — Language-aware coloring for TS/JS/Python/Rust/Go/Bash/JSON/CSS/HTML
- **Undo/Redo** — Ctrl+Z / Ctrl+Shift+Z in input with snapshot-based undo stack
- **Checkpoint Rollback** — Esc-Esc to restore files modified by Write/Edit
- **Task Management** — TaskCreate/Update/List/Get for tracking multi-step workflows
- **Smart Truncation** — Grep pagination (head_limit/offset), Bash output capped at 500 lines, Glob pagination
- **Cost Tracking** — `/cost` command + status bar with per-model USD pricing
- **OpenAI Compatibility** — `--api-format openai` for any OpenAI-compatible endpoint

## Configuration

### CLI Flags

```
--api-url <url>          API base URL (default: https://api.anthropic.com)
--api-key <key>          API key
--api-format <fmt>       anthropic | openai (default: anthropic)
--model <model>          Model name (default: claude-sonnet-4-20250514)
--resume <id>            Resume a previous session
--fork-session <id>      Fork from an existing session
--thinking <tokens>      Enable extended thinking with token budget
--permission-mode <mode> default | auto | plan
--allow <pattern>        Auto-allow Bash commands matching glob pattern (repeatable)
--deny <pattern>         Always deny Bash commands matching pattern (repeatable)
--allow-outside-cwd      Allow file tools to access paths outside working directory
--dangerously-skip-permissions  Allow all tools without prompting
--no-color               Disable colored output
--version                Show version
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_BASE_URL` | Custom API base URL |
| `CLIO_API_KEY` | Gateway API key (alternative) |
| `CLIO_API_URL` | Gateway URL (alternative) |
| `CLIO_MODEL` | Default model |
| `NO_COLOR` | Disable colored output |

### Settings Files

4-level hierarchy (later overrides earlier):

```
~/.clio/settings.json           Global config (shared across projects)
~/.clio/settings.local.json     Global secrets (gitignored — API keys)
.clio/settings.json             Project config (committed, team-shared)
.clio/settings.local.json       Project secrets (gitignored, personal)
```

Example `~/.clio/settings.json`:

```json
{
  "model": "claude-sonnet-4-20250514",
  "permissionMode": "default",
  "allowRules": ["npm *", "git *", "pnpm *"],
  "denyRules": ["rm -rf *"],
  "thinkingBudget": 0,
  "allowOutsideCwd": false,
  "hooks": {
    "pre": [
      { "command": "echo $CLIO_TOOL_NAME", "tools": ["Bash"], "timeout": 5000 }
    ]
  },
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  }
}
```

Arrays (`allowRules`, `denyRules`, `hooks.pre`, `hooks.post`) concatenate across layers. Scalars override.

## Commands

| Command | Description |
|---------|-------------|
| `/btw` | Quick side question without derailing main conversation |
| `/clear` | Reset conversation |
| `/commit` | Generate commit message and commit staged changes |
| `/compact` | Compress conversation context to reduce token usage |
| `/context` | Show context window analysis (tokens by category, capacity bar) |
| `/cost` | Show session token usage and USD cost |
| `/doctor` | System health check (git, node, API, settings, working dir) |
| `/exit` | Save session and quit |
| `/help` | Show command list and keyboard shortcuts |
| `/init` | Scan project and generate CLAUDE.md |
| `/model [name]` | Show or switch model |
| `/pr` | Generate PR title/body and create via `gh` |
| `/review` | Code review current git diff |
| `/sessions` | List saved sessions |
| `/settings` | Show settings file hierarchy and merged config |
| `/theme` | Cycle through three output themes |
| `/quit` | Quit (alias for /exit) |

## Input

| Key | Action |
|-----|--------|
| `Enter` | Submit input |
| `Ctrl+J` / `Shift+Enter` | Insert newline (multi-line input) |
| `Up` / `Down` | Command history (single-line) / cursor navigation (multi-line) |
| `Tab` | Complete `/` commands or `@file` references |
| `Ctrl+R` | Reverse history search |
| `Ctrl+A` / `Ctrl+E` | Move to start / end of line |
| `Ctrl+W` | Delete word backward |
| `Ctrl+K` | Kill to end of line |
| `Ctrl+U` | Kill to start of line |
| `Ctrl+Y` | Yank (paste from kill ring) |
| `Ctrl+Z` | Undo last input change |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+L` | Clear screen |
| `Ctrl+O` | Toggle verbose mode |
| `Shift+Tab` | Cycle permission mode (default → auto → plan) |
| `Ctrl+Left/Right` | Move by word |
| `Home` / `End` | Move to start / end of line |
| `Escape` | Cancel generation or close menu |
| `Escape Escape` | Rollback last checkpoint (undo Write/Edit changes) |
| `Ctrl+C` | Cancel input or interrupt running request |
| `Ctrl+D` | Exit (on empty line) |
| Paste | Multi-line paste auto-detected |

## Tools

| Tool | Category | Description |
|------|----------|-------------|
| Read | safe | Read files with line numbers, offset/limit support |
| Glob | safe | Fast file pattern matching with head_limit/offset pagination |
| Grep | safe | Regex search with output_mode, head_limit, context lines, type/glob filter, multiline, case-insensitive |
| WebFetch | safe | Fetch URLs, HTML auto-stripped to text (50k char default) |
| WebSearch | safe | DuckDuckGo web search with configurable result limit |
| AskUserQuestion | safe | Prompt user for input during agent execution |
| EnterPlanMode | safe | Switch to read-only mode for exploration |
| ExitPlanMode | safe | Restore previous permission mode |
| TaskCreate | safe | Create a task for progress tracking |
| TaskUpdate | safe | Update task status or add progress note |
| TaskList | safe | List all tasks with statuses |
| TaskGet | safe | Get task details including progress messages |
| Write | write | Create/overwrite files (auto-creates parent dirs) |
| Edit | write | Exact string replacement with uniqueness check |
| Bash | dangerous | Execute shell commands (120s timeout, 10MB buffer, 500-line truncation) |
| Agent | dangerous | Spawn sub-agents with optional worktree isolation and background execution |

**Permission modes:**
- `default` — Safe tools auto-allowed, dangerous/write tools prompt Y/n/a
- `auto` — All tools auto-allowed (no prompts), with deny rule enforcement
- `plan` — Safe tools allowed, dangerous/write silently denied

**Allow/Deny rules** match Bash commands with glob patterns:
```bash
clio --allow "npm *" --allow "git status" --deny "rm -rf *"
```

## Custom Agents

Define reusable agent configurations in `.clio/agents/`:

```markdown
<!-- .clio/agents/reviewer.md -->
---
tools: Read, Grep, Glob
model: claude-sonnet-4-20250514
max_iterations: 10
---

You are a code reviewer. Analyze the codebase for bugs, security issues, and style problems.
```

Use via the Agent tool with `subagent_type: "reviewer"`.

## MCP Servers

Configure Model Context Protocol servers in settings.json:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-filesystem"]
    }
  }
}
```

MCP tools appear with `mcp__<server>__<tool>` prefix and are automatically discovered at startup.

## Hooks

Configure in settings.json to run shell commands before/after tool execution:

```json
{
  "hooks": {
    "pre": [
      { "command": "./validate.sh", "tools": ["Write", "Edit"], "timeout": 5000 }
    ],
    "post": [
      { "command": "echo done >> /tmp/clio.log" }
    ]
  }
}
```

- **Pre-hooks**: Non-zero exit blocks tool execution
- **Post-hooks**: Non-zero exit logged as warning, doesn't block
- **Environment**: `CLIO_TOOL_NAME`, `CLIO_TOOL_INPUT` (JSON), `CLIO_HOOK_PHASE`
- **Scope**: `tools` array limits which tools trigger the hook (empty = all)

## Connection Modes

```bash
# Direct Anthropic API (default)
export ANTHROPIC_API_KEY=sk-ant-xxx
clio

# OpenAI-compatible endpoint
clio --api-url https://my-proxy.com --api-key sk-xxx --api-format openai

# Custom gateway
clio --api-url http://localhost:3000 --api-key sk-xxx
```

## Sessions

Conversations auto-save to `~/.clio/sessions/{id}.json` after each turn.

```bash
# List recent sessions
clio    # then type /sessions

# Resume a session
clio --resume a1b2c3d4

# Fork from existing session
clio --fork-session a1b2c3d4
```

## Project Structure

```
src/
├── index.ts                  Entry point, REPL, command routing (17 slash commands)
├── types.ts                  Shared TypeScript types
├── core/
│   ├── agent.ts              Core agent loop with prompt caching + model-aware context
│   ├── client.ts             SSE streaming client (Anthropic + OpenAI format)
│   ├── compact.ts            Conversation summarization via API
│   ├── context.ts            System prompt (environment, git, CLAUDE.md upward traversal)
│   ├── permissions.ts        Permission system (3 modes, allow/deny rules, auto classifier)
│   ├── pricing.ts            Per-model USD cost estimation
│   ├── session.ts            Session persistence + fork (~/.clio/sessions/)
│   └── settings.ts           4-level settings hierarchy + merge
├── tools/
│   ├── index.ts              16 tool definitions + local execution + truncation
│   ├── checkpoint.ts         File snapshot + rollback for Write/Edit
│   ├── hooks.ts              Pre/post tool execution hooks
│   ├── mcp.ts                MCP client (JSON-RPC 2.0 over stdio)
│   ├── subagent.ts           Sub-agent execution with iteration limit
│   ├── tasks.ts              Task store for progress tracking
│   └── worktree.ts           Git worktree create/cleanup for isolated agents
├── ui/
│   ├── render.ts             ANSI colors, spinner, diff display, tool-specific rendering
│   ├── input.ts              Raw-mode terminal input (history, paste, tab, undo/redo)
│   ├── markdown.ts           Streaming markdown → ANSI renderer
│   ├── highlight.ts          Syntax highlighting (10 languages)
│   ├── statusbar.ts          Configurable bottom status bar
│   ├── image.ts              Image file detection + base64 encoding
│   └── file-completions.ts   @file Tab completion (fast-glob scan)
└── commands/
    ├── git-commands.ts        /commit, /pr, /review implementations
    ├── doctor.ts              /doctor system health checks
    ├── init.ts                CLAUDE.md generation from project scan
    └── custom-agents.ts       .clio/agents/*.md loader with front-matter parsing
```

## License

MIT
