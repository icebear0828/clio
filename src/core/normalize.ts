import type { ApiFormat, ContentBlock, Message } from "../types.js";

interface NormalizeOptions {
  apiFormat: ApiFormat;
  keepRecentThinkingTurns: number;
}

export function normalizeMessages(messages: Message[], options: NormalizeOptions): Message[] {
  let result = ensureToolResultPairing(messages);
  result = fixMessageOrdering(result);
  if (options.apiFormat !== "openai") {
    result = clearOldThinking(result, options.keepRecentThinkingTurns);
  }
  result = optimizeCacheBreakpoints(result);
  return result;
}

function ensureToolResultPairing(messages: Message[]): Message[] {
  const toolUseIds = new Map<string, number>();
  const toolResultIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        toolUseIds.set(block.id, i);
      }
      if (block.type === "tool_result" && block.tool_use_id) {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  const result: Message[] = [];
  let lastAssistantIdx = -1;
  for (let j = messages.length - 1; j >= 0; j--) {
    if (messages[j].role === "assistant") { lastAssistantIdx = j; break; }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    if (msg.role === "assistant" && i !== lastAssistantIdx && typeof msg.content !== "string") {
      const orphanIds: string[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id && !toolResultIds.has(block.id)) {
          orphanIds.push(block.id);
        }
      }

      if (orphanIds.length > 0) {
        const nextMsg = messages[i + 1];
        if (nextMsg && nextMsg.role === "user" && typeof nextMsg.content !== "string") {
          const syntheticResults: ContentBlock[] = orphanIds.map(id => ({
            type: "tool_result",
            tool_use_id: id,
            content: "Tool execution was interrupted.",
            is_error: true,
          }));
          result.push({
            role: "user",
            content: [...syntheticResults, ...nextMsg.content],
          });
          i++;
        } else if (!nextMsg || nextMsg.role !== "user") {
          result.push({
            role: "user",
            content: orphanIds.map(id => ({
              type: "tool_result",
              tool_use_id: id,
              content: "Tool execution was interrupted.",
              is_error: true,
            })),
          });
        }
      }
    }
  }

  return result.map(msg => {
    if (typeof msg.content === "string") return msg;
    const filtered = msg.content.filter(block => {
      if (block.type === "tool_result" && block.tool_use_id) {
        return toolUseIds.has(block.tool_use_id);
      }
      return true;
    });
    if (filtered.length === msg.content.length) return msg;
    if (filtered.length === 0) return null;
    return { ...msg, content: filtered };
  }).filter((msg): msg is Message => msg !== null);
}

function clearOldThinking(messages: Message[], keepRecentTurns: number): Message[] {
  let thinkingTurnCount = 0;
  const assistantIndices: number[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    const hasThinking = msg.content.some(b => b.type === "thinking" && b.thinking);
    if (hasThinking) {
      assistantIndices.push(i);
      thinkingTurnCount++;
    }
  }

  if (thinkingTurnCount <= keepRecentTurns) return messages;

  const indicesToClear = assistantIndices.slice(keepRecentTurns);
  const clearSet = new Set(indicesToClear);

  return messages.map((msg, i) => {
    if (!clearSet.has(i)) return msg;
    if (typeof msg.content === "string") return msg;
    const newContent = msg.content.map(block => {
      if (block.type === "thinking" && block.thinking) {
        return { ...block, thinking: "" };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });
}

function fixMessageOrdering(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const result: Message[] = [];

  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      const lastContent = typeof last.content === "string"
        ? [{ type: "text" as const, text: last.content } as ContentBlock]
        : last.content;
      const msgContent = typeof msg.content === "string"
        ? [{ type: "text" as const, text: msg.content } as ContentBlock]
        : msg.content;
      result[result.length - 1] = { role: msg.role, content: [...lastContent, ...msgContent] };
    } else {
      result.push(msg);
    }
  }

  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: "Continue." });
  }

  return result;
}

function optimizeCacheBreakpoints(messages: Message[]): Message[] {
  const breakpoints: Array<{ msgIdx: number; blockIdx: number }> = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg.content === "string") continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      if (msg.content[j].cache_control) {
        breakpoints.push({ msgIdx: i, blockIdx: j });
      }
    }
  }

  if (breakpoints.length <= 3) return messages;

  const toRemove = new Set(breakpoints.slice(3).map(bp => `${bp.msgIdx}:${bp.blockIdx}`));

  return messages.map((msg, i) => {
    if (typeof msg.content === "string") return msg;
    let changed = false;
    const newContent = msg.content.map((block, j) => {
      if (toRemove.has(`${i}:${j}`) && block.cache_control) {
        changed = true;
        const { cache_control: _, ...rest } = block;
        return rest as ContentBlock;
      }
      return block;
    });
    return changed ? { ...msg, content: newContent } : msg;
  });
}
