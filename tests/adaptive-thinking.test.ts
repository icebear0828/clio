import { describe, it, expect } from "vitest";
import { computeThinkingBudget } from "../src/core/adaptive-thinking.js";

describe("computeThinkingBudget", () => {
  const CTX = 200_000;
  const BUDGET = 10_000;

  it("returns 0 when baseline budget is 0", () => {
    expect(computeThinkingBudget(50_000, 0, CTX)).toBe(0);
  });

  it("returns 0 when baseline budget is negative", () => {
    expect(computeThinkingBudget(50_000, -100, CTX)).toBe(0);
  });

  it("returns full budget at low usage (<=50%)", () => {
    expect(computeThinkingBudget(50_000, BUDGET, CTX)).toBe(BUDGET);
    expect(computeThinkingBudget(100_000, BUDGET, CTX)).toBe(BUDGET);
  });

  it("scales down between 50-75% usage", () => {
    // At 60% usage: factor = 1 - (0.6 - 0.5) * 2 = 0.8
    const input60 = 120_000;
    const result = computeThinkingBudget(input60, BUDGET, CTX);
    expect(result).toBe(Math.max(1024, Math.floor(BUDGET * 0.8)));
  });

  it("scales down further at 70% usage", () => {
    // At 70% usage: factor = 1 - (0.7 - 0.5) * 2 = 0.6
    const input70 = 140_000;
    const result = computeThinkingBudget(input70, BUDGET, CTX);
    expect(result).toBe(Math.max(1024, Math.floor(BUDGET * 0.6)));
  });

  it("caps at 20% of budget between 75-85% usage", () => {
    const input80 = 160_000;
    const result = computeThinkingBudget(input80, BUDGET, CTX);
    expect(result).toBe(Math.max(1024, Math.min(1024, Math.floor(BUDGET * 0.2))));
  });

  it("returns 1024 above 85% usage", () => {
    const input90 = 180_000;
    expect(computeThinkingBudget(input90, BUDGET, CTX)).toBe(1024);
  });

  it("returns 1024 when available space is zero or negative", () => {
    // input tokens + reserve exceeds context
    expect(computeThinkingBudget(CTX, BUDGET, CTX)).toBe(1024);
  });

  it("enforces minimum of 1024", () => {
    // Small budget with high usage
    expect(computeThinkingBudget(50_000, 500, CTX)).toBe(1024);
  });

  it("never exceeds baseline budget", () => {
    const result = computeThinkingBudget(10_000, BUDGET, CTX);
    expect(result).toBeLessThanOrEqual(BUDGET);
  });
});
