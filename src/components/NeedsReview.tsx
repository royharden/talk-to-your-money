import { useEffect, useState, useCallback } from "react";
import { Check, ChevronDown, Inbox, CheckCheck } from "lucide-react";
import { Transaction } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { apiConfirmCategory, apiBulkConfirm } from "@/lib/api";
import { formatCurrency, formatDate, formatConfidence } from "@/lib/format";
import { CATEGORY_COLORS, CATEGORIES } from "@/lib/categories";
import { ConfidenceDot, CategoryChip } from "@/components/Shared";

export function NeedsReview({ onReviewed }: { onReviewed: () => void }) {
  const [items, setItems] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("needs_review", true)
      .order("date", { ascending: false });
    if (error) {
      console.error(error);
      setLoading(false);
      return;
    }
    setItems(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleConfirm = useCallback(async (tx: Transaction, category: string) => {
    try {
      await apiConfirmCategory(tx.id, category);
    } catch (err) {
      console.error(err);
      return;
    }
    setItems((prev) => prev.filter((t) => t.id !== tx.id));
    onReviewed();
  }, [onReviewed]);

  const handleBulkAccept = useCallback(async () => {
    const highConf = items.filter((t) => Number(t.category_conf) >= 0.6);
    if (highConf.length === 0) return;

    try {
      await apiBulkConfirm(highConf.map((t) => t.id));
    } catch (err) {
      console.error(err);
      return;
    }
    setItems((prev) => prev.filter((t) => Number(t.category_conf) < 0.6));
    onReviewed();
  }, [items, onReviewed]);

  const handleSetCategory = useCallback(async (tx: Transaction, category: string) => {
    await handleConfirm(tx, category);
  }, [handleConfirm]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-slate-400">Loading review queue...</div>;
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
        <Inbox className="w-12 h-12 text-slate-300" />
        <p className="text-sm">All caught up! No transactions need review.</p>
      </div>
    );
  }

  const highConfCount = items.filter((t) => Number(t.category_conf) >= 0.6).length;

  // Get top 3 options from jev_response
  const getOptions = (tx: Transaction): { category: string; probability: number }[] => {
    if (!tx.jev_response?.probabilities) {
      return [{ category: tx.category, probability: Number(tx.category_conf) }];
    }
    return Object.entries(tx.jev_response.probabilities)
      .map(([category, probability]) => ({ category, probability: probability as number }))
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 3);
  };

  const mapCategoryKey = (key: string): string => {
    const map: Record<string, string> = {
      groceries: "Groceries", dining: "Dining", transport: "Transport", housing: "Rent/Housing",
      utilities: "Utilities", subscriptions: "Subscriptions", shopping: "Shopping", health: "Health",
      entertainment: "Entertainment", travel: "Travel", income: "Income", transfers: "Transfers",
      fees: "Fees", other: "Other", uncertain: "Other",
    };
    return map[key] || key.charAt(0).toUpperCase() + key.slice(1);
  };

  return (
    <div className="overflow-y-auto h-full p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Needs You</h2>
          <p className="text-sm text-slate-500">{items.length} transaction{items.length !== 1 ? "s" : ""} need categorization</p>
        </div>
        {highConfCount > 0 && (
          <button
            onClick={handleBulkAccept}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
          >
            <CheckCheck className="w-4 h-4" />
            Bulk accept ({highConfCount} above 60%)
          </button>
        )}
      </div>

      <div className="space-y-3">
        {items.map((tx) => {
          const options = getOptions(tx);
          const isExpanded = expanded === tx.id;
          return (
            <div key={tx.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <ConfidenceDot confidence={Number(tx.category_conf)} source={tx.category_source} />
                      <span className="font-medium text-slate-800">{tx.merchant}</span>
                      <CategoryChip category={tx.category} small />
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {formatDate(tx.date)} · {formatCurrency(tx.amount_cents)} · {formatConfidence(Number(tx.category_conf))}
                      {tx.category_source === "fallback" && " · Fallback (not Jev)"}
                    </div>
                  </div>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : tx.id)}
                    className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"
                  >
                    <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                  </button>
                </div>

                {/* Top 3 options with probability bars */}
                <div className="mt-3 space-y-2">
                  {options.map((opt, i) => {
                    const catName = mapCategoryKey(opt.category);
                    const color = CATEGORY_COLORS[catName] || "#94a3b8";
                    return (
                      <button
                        key={i}
                        onClick={() => handleSetCategory(tx, catName)}
                        className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 transition-colors group"
                      >
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm text-slate-700">{catName}</span>
                            <span className="text-xs text-slate-400">{Math.round(opt.probability * 100)}%</span>
                          </div>
                          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${opt.probability * 100}%`, background: color }}
                            />
                          </div>
                        </div>
                        <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                          <Check className="w-4 h-4 text-emerald-600" />
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Expanded: full category list */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <p className="text-xs text-slate-400 mb-2">Choose a different category:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {CATEGORIES.filter((c) => c !== tx.category).map((c) => (
                        <button
                          key={c}
                          onClick={() => handleSetCategory(tx, c)}
                          className="px-2 py-1 text-xs rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
