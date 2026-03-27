import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as readline from "node:readline/promises";
import { apiRequest } from "./client.js";
import { bold, dim, red, green, cyan } from "./render.js";
import type { Config } from "./types.js";

const execAsync = promisify(exec);
const run = (cmd: string) =>
  execAsync(cmd, { cwd: process.cwd(), timeout: 15_000, maxBuffer: 5 * 1024 * 1024 })
    .then((r) => r.stdout.trim());

async function confirm(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(prompt)).trim().toLowerCase();
  } catch {
    return "n";
  } finally {
    rl.close();
  }
}

async function callAPI(config: Config, userContent: string): Promise<string> {
  const body = await apiRequest(config, {
    model: config.model,
    max_tokens: 4096,
    messages: [{ role: "user", content: userContent }],
  });
  return body.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// ─── /commit ───

export async function commitCommand(config: Config): Promise<void> {
  // Check for changes
  const status = await run("git status --porcelain").catch(() => "");
  if (!status) {
    console.log(dim("  Nothing to commit — working tree clean.\n"));
    return;
  }

  // Check staged
  let diff = await run("git diff --cached").catch(() => "");
  if (!diff) {
    console.log(dim("  No staged changes. Staging all modified files..."));
    await run("git add -u");
    diff = await run("git diff --cached").catch(() => "");
    if (!diff) {
      console.log(dim("  Still nothing staged. Use `git add` to stage files.\n"));
      return;
    }
  }

  // Get style reference
  const log = await run("git log --oneline -5").catch(() => "");

  // Generate message
  process.stderr.write(dim("  Generating commit message...\n"));
  const prompt = [
    "Generate a concise git commit message for this diff.",
    "Follow conventional commit style if the repo uses it.",
    "Output ONLY the commit message, no explanation, no quotes, no markdown.",
    "",
    log ? `Recent commits for style reference:\n${log}\n` : "",
    `Diff:\n\`\`\`\n${diff.slice(0, 15000)}\n\`\`\``,
  ].join("\n");

  const message = (await callAPI(config, prompt)).trim();

  // Preview
  console.log(`\n  ${bold("Commit message:")}`);
  console.log(`  ${green(message)}\n`);

  const answer = await confirm(`  ${dim("[Y]es / [e]dit / [n]o")} > `);

  if (answer === "n" || answer === "no") {
    console.log(dim("  Cancelled.\n"));
    return;
  }

  let finalMessage = message;
  if (answer === "e" || answer === "edit") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      finalMessage = (await rl.question(dim("  New message: "))).trim();
    } finally {
      rl.close();
    }
    if (!finalMessage) {
      console.log(dim("  Cancelled.\n"));
      return;
    }
  }

  // Commit
  const escaped = finalMessage.replace(/"/g, '\\"');
  await run(`git commit -m "${escaped}"`);
  console.log(green("  Committed!\n"));
}

// ─── /pr ───

async function detectBaseBranch(): Promise<string> {
  // Try main, then master
  for (const branch of ["main", "master"]) {
    try {
      await run(`git rev-parse --verify ${branch}`);
      return branch;
    } catch { /* not found */ }
  }
  return "main";
}

export async function prCommand(config: Config): Promise<void> {
  const branch = await run("git rev-parse --abbrev-ref HEAD").catch(() => "");
  if (!branch) {
    console.log(red("  Not in a git repository.\n"));
    return;
  }

  const base = await detectBaseBranch();
  if (branch === base) {
    console.log(red(`  Already on ${base}. Create a feature branch first.\n`));
    return;
  }

  // Check gh CLI
  try {
    await run("gh --version");
  } catch {
    console.log(red("  GitHub CLI (gh) not found. Install from https://cli.github.com\n"));
    return;
  }

  // Gather context
  const commits = await run(`git log ${base}..HEAD --oneline`).catch(() => "");
  const diffStat = await run(`git diff ${base}...HEAD --stat`).catch(() => "");
  const diff = await run(`git diff ${base}...HEAD`).catch(() => "");

  if (!commits) {
    console.log(dim(`  No commits ahead of ${base}.\n`));
    return;
  }

  // Generate PR
  process.stderr.write(dim("  Generating PR title and description...\n"));
  const prompt = [
    "Generate a pull request title and body for these changes.",
    "Output format (exactly):",
    "TITLE: <short title under 70 chars>",
    "BODY:",
    "<markdown body with ## Summary and ## Test plan sections>",
    "",
    `Branch: ${branch} → ${base}`,
    `\nCommits:\n${commits}`,
    `\nDiff stat:\n${diffStat}`,
    `\nDiff (truncated):\n\`\`\`\n${diff.slice(0, 12000)}\n\`\`\``,
  ].join("\n");

  const result = await callAPI(config, prompt);

  // Parse title/body
  const titleMatch = result.match(/TITLE:\s*(.+)/);
  const bodyMatch = result.match(/BODY:\s*([\s\S]+)/);
  const title = titleMatch?.[1]?.trim() ?? `${branch}`;
  const body = bodyMatch?.[1]?.trim() ?? result;

  // Preview
  console.log(`\n  ${bold("Title:")} ${title}`);
  console.log(`  ${bold("Body:")}`);
  for (const line of body.split("\n").slice(0, 15)) {
    console.log(`    ${dim(line)}`);
  }
  console.log();

  const answer = await confirm(`  Create PR? ${dim("[Y]es / [n]o")} > `);
  if (answer === "n" || answer === "no") {
    console.log(dim("  Cancelled.\n"));
    return;
  }

  // Push if needed
  try {
    await run(`git rev-parse --abbrev-ref @{upstream}`);
  } catch {
    process.stderr.write(dim(`  Pushing ${branch} to origin...\n`));
    await run(`git push -u origin ${branch}`);
  }

  // Create PR
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedBody = body.replace(/"/g, '\\"').replace(/`/g, "\\`");
  const prUrl = await run(`gh pr create --title "${escapedTitle}" --body "${escapedBody}"`);
  console.log(green(`  PR created: ${prUrl}\n`));
}

// ─── /review ───

export async function reviewCommand(config: Config): Promise<string | null> {
  const staged = await run("git diff --cached").catch(() => "");
  const unstaged = await run("git diff").catch(() => "");
  const diff = staged + (staged && unstaged ? "\n" : "") + unstaged;

  if (!diff) {
    console.log(dim("  No changes to review.\n"));
    return null;
  }

  const fileCount = (await run("git diff --name-only").catch(() => "")).split("\n").filter(Boolean).length
    + (await run("git diff --cached --name-only").catch(() => "")).split("\n").filter(Boolean).length;

  // Return a prompt to inject into conversation
  return [
    `Review this code diff (${fileCount} files changed). Look for:`,
    "- Bugs and logic errors",
    "- Security issues",
    "- Performance problems",
    "- Code quality and readability",
    "- Missing error handling",
    "",
    "Be specific with file:line references. Prioritize issues by severity.",
    "",
    "```diff",
    diff.slice(0, 20000),
    "```",
  ].join("\n");
}
