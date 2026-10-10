import { supabase } from "./supabase";
import { Mode, ParsedTransaction } from "./types";
import { runQuery } from "./queries";
import { offlineRoute, OFFLINE_TEMPLATES, RECORDED_JEV_RESPONSES } from "./demo";

/** Invoke an edge function via supabase.functions.invoke */
async function invokeFn(name: string, body: any): Promise<any> {
  const { data, error } = await supabase.functions.invoke(name, {
    body,
  });
  if (error) {
    throw new Error(`${name}: ${error.message || error}`);
  }
  if (data?.error) {
    throw new Error(data.error);
  }
  return data;
}

/** Parse chat text into transactions */
export async function apiParseChat(text: string, mode: Mode): Promise<ParsedTransaction[]> {
  if (mode === "offline") {
    // Simple offline parse: "lunch 14.50 at Chipotle yesterday"
    return offlineParseChat(text);
  }
  return invokeFn("ingest", { type: "chat", text, today: new Date().toISOString().slice(0, 10) })
    .then((r) => r.transactions || []);
}

/** Parse CSV text */
export async function apiParseCsv(csvText: string, mode: Mode): Promise<ParsedTransaction[]> {
  if (mode === "offline") return [];
  return invokeFn("ingest", { type: "csv", csvText })
    .then((r) => r.transactions || []);
}

/** Parse PDF text */
export async function apiParsePdf(pdfText: string, mode: Mode): Promise<{ transactions: ParsedTransaction[]; regex_parsed: number; llm_parsed: number }> {
  if (mode === "offline") return { transactions: [], regex_parsed: 0, llm_parsed: 0 };
  return invokeFn("ingest", { type: "pdf", pdfText });
}

/** Transcribe + parse voice */
export async function apiParseVoice(audioBlob: Blob, mode: Mode): Promise<{ transcript: string; transactions: ParsedTransaction[] }> {
  if (mode === "offline") {
    return { transcript: "[Offline mode — voice not available]", transactions: [] };
  }
  const formData = new FormData();
  formData.append("action", "voice");
  formData.append("audio", audioBlob, "audio.webm");
  formData.append("today", new Date().toISOString().slice(0, 10));

  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ingest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: formData,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `ingest failed (${resp.status})`);
  }
  return resp.json();
}

/** Parse receipt image */
export async function apiParseReceipt(imageFile: File, mode: Mode): Promise<{ parsed: any; transactions: ParsedTransaction[]; sum_check: boolean }> {
  if (mode === "offline") {
    return { parsed: {}, transactions: [], sum_check: true };
  }
  const formData = new FormData();
  formData.append("action", "receipt");
  formData.append("image", imageFile);

  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ingest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: formData,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `ingest failed (${resp.status})`);
  }
  return resp.json();
}

/** Categorize transactions via Jev */
export async function apiCategorize(
  transactions: ParsedTransaction[],
  mode: Mode,
  customCategories: string[] = []
): Promise<any[]> {
  if (mode === "offline") {
    return transactions.map((tx) => {
      const fb = offlineCategorize(tx.merchant);
      return {
        ...tx,
        category: fb.category,
        category_conf: fb.confidence,
        category_source: "fallback",
        recurring_p: 0,
        needs_review: fb.confidence < 0.75,
        fallback: true,
      };
    });
  }
  return invokeFn("jev-classify", {
    action: "categorize",
    transactions,
    customCategories,
  }).then((r) => r.results || []);
}

/** Route a question via Jev */
export async function apiRoute(
  text: string,
  mode: Mode,
  customCategories: string[] = []
): Promise<{
  intent: string;
  intent_confidence: number;
  period: string;
  category: string;
  uncertain: boolean;
  fallback?: boolean;
}> {
  if (mode === "offline") {
    const route = offlineRoute(text);
    return { ...route, intent_confidence: route.confidence, uncertain: false };
  }
  return invokeFn("jev-classify", {
    action: "route",
    text,
    customCategories,
  });
}

/** Get an answer (LLM or template) */
export async function apiAnswer(
  question: string,
  intent: string,
  computedResult: any,
  mode: Mode
): Promise<{ answer: string; highlight_numbers: string[]; suggestion?: string | null; source: string }> {
  if (mode === "offline" || mode === "mock") {
    const templateFn = OFFLINE_TEMPLATES[intent] || OFFLINE_TEMPLATES.unsupported;
    const answer = templateFn(computedResult || {});
    const nums = (answer.match(/-?\$?[\d,]+\.?\d*/g) || []).map((m) => m.replace(/[$,]/g, ""));
    return { answer, highlight_numbers: nums.slice(0, 5), source: "template", suggestion: null };
  }
  return invokeFn("answer", {
    question,
    intent,
    computedResult,
    useMock: false,
  });
}

/** Full question flow: route → query → answer */
export async function askQuestion(
  question: string,
  mode: Mode,
  customCategories: string[] = []
): Promise<{
  route: any;
  queryResult: any;
  answer: string;
  highlight_numbers: string[];
  suggestion?: string | null;
  source: string;
}> {
  const route = await apiRoute(question, mode, customCategories);

  if (route.uncertain) {
    return {
      route,
      queryResult: null,
      answer: "I'm not sure what you're asking. Try one of these:",
      highlight_numbers: [],
      suggestion: null,
      source: "clarification",
    };
  }

  const queryResult = await runQuery(route.intent, route.period, route.category, question);
  const answerResult = await apiAnswer(question, route.intent, queryResult.result, mode);

  return {
    route,
    queryResult,
    answer: answerResult.answer,
    highlight_numbers: answerResult.highlight_numbers,
    suggestion: answerResult.suggestion,
    source: answerResult.source,
  };
}

/** Offline chat parser — simple regex */
function offlineParseChat(text: string): ParsedTransaction[] {
  // Pattern: "lunch 14.50 at Chipotle" or "spent 50 at target"
  const match = text.match(/(?:spent\s+)?(\d+\.?\d*)\s+(?:at\s+|on\s+)?(.+)/i);
  if (!match) return [];
  const [, amountStr, merchant] = match;
  const amount = parseFloat(amountStr);
  if (isNaN(amount)) return [];

  const today = new Date().toISOString().slice(0, 10);
  return [{
    date: today,
    amount_cents: -Math.round(amount * 100),
    merchant_raw: merchant.trim(),
    merchant: merchant.trim().toUpperCase(),
    description: text,
    source: "chat",
  }];
}

/** Offline categorizer — keyword map */
const OFFLINE_MAP: Record<string, { category: string; confidence: number }> = {
  CHIPOTLE: { category: "Dining", confidence: 0.9 },
  STARBUCKS: { category: "Dining", confidence: 0.88 },
  MCDONALD: { category: "Dining", confidence: 0.87 },
  WHOLE: { category: "Groceries", confidence: 0.89 },
  TRADER: { category: "Groceries", confidence: 0.85 },
  UBER: { category: "Transport", confidence: 0.85 },
  LYFT: { category: "Transport", confidence: 0.83 },
  NETFLIX: { category: "Subscriptions", confidence: 0.95 },
  SPOTIFY: { category: "Subscriptions", confidence: 0.95 },
  AMAZON: { category: "Shopping", confidence: 0.8 },
  TARGET: { category: "Shopping", confidence: 0.82 },
};

function offlineCategorize(merchant: string): { category: string; confidence: number } {
  const m = merchant.toUpperCase();
  for (const [kw, val] of Object.entries(OFFLINE_MAP)) {
    if (m.includes(kw)) return val;
  }
  return { category: "Other", confidence: 0.3 };
}
