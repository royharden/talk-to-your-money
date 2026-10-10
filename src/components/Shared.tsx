import { CATEGORY_COLORS } from "@/lib/categories";

export function ConfidenceDot({ confidence, source }: { confidence: number; source?: string }) {
  let color = "bg-slate-300";
  if (source === "rule") {
    color = "bg-emerald-500";
  } else if (source === "fallback") {
    color = "bg-amber-400";
  } else if (confidence >= 0.75) {
    color = "bg-emerald-500";
  } else if (confidence >= 0.6) {
    color = "bg-amber-400";
  } else {
    color = "bg-red-400";
  }
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} title={`${Math.round(confidence * 100)}% (${source || "jev"})`} />;
}

export function CategoryChip({ category, small }: { category: string; small?: boolean }) {
  const color = CATEGORY_COLORS[category] || "#94a3b8";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ${small ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"} font-medium`}
      style={{ background: `${color}15`, color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {category}
    </span>
  );
}

export function SourceIcon({ source }: { source: string }) {
  const icons: Record<string, string> = {
    chat: "💬",
    voice: "🎙",
    receipt: "🧾",
    statement: "📄",
  };
  return <span title={source} className="text-xs">{icons[source] || "📄"}</span>;
}
