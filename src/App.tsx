import { useState, useCallback, useEffect } from "react";
import { LayoutDashboard, MessageSquare, Inbox, List, Upload, BarChart3, Settings } from "lucide-react";
import { Header } from "@/components/Header";
import { ChatPanel } from "@/components/ChatPanel";
import { Dashboard } from "@/components/Dashboard";
import { NeedsReview } from "@/components/NeedsReview";
import { Transactions } from "@/components/Transactions";
import { Import } from "@/components/Import";
import { Stats } from "@/components/Stats";
import { BudgetSettings } from "@/components/BudgetSettings";
import { Mode } from "@/lib/types";
import { CATEGORIES, MAX_CUSTOM_CATEGORIES } from "@/lib/categories";
import { supabase } from "@/lib/supabase";
import { ensureSession } from "@/lib/api";

type Tab = "dashboard" | "chat" | "review" | "transactions" | "import" | "stats" | "budgets";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "chat", label: "Chat", icon: <MessageSquare className="w-4 h-4" /> },
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: "review", label: "Needs You", icon: <Inbox className="w-4 h-4" /> },
  { id: "transactions", label: "Transactions", icon: <List className="w-4 h-4" /> },
  { id: "import", label: "Import", icon: <Upload className="w-4 h-4" /> },
  { id: "budgets", label: "Budgets", icon: <Settings className="w-4 h-4" /> },
  { id: "stats", label: "Stats", icon: <BarChart3 className="w-4 h-4" /> },
];

function App() {
  const [mode, setMode] = useState<Mode>("live");
  const [tab, setTab] = useState<Tab>("chat");
  const [refreshKey, setRefreshKey] = useState(0);
  const [customCategories, setCustomCategories] = useState<string[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [session, setSession] = useState<"loading" | "ready" | "error">("loading");
  const [sessionError, setSessionError] = useState("");

  // Every read and write is scoped to this browser's workspace, so get one first
  useEffect(() => {
    ensureSession()
      .then(() => setSession("ready"))
      .catch((err) => {
        console.error(err);
        setSessionError(err instanceof Error ? err.message : String(err));
        setSession("error");
      });
  }, []);

  const triggerRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Load custom categories
  useEffect(() => {
    const saved = localStorage.getItem("customCategories");
    if (saved) {
      try {
        setCustomCategories(JSON.parse(saved));
      } catch {}
    }
  }, []);

  const handleAddCategory = useCallback((name: string) => {
    setCustomCategories((prev) => {
      if (prev.length >= MAX_CUSTOM_CATEGORIES) return prev;
      if (prev.includes(name) || CATEGORIES.includes(name as any)) return prev;
      const next = [...prev, name];
      localStorage.setItem("customCategories", JSON.stringify(next));
      return next;
    });
  }, []);

  const handleRemoveCategory = useCallback((name: string) => {
    setCustomCategories((prev) => {
      const next = prev.filter((c) => c !== name);
      localStorage.setItem("customCategories", JSON.stringify(next));
      return next;
    });
  }, []);

  // Load review count for badge
  useEffect(() => {
    if (session !== "ready") return;
    const loadCount = async () => {
      const { count } = await supabase
        .from("transactions")
        .select("*", { count: "exact", head: true })
        .eq("needs_review", true);
      setReviewCount(count || 0);
    };
    loadCount();
    const interval = setInterval(loadCount, 5000);
    return () => clearInterval(interval);
  }, [refreshKey, session]);

  if (session !== "ready") {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 px-4 text-center text-sm text-slate-500">
        {session === "loading" ? "Setting up your workspace..." : `Couldn't start a session: ${sessionError}`}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <Header mode={mode} onModeChange={setMode} />

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat panel (always visible on desktop) */}
        <div className="hidden lg:flex w-[380px] xl:w-[420px] border-r border-slate-200 bg-slate-50/30 flex-col">
          <ChatPanel
            key={`chat-${refreshKey}`}
            mode={mode}
            customCategories={customCategories}
            onTransactionsCategorized={triggerRefresh}
          />
        </div>

        {/* Right: Main content area with tabs */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-slate-200 bg-white overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
                  tab === t.id
                    ? "bg-emerald-50 text-emerald-700"
                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                }`}
              >
                {t.icon}
                {t.label}
                {t.id === "review" && reviewCount > 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-amber-400 text-white">
                    {reviewCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {/* Mobile chat */}
            {tab === "chat" && (
              <div className="h-full lg:hidden">
                <ChatPanel
                  key={`chat-mobile-${refreshKey}`}
                  mode={mode}
                  customCategories={customCategories}
                  onTransactionsCategorized={triggerRefresh}
                />
              </div>
            )}

            {tab === "dashboard" && <Dashboard key={`dash-${refreshKey}`} />}
            {tab === "review" && <NeedsReview key={`review-${refreshKey}`} onReviewed={triggerRefresh} />}
            {tab === "transactions" && <Transactions key={`tx-${refreshKey}`} onChanged={triggerRefresh} />}
            {tab === "import" && (
              <Import mode={mode} customCategories={customCategories} onImported={triggerRefresh} />
            )}
            {tab === "stats" && <Stats key={`stats-${refreshKey}`} />}
            {tab === "budgets" && (
              <BudgetSettings
                key={`budgets-${refreshKey}`}
                customCategories={customCategories}
                onAddCategory={handleAddCategory}
                onRemoveCategory={handleRemoveCategory}
                onChanged={triggerRefresh}
              />
            )}

            {/* On desktop, show dashboard when chat is selected */}
            {tab === "chat" && (
              <div className="hidden lg:block h-full">
                <Dashboard key={`dash-${refreshKey}`} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
