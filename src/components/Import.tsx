import { useState, useCallback, useRef } from "react";
import { Upload, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import Papa from "papaparse";
import { ParsedTransaction, Mode } from "@/lib/types";
import { apiParseCsv, apiParsePdf, apiCategorize, apiUpsertRule } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { formatCurrency, formatDate } from "@/lib/format";


interface ImportStats {
  total: number;
  deduped: number;
  categorized: number;
  autoAccepted: number;
  needsReview: number;
  batches: number;
}

export function Import({ mode, customCategories, onImported }: { mode: Mode; customCategories: string[]; onImported: () => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [parsed, setParsed] = useState<ParsedTransaction[]>([]);
  const [categorizeProgress, setCategorizeProgress] = useState(0);
  const [stats, setStats] = useState<ImportStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setParsed([]);
    setStats(null);
    setCategorizeProgress(0);
    setFileName(file.name);

    try {
      if (file.name.toLowerCase().endsWith(".csv")) {
        const text = await file.text();
        const parsed = Papa.parse(text, { skipEmptyLines: true });
        const csvText = (parsed.data as any[][]).map((row) => row.join(",")).join("\n");
        const txs = await apiParseCsv(csvText, mode);
        setParsed(txs);
      } else if (file.name.toLowerCase().endsWith(".pdf")) {
        // Extract text from PDF in the browser using pdfjs-dist
        const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          fullText += content.items.map((item: any) => item.str).join(" ") + "\n";
        }
        const result = await apiParsePdf(fullText, mode);
        setParsed(result.transactions);
      } else {
        setError("Please upload a CSV or PDF file");
      }
    } catch (err: any) {
      setError(`Failed to parse file: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [mode]);

  const handleCategorizeAndSave = useCallback(async () => {
    if (parsed.length === 0) return;
    setLoading(true);
    setCategorizeProgress(0);

    try {
      // Categorize in batches of 10, showing progress
      const batchSize = 10;
      const allCategorized: any[] = [];

      for (let i = 0; i < parsed.length; i += batchSize) {
        const batch = parsed.slice(i, i + batchSize);
        const results = await apiCategorize(batch, mode, customCategories);
        allCategorized.push(...results);
        setCategorizeProgress(Math.min(((i + batchSize) / parsed.length) * 100, 100));
      }

      // Save to database
      const rows = allCategorized.map((tx) => ({
        date: tx.date,
        amount_cents: tx.amount_cents,
        merchant_raw: tx.merchant_raw,
        merchant: tx.merchant,
        description: tx.description,
        source: tx.source,
        category: tx.category,
        category_conf: tx.category_conf,
        category_source: tx.category_source,
        recurring_p: tx.recurring_p,
        needs_review: tx.needs_review,
        jev_response: tx.jev_response || null,
      }));

      const { error: insertError } = await supabase.from("transactions").insert(rows);
      if (insertError) throw insertError;

      // Create rules for auto-accepted
      const autoAccepted = allCategorized.filter((tx) => !tx.needs_review && tx.category_source === "jev");
      for (const tx of autoAccepted) {
        await apiUpsertRule(tx.merchant, tx.category);
      }

      setStats({
        total: parsed.length,
        deduped: parsed.length,
        categorized: allCategorized.length,
        autoAccepted: allCategorized.filter((t) => !t.needs_review).length,
        needsReview: allCategorized.filter((t) => t.needs_review).length,
        batches: Math.ceil(parsed.length / batchSize),
      });
      setParsed([]);
      onImported();
    } catch (err: any) {
      setError(`Failed to save: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [parsed, mode, customCategories, onImported]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="overflow-y-auto h-full p-5">
      <h2 className="text-lg font-bold text-slate-800 mb-1">Import Statement</h2>
      <p className="text-sm text-slate-500 mb-4">Upload a CSV or PDF bank statement. Text is parsed in the browser — no raw file is uploaded.</p>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors ${
          dragOver ? "border-emerald-400 bg-emerald-50" : "border-slate-200 hover:border-slate-300 bg-white"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
        <Upload className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <p className="text-sm text-slate-600 font-medium">Drop CSV or PDF here, or click to browse</p>
        <p className="text-xs text-slate-400 mt-1">PDFs are parsed in your browser — only text is sent to the server</p>
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 p-3 rounded-xl bg-red-50 text-red-700 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-4 flex items-center gap-2 p-3 rounded-xl bg-slate-50 text-slate-600 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          {categorizeProgress > 0 ? `Categorizing with Jev... ${Math.round(categorizeProgress)}%` : "Parsing file..."}
        </div>
      )}

      {categorizeProgress > 0 && categorizeProgress < 100 && (
        <div className="mt-2 h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{ width: `${categorizeProgress}%` }}
          />
        </div>
      )}

      {/* Parsed preview */}
      {parsed.length > 0 && !loading && (
        <div className="mt-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700">
              Preview — {parsed.length} transactions from {fileName}
            </h3>
            <button
              onClick={handleCategorizeAndSave}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
            >
              Categorize with Jev & Save
            </button>
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden max-h-64 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Date</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Merchant</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-slate-500">Amount</th>
                </tr>
              </thead>
              <tbody>
                {parsed.slice(0, 50).map((tx, i) => (
                  <tr key={i} className="border-b border-slate-50">
                    <td className="px-3 py-2 text-xs text-slate-600">{formatDate(tx.date)}</td>
                    <td className="px-3 py-2 text-xs font-medium text-slate-800">{tx.merchant}</td>
                    <td className={`px-3 py-2 text-xs text-right font-medium ${tx.amount_cents < 0 ? "text-slate-800" : "text-emerald-600"}`}>
                      {formatCurrency(tx.amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Import stats */}
      {stats && !loading && (
        <div className="mt-5 bg-white rounded-2xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle className="w-5 h-5 text-emerald-500" />
            <h3 className="text-sm font-semibold text-slate-700">Import Complete</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="Imported" value={String(stats.total)} />
            <Stat label="Auto-accepted" value={String(stats.autoAccepted)} accent="emerald" />
            <Stat label="Needs review" value={String(stats.needsReview)} accent={stats.needsReview > 0 ? "amber" : "slate"} />
            <Stat label="Jev batches" value={String(stats.batches)} accent="blue" />
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  const colors: Record<string, string> = {
    emerald: "text-emerald-600",
    amber: "text-amber-600",
    blue: "text-blue-600",
    slate: "text-slate-700",
  };
  return (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-lg font-bold ${accent ? colors[accent] : "text-slate-800"}`}>{value}</div>
    </div>
  );
}
