import { describe, it, expect, vi } from "vitest";
import { createLLMClassifier, type LLMClassifierConfig } from "../src/core/llm-classifier.js";
import type { Config } from "../src/types.js";

// Mock apiRequest
vi.mock("../src/core/client.js", () => ({
  apiRequest: vi.fn(),
}));

import { apiRequest } from "../src/core/client.js";
const mockApiRequest = vi.mocked(apiRequest);

const fakeConfig: Config = {
  apiUrl: "https://api.example.com",
  apiKey: "test-key",
  model: "claude-sonnet-4-20250514",
  permissionMode: "auto",
  thinkingBudget: 0,
  apiFormat: "anthropic",
};

const classifierConfig: LLMClassifierConfig = {
  enabled: true,
  model: "claude-haiku-4-5-20251001",
  timeout: 5000,
};

describe("LLM Classifier", () => {
  it("returns 'allow' when API responds ALLOW", async () => {
    mockApiRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: "ALLOW" }],
    });

    const classify = createLLMClassifier(fakeConfig, classifierConfig, () => "");
    const result = await classify("Bash", { command: "npm test" });
    expect(result).toBe("allow");
  });

  it("returns 'deny' when API responds DENY", async () => {
    mockApiRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: "DENY" }],
    });

    const classify = createLLMClassifier(fakeConfig, classifierConfig, () => "");
    const result = await classify("Bash", { command: "rm -rf /" });
    expect(result).toBe("deny");
  });

  it("returns 'prompt' when API responds PROMPT", async () => {
    mockApiRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: "PROMPT" }],
    });

    const classify = createLLMClassifier(fakeConfig, classifierConfig, () => "");
    const result = await classify("Write", { file_path: "/tmp/unknown" });
    expect(result).toBe("prompt");
  });

  it("returns 'prompt' on unrecognized response", async () => {
    mockApiRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: "MAYBE" }],
    });

    const classify = createLLMClassifier(fakeConfig, classifierConfig, () => "");
    const result = await classify("Bash", { command: "something" });
    expect(result).toBe("prompt");
  });

  it("returns 'prompt' on API error", async () => {
    mockApiRequest.mockRejectedValueOnce(new Error("API failure"));

    const classify = createLLMClassifier(fakeConfig, classifierConfig, () => "");
    const result = await classify("Bash", { command: "echo hi" });
    expect(result).toBe("prompt");
  });

  it("returns 'prompt' on timeout", async () => {
    // Simulate a slow API call
    mockApiRequest.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 10000)) as ReturnType<typeof apiRequest>
    );

    const shortTimeout: LLMClassifierConfig = { enabled: true, timeout: 50 };
    const classify = createLLMClassifier(fakeConfig, shortTimeout, () => "");
    const result = await classify("Bash", { command: "echo hi" });
    expect(result).toBe("prompt");
  });

  it("sends correct model and system prompt", async () => {
    mockApiRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: "ALLOW" }],
    });

    const classify = createLLMClassifier(fakeConfig, classifierConfig, () => "some context");
    await classify("Bash", { command: "ls" });

    expect(mockApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" }),
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        system: expect.stringContaining("security classifier"),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Tool: Bash"),
          }),
        ]),
      }),
    );
  });

  it("includes recent context in the prompt", async () => {
    mockApiRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: "ALLOW" }],
    });

    const classify = createLLMClassifier(fakeConfig, classifierConfig, () => "user asked to list files");
    await classify("Bash", { command: "ls -la" });

    // Find the most recent call
    const lastCall = mockApiRequest.mock.calls[mockApiRequest.mock.calls.length - 1];
    const body = lastCall[1] as Record<string, unknown>;
    const msgs = body.messages as Array<{ content: string }>;
    expect(msgs[0].content).toContain("user asked to list files");
  });

  it("handles case-insensitive responses", async () => {
    mockApiRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: "allow" }],
    });

    const classify = createLLMClassifier(fakeConfig, classifierConfig, () => "");
    const result = await classify("Bash", { command: "echo test" });
    expect(result).toBe("allow");
  });
});
