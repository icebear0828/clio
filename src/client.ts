import type { Config, ContentBlock, Message } from "./types.js";

const CONNECT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 8000];

const ANTHROPIC_VERSION = "2023-06-01";

function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : "";
  return msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT") || msg.includes("fetch failed");
}

// ── Format-specific helpers ──

function getUrl(config: Config): string {
  return config.apiFormat === "openai"
    ? `${config.apiUrl}/v1/chat/completions`
    : `${config.apiUrl}/v1/messages`;
}

function getHeaders(config: Config): Record<string, string> {
  if (config.apiFormat === "openai") {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    };
  }

  const betaFeatures: string[] = ["prompt-caching-2024-07-31"];
  if (config.thinkingBudget > 0) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  return {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": betaFeatures.join(","),
  };
}

/** Convert Anthropic request body to OpenAI format */
function toOpenAIBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  const system = body.system;
  if (typeof system === "string" && system) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = (system as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text")
      .map((b) => b.text as string)
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  // Convert messages
  const srcMessages = (body.messages ?? []) as Message[];
  for (const m of srcMessages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
    } else {
      // Extract text from ContentBlocks
      const blocks = m.content as ContentBlock[];
      const textParts = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      // Handle tool_use blocks → OpenAI function calls
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id ?? "call_0",
          type: "function" as const,
          function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
        }));

      // Handle tool_result blocks → OpenAI tool messages
      const toolResults = blocks.filter((b) => b.type === "tool_result");

      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id ?? "call_0",
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
      } else if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: textParts || null,
          tool_calls: toolCalls,
        });
      } else {
        messages.push({ role: m.role, content: textParts });
      }
    }
  }

  // Convert tool definitions
  const tools = body.tools as Array<{ name: string; description: string; input_schema: Record<string, unknown> }> | undefined;
  const openaiTools = tools?.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  return {
    model: body.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: body.max_tokens,
    ...(openaiTools?.length ? { tools: openaiTools } : {}),
  };
}

/** Convert a single OpenAI streaming chunk to Anthropic-like events */
function* translateOpenAIChunk(
  chunk: Record<string, unknown>,
  state: { blockStarted: boolean; toolCallAccum: Map<number, { id: string; name: string; args: string }> }
): Generator<Record<string, unknown>> {
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  if (!choices || choices.length === 0) return;

  const choice = choices[0];
  const delta = choice.delta as Record<string, unknown> | undefined;
  const finishReason = choice.finish_reason as string | null;

  if (delta) {
    // Text content
    if (typeof delta.content === "string") {
      if (!state.blockStarted) {
        yield { type: "content_block_start", content_block: { type: "text", text: "" }, index: 0 };
        state.blockStarted = true;
      }
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } };
    }

    // Tool calls (streaming)
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const idx = (tc.index as number) ?? 0;
        const fn = tc.function as Record<string, unknown> | undefined;

        if (!state.toolCallAccum.has(idx)) {
          state.toolCallAccum.set(idx, {
            id: (tc.id as string) ?? `call_${idx}`,
            name: (fn?.name as string) ?? "",
            args: "",
          });
        }

        const accum = state.toolCallAccum.get(idx)!;
        if (fn?.name) accum.name = fn.name as string;
        if (fn?.arguments) accum.args += fn.arguments as string;
      }
    }
  }

  // Finish
  if (finishReason) {
    if (state.blockStarted) {
      yield { type: "content_block_stop", index: 0 };
    }

    // Emit tool_use blocks from accumulated tool calls
    if (finishReason === "tool_calls" || state.toolCallAccum.size > 0) {
      let toolIdx = state.blockStarted ? 1 : 0;
      for (const [, tc] of state.toolCallAccum) {
        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = JSON.parse(tc.args || "{}") as Record<string, unknown>; } catch { /* */ }
        yield {
          type: "content_block_start",
          index: toolIdx,
          content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
        };
        yield {
          type: "content_block_delta",
          index: toolIdx,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(parsedArgs) },
        };
        yield { type: "content_block_stop", index: toolIdx };
        toolIdx++;
      }
    }

    // Usage from OpenAI
    const usage = chunk.usage as Record<string, number> | undefined;
    yield {
      type: "message_start",
      message: {
        usage: {
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: 0,
        },
      },
    };

    yield {
      type: "message_delta",
      delta: {
        stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
      },
      usage: { output_tokens: usage?.completion_tokens ?? 0 },
    };
  }
}

// ── Main streaming function ──

export async function* streamRequest(
  config: Config,
  body: Record<string, unknown>,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  const isOpenAI = config.apiFormat === "openai";
  const requestBody = isOpenAI ? toOpenAIBody(body) : { ...body, stream: true };
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)];
      await new Promise((r) => setTimeout(r, delay));
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }

    let response: Response;
    try {
      response = await fetch(getUrl(config), {
        method: "POST",
        headers: getHeaders(config),
        body: JSON.stringify(requestBody),
        signal: signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (isNetworkError(err) && attempt < MAX_RETRIES) continue;
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (isRetryable(response.status) && attempt < MAX_RETRIES) {
        lastError = new Error(`API ${response.status}: ${text.slice(0, 300)}`);
        continue;
      }
      throw new Error(`API ${response.status}: ${text.slice(0, 300)}`);
    }

    if (!response.body) throw new Error("Empty response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const openaiState = {
      blockStarted: false,
      toolCallAccum: new Map<number, { id: string; name: string; args: string }>(),
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (isOpenAI) {
              yield* translateOpenAIChunk(parsed, openaiState);
            } else {
              yield parsed;
            }
          } catch {
            // skip unparseable
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return;
  }

  throw lastError ?? new Error("Request failed after retries");
}

/** Non-streaming request (for /commit, /pr, /init, /compact) */
export async function apiRequest(
  config: Config,
  body: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text?: string }> }> {
  const isOpenAI = config.apiFormat === "openai";
  const requestBody = isOpenAI
    ? { ...toOpenAIBody(body), stream: false }
    : body;

  const response = await fetch(getUrl(config), {
    method: "POST",
    headers: getHeaders(config),
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${text.slice(0, 300)}`);
  }

  if (isOpenAI) {
    // Translate OpenAI response to Anthropic format
    const oaiResp = (await response.json()) as {
      choices: Array<{ message: { content?: string } }>;
    };
    const text = oaiResp.choices?.[0]?.message?.content ?? "";
    return { content: [{ type: "text", text }] };
  }

  return response.json() as Promise<{ content: Array<{ type: string; text?: string }> }>;
}
