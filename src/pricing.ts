interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING_TABLE: Array<{ prefix: string; pricing: ModelPricing }> = [
  { prefix: "claude-opus-4",    pricing: { inputPerMillion: 15,   outputPerMillion: 75 } },
  { prefix: "claude-sonnet-4",  pricing: { inputPerMillion: 3,    outputPerMillion: 15 } },
  { prefix: "claude-haiku-4",   pricing: { inputPerMillion: 0.80, outputPerMillion: 4 } },
  { prefix: "claude-haiku-3.5", pricing: { inputPerMillion: 0.80, outputPerMillion: 4 } },
  { prefix: "claude-haiku-3",   pricing: { inputPerMillion: 0.25, outputPerMillion: 1.25 } },
];

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { input: number; output: number; total: number } | null {
  const entry = PRICING_TABLE.find((e) => model.startsWith(e.prefix));
  if (!entry) return null;
  const input = (inputTokens / 1_000_000) * entry.pricing.inputPerMillion;
  const output = (outputTokens / 1_000_000) * entry.pricing.outputPerMillion;
  return { input, output, total: input + output };
}

export function formatUSD(amount: number): string {
  if (amount < 0.01) return "<$0.01";
  return "$" + amount.toFixed(2);
}
