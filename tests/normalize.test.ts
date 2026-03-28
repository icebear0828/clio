import { describe, it, expect } from "vitest";
import { normalizeMessages } from "../src/core/normalize.js";
import type { Message, ContentBlock } from "../src/types.js";

const opts = { apiFormat: "anthropic" as const, keepRecentThinkingTurns: 2 };

describe("normalizeMessages", () => {
  describe("tool result pairing", () => {
    it("passes through well-paired messages", () => {
      const messages: Message[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ];
      const result = normalizeMessages(messages, opts);
      expect(result).toHaveLength(3);
    });

    it("adds synthetic error for orphaned tool_use when next user has blocks", () => {
      const messages: Message[] = [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        // no tool_result for t1 — next message is user with content blocks
        { role: "user", content: [{ type: "text", text: "continue" }] },
        { role: "assistant", content: "done" },
      ];
      const result = normalizeMessages(messages, opts);
      const userBlocks = result.filter(m => m.role === "user" && typeof m.content !== "string");
      const hasToolResult = userBlocks.some(m =>
        (m.content as ContentBlock[]).some(b => b.type === "tool_result" && b.tool_use_id === "t1")
      );
      expect(hasToolResult).toBe(true);
    });

    it("adds synthetic error for orphaned tool_use when no next user message", () => {
      const messages: Message[] = [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "assistant", content: "done" },
      ];
      const result = normalizeMessages(messages, opts);
      const userBlocks = result.filter(m => m.role === "user" && typeof m.content !== "string");
      const hasToolResult = userBlocks.some(m =>
        (m.content as ContentBlock[]).some(b => b.type === "tool_result" && b.tool_use_id === "t1")
      );
      expect(hasToolResult).toBe(true);
    });

    it("does NOT inject synthetic result when next user message is a string", () => {
      const messages: Message[] = [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: "continue" },
        { role: "assistant", content: "done" },
      ];
      const result = normalizeMessages(messages, opts);
      // Known behavior: string user content doesn't trigger synthetic pairing
      const hasToolResult = result.some(m =>
        typeof m.content !== "string" &&
        (m.content as ContentBlock[]).some(b => b.type === "tool_result" && b.tool_use_id === "t1")
      );
      expect(hasToolResult).toBe(false);
    });

    it("filters orphan tool_results with no matching tool_use", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "nonexistent", content: "x" }] },
        { role: "assistant", content: "ok" },
      ];
      const result = normalizeMessages(messages, opts);
      // The orphan tool_result should be filtered out, message may be dropped
      const hasOrphan = result.some(m =>
        typeof m.content !== "string" &&
        (m.content as ContentBlock[]).some(b => b.type === "tool_result" && b.tool_use_id === "nonexistent")
      );
      expect(hasOrphan).toBe(false);
    });
  });

  describe("message ordering", () => {
    it("merges consecutive same-role messages", () => {
      const messages: Message[] = [
        { role: "user", content: "hello" },
        { role: "user", content: "world" },
        { role: "assistant", content: "hi" },
      ];
      const result = normalizeMessages(messages, opts);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("user");
    });

    it("prepends user message if first message is assistant", () => {
      const messages: Message[] = [
        { role: "assistant", content: "hello" },
        { role: "user", content: "hi" },
      ];
      const result = normalizeMessages(messages, opts);
      expect(result[0].role).toBe("user");
    });

    it("handles empty messages", () => {
      expect(normalizeMessages([], opts)).toEqual([]);
    });
  });

  describe("clearOldThinking", () => {
    it("clears thinking content beyond keepRecentThinkingTurns", () => {
      const messages: Message[] = [
        { role: "user", content: "q1" },
        { role: "assistant", content: [{ type: "thinking", thinking: "thought1" }, { type: "text", text: "a1" }] },
        { role: "user", content: "q2" },
        { role: "assistant", content: [{ type: "thinking", thinking: "thought2" }, { type: "text", text: "a2" }] },
        { role: "user", content: "q3" },
        { role: "assistant", content: [{ type: "thinking", thinking: "thought3" }, { type: "text", text: "a3" }] },
      ];
      const result = normalizeMessages(messages, { ...opts, keepRecentThinkingTurns: 2 });
      // The oldest thinking (thought1) should be cleared
      const first = result[1];
      const thinkingBlock = (first.content as ContentBlock[]).find(b => b.type === "thinking");
      expect(thinkingBlock?.thinking).toBe("");
      // Recent two should be preserved
      const third = result[3];
      const t2 = (third.content as ContentBlock[]).find(b => b.type === "thinking");
      expect(t2?.thinking).toBe("thought2");
      const fifth = result[5];
      const t3 = (fifth.content as ContentBlock[]).find(b => b.type === "thinking");
      expect(t3?.thinking).toBe("thought3");
    });

    it("skips thinking cleanup for openai format", () => {
      const messages: Message[] = [
        { role: "user", content: "q1" },
        { role: "assistant", content: [{ type: "thinking", thinking: "thought1" }, { type: "text", text: "a1" }] },
        { role: "user", content: "q2" },
        { role: "assistant", content: [{ type: "thinking", thinking: "thought2" }, { type: "text", text: "a2" }] },
        { role: "user", content: "q3" },
        { role: "assistant", content: [{ type: "thinking", thinking: "thought3" }, { type: "text", text: "a3" }] },
      ];
      const result = normalizeMessages(messages, { apiFormat: "openai", keepRecentThinkingTurns: 1 });
      // All thinking should be preserved in openai mode
      const allThinking = result
        .filter(m => typeof m.content !== "string")
        .flatMap(m => (m.content as ContentBlock[]).filter(b => b.type === "thinking"));
      expect(allThinking.every(b => b.thinking !== "")).toBe(true);
    });
  });

  describe("cache breakpoint optimization", () => {
    it("keeps at most 3 cache breakpoints (newest)", () => {
      const mkMsg = (id: number, cached: boolean): Message => ({
        role: id % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `msg${id}`, ...(cached ? { cache_control: { type: "ephemeral" as const } } : {}) }],
      });
      const messages: Message[] = [
        mkMsg(0, true), mkMsg(1, true), mkMsg(2, true), mkMsg(3, true), mkMsg(4, true),
      ];
      const result = normalizeMessages(messages, opts);
      let cacheCount = 0;
      for (const m of result) {
        if (typeof m.content === "string") continue;
        for (const b of m.content) {
          if (b.cache_control) cacheCount++;
        }
      }
      expect(cacheCount).toBeLessThanOrEqual(3);
    });

    it("preserves all breakpoints when <= 3", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] },
      ];
      const result = normalizeMessages(messages, opts);
      let cacheCount = 0;
      for (const m of result) {
        if (typeof m.content === "string") continue;
        for (const b of m.content) {
          if (b.cache_control) cacheCount++;
        }
      }
      expect(cacheCount).toBe(2);
    });
  });
});
