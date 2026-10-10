import { Radio, Wifi, WifiOff, Cpu, ShieldCheck } from "lucide-react";
import { Mode } from "@/lib/types";

interface HeaderProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
}

export function Header({ mode, onModeChange }: HeaderProps) {
  const modes: { value: Mode; label: string; icon: React.ReactNode }[] = [
    { value: "live", label: "Live", icon: <Wifi className="w-3.5 h-3.5" /> },
    { value: "mock", label: "Mock writer", icon: <Cpu className="w-3.5 h-3.5" /> },
    { value: "offline", label: "Offline replay", icon: <WifiOff className="w-3.5 h-3.5" /> },
  ];

  return (
    <header className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-white">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white">
            <Radio className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-800 leading-tight">Talk-to-Your-Money</h1>
            <p className="text-[11px] text-slate-400 leading-tight">ask where it went</p>
          </div>
        </div>
        <span className="ml-2 px-2 py-0.5 text-[10px] font-medium rounded-full bg-amber-50 text-amber-600 border border-amber-100 flex items-center gap-1">
          <ShieldCheck className="w-3 h-3" />
          Demo data only, no bank connections
        </span>
      </div>

      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
        {modes.map((m) => (
          <button
            key={m.value}
            onClick={() => onModeChange(m.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
              mode === m.value
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {m.icon}
            {m.label}
          </button>
        ))}
      </div>
    </header>
  );
}
