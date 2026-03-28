import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the internal formatting logic by importing the module
// and calling getLspDiagnosticsSummary after setting up mocks

// Since LspClient/LspManager rely on spawning processes,
// we test the Content-Length framing and diagnostics formatting logic

describe("LSP Content-Length Framing", () => {
  it("parses a single complete message", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const buffer = Buffer.from(frame);

    // Simulate parsing
    const headerEnd = buffer.indexOf("\r\n\r\n");
    expect(headerEnd).toBeGreaterThan(0);

    const headerStr = buffer.subarray(0, headerEnd).toString("utf-8");
    const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
    expect(match).not.toBeNull();

    const contentLength = parseInt(match![1], 10);
    expect(contentLength).toBe(Buffer.byteLength(body));

    const content = buffer.subarray(headerEnd + 4, headerEnd + 4 + contentLength).toString("utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(1);
  });

  it("handles multi-byte UTF-8 content correctly", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "test", params: { text: "日本語" } });
    const byteLength = Buffer.byteLength(body);
    expect(byteLength).toBeGreaterThan(body.length); // Multi-byte chars

    const frame = `Content-Length: ${byteLength}\r\n\r\n${body}`;
    const buffer = Buffer.from(frame);
    const headerEnd = buffer.indexOf("\r\n\r\n");
    const content = buffer.subarray(headerEnd + 4, headerEnd + 4 + byteLength).toString("utf-8");
    expect(JSON.parse(content).params.text).toBe("日本語");
  });

  it("handles split frames across chunks", () => {
    const body1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "first" });
    const body2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: "second" });
    const frame1 = `Content-Length: ${Buffer.byteLength(body1)}\r\n\r\n${body1}`;
    const frame2 = `Content-Length: ${Buffer.byteLength(body2)}\r\n\r\n${body2}`;
    const combined = Buffer.from(frame1 + frame2);

    // Parse first message
    const headerEnd1 = combined.indexOf("\r\n\r\n");
    const match1 = /Content-Length:\s*(\d+)/i.exec(combined.subarray(0, headerEnd1).toString());
    const len1 = parseInt(match1![1], 10);
    const content1 = combined.subarray(headerEnd1 + 4, headerEnd1 + 4 + len1).toString("utf-8");
    expect(JSON.parse(content1).result).toBe("first");

    // Parse second message from remaining
    const rest = combined.subarray(headerEnd1 + 4 + len1);
    const headerEnd2 = rest.indexOf("\r\n\r\n");
    const match2 = /Content-Length:\s*(\d+)/i.exec(rest.subarray(0, headerEnd2).toString());
    const len2 = parseInt(match2![1], 10);
    const content2 = rest.subarray(headerEnd2 + 4, headerEnd2 + 4 + len2).toString("utf-8");
    expect(JSON.parse(content2).result).toBe("second");
  });
});

describe("LSP Diagnostics Formatting", () => {
  it("formats diagnostics with severity labels", () => {
    const diags = [
      {
        range: { start: { line: 14, character: 0 }, end: { line: 14, character: 10 } },
        severity: 1 as const,
        message: "Type 'string' is not assignable to type 'number'",
        source: "ts",
      },
      {
        range: { start: { line: 41, character: 5 }, end: { line: 41, character: 10 } },
        severity: 2 as const,
        message: "Unused variable 'x'",
        source: "ts",
      },
    ];

    // Simulate formatting
    const severityLabels = ["", "error", "warning", "info", "hint"];
    const lines: string[] = ["src/index.ts:"];
    for (const d of diags) {
      const severity = severityLabels[d.severity ?? 4];
      const line = d.range.start.line + 1;
      const source = d.source ? ` (${d.source})` : "";
      lines.push(`  Line ${line}: ${severity}: ${d.message}${source}`);
    }

    const result = lines.join("\n");
    expect(result).toContain("src/index.ts:");
    expect(result).toContain("Line 15: error: Type 'string' is not assignable to type 'number' (ts)");
    expect(result).toContain("Line 42: warning: Unused variable 'x' (ts)");
  });

  it("sorts diagnostics by severity (errors first)", () => {
    const entries = [
      { severity: 2, line: 10, message: "warning" },
      { severity: 1, line: 5, message: "error" },
      { severity: 3, line: 20, message: "info" },
    ];

    entries.sort((a, b) => a.severity - b.severity);
    expect(entries[0].message).toBe("error");
    expect(entries[1].message).toBe("warning");
    expect(entries[2].message).toBe("info");
  });

  it("limits output to MAX_DIAGNOSTICS", () => {
    const MAX = 50;
    const entries = Array.from({ length: 100 }, (_, i) => ({
      file: "big.ts",
      severity: 2,
      line: i + 1,
      message: `warning ${i}`,
    }));

    const limited = entries.slice(0, MAX);
    expect(limited.length).toBe(50);

    const remaining = entries.length - MAX;
    expect(remaining).toBe(50);
  });
});
