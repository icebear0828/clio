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
    description: "Generate CLAUDE.md for the current project",
    source: "builtin",
    promptTemplate: `Generate a CLAUDE.md file for this project. Follow these steps:

1. Read the project structure (package.json, README, src/ layout)
2. Identify the tech stack, build system, and testing framework
3. Generate a concise CLAUDE.md with:
   - Project overview (1-2 sentences)
   - Key commands (build, test, lint)
   - Code conventions and patterns
   - Important file locations
4. Write the file to CLAUDE.md in the project root`,
  },
];
