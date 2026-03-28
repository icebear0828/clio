import type { SkillDefinition } from "../index.js";

export const builtinSkills: SkillDefinition[] = [
  {
    name: "commit",
    description: "Generate a git commit message and commit staged changes",
    source: "builtin",
    promptTemplate: `You are helping the user create a git commit. Follow these steps:

1. Run \`git status\` to see all untracked files (never use -uall flag)
2. Run \`git diff\` to see both staged and unstaged changes
3. Run \`git log --oneline -5\` to see recent commit message style
4. Analyze the changes and draft a concise commit message
5. Stage relevant files with \`git add\` (prefer specific files over \`git add -A\`)
6. Create the commit with the message ending with:
   Co-Authored-By: Claude <noreply@anthropic.com>
7. Run \`git status\` to verify success

Do not push. Do not skip hooks (--no-verify).`,
  },
  {
    name: "pr",
    description: "Create a pull request with auto-generated title and description",
    source: "builtin",
    promptTemplate: `You are helping the user create a pull request. Follow these steps:

1. Run \`git status\` and \`git log --oneline -10\` to understand current branch state
2. Determine the base branch (main or master)
3. Run \`git diff <base>...HEAD\` to see all changes
4. Draft a PR title (under 70 chars) and body with:
   ## Summary
   <bullet points>
   ## Test plan
   <checklist>
5. Push the branch if needed (\`git push -u origin HEAD\`)
6. Create the PR using \`gh pr create --title "..." --body "..."\`
7. Return the PR URL`,
  },
  {
    name: "review",
    description: "Code review current git diff for bugs and issues",
    source: "builtin",
    promptTemplate: `Review the current code changes for issues. Follow these steps:

1. Run \`git diff\` to see unstaged changes, or \`git diff --cached\` for staged changes
2. Analyze the diff for:
   - Bugs and logic errors
   - Security vulnerabilities (injection, XSS, etc.)
   - Performance issues
   - Missing error handling at system boundaries
   - Style inconsistencies
3. Provide a structured review with specific line references
4. Rate overall quality and suggest concrete improvements`,
  },
  {
    name: "init",
    description: "Generate AGENTS.md for the current project",
    source: "builtin",
    promptTemplate: `Generate an AGENTS.md file for this project. Follow these steps:

1. Read the project structure (package.json, README, src/ layout)
2. Identify the tech stack, build system, and testing framework
3. Generate a concise AGENTS.md with:
   - Project overview (1-2 sentences)
   - Key commands (build, test, lint)
   - Code conventions and patterns
   - Important file locations
4. Write the file to AGENTS.md in the project root`,
  },
  {
    name: "simplify",
    description: "Review changed code for reuse, quality, and efficiency, then fix any issues found",
    source: "builtin",
    promptTemplate: `Review the recently changed code for opportunities to simplify and improve. Follow these steps:

1. Run \`git diff\` to see current changes, or \`git diff HEAD~1\` if nothing is staged
2. For each changed file, analyze:
   - Code duplication — can anything be reused or consolidated?
   - Unnecessary complexity — can the logic be simplified?
   - Dead code — are there unused imports, variables, or functions?
   - Efficiency — are there obvious performance improvements?
   - Consistency — does the code follow the patterns used elsewhere in the project?
3. Apply fixes directly using Edit — don't just suggest, actually make the changes
4. After fixing, run any available test commands to verify nothing is broken
5. Summarize what was simplified and why`,
  },
  {
    name: "loop",
    description: "Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)",
    source: "builtin",
    trigger: "user wants to set up a recurring task, poll for status, or run something repeatedly on an interval",
    promptTemplate: `Set up a recurring execution loop. Parse the user's request: {{args}}

Expected format: /loop [interval] [command or prompt]
- interval: e.g. "5m", "30s", "1h" (default: 10m)
- command: a slash command like /commit or a natural language prompt

Create a script that:
1. Runs the specified command/prompt at the given interval
2. Logs each execution with timestamp
3. Can be stopped with Ctrl+C
4. Shows a countdown between executions

Use Bash to set up and run the loop.`,
  },
  {
    name: "schedule",
    description: "Create, list, or manage scheduled tasks that run on a cron schedule",
    source: "builtin",
    trigger: "user wants to schedule a recurring task, set up a cron job, or manage scheduled agents",
    promptTemplate: `Help the user manage scheduled tasks. Parse: {{args}}

Commands:
- /schedule create "description" --cron "*/5 * * * *" -- command
- /schedule list
- /schedule delete <id>

For create:
1. Parse the cron expression and command
2. Set up a cron job using the system cron (crontab -e on Unix)
3. Confirm the schedule and next run time

For list:
1. Show all scheduled tasks with their cron expressions and next run times

For delete:
1. Remove the specified scheduled task`,
  },
  {
    name: "update-config",
    description: "Configure Claude Code settings via settings.json. Use for hooks, permissions, and automated behaviors",
    source: "builtin",
    trigger: "user wants to configure settings, add hooks, change permissions, or set up automated behaviors",
    promptTemplate: `Help the user update their Claude Code configuration. Parse: {{args}}

Settings files (4-level hierarchy):
- ~/.clio/settings.json (global)
- ~/.clio/settings.local.json (global secrets, gitignored)
- .clio/settings.json (project, committed)
- .clio/settings.local.json (project secrets, gitignored)

Available settings:
- model: default model name
- permissionMode: "default" | "auto" | "plan"
- allowRules: string[] — glob patterns for auto-allowed Bash commands
- denyRules: string[] — glob patterns for always-denied Bash commands
- thinkingBudget: number — extended thinking token budget (0 = disabled)
- allowOutsideCwd: boolean — allow file access outside working directory
- hooks: { pre: HookConfig[], post: HookConfig[] } — tool execution hooks
- mcpServers: { [name]: { command, args, env? } } — MCP server configs
- lspServers: { [name]: { command, args, rootUri? } } — LSP server configs
- statusBar: { fields: string[] } — status bar field configuration
- sandbox: { allowedPaths?, deniedEnvVars?, network?, resourceLimits? }
- autoClassifier: { enabled, safePatterns?, dangerousPatterns?, llmClassifier? }

For automated behaviors ("from now on when X", "each time X", "whenever X"):
These require hooks in settings.json. Create appropriate pre/post hooks.

1. Read the relevant settings file
2. Apply the requested changes
3. Write back the file
4. Confirm what was changed`,
  },
];
