#!/usr/bin/env node
/**
 * A/B Benchmark: Clio vs Claude Code
 *
 * Usage: node benchmark/run.mjs [--runs N] [--tasks task1,task2]
 *
 * Expects env vars: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY
 * Clio must be built (dist/index.js).
 * Claude Code CLI (`claude`) must be on PATH.
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// ── Config ──
const args = process.argv.slice(2);
let RUNS = 3;
let taskFilter = null;
let clioApiFormat = "anthropic";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--runs" && args[i + 1]) RUNS = parseInt(args[++i], 10);
  if (args[i] === "--tasks" && args[i + 1]) taskFilter = args[++i].split(",");
  if (args[i] === "--clio-format" && args[i + 1]) clioApiFormat = args[++i];
}

// ── Task definitions ──
const TASKS = [
  {
    id: "simple-qa",
    name: "Simple Q&A (no tools)",
    prompt: "What is the capital of France? Reply with just the city name.",
  },
  {
    id: "math",
    name: "Math reasoning",
    prompt: "What is 17 * 23 + 42? Reply with just the number.",
  },
  {
    id: "read-file",
    name: "Read file (Read tool)",
    prompt: "Read the file package.json and tell me the project name. Reply with just the name.",
  },
  {
    id: "search-code",
    name: "Search code (Grep tool)",
    prompt: "Find all TypeScript files under src/ that contain the word 'export'. Just list the file paths, one per line.",
  },
  {
    id: "multi-step",
    name: "Multi-step (Read + analyze)",
    prompt: "Read tsconfig.json and package.json. What TypeScript target and module system does this project use? Reply in one sentence.",
  },
];

const activeTasks = taskFilter
  ? TASKS.filter((t) => taskFilter.includes(t.id))
  : TASKS;

// ── Runners ──

function parseRun(out, elapsed) {
  const json = JSON.parse(out.toString().trim());
  return {
    ok: true,
    result: json.result,
    input_tokens: json.usage?.input_tokens ?? 0,
    output_tokens: json.usage?.output_tokens ?? 0,
    cache_creation: json.usage?.cache_creation_input_tokens ?? 0,
    cache_read: json.usage?.cache_read_input_tokens ?? 0,
    num_turns: json.num_turns ?? 1,
    duration_ms: json.duration_ms ?? Math.round(elapsed),
  };
}

function runClio(prompt) {
  const start = performance.now();
  try {
    const out = execSync(
      `node dist/index.js -p ${shellQuote(prompt)} --output-format json --api-format ${clioApiFormat}`,
      { cwd: projectRoot, timeout: 120_000, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] },
    );
    return parseRun(out, performance.now() - start);
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message, duration_ms: Math.round(performance.now() - start) };
  }
}

function runClaude(prompt) {
  const start = performance.now();
  try {
    const out = execSync(
      `claude -p ${shellQuote(prompt)} --output-format json`,
      { cwd: projectRoot, timeout: 120_000, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] },
    );
    return parseRun(out, performance.now() - start);
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message, duration_ms: Math.round(performance.now() - start) };
  }
}

function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Stats ──

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

// ── Main ──

console.log(`\n╔════════════════════════════════════════════════════╗`);
console.log(`║       A/B Benchmark: Clio vs Claude Code          ║`);
console.log(`╚════════════════════════════════════════════════════╝\n`);
console.log(`  Runs per task: ${RUNS}`);
console.log(`  Clio API format: ${clioApiFormat}`);
console.log(`  Tasks: ${activeTasks.map((t) => t.id).join(", ")}`);
console.log(`  CWD: ${projectRoot}\n`);

const results = [];

for (const task of activeTasks) {
  console.log(`── ${task.name} ──`);
  console.log(`   Prompt: "${task.prompt.slice(0, 60)}${task.prompt.length > 60 ? "..." : ""}"`);

  const clioRuns = [];
  const ccRuns = [];

  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`   Run ${i + 1}/${RUNS}: Clio...`);
    const clioResult = runClio(task.prompt);
    process.stdout.write(` ${clioResult.duration_ms}ms | CC...`);
    const ccResult = runClaude(task.prompt);
    console.log(` ${ccResult.duration_ms}ms`);

    clioRuns.push(clioResult);
    ccRuns.push(ccResult);
  }

  const clioOk = clioRuns.filter((r) => r.ok);
  const ccOk = ccRuns.filter((r) => r.ok);

  const buildStats = (runs) => ({
    success: runs.length,
    total: RUNS,
    duration_median_ms: runs.length ? Math.round(median(runs.map((r) => r.duration_ms))) : null,
    duration_avg_ms: runs.length ? Math.round(avg(runs.map((r) => r.duration_ms))) : null,
    input_tokens_avg: runs.length ? Math.round(avg(runs.map((r) => r.input_tokens))) : null,
    output_tokens_avg: runs.length ? Math.round(avg(runs.map((r) => r.output_tokens))) : null,
    cache_creation_total: runs.length ? sum(runs.map((r) => r.cache_creation)) : 0,
    cache_read_total: runs.length ? sum(runs.map((r) => r.cache_read)) : 0,
    cache_hit_rate: runs.length
      ? (() => {
          const cr = sum(runs.map((r) => r.cache_read));
          const cc = sum(runs.map((r) => r.cache_creation));
          const total = cr + cc;
          return total > 0 ? cr / total : 0;
        })()
      : 0,
    num_turns_avg: runs.length ? +(avg(runs.map((r) => r.num_turns))).toFixed(1) : null,
    sample_result: runs[0]?.result?.slice(0, 200) ?? "(failed)",
  });

  results.push({
    task: task.id,
    name: task.name,
    clio: buildStats(clioOk),
    claude: buildStats(ccOk),
  });

  console.log();
}

// ── Summary table ──
console.log(`\n${"═".repeat(120)}`);
console.log(`  SUMMARY`);
console.log(`${"═".repeat(120)}`);

const header = [
  "Task".padEnd(15),
  "│",
  "Clio ms".padStart(8),
  "in tok".padStart(8),
  "out".padStart(6),
  "cache%".padStart(7),
  "turns".padStart(6),
  "│",
  "CC ms".padStart(8),
  "in tok".padStart(8),
  "out".padStart(6),
  "cache%".padStart(7),
  "turns".padStart(6),
  "│",
  "Δ ms".padStart(7),
  "Δ in".padStart(7),
].join(" ");

console.log(header);
console.log("─".repeat(120));

for (const r of results) {
  const clioCacheP = (r.clio.cache_hit_rate * 100).toFixed(0) + "%";
  const ccCacheP = (r.claude.cache_hit_rate * 100).toFixed(0) + "%";
  const dMs = (r.clio.duration_median_ms ?? 0) - (r.claude.duration_median_ms ?? 0);
  const dIn = (r.clio.input_tokens_avg ?? 0) - (r.claude.input_tokens_avg ?? 0);

  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

  const row = [
    r.task.padEnd(15),
    "│",
    `${r.clio.duration_median_ms ?? "—"}`.padStart(8),
    `${r.clio.input_tokens_avg ?? "—"}`.padStart(8),
    `${r.clio.output_tokens_avg ?? "—"}`.padStart(6),
    clioCacheP.padStart(7),
    `${r.clio.num_turns_avg ?? "—"}`.padStart(6),
    "│",
    `${r.claude.duration_median_ms ?? "—"}`.padStart(8),
    `${r.claude.input_tokens_avg ?? "—"}`.padStart(8),
    `${r.claude.output_tokens_avg ?? "—"}`.padStart(6),
    ccCacheP.padStart(7),
    `${r.claude.num_turns_avg ?? "—"}`.padStart(6),
    "│",
    sign(dMs).padStart(7),
    sign(dIn).padStart(7),
  ].join(" ");

  console.log(row);
}

console.log("─".repeat(120));
console.log(`  Δ = Clio − CC (negative = Clio faster/fewer tokens)`);

// ── Cache detail ──
console.log(`\n  Cache breakdown:`);
console.log(`  ${"Task".padEnd(15)} │ ${"Clio create".padStart(12)} ${"read".padStart(10)} ${"hit%".padStart(6)} │ ${"CC create".padStart(12)} ${"read".padStart(10)} ${"hit%".padStart(6)}`);
console.log(`  ${"─".repeat(85)}`);
for (const r of results) {
  const row = [
    `  ${r.task.padEnd(15)}`,
    "│",
    `${r.clio.cache_creation_total}`.padStart(12),
    `${r.clio.cache_read_total}`.padStart(10),
    `${(r.clio.cache_hit_rate * 100).toFixed(0)}%`.padStart(6),
    "│",
    `${r.claude.cache_creation_total}`.padStart(12),
    `${r.claude.cache_read_total}`.padStart(10),
    `${(r.claude.cache_hit_rate * 100).toFixed(0)}%`.padStart(6),
  ].join(" ");
  console.log(row);
}

// ── Sample results ──
console.log(`\n  Sample outputs:`);
for (const r of results) {
  console.log(`    ${r.task}:`);
  console.log(`      Clio:   ${r.clio.sample_result}`);
  console.log(`      CC:     ${r.claude.sample_result}`);
}

// ── JSON dump ──
const jsonPath = resolve(projectRoot, "benchmark", "results.json");
const fs = await import("node:fs");
fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
console.log(`\n  Full results saved to: ${jsonPath}\n`);
