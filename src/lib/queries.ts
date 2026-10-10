import { supabase } from "./supabase";
import { Transaction, Budget } from "./types";
import { currentMonthISO } from "./format";

/** Period resolution: returns {start, end} ISO dates */
export function resolvePeriod(period: string): { start: string; end: string } {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  switch (period) {
    case "this_month": {
      const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const end = nextMonth.toISOString().slice(0, 10);
      return { start, end };
    }
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    }
    case "last_30_days": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { start: d.toISOString().slice(0, 10), end: today };
    }
    case "last_90_days": {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return { start: d.toISOString().slice(0, 10), end: today };
    }
    case "this_year": {
      return { start: `${now.getFullYear()}-01-01`, end: today };
    }
    default:
      return { start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`, end: today };
  }
}

/** Fetch transactions in a date range */
async function fetchTransactions(start: string, end: string): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .gte("date", start)
    .lt("date", end)
    .order("date", { ascending: false });
  if (error) throw error;
  return data || [];
}

/** All transactions (no date filter) */
async function fetchAllTransactions(): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .order("date", { ascending: false });
  if (error) throw error;
  return data || [];
}

/** Spend by category */
export async function querySpendByCategory(period: string, category?: string) {
  const { start, end } = resolvePeriod(period);
  const txs = await fetchTransactions(start, end);
  const spend = txs.filter((t) => t.amount_cents < 0);

  if (category && category !== "none") {
    const filtered = spend.filter((t) => t.category === category);
    const total = filtered.reduce((s, t) => s + Math.abs(t.amount_cents), 0);
    return {
      query_name: "spend_by_category",
      result: {
        category,
        total_cents: total,
        rows: filtered.map((t) => ({ date: t.date, merchant: t.merchant, amount_cents: t.amount_cents })),
        transaction_count: filtered.length,
      },
    };
  }

  const byCat: Record<string, number> = {};
  for (const t of spend) {
    byCat[t.category] = (byCat[t.category] || 0) + Math.abs(t.amount_cents);
  }
  const rows = Object.entries(byCat)
    .map(([category, total_cents]) => ({ category, total_cents }))
    .sort((a, b) => b.total_cents - a.total_cents);
  const total = rows.reduce((s, r) => s + r.total_cents, 0);

  return {
    query_name: "spend_by_category",
    result: { rows, total_cents: total, period: { start, end } },
  };
}

/** Spend by merchant */
export async function querySpendByMerchant(period: string, merchant?: string) {
  const { start, end } = resolvePeriod(period);
  const txs = await fetchTransactions(start, end);
  const spend = txs.filter((t) => t.amount_cents < 0);

  if (merchant) {
    const filtered = spend.filter((t) => t.merchant.toUpperCase().includes(merchant.toUpperCase()));
    const total = filtered.reduce((s, t) => s + Math.abs(t.amount_cents), 0);
    return {
      query_name: "spend_by_merchant",
      result: { merchant, total_cents: total, rows: filtered, transaction_count: filtered.length },
    };
  }

  const byMerch: Record<string, { total: number; count: number }> = {};
  for (const t of spend) {
    if (!byMerch[t.merchant]) byMerch[t.merchant] = { total: 0, count: 0 };
    byMerch[t.merchant].total += Math.abs(t.amount_cents);
    byMerch[t.merchant].count += 1;
  }
  const rows = Object.entries(byMerch)
    .map(([merchant, v]) => ({ merchant, total_cents: v.total, count: v.count }))
    .sort((a, b) => b.total_cents - a.total_cents);

  return { query_name: "spend_by_merchant", result: { rows } };
}

/** Top merchants */
export async function queryTopMerchants(period: string, n: number = 5) {
  const { start, end } = resolvePeriod(period);
  const txs = await fetchTransactions(start, end);
  const spend = txs.filter((t) => t.amount_cents < 0);

  const byMerch: Record<string, { total: number; count: number }> = {};
  for (const t of spend) {
    if (!byMerch[t.merchant]) byMerch[t.merchant] = { total: 0, count: 0 };
    byMerch[t.merchant].total += Math.abs(t.amount_cents);
    byMerch[t.merchant].count += 1;
  }
  const rows = Object.entries(byMerch)
    .map(([merchant, v]) => ({ merchant, total_cents: v.total, count: v.count }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, n);

  return { query_name: "top_merchants", result: { rows, n } };
}

/** Compare two periods */
export async function queryComparePeriods(periodA: string, periodB: string) {
  const a = await querySpendByCategory(periodA);
  const b = await querySpendByCategory(periodB);
  return {
    query_name: "compare_periods",
    result: {
      period_a: periodA,
      period_b: periodB,
      period_a_total: a.result.total_cents,
      period_b_total: b.result.total_cents,
      period_a_rows: a.result.rows,
      period_b_rows: b.result.rows,
      difference: a.result.total_cents - b.result.total_cents,
    },
  };
}

/** Budget status for a month */
export async function queryBudgetStatus(month?: string) {
  const m = month || currentMonthISO();
  const { start, end } = {
    start: m,
    end: new Date(new Date(m).getFullYear(), new Date(m).getMonth() + 1, 1)
      .toISOString()
      .slice(0, 10),
  };

  const { data: budgets, error } = await supabase
    .from("budgets")
    .select("*")
    .eq("month", m);
  if (error) throw error;

  const txs = await fetchTransactions(start, end);
  const spend = txs.filter((t) => t.amount_cents < 0);

  const byCat: Record<string, number> = {};
  for (const t of spend) {
    byCat[t.category] = (byCat[t.category] || 0) + Math.abs(t.amount_cents);
  }

  const rows = (budgets || []).map((b: Budget) => {
    const spent = byCat[b.category] || 0;
    const pct = b.amount_cents > 0 ? (spent / b.amount_cents) * 100 : 0;
    const dayOfMonth = new Date().getDate();
    const daysInMonth = new Date(new Date(m).getFullYear(), new Date(m).getMonth() + 1, 0).getDate();
    const projected = (spent / dayOfMonth) * daysInMonth;
    return {
      category: b.category,
      budget_cents: b.amount_cents,
      spent_cents: spent,
      pct: Math.round(pct),
      projected_cents: Math.round(projected),
      status: pct >= 100 ? "over" : pct >= 80 ? "warning" : "ok",
    };
  });

  return { query_name: "budget_status", result: { month: m, rows } };
}

/** Income vs spend */
export async function queryIncomeVsSpend(period: string) {
  const { start, end } = resolvePeriod(period);
  const txs = await fetchTransactions(start, end);
  const income = txs.filter((t) => t.amount_cents > 0).reduce((s, t) => s + t.amount_cents, 0);
  const spend = txs.filter((t) => t.amount_cents < 0).reduce((s, t) => s + t.amount_cents, 0);
  return {
    query_name: "income_vs_spend",
    result: {
      income_cents: income,
      spend_cents: spend,
      net_cents: income + spend,
      period: { start, end },
    },
  };
}

/** Recurring charges */
export async function queryRecurringList() {
  const allTxs = await fetchAllTransactions();
  const byMerch: Record<string, Transaction[]> = {};
  for (const t of allTxs) {
    if (t.recurring_p >= 0.7) {
      if (!byMerch[t.merchant]) byMerch[t.merchant] = [];
      byMerch[t.merchant].push(t);
    }
  }

  const rows = Object.entries(byMerch)
    .map(([merchant, txs]) => {
      txs.sort((a, b) => a.date.localeCompare(b.date));
      const amounts = txs.map((t) => Math.abs(t.amount_cents));
      const avgAmount = Math.round(amounts.reduce((s, a) => s + a, 0) / amounts.length);
      const lastDate = txs[txs.length - 1].date;

      // Detect spacing
      const intervals: number[] = [];
      for (let i = 1; i < txs.length; i++) {
        const diff = Math.round(
          (new Date(txs[i].date).getTime() - new Date(txs[i - 1].date).getTime()) / (1000 * 60 * 60 * 24)
        );
        intervals.push(diff);
      }
      const avgInterval = intervals.length > 0 ? Math.round(intervals.reduce((s, a) => s + a, 0) / intervals.length) : 30;

      // Predict next date
      const last = new Date(lastDate);
      last.setDate(last.getDate() + avgInterval);
      const nextDate = last.toISOString().slice(0, 10);

      return {
        merchant,
        amount_cents: avgAmount,
        count: txs.length,
        last_date: lastDate,
        next_date: nextDate,
        interval_days: avgInterval,
      };
    })
    .sort((a, b) => a.next_date.localeCompare(b.next_date));

  return { query_name: "recurring_list", result: { rows } };
}

/** Find transaction */
export async function queryFindTransaction(search: string, period?: string) {
  let txs: Transaction[];
  if (period && period !== "uncertain") {
    const { start, end } = resolvePeriod(period);
    txs = await fetchTransactions(start, end);
  } else {
    txs = await fetchAllTransactions();
  }

  const searchLower = search.toLowerCase();
  const filtered = txs.filter(
    (t) =>
      t.merchant.toLowerCase().includes(searchLower) ||
      t.description.toLowerCase().includes(searchLower) ||
      t.category.toLowerCase().includes(searchLower)
  );

  return {
    query_name: "find_transaction",
    result: { rows: filtered.slice(0, 20), total_count: filtered.length, search },
  };
}

/** Dispatch query by intent */
export async function runQuery(
  intent: string,
  period: string,
  category: string,
  question: string
): Promise<{ query_name: string; result: any }> {
  switch (intent) {
    case "spend_by_category":
      return querySpendByCategory(period, category !== "none" ? category : undefined);
    case "spend_by_merchant":
      return querySpendByMerchant(period);
    case "compare_periods":
      return queryComparePeriods(period, "last_month");
    case "top_merchants":
      return queryTopMerchants(period);
    case "budget_status":
      return queryBudgetStatus();
    case "income_vs_spend":
      return queryIncomeVsSpend(period);
    case "recurring_list":
      return queryRecurringList();
    case "find_transaction":
      return queryFindTransaction(question);
    case "set_budget":
      return { query_name: "set_budget", result: { ok: true } };
    default:
      return { query_name: "unsupported", result: {} };
  }
}
