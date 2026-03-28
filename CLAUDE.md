# Clio — Claude Code CLI Clone

Agentic coding CLI that connects to Anthropic API (or compatible endpoints) to provide a terminal-based Claude Code experience. 47 source files, ~9.7k lines, single runtime dependency (`fast-glob`).

## Quick Reference

```bash
npm run dev              # Run without build (tsx)
npm run build            # Compile TypeScript
npm run test             # Run all tests (vitest)
npm run test -- --watch  # Watch mode
npm run test -- tests/permissions.test.ts  # Single file
```

## Architecture

```
src/
├── index.ts              # Entry: REPL loop, command routing, print mode (-p)
├── types.ts              # Shared types (Config, Message, ContentBlock, UsageStats)
├── core/                 # Engine (18 files)
│   ├── agent.ts          # Agent loop (25 max iterations, auto-compact at 85%)
│   ├── client.ts         # HTTP client (SSE streaming, retry 429/502/503/504)
│   ├── system-prompt.ts  # 14-section system prompt builder
│   ├── section-cache.ts  # Static sections cached per session, dynamic recomputed
│   ├── context.ts        # CLAUDE.md upward traversal + git context
│   ├── settings.ts       # 4-layer config merge (global → project × committed/local)
│   ├── permissions.ts    # 3 modes (default/auto/plan) + allow/deny rules
│   ├── llm-classifier.ts # 2-stage: pattern match → LLM fallback
│   ├── session.ts        # Session persistence (~/.clio/sessions/)
│   ├── compact.ts        # Context compaction via summarization
│   ├── normalize.ts      # Message normalization (tool pairing, thinking blocks)
│   ├── memory.ts         # Auto memory (4 types, MEMORY.md index)
│   ├── adaptive-thinking.ts # Dynamic thinking budget
│   ├── pricing.ts        # Model pricing tables
│   ├── sandbox.ts        # Path/network/env sandboxing
│   ├── billing.ts        # Billing header for CC compatibility
│   └── prompts.ts        # Prompt templates
├── tools/                # Tool system (9 files)
│   ├── index.ts          # 21 tool definitions + executeTool() dispatcher
│   ├── mcp.ts            # MCP server lifecycle (JSON-RPC 2.0, zero deps)
│   ├── lsp.ts            # LSP client (Content-Length framing, zero deps)
│   ├── subagent.ts       # Sub-agent spawning (foreground/background/worktree)
│   ├── teams.ts          # Agent team coordination + SendMessage
│   ├── hooks.ts          # Pre/post tool hooks (shell commands)
│   ├── tasks.ts          # In-memory task store
│   ├── checkpoint.ts     # File undo/rollback
│   └── worktree.ts       # Git worktree isolation
├── ui/                   # Terminal UI (8 files)
│   ├── render.ts         # ANSI colors, spinners, box drawing
│   ├── input.ts          # Raw stdin, CSI parsing, undo/redo, history
│   ├── markdown.ts       # Streaming markdown renderer
│   ├── highlight.ts      # Syntax highlighting (TS/JS/Python/Rust/Go/Bash/JSON/CSS/HTML)
│   ├── statusbar.ts      # Footer bar (model, tokens, cost)
│   ├── keybindings.ts    # Keyboard shortcuts
│   ├── image.ts          # Image detection + base64 encoding
│   └── file-completions.ts # @file tab completion
├── commands/             # Slash commands (4 files)
│   ├── git-commands.ts   # /commit /pr /review
│   ├── init.ts           # /init (generate CLAUDE.md)
│   ├── doctor.ts         # /doctor (diagnostics)
│   └── custom-agents.ts  # Agent definition loading (.md files)
├── plugins/              # Plugin system (4 files)
│   ├── types.ts, manifest.ts, loader.ts, index.ts
└── skills/               # Skills system (3 files)
    ├── index.ts, loader.ts, builtins/index.ts
```

## Key Patterns

### Config hierarchy (settings.ts)
`~/.clio/settings.json` → `~/.clio/settings.local.json` → `.clio/settings.json` → `.clio/settings.local.json`
- Arrays (allowRules, denyRules, hooks) concatenate
- Objects (mcpServers, lspServers) shallow merge
- Scalars override

### Tool registration (tools/index.ts)
Tools are objects in `TOOL_DEFINITIONS[]` with `{ name, description, input_schema }`. Execution via `executeTool(name, input)`. Add new tools by appending to the array and adding a case in the dispatcher.

### System prompt (system-prompt.ts + section-cache.ts)
10 static sections (cached per session) + 4 dynamic sections (recomputed per turn). Reference text: `docs/cc-system-prompt.md`.

### Imports
- Node APIs: `import * as fs from "node:fs/promises"`
- Local: `import { foo } from "./bar.js"` (**.js extension required** for ESM)
- Types: `import type { X } from "../types.js"`

### Error handling
- I/O: try-catch, return null on failure
- Tools: return `{ is_error: true, content: "..." }`
- Network: exponential backoff for 429/502/503/504

## Code Rules

- **TypeScript strict mode** — no `any` (including `as any`, `: any`, `<any>`)
- **Single runtime dependency** — only `fast-glob`. Do not add new deps without discussion
- **ESM** — `"type": "module"` in package.json, `.js` extensions in imports
- **No unnecessary additions** — no docstrings, comments, or type annotations on unchanged code
- After renaming/deleting a symbol, grep `src/` and `tests/` to confirm zero residual references

## Self-iteration Workflow

This project is designed to be modified by Clio itself (dogfooding). Hooks in `.clio/settings.json` provide automated guardrails.

### Automated hooks (enforced by `.clio/settings.json`)
- **After every Edit/Write on `.ts`**: `scripts/tsc-gate.sh` runs `tsc --noEmit`. If it fails, the error output is appended to the tool result — you will see it.
- **After every Write**: `scripts/test-gate.sh` runs `npm test`. If tests fail, the failure output is appended — you will see it.

### Edit loop
1. **Read before edit** — understand the module and its callers
2. **Edit** — hook auto-runs tsc, you see errors inline
3. **If tsc fails** — fix the type errors immediately. Do NOT move to another file until tsc passes
4. **If tests fail** — fix the failing tests. Do NOT move on until green
5. **Grep for residuals** — after rename/delete, confirm zero stale references

### Recovery rules (CRITICAL)
- **3-strike rule**: if you fail to fix the same tsc/test error after 3 attempts, STOP and rollback. Use the checkpoint system (`/undo` command) to restore the file to its pre-edit state, then re-plan a different approach.
- **Never leave broken state**: if you are about to hit the iteration limit (25 turns) and tsc/tests are still failing, rollback all changes rather than leaving broken code.
- **Build verification**: after a complex change, run `npm run build && npm run dev -- --version` to verify the CLI still starts.
- **Scope discipline**: change one module at a time. Verify tsc+tests pass before moving to the next module.

### Git workflow (autonomous)
After completing a change with tsc+tests green:
1. `git checkout -b feat/<short-description>` — create feature branch
2. `git add <specific files>` — stage only changed files, never `git add -A`
3. `git commit -m "type: description"` — conventional commit message in English
4. `git push -u origin feat/<short-description>`
5. `gh pr create --title "..." --body "..."` — create PR against master
6. **Self-review via sub-agent**: spawn a sub-agent with the Agent tool to review the PR:
   - Prompt: `Review PR #<number> in this repo. Run "gh pr diff <number>" to read the changes. Check for: type errors, logic bugs, security issues, missing tests, style violations. If the PR is acceptable, run "gh pr review <number> --approve". If not, run "gh pr review <number> --request-changes --body '<issues>'" and report back.`
   - Agent type: `general-purpose`
7. If review agent approves → `gh pr merge <number> --squash --delete-branch`
8. If review agent requests changes → fix issues, push, re-request review

**NEVER push directly to master or main. All changes go through PRs.**

### When adding a new module
- Add the file under the appropriate directory (`core/`, `tools/`, `ui/`, etc.)
- Export from the module, import with `.js` extension
- Add a corresponding `tests/{module}.test.ts`
- Run full `npm test` to verify

### When modifying tools/index.ts
- Tool changes affect the agent loop — always run `npm run build` after and verify no runtime errors with `npm run dev -- --version`

## Testing

- Framework: vitest 4.x
- Location: `tests/{module}.test.ts`
- Pattern: `describe()` + `it()` with arrow functions, AAA style
- Mocking: `vi.spyOn()`, restore after each test
- **After any code change**: `npm test` to verify all 220+ tests pass
- **After changing a specific module**: `npm test -- tests/{module}.test.ts` for fast feedback

## Config Paths

| Scope | Committed | Local (gitignored) |
|-------|-----------|-------------------|
| Global | `~/.clio/settings.json` | `~/.clio/settings.local.json` |
| Project | `.clio/settings.json` | `.clio/settings.local.json` |

Environment variables: `CLIO_API_KEY`, `CLIO_API_URL`, `CLIO_MODEL`

## Docs

- `docs/cc-system-prompt.md` — Claude Code v2.1.86 system prompt (reference)
- `docs/cc-clio-diff.md` — Section-by-section diff vs CC
- `docs/architecture.md` — Module dependency graph
