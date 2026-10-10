import { useEffect, useState, useCallback, useMemo } from "react";
import { Search, Pencil, Check, X, Trash2 } from "lucide-react";
import { Transaction } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { formatCurrency, formatDate } from "@/lib/format";
import { CATEGORIES } from "@/lib/categories";
import { ConfidenceDot, CategoryChip, SourceIcon } from "@/components/Shared";
import { apiUpdateTransactionCategory, apiDeleteTransaction, apiDeleteAllData } from "@/lib/api";

export function Transactions({ onChanged }: { onChanged: () => void }) {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [editCat, setEditCat] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase.from("transactions").select("*").order("date", { ascending: false });
    if (filterCat !== "all") {
      query = query.eq("category", filterCat);
    }
    const { data, error } = await query.limit(200);
    if (error) {
      console.error(error);
      setLoading(false);
      return;
    }

    let filtered = data || [];
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(
        (t: Transaction) =>
          t.merchant.toLowerCase().includes(s) ||
          t.description.toLowerCase().includes(s) ||
          t.category.toLowerCase().includes(s)
      );
    }
    setTxs(filtered);
    setLoading(false);
  }, [search, filterCat]);

  useEffect(() => { load(); }, [load]);

  const handleEdit = useCallback(async (tx: Transaction) => {
    try {
      await apiUpdateTransactionCategory(tx.id, editCat);
    } catch (err) {
      console.error(err);
      return;
    }
    setEditing(null);
    load();
    onChanged();
  }, [editCat, load, onChanged]);

  const handleDelete = useCallback(async (tx: Transaction) => {
    try {
      await apiDeleteTransaction(tx.id);
    } catch (err) {
      console.error(err);
      return;
    }
    load();
    onChanged();
  }, [load, onChanged]);

  const handleDeleteAll = useCallback(async () => {
    if (!confirm("Delete ALL transactions? This cannot be undone.")) return;
    try {
      await apiDeleteAllData();
    } catch (err) {
      console.error(err);
      return;
    }
    load();
    onChanged();
  }, [load, onChanged]);

  const totalSpend = useMemo(
    () => txs.filter((t) => t.amount_cents < 0).reduce((s, t) => s + Math.abs(t.amount_cents), 0),
    [txs]
  );

  if (loading) {
    return <div className="flex items-center justify-center h-full text-slate-400">Loading transactions...</div>;
  }

  return (
    <div className="overflow-y-auto h-full p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Transactions</h2>
          <p className="text-sm text-slate-500">{txs.length} shown · Total spend: {formatCurrency(totalSpend)}</p>
        </div>
        <button
          onClick={handleDeleteAll}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
          Delete all my data
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search merchant, description, or category..."
            className="w-full pl-9 pr-4 py-2 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent"
          />
        </div>
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          className="px-3 py-2 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent bg-white"
        >
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Date</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500">Merchant</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 hidden sm:table-cell">Category</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-500">Amount</th>
              <th className="text-center px-4 py-2.5 text-xs font-medium text-slate-500 hidden md:table-cell">Source</th>
              <th className="text-center px-4 py-2.5 text-xs font-medium text-slate-500">Conf</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {txs.map((tx) => (
              <tr key={tx.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">{formatDate(tx.date)}</td>
                <td className="px-4 py-3 text-sm font-medium text-slate-800">
                  <div className="flex items-center gap-1.5">
                    <SourceIcon source={tx.source} />
                    {tx.merchant}
                  </div>
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  {editing === tx.id ? (
                    <select
                      value={editCat}
                      onChange={(e) => setEditCat(e.target.value)}
                      className="px-2 py-1 text-xs rounded-lg border border-slate-200 bg-white"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  ) : (
                    <CategoryChip category={tx.category} small />
                  )}
                </td>
                <td className={`px-4 py-3 text-sm font-medium text-right whitespace-nowrap ${tx.amount_cents < 0 ? "text-slate-800" : "text-emerald-600"}`}>
                  {formatCurrency(tx.amount_cents)}
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <span className="text-xs text-slate-400 capitalize">{tx.source}</span>
                </td>
                <td className="px-4 py-3 flex items-center justify-center">
                  <ConfidenceDot confidence={Number(tx.category_conf)} source={tx.category_source} />
                </td>
                <td className="px-4 py-3">
                  {editing === tx.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => handleEdit(tx)} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded">
                        <Check className="w-4 h-4" />
                      </button>
                      <button onClick={() => setEditing(null)} className="p-1 text-slate-400 hover:bg-slate-100 rounded">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { setEditing(tx.id); setEditCat(tx.category); }}
                        className="p-1 text-slate-400 hover:bg-slate-100 rounded"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(tx)}
                        className="p-1 text-slate-400 hover:bg-red-50 hover:text-red-500 rounded"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {txs.length === 0 && (
          <div className="p-8 text-center text-slate-400 text-sm">No transactions found</div>
        )}
      </div>
    </div>
  );
}
