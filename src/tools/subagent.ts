import { streamRequest } from "../core/client.js";
import { getSubAgentSystemPrompt } from "../core/system-prompt.js";
import { TOOL_DEFINITIONS, executeTool } from "./index.js";
import { getMcpToolDefinitions } from "./mcp.js";
import type { Config, ContentBlock, Message } from "../types.js";

const MAX_ITERATIONS = 15;

export interface SubAgentOptions {
  systemPromptOverride?: string;
  allowedTools?: string[];
  model?: string;
  maxIterations?: number;
  workdir?: string;
  signal?: AbortSignal;
}

interface StreamedBlock {
  type: string;
  text: string;
  inputJson: string;
  id?: string;
  name?: string;
}

export async function executeSubAgent(
  config: Config,
  prompt: string,
  options?: SubAgentOptions,
): Promise<string> {
  const signal = options?.signal;
  const maxIter = options?.maxIterations ?? MAX_ITERATIONS;

  const originalCwd = process.cwd();
  if (options?.workdir) process.chdir(options.workdir);

  try {
  const messages: Message[] = [{ role: "user", content: prompt }];

  const systemText = options?.systemPromptOverride ?? getSubAgentSystemPrompt();
  const system = [
    {
      type: "text",
      text: systemText,
      cache_control: { type: "ephemeral" },
    },
  ];

  const SUBAGENT_EXCLUDED = new Set(["Agent", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);
  const allowedSet = options?.allowedTools ? new Set(options.allowedTools) : null;
  const allTools = [
    ...TOOL_DEFINITIONS.filter((t) => !SUBAGENT_EXCLUDED.has(t.name) && (!allowedSet || allowedSet.has(t.name))),
    ...getMcpToolDefinitions(),
  ];
  const tools = allTools.map((t, i, arr) =>
    i === arr.length - 1
      ? { ...t, cache_control: { type: "ephemeral" as const } }
      : t
  );

  let iteration = 0;

  while (iteration++ < maxIter) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const body: Record<string, unknown> = {
      model: options?.model ?? config.model,
      messages,
      max_tokens: config.thinkingBudget > 0 ? config.thinkingBudget + 16384 : 16384,
      tools,
      system,
    };

    if (config.thinkingBudget > 0) {
      body.thinking = {
        type: "enabled",
        budget_tokens: config.thinkingBudget,
      };
    }

    const contentBlocks: ContentBlock[] = [];
    let current: StreamedBlock | null = null;
    let stopReason = "";

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
        };
      }

      if (type === "content_block_delta" && current) {
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === "text_delta") {
          current.text += delta.text as string;
        }
        if (delta.type === "input_json_delta" && delta.partial_json) {
          current.inputJson += delta.partial_json as string;
        }
      }

      if (type === "content_block_stop" && current) {
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
            id: current.id ?? `sub_${Date.now()}`,
            name: current.name,
            input: parsedInput,
          });
        } else if (current.type === "thinking") {
          contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: "",
          });
        }
        current = null;
      }

      if (type === "message_delta") {
        const delta = event.delta as Record<string, unknown>;
        stopReason = delta.stop_reason as string;
      }
    }

    messages.push({ role: "assistant", content: contentBlocks });

    if (stopReason !== "tool_use") {
      // Extract final text from the last response
      const textParts: string[] = [];
      for (const block of contentBlocks) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }
      return textParts.join("\n") || "(no output)";
    }

    // Execute tools
    const toolResults: ContentBlock[] = [];

    for (const block of contentBlocks) {
      if (block.type !== "tool_use") continue;
      if (signal?.aborted) break;

      const toolName = block.name ?? "unknown";
      const toolInput = (block.input ?? {}) as Record<string, unknown>;

      try {
        const result = await executeTool(toolName, toolInput);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: msg,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Reached max iterations — return whatever text we have
  const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    const texts = lastAssistant.content
      .filter((b): b is ContentBlock & { text: string } => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return "(sub-agent reached max iterations)";

  } finally {
    if (options?.workdir) process.chdir(originalCwd);
  }
}
