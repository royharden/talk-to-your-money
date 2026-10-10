import { Mic, Send, Sparkles, Receipt as ReceiptIcon } from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { ChatMessage, Mode, ParsedTransaction } from "@/lib/types";
import { SAMPLE_QUESTIONS } from "@/lib/demo";
import { askQuestion, apiParseChat, apiParseVoice, apiParseReceipt, apiCategorize, apiUpsertRule } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { formatCurrency, formatDate } from "@/lib/format";
import { CATEGORY_COLORS } from "@/lib/categories";

interface ChatPanelProps {
  mode: Mode;
  customCategories: string[];
  onTransactionsCategorized: () => void;
}

export function ChatPanel({ mode, customCategories, onTransactionsCategorized }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Hi Sam! I'm your money assistant. Ask me where your money went, or log an expense like \"lunch 14.50 at Chipotle\".",
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const handleConfirmTransaction = useCallback(async (tx: ParsedTransaction, msgId: string) => {
    setLoading(true);
    try {
      // Categorize with Jev
      const categorized = await apiCategorize([tx], mode, customCategories);
      const cat = categorized[0];

      const { error } = await supabase.from("transactions").insert({
        date: cat.date,
        amount_cents: cat.amount_cents,
        merchant_raw: cat.merchant_raw,
        merchant: cat.merchant,
        description: cat.description,
        source: cat.source,
        category: cat.category,
        category_conf: cat.category_conf,
        category_source: cat.category_source,
        recurring_p: cat.recurring_p,
        needs_review: cat.needs_review,
        jev_response: cat.jev_response || null,
      });

      if (error) throw error;

      // Create a rule for confirmed merchant
      if (mode !== "offline") {
        await apiUpsertRule(cat.merchant, cat.category);
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? { ...m, text: `Saved: ${formatCurrency(cat.amount_cents)} at ${cat.merchant} → ${cat.category}`, parsed: undefined }
            : m
        )
      );
      onTransactionsCategorized();
    } catch (err: any) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, text: `Error saving: ${err.message}`, parsed: undefined } : m
        )
      );
    } finally {
      setLoading(false);
    }
  }, [mode, customCategories, onTransactionsCategorized]);

  const handleMic = useCallback(async () => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });

        setLoading(true);
        try {
          const result = await apiParseVoice(audioBlob, mode);
          if (result.transactions.length > 0) {
            addMessage({
              id: crypto.randomUUID(),
              role: "user",
              text: result.transcript,
              timestamp: Date.now(),
            });
            addMessage({
              id: crypto.randomUUID(),
              role: "assistant",
              text: "I heard this. Confirm to save:",
              timestamp: Date.now(),
              parsed: result.transactions,
            });
          } else {
            addMessage({
              id: crypto.randomUUID(),
              role: "assistant",
              text: result.transcript || "I couldn't transcribe that. Try again?",
              timestamp: Date.now(),
            });
          }
        } catch (err: any) {
          addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            text: `Voice error: ${err.message}`,
            timestamp: Date.now(),
          });
        } finally {
          setLoading(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (err: any) {
      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        text: `Microphone error: ${err.message}`,
        timestamp: Date.now(),
      });
    }
  }, [recording, mode, addMessage]);

  const handleReceiptUpload = useCallback(async (file: File) => {
    setLoading(true);
    try {
      const result = await apiParseReceipt(file, mode);
      if (result.transactions.length > 0) {
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          text: `Receipt parsed${result.sum_check ? "" : " (sum mismatch — please verify)"}:`,
          timestamp: Date.now(),
          parsed: result.transactions,
        });
      } else {
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          text: "I couldn't read that receipt. Try a clearer photo.",
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        text: `Receipt error: ${err.message}`,
        timestamp: Date.now(),
      });
    } finally {
      setLoading(false);
    }
  }, [mode, addMessage]);

  const handleSendRef = useRef(async (text?: string) => {});
  handleSendRef.current = async (text?: string) => {
    const value = text ?? input;
    if (!value.trim() || loading) return;
    setInput("");
    setLoading(true);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: value,
      timestamp: Date.now(),
    };
    addMessage(userMsg);

    try {
      const looksLikeExpense = /\d+\.?\d*\s+(?:at|on|for)/i.test(value) || /^(?:spent|paid|bought)\s/i.test(value);

      if (looksLikeExpense) {
        const parsed = await apiParseChat(value, mode);
        if (parsed.length > 0) {
          addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            text: "I parsed this entry. Confirm to save it:",
            timestamp: Date.now(),
            parsed,
          });
        } else {
          addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            text: "I couldn't parse that as an expense. Try: \"lunch 14.50 at Chipotle\"",
            timestamp: Date.now(),
          });
        }
      } else {
        const result = await askQuestion(value, mode, customCategories);
        await supabase.from("questions").insert({
          text: value,
          jev_route: result.route,
          query_name: result.queryResult?.query_name,
          result: result.queryResult?.result,
          answer: { answer: result.answer, highlight_numbers: result.highlight_numbers },
        });
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          text: result.answer,
          timestamp: Date.now(),
          highlight_numbers: result.highlight_numbers,
          suggestion: result.suggestion,
          intent: result.route?.intent,
          fallback: result.route?.fallback,
          chart_data: result.queryResult?.result,
        });
      }
    } catch (err: any) {
      addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        text: `Sorry, something went wrong: ${err.message}`,
        timestamp: Date.now(),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            onConfirm={handleConfirmTransaction}
            loading={loading}
          />
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <Sparkles className="w-4 h-4 animate-pulse" />
            <span>Thinking...</span>
          </div>
        )}
      </div>

      {/* Suggested questions */}
      {messages.length <= 2 && (
        <div className="px-4 pb-2 flex flex-wrap gap-2">
          {SAMPLE_QUESTIONS.slice(0, 5).map((q) => (
            <button
              key={q}
              onClick={() => handleSendRef.current(q)}
              className="px-3 py-1.5 text-xs rounded-full bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 transition-colors border border-slate-200"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div className="border-t border-slate-200 p-3 flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleReceiptUpload(file);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || mode === "offline"}
          className="p-2.5 rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 transition-colors"
          title="Upload receipt photo"
        >
          <ReceiptIcon className="w-5 h-5" />
        </button>
        <button
          onClick={handleMic}
          disabled={loading || mode === "offline"}
          className={`p-2.5 rounded-xl transition-colors disabled:opacity-40 ${
            recording
              ? "bg-red-50 text-red-600 animate-pulse"
              : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          }`}
          title={recording ? "Stop recording" : "Record voice"}
        >
          <Mic className="w-5 h-5" />
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSendRef.current();
            }
          }}
          placeholder="Ask about your spending or log an expense..."
          className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent"
        />
        <button
          onClick={() => handleSendRef.current()}
          disabled={loading || !input.trim()}
          className="p-2.5 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:bg-slate-300 transition-colors"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  onConfirm,
  loading,
}: {
  msg: ChatMessage;
  onConfirm: (tx: ParsedTransaction, msgId: string) => void;
  loading: boolean;
}) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
            isUser
              ? "bg-emerald-600 text-white rounded-br-md"
              : "bg-slate-100 text-slate-800 rounded-bl-md"
          }`}
        >
          {msg.text}
          {msg.fallback && (
            <div className="mt-1 text-xs text-amber-600 font-medium">Fallback (not Jev)</div>
          )}
        </div>

        {/* Parsed transaction confirmation cards */}
        {msg.parsed && msg.parsed.length > 0 && (
          <div className="mt-2 space-y-2">
            {msg.parsed.map((tx, i) => (
              <div key={i} className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-slate-800">{tx.merchant}</div>
                    <div className="text-xs text-slate-500">
                      {formatDate(tx.date)} · {formatCurrency(tx.amount_cents)}
                    </div>
                  </div>
                  <button
                    onClick={() => onConfirm(tx, msg.id)}
                    disabled={loading}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 transition-colors"
                  >
                    Save
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Inline chart for category breakdown */}
        {msg.chart_data?.rows && msg.intent === "spend_by_category" && (
          <div className="mt-2 bg-white border border-slate-200 rounded-xl p-3">
            <div className="space-y-1.5">
              {msg.chart_data.rows.slice(0, 5).map((row: any) => (
                <div key={row.category} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: CATEGORY_COLORS[row.category] || "#94a3b8" }} />
                  <span className="text-xs text-slate-600 flex-1">{row.category}</span>
                  <span className="text-xs font-medium text-slate-800">{formatCurrency(row.total_cents)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top merchants inline */}
        {msg.chart_data?.rows && msg.intent === "top_merchants" && (
          <div className="mt-2 bg-white border border-slate-200 rounded-xl p-3">
            <div className="space-y-1.5">
              {msg.chart_data.rows.slice(0, 5).map((row: any, i: number) => (
                <div key={row.merchant} className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 w-4">{i + 1}</span>
                  <span className="text-xs text-slate-600 flex-1">{row.merchant}</span>
                  <span className="text-xs font-medium text-slate-800">{formatCurrency(row.total_cents)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Budget status inline */}
        {msg.chart_data?.rows && msg.intent === "budget_status" && (
          <div className="mt-2 bg-white border border-slate-200 rounded-xl p-3">
            <div className="space-y-2">
              {msg.chart_data.rows.slice(0, 6).map((row: any) => (
                <div key={row.category}>
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="text-slate-600">{row.category}</span>
                    <span className="font-medium text-slate-800">
                      {formatCurrency(row.spent_cents)} / {formatCurrency(row.budget_cents)}
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        row.status === "over" ? "bg-red-500" : row.status === "warning" ? "bg-amber-500" : "bg-emerald-500"
                      }`}
                      style={{ width: `${Math.min(row.pct, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
