import { useEffect, useState, useCallback } from "react";
import { BarChart3, Zap, DollarSign, TrendingUp, Gauge } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Transaction } from "@/lib/types";
import { estimateJevCost, LLM_PER_TX_COST } from "@/lib/policy";

interface StatsData {
  totalCalls: number;
  ingestCalls: number;
  jevCalls: number;
  answerCalls: number;
  totalTxs: number;
  jevTxs: number;
  ruleTxs: number;
  fallbackTxs: number;
  userTxs: number;
  autoAcceptRate: number;
  totalInputTokens: number;
  jevCost: number;
  llmPerTxCost: number;
  batches: number;
  questionsAsked: number;
}

export function Stats() {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Get transactions
      const { data: txs } = await supabase.from("transactions").select("*");
      const allTxs = (txs || []) as Transaction[];

      // Get questions
      const { count: questionCount } = await supabase
        .from("questions")
        .select("*", { count: "exact", head: true });

      // Count categories by source
      const jevTxs = allTxs.filter((t) => t.category_source === "jev").length;
      const ruleTxs = allTxs.filter((t) => t.category_source === "rule").length;
      const fallbackTxs = allTxs.filter((t) => t.category_source === "fallback").length;
      const userTxs = allTxs.filter((t) => t.category_source === "user").length;
      const autoAccepted = allTxs.filter((t) => !t.needs_review && t.category_source !== "rule" && t.category_source !== "user").length;
      const categorizable = jevTxs + fallbackTxs;
      const autoAcceptRate = categorizable > 0 ? (autoAccepted / categorizable) * 100 : 0;

      // Estimate tokens (rough: ~75 tokens per transaction in a batch)
      const estInputTokens = Math.ceil(jevTxs / 10) * 450;
      const jevCost = estimateJevCost(estInputTokens);

      setData({
        totalCalls: 0,
        ingestCalls: 0,
        jevCalls: Math.ceil(jevTxs / 10),
        answerCalls: questionCount || 0,
        totalTxs: allTxs.length,
        jevTxs,
        ruleTxs,
        fallbackTxs,
        userTxs,
        autoAcceptRate,
        totalInputTokens: estInputTokens,
        jevCost,
        llmPerTxCost: allTxs.length * LLM_PER_TX_COST,
        batches: Math.ceil(jevTxs / 10),
        questionsAsked: questionCount || 0,
      });
    } catch (err) {
      console.error("Stats error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) {
    return <div className="flex items-center justify-center h-full text-slate-400">Loading stats...</div>;
  }

  return (
    <div className="overflow-y-auto h-full p-5 space-y-5">
      <div>
        <h2 className="text-lg font-bold text-slate-800">Jev Stats</h2>
        <p className="text-sm text-slate-500">Efficiency of batched Jev categorization vs. per-transaction LLM calls</p>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Total Transactions"
          value={String(data.totalTxs)}
          icon={<BarChart3 className="w-4 h-4" />}
          accent="blue"
        />
        <MetricCard
          label="Jev Batches"
          value={String(data.batches)}
          icon={<Zap className="w-4 h-4" />}
          accent="emerald"
          sub={`${data.jevTxs} txs in ${data.batches} calls`}
        />
        <MetricCard
          label="Auto-Accept Rate"
          value={`${data.autoAcceptRate.toFixed(0)}%`}
          icon={<Gauge className="w-4 h-4" />}
          accent="amber"
          sub={`${data.ruleTxs} via rules, ${data.userTxs} user-confirmed`}
        />
        <MetricCard
          label="Questions Asked"
          value={String(data.questionsAsked)}
          icon={<TrendingUp className="w-4 h-4" />}
          accent="slate"
        />
      </div>

      {/* Cost comparison */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-emerald-500" />
          Cost Comparison: Jev vs. LLM-per-transaction
        </h3>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-slate-600">Jev (batched, 10 per request)</span>
              <span className="font-bold text-emerald-600">${data.jevCost.toFixed(6)}</span>
            </div>
            <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full"
                style={{ width: `${Math.min((data.jevCost / data.llmPerTxCost) * 100, 100)}%` }}
              />
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {data.totalInputTokens} input tokens × $0.042/M = ${data.jevCost.toFixed(6)}
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-slate-600">LLM per transaction (estimated)</span>
              <span className="font-bold text-slate-700">${data.llmPerTxCost.toFixed(2)}</span>
            </div>
            <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-slate-400 rounded-full" style={{ width: "100%" }} />
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {data.totalTxs} transactions × ${LLM_PER_TX_COST} = ${data.llmPerTxCost.toFixed(2)}
            </div>
          </div>
          <div className="pt-3 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">Savings</span>
              <span className="text-lg font-bold text-emerald-600">
                {data.jevCost > 0 ? `${((1 - data.jevCost / data.llmPerTxCost) * 100).toFixed(1)}%` : "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Category source breakdown */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Category Source Breakdown</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SourceStat label="Jev" value={data.jevTxs} color="#10b981" />
          <SourceStat label="Rules" value={data.ruleTxs} color="#3b82f6" />
          <SourceStat label="User" value={data.userTxs} color="#8b5cf6" />
          <SourceStat label="Fallback" value={data.fallbackTxs} color="#f59e0b" />
        </div>
      </div>

      {/* Usage note */}
      <div className="bg-slate-50 rounded-2xl p-4">
        <p className="text-xs text-slate-500">
          Daily cap: 200 calls per Edge Function per day. Usage is tracked server-side and cannot be reset from the browser.
          Cost constants are editable in <code className="text-slate-700">src/lib/policy.ts</code>.
        </p>
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon, accent, sub }: { label: string; value: string; icon: React.ReactNode; accent: string; sub?: string }) {
  const accents: Record<string, string> = {
    emerald: "text-emerald-600 bg-emerald-50",
    amber: "text-amber-600 bg-amber-50",
    blue: "text-blue-600 bg-blue-50",
    slate: "text-slate-600 bg-slate-50",
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={`p-1.5 rounded-lg ${accents[accent]}`}>{icon}</span>
        <span className="text-xs text-slate-500">{label}</span>
      </div>
      <p className="text-xl font-bold text-slate-800">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

function SourceStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <div className="w-3 h-3 rounded-full mx-auto mb-1" style={{ background: color }} />
      <div className="text-lg font-bold text-slate-800">{value}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  );
}
