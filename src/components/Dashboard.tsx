import { useEffect, useState, useCallback } from "react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, Calendar, AlertTriangle, ArrowRight } from "lucide-react";
import { Transaction, Budget } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { formatCurrency, formatCurrencyShort, formatMonth, currentMonthISO, lastMonthISO } from "@/lib/format";
import { CATEGORY_COLORS } from "@/lib/categories";
import { CategoryChip } from "@/components/Shared";

interface DashboardData {
  thisMonthSpend: number;
  lastMonthSpend: number;
  categoryBreakdown: { category: string; total_cents: number }[];
  monthlyBars: { month: string; spend: number; income: number }[];
  topMerchants: { merchant: string; total_cents: number; count: number }[];
  recurring: { merchant: string; amount_cents: number; next_date: string }[];
  budgets: (Budget & { spent_cents: number; pct: number; status: string })[];
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const now = new Date();
      const thisMonth = currentMonthISO();
      const lastMonth = lastMonthISO();

      const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

      // This month transactions
      const { data: thisMonthTxs } = await supabase
        .from("transactions")
        .select("*")
        .gte("date", thisMonth)
        .lt("date", thisMonthEnd);

      // Last month transactions
      const { data: lastMonthTxs } = await supabase
        .from("transactions")
        .select("*")
        .gte("date", lastMonth)
        .lt("date", thisMonth);

      // All transactions for 3-month bar chart
      const { data: allTxs } = await supabase
        .from("transactions")
        .select("*")
        .gte("date", "2026-07-01")
        .lt("date", thisMonthEnd);

      // Budgets
      const { data: budgets } = await supabase
        .from("budgets")
        .select("*")
        .eq("month", thisMonth);

      const tmTxs = (thisMonthTxs || []) as Transaction[];
      const lmTxs = (lastMonthTxs || []) as Transaction[];
      const allTransactions = (allTxs || []) as Transaction[];

      const thisMonthSpend = tmTxs.filter((t) => t.amount_cents < 0).reduce((s, t) => s + Math.abs(t.amount_cents), 0);
      const lastMonthSpend = lmTxs.filter((t) => t.amount_cents < 0).reduce((s, t) => s + Math.abs(t.amount_cents), 0);

      // Category breakdown this month
      const byCat: Record<string, number> = {};
      for (const t of tmTxs) {
        if (t.amount_cents < 0) {
          byCat[t.category] = (byCat[t.category] || 0) + Math.abs(t.amount_cents);
        }
      }
      const categoryBreakdown = Object.entries(byCat)
        .map(([category, total_cents]) => ({ category, total_cents }))
        .sort((a, b) => b.total_cents - a.total_cents);

      // Monthly bars (3 months)
      const months = ["2026-07-01", "2026-08-01", "2026-09-01"];
      const monthEnds = ["2026-08-01", "2026-09-01", thisMonthEnd];
      const monthlyBars = months.map((m, i) => {
        const txs = allTransactions.filter((t) => t.date >= m && t.date < monthEnds[i]);
        const spend = txs.filter((t) => t.amount_cents < 0).reduce((s, t) => s + Math.abs(t.amount_cents), 0);
        const income = txs.filter((t) => t.amount_cents > 0).reduce((s, t) => s + t.amount_cents, 0);
        return { month: formatMonth(m), spend, income };
      });

      // Top merchants this month
      const byMerch: Record<string, { total: number; count: number }> = {};
      for (const t of tmTxs) {
        if (t.amount_cents < 0) {
          if (!byMerch[t.merchant]) byMerch[t.merchant] = { total: 0, count: 0 };
          byMerch[t.merchant].total += Math.abs(t.amount_cents);
          byMerch[t.merchant].count += 1;
        }
      }
      const topMerchants = Object.entries(byMerch)
        .map(([merchant, v]) => ({ merchant, total_cents: v.total, count: v.count }))
        .sort((a, b) => b.total_cents - a.total_cents)
        .slice(0, 5);

      // Recurring charges
      const recurringMap: Record<string, { txs: Transaction[] }> = {};
      for (const t of allTransactions) {
        if (t.recurring_p >= 0.7) {
          if (!recurringMap[t.merchant]) recurringMap[t.merchant] = { txs: [] };
          recurringMap[t.merchant].txs.push(t);
        }
      }
      const recurring = Object.entries(recurringMap)
        .map(([merchant, v]) => {
          const txs = v.txs.sort((a, b) => a.date.localeCompare(b.date));
          const avgAmount = Math.round(txs.reduce((s, t) => s + Math.abs(t.amount_cents), 0) / txs.length);
          const lastDate = txs[txs.length - 1].date;
          const intervals: number[] = [];
          for (let i = 1; i < txs.length; i++) {
            intervals.push(Math.round((new Date(txs[i].date).getTime() - new Date(txs[i - 1].date).getTime()) / 86400000));
          }
          const avgInterval = intervals.length > 0 ? Math.round(intervals.reduce((s, a) => s + a, 0) / intervals.length) : 30;
          const next = new Date(lastDate);
          next.setDate(next.getDate() + avgInterval);
          return { merchant, amount_cents: avgAmount, next_date: next.toISOString().slice(0, 10) };
        })
        .sort((a, b) => a.next_date.localeCompare(b.next_date))
        .slice(0, 6);

      // Budget progress
      const spendByCat: Record<string, number> = {};
      for (const t of tmTxs) {
        if (t.amount_cents < 0) {
          spendByCat[t.category] = (spendByCat[t.category] || 0) + Math.abs(t.amount_cents);
        }
      }
      const budgetRows = (budgets || []).map((b: Budget) => {
        const spent = spendByCat[b.category] || 0;
        const pct = b.amount_cents > 0 ? (spent / b.amount_cents) * 100 : 0;
        return { ...b, spent_cents: spent, pct: Math.round(pct), status: pct >= 100 ? "over" : pct >= 80 ? "warning" : "ok" };
      });

      setData({
        thisMonthSpend,
        lastMonthSpend,
        categoryBreakdown,
        monthlyBars,
        topMerchants,
        recurring,
        budgets: budgetRows,
      });
    } catch (err) {
      console.error("Dashboard error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) {
    return <div className="flex items-center justify-center h-full text-slate-400">Loading dashboard...</div>;
  }

  const monthChange = data.lastMonthSpend > 0
    ? ((data.thisMonthSpend - data.lastMonthSpend) / data.lastMonthSpend) * 100
    : 0;

  const pieData = data.categoryBreakdown.map((r) => ({
    name: r.category,
    value: r.total_cents,
    color: CATEGORY_COLORS[r.category] || "#94a3b8",
  }));

  return (
    <div className="overflow-y-auto h-full p-5 space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="This Month"
          value={formatCurrency(data.thisMonthSpend)}
          icon={<Wallet className="w-4 h-4" />}
          accent="emerald"
        />
        <SummaryCard
          label="Last Month"
          value={formatCurrency(data.lastMonthSpend)}
          icon={<Calendar className="w-4 h-4" />}
          accent="slate"
        />
        <SummaryCard
          label="Change"
          value={`${monthChange >= 0 ? "+" : ""}${monthChange.toFixed(0)}%`}
          icon={monthChange >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
          accent={monthChange >= 0 ? "amber" : "emerald"}
        />
        <SummaryCard
          label="Categories"
          value={String(data.categoryBreakdown.length)}
          icon={<ArrowRight className="w-4 h-4" />}
          accent="blue"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Category donut */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Spending by Category</h3>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: any) => formatCurrency(Number(v))}
                  contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0", fontSize: "12px" }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[240px] flex items-center justify-center text-slate-300 text-sm">No data</div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {data.categoryBreakdown.slice(0, 8).map((r) => (
              <div key={r.category} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: CATEGORY_COLORS[r.category] || "#94a3b8" }} />
                <span className="text-xs text-slate-500 flex-1 truncate">{r.category}</span>
                <span className="text-xs font-medium text-slate-700">{formatCurrencyShort(r.total_cents)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Monthly bars */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Monthly Spend vs Income</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.monthlyBars} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCurrencyShort(v)} />
              <Tooltip formatter={(v: any) => formatCurrency(Number(v))} contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0", fontSize: "12px" }} />
              <Legend wrapperStyle={{ fontSize: "12px" }} />
              <Bar dataKey="spend" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Spend" />
              <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} name="Income" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Budget bars + Top merchants */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Budget progress */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Budget Progress</h3>
          <div className="space-y-3">
            {data.budgets.length === 0 && <p className="text-sm text-slate-400">No budgets set</p>}
            {data.budgets.map((b) => (
              <div key={b.id}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <CategoryChip category={b.category} small />
                  <span className="font-medium text-slate-700">
                    {formatCurrency(b.spent_cents)} / {formatCurrency(b.amount_cents)}
                  </span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      b.status === "over" ? "bg-red-500" : b.status === "warning" ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.min(b.pct, 100)}%` }}
                  />
                </div>
                {b.status === "over" && (
                  <div className="flex items-center gap-1 mt-1 text-xs text-red-500">
                    <AlertTriangle className="w-3 h-3" /> Over budget
                  </div>
                )}
                {b.status === "warning" && (
                  <div className="flex items-center gap-1 mt-1 text-xs text-amber-600">
                    <AlertTriangle className="w-3 h-3" /> Approaching limit
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Top merchants */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Top Merchants This Month</h3>
          <div className="space-y-2">
            {data.topMerchants.length === 0 && <p className="text-sm text-slate-400">No spending yet</p>}
            {data.topMerchants.map((m, i) => (
              <div key={m.merchant} className="flex items-center gap-3">
                <span className="text-sm text-slate-400 w-5">{i + 1}</span>
                <span className="text-sm text-slate-700 flex-1 truncate">{m.merchant}</span>
                <span className="text-xs text-slate-400">{m.count} tx</span>
                <span className="text-sm font-medium text-slate-800">{formatCurrency(m.total_cents)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recurring charges */}
      {data.recurring.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Recurring Charges</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.recurring.map((r) => (
              <div key={r.merchant} className="flex items-center justify-between p-3 rounded-xl bg-slate-50">
                <div>
                  <div className="text-sm font-medium text-slate-700">{r.merchant}</div>
                  <div className="text-xs text-slate-400">Next: {r.next_date}</div>
                </div>
                <span className="text-sm font-semibold text-slate-800">{formatCurrency(r.amount_cents)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, icon, accent }: { label: string; value: string; icon: React.ReactNode; accent: string }) {
  const accents: Record<string, string> = {
    emerald: "text-emerald-600 bg-emerald-50",
    amber: "text-amber-600 bg-amber-50",
    slate: "text-slate-600 bg-slate-50",
    blue: "text-blue-600 bg-blue-50",
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={`p-1.5 rounded-lg ${accents[accent]}`}>{icon}</span>
        <span className="text-xs text-slate-500">{label}</span>
      </div>
      <p className="text-xl font-bold text-slate-800">{value}</p>
    </div>
  );
}
