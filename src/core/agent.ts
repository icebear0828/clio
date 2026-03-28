import { streamRequest } from "./client.js";
import { compactConversation } from "./compact.js";
import { executeTool, buildToolsForRequest, DEFERRED_TOOL_NAMES } from "../tools/index.js";
import { getMcpToolDefinitions } from "../tools/mcp.js";
import { renderToolCall, renderToolResult, renderPermissionDenied, renderDiff, startSpinner, dim, dimCyan, renderThinkingStart, renderThinkingEnd } from "../ui/render.js";
import type { PermissionManager } from "./permissions.js";
import { buildSystemSections } from "./system-prompt.js";
import { SectionCache } from "./section-cache.js";
import { MarkdownRenderer } from "../ui/markdown.js";
import { runHooks, type HooksConfig } from "../tools/hooks.js";
import type { Config, ContentBlock, Message, UsageStats } from "../types.js";
import type { CheckpointManager } from "../tools/checkpoint.js";
import { normalizeMessages } from "./normalize.js";
import { computeThinkingBudget } from "./adaptive-thinking.js";

export function getContextLimit(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus") && (m.includes("1m") || m.includes("1000k"))) return 1_000_000;
  if (m.includes("opus")) return 200_000;
  if (m.includes("haiku")) return 200_000;
  if (m.includes("sonnet")) return 200_000;
  return 200_000;
}

export const CONTEXT_LIMIT_TOKENS = 200_000;
const AUTO_COMPACT_THRESHOLD = 0.85;

function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else {
      for (const b of m.content) {
        chars += (b.text?.length ?? 0) + (b.content?.length ?? 0) + JSON.stringify(b.input ?? "").length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

interface StreamedBlock {
  type: string;
  text: string;
  inputJson: string;
  id?: string;
  name?: string;
  thinking?: string;
}

export async function runAgentLoop(
  config: Config,
  messages: Message[],
  permissionManager: PermissionManager,
  signal?: AbortSignal,
  hooks?: HooksConfig,
  checkpointManager?: CheckpointManager,
  sectionCache?: SectionCache,
): Promise<UsageStats> {
  let iteration = 0;
  const MAX_ITERATIONS = 25;
  const usage: UsageStats = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

  const cache = sectionCache ?? new SectionCache();

  const unlockedDeferred = new Set<string>();

  const contextLimit = getContextLimit(config.model);

  while (iteration++ < MAX_ITERATIONS) {
    const estimated = estimateTokens(messages);
    if (estimated > contextLimit * AUTO_COMPACT_THRESHOLD && messages.length > 4) {
      process.stderr.write(dim("  [auto-compacting — context at ~" + Math.round(estimated / 1000) + "k tokens]\n"));
      try {
        const summary = await compactConversation(config, messages);
        messages.length = 0;
        messages.push({ role: "user", content: "Summary of prior conversation:\n\n" + summary });
        messages.push({ role: "assistant", content: "Understood. I have the context. Continuing." });
      } catch {
      }
    }

    const normalizedMessages = normalizeMessages(messages, {
      apiFormat: config.apiFormat,
      keepRecentThinkingTurns: 2,
    });

    const coreTools = buildToolsForRequest(unlockedDeferred);
    const allTools = [...coreTools, ...getMcpToolDefinitions()];
    const tools = allTools.map((t, i, arr) =>
      i === arr.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t
    );

    const system = await buildSystemSections(cache);

    const effectiveBudget = config.thinkingBudget > 0
      ? computeThinkingBudget(estimateTokens(normalizedMessages), config.thinkingBudget, contextLimit)
      : 0;

    const body: Record<string, unknown> = {
      model: config.model,
      messages: normalizedMessages,
      max_tokens: effectiveBudget > 0 ? effectiveBudget + 16384 : 16384,
      tools,
      system,
    };

    if (effectiveBudget > 0) {
      body.thinking = {
        type: "enabled",
        budget_tokens: effectiveBudget,
      };
    }

    // ── Stream response ──
    const contentBlocks: ContentBlock[] = [];
    let current: StreamedBlock | null = null;
    let stopReason = "";
    let hasTextOutput = false;
    let thinkingLineStart = true;
    const md = new MarkdownRenderer();

    for await (const event of streamRequest(config, body, signal)) {
      const type = event.type as string;

      if (type === "error") {
        const err = event.error as Record<string, unknown> | undefined;
        const msg = (err?.message as string) ?? "Unknown streaming error";
        throw new Error(`API stream error: ${msg}`);
      }

      if (type === "content_block_start") {
        const block = event.content_block as Record<string, unknown>;
        current = {
          type: block.type as string,
          text: "",
          inputJson: "",
          id: block.id as string | undefined,
          name: block.name as string | undefined,
          thinking: "",
        };
        if (block.type === "thinking") {
          thinkingLineStart = true;
          renderThinkingStart();
        }
      }

      if (type === "content_block_delta" && current) {
        const delta = event.delta as Record<string, unknown>;

        if (delta.type === "text_delta") {
          const text = delta.text as string;
          md.write(text);
          current.text += text;
          hasTextOutput = true;
        }

        if (delta.type === "input_json_delta" && delta.partial_json) {
          current.inputJson += delta.partial_json as string;
        }

        if (delta.type === "thinking_delta") {
          const t = delta.thinking as string;
          let out = "";
          for (const c of t) {
            if (thinkingLineStart) { out += `  ${dimCyan("│")} `; thinkingLineStart = false; }
            out += c;
            if (c === "\n") thinkingLineStart = true;
          }
          process.stderr.write(dim(out));
          current.thinking += t;
        }
      }

      if (type === "content_block_stop" && current) {
        if (current.type === "thinking" && current.thinking) {
          renderThinkingEnd();
        }
        if (current.type === "text") {
          contentBlocks.push({ type: "text", text: current.text });
        } else if (current.type === "tool_use") {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(current.inputJson || "{}") as Record<string, unknown>;
          } catch {
            parsedInput = { _raw: current.inputJson };
          }
          contentBlocks.push({
            type: "tool_use",
            id: current.id ?? `unknown_${Date.now()}`,
            name: current.name,
            input: parsedInput,
          });
        } else if (current.type === "thinking") {
          contentBlocks.push({
            type: "thinking",
            thinking: current.thinking,
            signature: "",
          });
        }
        current = null;
      }

      if (type === "message_start") {
        const msg = event.message as Record<string, unknown>;
        const u = msg?.usage as Record<string, number> | undefined;
        if (u?.input_tokens) usage.inputTokens += u.input_tokens;
        if (u?.cache_creation_input_tokens) usage.cacheCreationInputTokens += u.cache_creation_input_tokens;
        if (u?.cache_read_input_tokens) usage.cacheReadInputTokens += u.cache_read_input_tokens;
      }

      if (type === "message_delta") {
        const delta = event.delta as Record<string, unknown>;
        stopReason = delta.stop_reason as string;
        const u = event.usage as Record<string, number> | undefined;
        if (u?.output_tokens) usage.outputTokens += u.output_tokens;
        // Some proxies report input/cache tokens in message_delta instead of message_start
        if (u?.input_tokens) usage.inputTokens += u.input_tokens;
        if (u?.cache_creation_input_tokens) usage.cacheCreationInputTokens += u.cache_creation_input_tokens;
        if (u?.cache_read_input_tokens) usage.cacheReadInputTokens += u.cache_read_input_tokens;
      }
    }

    md.flush();
    if (hasTextOutput) process.stdout.write("\n");

    messages.push({ role: "assistant", content: contentBlocks });

    if (stopReason !== "tool_use") return usage;

    // ── Execute tools ──
    const toolResults: ContentBlock[] = [];

    for (const block of contentBlocks) {
      if (block.type !== "tool_use") continue;
      if (signal?.aborted) break;

      const toolName = block.name ?? "unknown";
      const toolInput = (block.input ?? {}) as Record<string, unknown>;

      renderToolCall(toolName, toolInput);

      if (toolName === "Edit" && toolInput.old_string && toolInput.new_string) {
        renderDiff(toolInput.old_string as string, toolInput.new_string as string);
      }

      const decision = await permissionManager.check(toolName, toolInput);
      if (decision === "deny") {
        renderPermissionDenied(toolName);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `User denied permission to run ${toolName}. Do not retry this tool call unless the user explicitly asks.`,
          is_error: true,
        });
        continue;
      }

      const preResult = await runHooks(hooks, "pre", toolName, toolInput);
      if (!preResult.ok) {
        const msg = preResult.output.trim()
          ? `Pre-hook blocked execution of ${toolName}.\n${preResult.output.trim()}`
          : `Pre-hook blocked execution of ${toolName}.`;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: msg,
          is_error: true,
        });
        continue;
      }

      if (checkpointManager && (toolName === "Write" || toolName === "Edit")) {
        const filePath = toolInput.file_path as string;
        if (filePath) {
          await checkpointManager.snapshotFile(filePath);
        }
      }

      if (DEFERRED_TOOL_NAMES.has(toolName) && !unlockedDeferred.has(toolName)) {
        const msg = `Tool "${toolName}" is deferred. Use ToolSearch to fetch its schema first (e.g. ToolSearch with query "select:${toolName}").`;
        renderToolResult(msg, true);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: msg,
          is_error: true,
        });
        continue;
      }

      const stopSpin = startSpinner(`Running ${toolName}...`);

      try {
        const result = await executeTool(toolName, toolInput);
        stopSpin();
        if (toolName === "ToolSearch") {
          const nameMatches = result.matchAll(/"name":\s*"([^"]+)"/g);
          for (const m of nameMatches) {
            if (DEFERRED_TOOL_NAMES.has(m[1])) {
              unlockedDeferred.add(m[1]);
            }
          }
        }
        renderToolResult(result, false);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
        const postResult = await runHooks(hooks, "post", toolName, toolInput);
        if (postResult.output.trim()) {
          const last = toolResults[toolResults.length - 1];
          last.content += "\n\n[Hook output]\n" + postResult.output.trim();
        }
      } catch (err) {
        stopSpin();
        const msg = err instanceof Error ? err.message : String(err);
        renderToolResult(msg, true);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: msg,
          is_error: true,
        });
      }
    }

    if (toolResults.length > 0) {
      const last = toolResults[toolResults.length - 1];
      toolResults[toolResults.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
    }
    messages.push({ role: "user", content: toolResults });
  }

  return usage;
}
