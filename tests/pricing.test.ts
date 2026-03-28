import { describe, it, expect } from "vitest";
import { estimateCost, formatUSD } from "../src/core/pricing.js";

describe("estimateCost", () => {
  it("returns null for unknown model", () => {
    expect(estimateCost("gpt-4o", 1000, 1000)).toBeNull();
  });

  it("calculates cost for claude-opus-4", () => {
    const result = estimateCost("claude-opus-4-20250514", 1_000_000, 1_000_000);
    expect(result).toEqual({ input: 15, output: 75, total: 90 });
  });

  it("calculates cost for claude-sonnet-4", () => {
    const result = estimateCost("claude-sonnet-4-20250514", 1_000_000, 1_000_000);
    expect(result).toEqual({ input: 3, output: 15, total: 18 });
  });

  it("calculates cost for claude-haiku-4", () => {
    const result = estimateCost("claude-haiku-4-20250101", 1_000_000, 1_000_000);
    expect(result).toEqual({ input: 0.8, output: 4, total: 4.8 });
  });

  it("calculates cost for claude-haiku-3.5", () => {
    const result = estimateCost("claude-haiku-3.5-20240101", 1_000_000, 1_000_000);
    expect(result).toEqual({ input: 0.8, output: 4, total: 4.8 });
  });

  it("calculates cost for claude-haiku-3", () => {
    const result = estimateCost("claude-haiku-3-20240101", 1_000_000, 1_000_000);
    expect(result).toEqual({ input: 0.25, output: 1.25, total: 1.5 });
  });

  it("handles zero tokens", () => {
    const result = estimateCost("claude-opus-4-20250514", 0, 0);
    expect(result).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("handles small token counts", () => {
    const result = estimateCost("claude-sonnet-4-20250514", 100, 50);
    expect(result).not.toBeNull();
    expect(result!.total).toBeCloseTo(0.0003 + 0.00075, 10);
  });

  it("matches by prefix, not exact name", () => {
    expect(estimateCost("claude-opus-4-anything", 1000, 1000)).not.toBeNull();
    expect(estimateCost("claude-sonnet-4-anything", 1000, 1000)).not.toBeNull();
  });
});

describe("formatUSD", () => {
  it("formats amounts >= $0.01 with two decimal places", () => {
    expect(formatUSD(1.5)).toBe("$1.50");
    expect(formatUSD(0.01)).toBe("$0.01");
    expect(formatUSD(100)).toBe("$100.00");
  });

  it("returns <$0.01 for tiny amounts", () => {
    expect(formatUSD(0)).toBe("<$0.01");
    expect(formatUSD(0.001)).toBe("<$0.01");
    expect(formatUSD(0.009)).toBe("<$0.01");
  });
});
