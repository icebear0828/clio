export function computeThinkingBudget(
  estimatedInputTokens: number,
  baselineBudget: number,
  contextLimit: number,
): number {
  if (baselineBudget <= 0) return 0;

  const reserveForOutput = 16384;
  const available = contextLimit - estimatedInputTokens - reserveForOutput;
  if (available <= 0) return 1024;

  const usage = estimatedInputTokens / contextLimit;

  let scaled: number;
  if (usage <= 0.5) {
    scaled = baselineBudget;
  } else if (usage <= 0.75) {
    const factor = 1 - (usage - 0.5) * 2;
    scaled = Math.floor(baselineBudget * factor);
  } else if (usage <= 0.85) {
    scaled = Math.min(1024, Math.floor(baselineBudget * 0.2));
  } else {
    scaled = 1024;
  }

  return Math.max(1024, Math.min(scaled, baselineBudget));
}
