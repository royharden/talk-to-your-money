import { Transaction } from "./types";

const AUTO_ACCEPT_THRESHOLD = 0.75;
const RECURRING_THRESHOLD = 0.7;
const RECURRING_AMOUNT_TOLERANCE = 0.10;

/** Determine if a categorized transaction should be auto-accepted or needs review */
export function applyCategoryPolicy(
  category: string,
  confidence: number,
  categorySource: string
): { needs_review: boolean; auto_accepted: boolean } {
  if (categorySource === "rule") {
    return { needs_review: false, auto_accepted: true };
  }
  if (categorySource === "fallback") {
    return { needs_review: true, auto_accepted: false };
  }
  if (confidence >= AUTO_ACCEPT_THRESHOLD && category !== "Other" && category !== "uncertain") {
    return { needs_review: false, auto_accepted: true };
  }
  return { needs_review: true, auto_accepted: false };
}

/** Check if a transaction is recurring based on Jev's recurring_p + code-based verification */
export function detectRecurring(
  merchant: string,
  recurringP: number,
  allTxs: Transaction[]
): { is_recurring: boolean; next_date?: string } {
  if (recurringP < RECURRING_THRESHOLD) {
    return { is_recurring: false };
  }

  const merchantTxs = allTxs
    .filter((t) => t.merchant === merchant && t.amount_cents < 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (merchantTxs.length < 2) {
    return { is_recurring: false };
  }

  // Check spacing patterns: ~7, 14, 30, 365 days with ±3 tolerance
  const intervals: number[] = [];
  for (let i = 1; i < merchantTxs.length; i++) {
    const diff = Math.round(
      (new Date(merchantTxs[i].date).getTime() - new Date(merchantTxs[i - 1].date).getTime()) /
        (1000 * 60 * 60 * 24)
    );
    intervals.push(diff);
  }

  const validPatterns = [7, 14, 30, 365];
  const matchesPattern = intervals.some((interval) =>
    validPatterns.some((p) => Math.abs(interval - p) <= 3)
  );

  if (!matchesPattern) {
    return { is_recurring: false };
  }

  // Check amounts within 10%
  const amounts = merchantTxs.map((t) => Math.abs(t.amount_cents));
  const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
  const amountsConsistent = amounts.every(
    (a) => Math.abs(a - avgAmount) / avgAmount <= RECURRING_AMOUNT_TOLERANCE
  );

  if (!amountsConsistent) {
    return { is_recurring: false };
  }

  // Predict next date
  const avgInterval = Math.round(intervals.reduce((s, a) => s + a, 0) / intervals.length);
  const lastDate = merchantTxs[merchantTxs.length - 1].date;
  const next = new Date(lastDate);
  next.setDate(next.getDate() + avgInterval);

  return { is_recurring: true, next_date: next.toISOString().slice(0, 10) };
}

/** Compute top 3 options from Jev probabilities for the review queue */
export function topThreeOptions(probabilities: Record<string, number> | undefined): { category: string; probability: number }[] {
  if (!probabilities) return [];
  return Object.entries(probabilities)
    .map(([category, probability]) => ({ category, probability }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3);
}

export const POLICY = {
  AUTO_ACCEPT_THRESHOLD,
  RECURRING_THRESHOLD,
  RECURRING_AMOUNT_TOLERANCE,
};

/** Cost estimate: input_tokens * 0.042 / 1_000_000 USD */
export function estimateJevCost(inputTokens: number): number {
  return (inputTokens * 0.042) / 1_000_000;
}

/** Estimated cost if every transaction was processed by an LLM individually */
export const LLM_PER_TX_COST = 0.001;
