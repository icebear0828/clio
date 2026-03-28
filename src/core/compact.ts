import { apiRequest } from "./client.js";
import type { Config, Message, ContentBlock } from "../types.js";

const COMPACT_PROMPT =
  "Summarize the conversation so far in a concise but comprehensive way. " +
  "Include: key decisions made, code changes discussed, files mentioned, " +
  "current task status, and any important context needed to continue. " +
  "Format as structured bullet points. Be thorough but concise.";

function serializeMessages(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      if (typeof m.content === "string") return `${role}: ${m.content}`;

      const parts = (m.content as ContentBlock[])
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") return `[Tool: ${b.name}(${JSON.stringify(b.input).slice(0, 200)})]`;
          if (b.type === "tool_result") return `[Result: ${typeof b.content === "string" ? b.content.slice(0, 200) : "..."}]`;
          return "";
        })
        .filter(Boolean);

      return `${role}: ${parts.join("\n")}`;
    })
    .join("\n\n");
}

export async function compactConversation(
  config: Config,
  messages: Message[]
): Promise<string> {
  const serialized = serializeMessages(messages);

  const body = await apiRequest(config, {
    model: config.model,
    max_tokens: 4096,
    messages: [{ role: "user", content: `${COMPACT_PROMPT}\n\n---\n\n${serialized}` }],
  });

  const text = body.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (!text) throw new Error("Empty summary response");
  return text;
}
