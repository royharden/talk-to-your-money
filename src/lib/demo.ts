import { Transaction } from "./types";

/** Recorded Jev responses for offline replay */
export const RECORDED_JEV_RESPONSES: Record<string, any> = {
  categorize: {
    model: "jev-1.13.0",
    answers: {
      tx0__category: { type: "choice", choice: "dining", confidence: 0.93, probabilities: { dining: 0.93, groceries: 0.04, other: 0.03 } },
      tx0__recurring: { type: "noul", noul: 0.12 },
      tx1__category: { type: "choice", choice: "groceries", confidence: 0.89, probabilities: { groceries: 0.89, shopping: 0.07, other: 0.04 } },
      tx1__recurring: { type: "noul", noul: 0.08 },
    },
    usage: { input_tokens: 450, output_tokens: 120 },
  },
  route: {
    spend_by_category: { intent: "spend_by_category", intent_confidence: 0.95, period: "this_month", category: "none" },
    top_merchants: { intent: "top_merchants", intent_confidence: 0.92, period: "last_month", category: "none" },
    budget_status: { intent: "budget_status", intent_confidence: 0.90, period: "this_month", category: "none" },
    income_vs_spend: { intent: "income_vs_spend", intent_confidence: 0.88, period: "this_month", category: "none" },
    recurring_list: { intent: "recurring_list", intent_confidence: 0.91, period: "this_month", category: "none" },
    compare_periods: { intent: "compare_periods", intent_confidence: 0.87, period: "last_month", category: "none" },
  },
};

/** 10 sample questions for offline/demo */
export const SAMPLE_QUESTIONS = [
  "Where did my money go this month?",
  "How much did I spend on dining?",
  "What are my top merchants?",
  "Am I over budget on anything?",
  "What are my recurring charges?",
  "How does this month compare to last month?",
  "Show me my income vs spending",
  "How much did I spend on groceries last month?",
  "Find my Chipotle transactions",
  "What's my biggest category?",
];

/** Template answers for offline mode */
export const OFFLINE_TEMPLATES: Record<string, (r: any) => string> = {
  spend_by_category: (r) => {
    const rows = r.rows || [];
    if (!rows.length) return "No spending data found for this period.";
    const top = rows.slice(0, 3);
    const lines = top.map((row: any) => `${row.category}: $${(row.total_cents / 100).toFixed(2)}`);
    return `Here's your spending breakdown:\n${lines.join("\n")}\n\nTotal: $${(r.total_cents / 100).toFixed(2)}`;
  },
  spend_by_merchant: (r) => {
    const rows = r.rows || [];
    if (!rows.length) return "No spending found at that merchant.";
    const total = (r.total_cents / 100).toFixed(2);
    return `You spent $${total} at ${rows[0]?.merchant || "that merchant"} across ${rows.length} transactions.`;
  },
  compare_periods: (r) => {
    const a = (r.period_a_total / 100).toFixed(2);
    const b = (r.period_b_total / 100).toFixed(2);
    const diff = Math.abs((r.period_a_total - r.period_b_total) / 100).toFixed(2);
    const dir = r.period_a_total > r.period_b_total ? "up" : "down";
    return `This period: $${a}, last period: $${b}. Spending is ${dir} by $${diff}.`;
  },
  top_merchants: (r) => {
    const rows = r.rows || [];
    if (!rows.length) return "No merchant data found.";
    const lines = rows.slice(0, 5).map((row: any, i: number) => `${i + 1}. ${row.merchant}: $${(row.total_cents / 100).toFixed(2)}`);
    return `Your top merchants:\n${lines.join("\n")}`;
  },
  budget_status: (r) => {
    const rows = r.rows || [];
    if (!rows.length) return "No budgets set for this month.";
    const lines = rows.map((row: any) => {
      const pct = Math.round((row.spent_cents / row.budget_cents) * 100);
      const status = pct >= 100 ? "over budget" : pct >= 80 ? "approaching limit" : "on track";
      return `${row.category}: $${(row.spent_cents / 100).toFixed(2)} / $${(row.budget_cents / 100).toFixed(2)} (${pct}%, ${status})`;
    });
    return `Budget status:\n${lines.join("\n")}`;
  },
  income_vs_spend: (r) => {
    const inc = (r.income_cents / 100).toFixed(2);
    const spd = Math.abs((r.spend_cents / 100)).toFixed(2);
    const net = ((r.income_cents + r.spend_cents) / 100).toFixed(2);
    return `Income: $${inc}, Spending: $${spd}, Net: $${net}.`;
  },
  recurring_list: (r) => {
    const rows = r.rows || [];
    if (!rows.length) return "No recurring charges detected.";
    const lines = rows.map((row: any) => `${row.merchant}: $${(row.amount_cents / 100).toFixed(2)} — next ~${row.next_date}`);
    return `Recurring charges:\n${lines.join("\n")}`;
  },
  find_transaction: (r) => {
    const rows = r.rows || [];
    if (!rows.length) return "No matching transactions found.";
    const lines = rows.slice(0, 5).map((row: any) => `${row.date} ${row.merchant} $${(row.amount_cents / 100).toFixed(2)}`);
    return `Found ${r.total_count || rows.length} matching transactions:\n${lines.join("\n")}`;
  },
  set_budget: () => "Budget updated. You can adjust it anytime in the Budgets panel.",
  unsupported: () => "I'm not sure how to answer that. Try asking about spending by category, top merchants, budgets, or recurring charges.",
  uncertain: () => "I'm not sure what you're asking. Try: \"How much did I spend on dining?\" or \"What are my top merchants?\"",
};

/** Offline question router — keyword-based */
export function offlineRoute(text: string): { intent: string; confidence: number; period: string; category: string } {
  const t = text.toLowerCase();
  let intent = "unsupported";
  let category = "none";
  let period = "this_month";

  if (/last month/.test(t)) period = "last_month";
  else if (/last 30/.test(t)) period = "last_30_days";
  else if (/last 90/.test(t)) period = "last_90_days";
  else if (/this year/.test(t)) period = "this_year";

  if (/categor|breakdown|where.*money|spend.*on|biggest category/.test(t)) intent = "spend_by_category";
  else if (/merchant|store|shop.*at/.test(t)) intent = "spend_by_merchant";
  else if (/compare|vs|versus|last.*this|difference/.test(t)) intent = "compare_periods";
  else if (/top|biggest|largest|most/.test(t)) intent = "top_merchants";
  else if (/budget|limit|over.*budget/.test(t)) intent = "budget_status";
  else if (/income|earn|make|deposit|paycheck/.test(t)) intent = "income_vs_spend";
  else if (/recurring|subscription|monthly|repeated/.test(t)) intent = "recurring_list";
  else if (/find|search|when.*did|show me/.test(t)) intent = "find_transaction";

  const cats = ["Groceries", "Dining", "Transport", "Rent/Housing", "Utilities", "Subscriptions", "Shopping", "Health", "Entertainment", "Travel", "Income", "Transfers", "Fees"];
  for (const c of cats) {
    if (t.includes(c.toLowerCase())) {
      category = c;
      break;
    }
  }

  return { intent, confidence: 0.85, period, category };
}
