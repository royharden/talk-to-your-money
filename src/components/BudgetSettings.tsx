import { useEffect, useState, useCallback } from "react";
import { Plus, Trash2, Save, Tag } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Budget } from "@/lib/types";
import { CATEGORIES, MAX_CUSTOM_CATEGORIES } from "@/lib/categories";
import { currentMonthISO, formatMonth } from "@/lib/format";

interface BudgetSettingsProps {
  customCategories: string[];
  onAddCategory: (name: string) => void;
  onRemoveCategory: (name: string) => void;
  onChanged: () => void;
}

export function BudgetSettings({ customCategories, onAddCategory, onRemoveCategory, onChanged }: BudgetSettingsProps) {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [loading, setLoading] = useState(true);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [newCatName, setNewCatName] = useState("");
  const [currentMonth] = useState(currentMonthISO());

  const allCategories = [...CATEGORIES, ...customCategories];

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("budgets")
      .select("*")
      .eq("month", currentMonth)
      .order("category");
    if (error) {
      console.error(error);
      setLoading(false);
      return;
    }
    setBudgets(data || []);
    const vals: Record<string, string> = {};
    for (const b of data || []) {
      vals[b.category] = String(b.amount_cents / 100);
    }
    setEditValues(vals);
    setLoading(false);
  }, [currentMonth]);

  useEffect(() => { load(); }, [load]);

  const handleSave = useCallback(async (category: string) => {
    const value = parseFloat(editValues[category] || "0");
    if (isNaN(value) || value < 0) return;
    const amountCents = Math.round(value * 100);

    const existing = budgets.find((b) => b.category === category);
    if (existing) {
      const { error } = await supabase
        .from("budgets")
        .update({ amount_cents: amountCents })
        .eq("id", existing.id);
      if (error) console.error(error);
    } else {
      const { error } = await supabase
        .from("budgets")
        .insert({ category, month: currentMonth, amount_cents: amountCents });
      if (error) console.error(error);
    }
    load();
    onChanged();
  }, [editValues, budgets, currentMonth, load, onChanged]);

  const handleDelete = useCallback(async (budget: Budget) => {
    const { error } = await supabase.from("budgets").delete().eq("id", budget.id);
    if (error) console.error(error);
    load();
    onChanged();
  }, [load, onChanged]);

  const handleAddCustomCat = useCallback(() => {
    const name = newCatName.trim();
    if (!name) return;
    onAddCategory(name);
    setNewCatName("");
  }, [newCatName, onAddCategory]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-slate-400">Loading budgets...</div>;
  }

  return (
    <div className="overflow-y-auto h-full p-5">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-slate-800">Budgets & Categories</h2>
        <p className="text-sm text-slate-500">Set monthly spending limits for {formatMonth(currentMonth)}</p>
      </div>

      {/* Budget editing */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-5">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Monthly Budgets</h3>
        <div className="space-y-3">
          {allCategories.map((cat) => {
            const budget = budgets.find((b) => b.category === cat);
            const isCustom = customCategories.includes(cat);
            return (
              <div key={cat} className="flex items-center gap-3">
                <span className="text-sm text-slate-700 w-32 sm:w-40 truncate">{cat}</span>
                <div className="flex-1 relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                  <input
                    type="number"
                    value={editValues[cat] || ""}
                    onChange={(e) => setEditValues((prev) => ({ ...prev, [cat]: e.target.value }))}
                    placeholder="0"
                    className="w-full pl-7 pr-3 py-1.5 text-sm rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent"
                  />
                </div>
                {budget && editValues[cat] && parseFloat(editValues[cat]) !== budget.amount_cents / 100 && (
                  <button
                    onClick={() => handleSave(cat)}
                    className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg"
                    title="Save"
                  >
                    <Save className="w-4 h-4" />
                  </button>
                )}
                {budget && (
                  <button
                    onClick={() => handleDelete(budget)}
                    className="p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 rounded-lg"
                    title="Remove budget"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                {isCustom && (
                  <button
                    onClick={() => onRemoveCategory(cat)}
                    className="text-xs text-slate-400 hover:text-red-500"
                    title="Remove custom category"
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom categories */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
          <Tag className="w-4 h-4 text-slate-400" />
          Custom Categories
        </h3>
        <p className="text-xs text-slate-400 mb-3">
          Add up to {MAX_CUSTOM_CATEGORIES} custom categories. They're appended to Jev's choice list.
          {customCategories.length}/{MAX_CUSTOM_CATEGORIES} used.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAddCustomCat(); }}
            placeholder="e.g. Pets, Gifts, Education"
            disabled={customCategories.length >= MAX_CUSTOM_CATEGORIES}
            className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent disabled:opacity-50"
          />
          <button
            onClick={handleAddCustomCat}
            disabled={!newCatName.trim() || customCategories.length >= MAX_CUSTOM_CATEGORIES}
            className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
        {customCategories.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {customCategories.map((c) => (
              <span key={c} className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">
                {c}
                <button onClick={() => onRemoveCategory(c)} className="hover:text-red-500">
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
