# c2a — Claude Code CLI

A Claude Code clone that runs in your terminal. Connects to the Anthropic API (or any compatible endpoint) and provides an interactive agentic coding assistant with local tool execution.

## Quick Start

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-ant-xxx

# Run directly (no build needed)
cd your-project
npx tsx /path/to/apps/cli/src/index.ts

# Or build first
pnpm build
node dist/index.js
```

## Features

- **Agent Loop** — Multi-turn tool calling: Claude reads files, writes code, runs commands, iterates until done
- **7 Tools** — Read, Write, Edit, Bash, Glob, Grep, WebFetch — all executed locally
- **Streaming** — Real-time markdown rendering with code blocks, headers, lists, inline formatting
- **Permissions** — Three modes (default/auto/plan), Y/n/a prompts, regex allow rules
- **Context** — Auto-loads CLAUDE.md files + git branch/status/commits into system prompt
- **Sessions** — Auto-save conversations, resume with `--resume <id>`
- **Git Workflow** — `/commit`, `/pr`, `/review` commands with AI-generated messages
- **Extended Thinking** — Show Claude's reasoning process with `--thinking`
- **Image Input** — Paste image file paths to send screenshots to Claude
- **Hooks** — Pre/post tool execution hooks via settings.json
- **Status Bar** — Persistent bottom bar showing model, token count, session ID

## Configuration

### CLI Flags

```
--api-url <url>          API base URL (default: https://api.anthropic.com)
--api-key <key>          API key
--model <model>          Model name (default: claude-sonnet-4-20250514)
--resume <id>            Resume a previous session
--thinking <tokens>      Enable extended thinking with token budget
--permission-mode <mode> default | auto | plan
--allow <pattern>        Auto-allow Bash commands matching glob pattern (repeatable)
--allow-outside-cwd      Allow file tools to access paths outside working directory
--dangerously-skip-permissions  Allow all tools without prompting
--no-color               Disable colored output
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_BASE_URL` | Custom API base URL |
| `CLAUDE2API_KEY` | Gateway API key (alternative) |
| `CLAUDE2API_URL` | Gateway URL (alternative) |
| `CLAUDE2API_MODEL` | Default model |
| `NO_COLOR` | Disable colored output |

### Settings Files

4-level hierarchy (later overrides earlier):

```
~/.c2a/settings.json           Global config (shared across projects)
~/.c2a/settings.local.json     Global secrets (gitignored — API keys)
.c2a/settings.json             Project config (committed, team-shared)
.c2a/settings.local.json       Project secrets (gitignored, personal)
```

Example `~/.c2a/settings.json`:

```json
{
  "model": "claude-sonnet-4-20250514",
  "permissionMode": "default",
  "allowRules": ["npm *", "git *", "pnpm *"],
  "thinkingBudget": 0,
  "allowOutsideCwd": false,
  "hooks": {
    "pre": [
      { "command": "echo $C2A_TOOL_NAME", "tools": ["Bash"], "timeout": 5000 }
    ]
  }
}
```

Example `~/.c2a/settings.local.json` (gitignored):

```json
{
  "apiKey": "sk-ant-xxxxx"
}
```

Arrays (`allowRules`, `hooks.pre`, `hooks.post`) concatenate across layers. Scalars override.

## Commands

| Command | Description |
|---------|-------------|
| `/clear` | Reset conversation |
| `/commit` | Generate commit message and commit staged changes |
| `/compact` | Compress conversation context to reduce token usage |
| `/cost` | Show session token usage |
| `/exit` | Save session and quit |
| `/help` | Show command list |
| `/init` | Scan project and generate CLAUDE.md |
| `/model [name]` | Show or switch model |
| `/pr` | Generate PR title/body and create via `gh` |
| `/review` | Code review current git diff |
| `/sessions` | List saved sessions |
| `/settings` | Show settings file hierarchy and merged config |

## Input

| Key | Action |
|-----|--------|
| `Enter` | Submit input |
| `\` at end of line | Continue on next line |
| `Up` / `Down` | Command history |
| `Tab` | Complete `/` commands |
| `Ctrl+C` | Cancel input or interrupt running request |
| `Ctrl+D` | Exit (on empty line) |
| Paste | Multi-line paste auto-detected and submitted |

## Tools

| Tool | Category | Description |
|------|----------|-------------|
| Read | safe | Read files with line numbers, offset/limit support |
| Glob | safe | Fast file pattern matching (ignores node_modules/.git) |
| Grep | safe | Regex search across files or directories (max 300 matches) |
| WebFetch | safe | Fetch URLs, HTML auto-converted to text |
| Write | write | Create/overwrite files (auto-creates parent dirs) |
| Edit | write | Exact string replacement with uniqueness check |
| Bash | dangerous | Execute shell commands (120s timeout, 10MB buffer) |

**Permission modes:**
- `default` — Safe tools auto-allowed, dangerous/write tools prompt Y/n/a
- `auto` — All tools auto-allowed (no prompts)
- `plan` — Safe tools allowed, dangerous/write silently denied

**Allow rules** match Bash commands with glob patterns:
```bash
c2a --allow "npm *" --allow "git status"
```

**Workspace restriction** — Read/Write/Edit are restricted to the current working directory subtree. Use `--allow-outside-cwd` to override.

## Hooks

Configure in settings.json to run shell commands before/after tool execution:

```json
{
  "hooks": {
    "pre": [
      { "command": "./validate.sh", "tools": ["Write", "Edit"], "timeout": 5000 }
    ],
    "post": [
      { "command": "echo done >> /tmp/c2a.log" }
    ]
  }
}
```

- **Pre-hooks**: Non-zero exit blocks tool execution
- **Post-hooks**: Non-zero exit logged as warning, doesn't block
- **Environment**: `C2A_TOOL_NAME`, `C2A_TOOL_INPUT` (JSON), `C2A_HOOK_PHASE`
- **Scope**: `tools` array limits which tools trigger the hook (empty = all)

## Connection Modes

```bash
# Direct Anthropic API (default)
export ANTHROPIC_API_KEY=sk-ant-xxx
c2a

# Custom proxy / OpenAI-compatible endpoint
c2a --api-url https://my-proxy.com --api-key sk-xxx

# claude2api gateway
c2a --api-url http://localhost:3000 --api-key sk-c2a-xxx
```

## Sessions

Conversations auto-save to `~/.c2a/sessions/{id}.json` after each turn.

```bash
# List recent sessions
c2a    # then type /sessions

# Resume a session
c2a --resume a1b2c3d4
```

## Project Structure

```
src/
├── index.ts        Entry point, REPL, command routing
├── agent.ts        Core agent loop (stream → parse → execute → loop)
├── client.ts       SSE streaming client with retry + timeout
├── tools.ts        7 tool definitions + local execution
├── permissions.ts  Permission system (modes, allow rules, prompts)
├── context.ts      System prompt (environment, git, CLAUDE.md)
├── markdown.ts     Streaming markdown → ANSI renderer
├── input.ts        Raw-mode terminal input (history, paste, tab)
├── render.ts       ANSI color helpers, spinner, diff display
├── hooks.ts        Pre/post tool execution hooks
├── image.ts        Image file detection + base64 encoding
├── session.ts      Session persistence (~/.c2a/sessions/)
├── settings.ts     4-level settings hierarchy
├── statusbar.ts    Bottom status bar (ANSI scroll region)
├── compact.ts      Conversation summarization
├── init.ts         CLAUDE.md generation from project scan
├── git-commands.ts /commit, /pr, /review implementations
└── types.ts        Shared TypeScript types
```

## Architecture Docs

Detailed implementation documentation in [`docs/`](docs/):

- [architecture.md](docs/architecture.md) — Module graph, request lifecycle, data structures
- [core-loop.md](docs/core-loop.md) — Agent loop, SSE protocol, tool pipeline
- [terminal-io.md](docs/terminal-io.md) — Raw mode input, markdown rendering, status bar
- [permissions-tools.md](docs/permissions-tools.md) — Permission model, tool implementations, hooks
- [context-session.md](docs/context-session.md) — CLAUDE.md loading, git context, sessions, settings
