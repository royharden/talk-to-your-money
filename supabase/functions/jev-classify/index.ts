// jev-classify Edge Function — categorizes transactions in batches + routes questions
// Uses TypeSafe AI's Jev model (jev-1.13.0)
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DEFAULT_DAILY_CAP = 200;
const DAILY_LIMIT_MESSAGE = "Demo daily limit reached — Offline demo still works.";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-1.13.0";

// Request bounds (checked before any paid call)
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TRANSACTIONS = 200;
const MAX_JEV_FIELD_CHARS = 200; // merchant / description sent to Jev
const MAX_CUSTOM_CATEGORIES = 20;
const MAX_CUSTOM_CATEGORY_CHARS = 40;
const MAX_ROUTE_TEXT_CHARS = 500;
const BATCH_SIZE = 10;
// First attempt + one retry; each retry reserves its own unit
const MAX_JEV_ATTEMPTS = 2;

const CATEGORIES = [
  "groceries", "dining", "transport", "housing", "utilities", "subscriptions",
  "shopping", "health", "entertainment", "travel", "income", "transfers", "fees", "other", "uncertain",
];

const CATEGORY_MAP: Record<string, string> = {
  groceries: "Groceries", dining: "Dining", transport: "Transport", housing: "Rent/Housing",
  utilities: "Utilities", subscriptions: "Subscriptions", shopping: "Shopping", health: "Health",
  entertainment: "Entertainment", travel: "Travel", income: "Income", transfers: "Transfers",
  fees: "Fees", other: "Other", uncertain: "Other",
};

const INTENTS = [
  "spend_by_category", "spend_by_merchant", "compare_periods", "top_merchants",
  "budget_status", "set_budget", "find_transaction", "income_vs_spend",
  "recurring_list", "unsupported", "uncertain",
];

const PERIODS = ["this_month", "last_month", "last_30_days", "last_90_days", "this_year", "custom", "uncertain"];

/** Fallback merchant keyword map */
const FALLBACK_MAP: Record<string, string> = {
  WHOLE: "Groceries", TRADER: "Groceries", COSTCO: "Groceries", GROCERY: "Groceries",
  CHIPOTLE: "Dining", STARBUCKS: "Dining", MCDONALD: "Dining", DOORDASH: "Dining",
  SWEETGREEN: "Dining", CHEESECAKE: "Dining", ZOMATO: "Dining", BOTTLE: "Dining",
  UBER: "Transport", LYFT: "Transport", SHELL: "Transport", GAS: "Transport",
  RENT: "Rent/Housing", ACH: "Rent/Housing",
  NETFLIX: "Subscriptions", SPOTIFY: "Subscriptions", PRIME: "Subscriptions",
  ICLOUD: "Subscriptions", NYTIMES: "Subscriptions", HULU: "Subscriptions",
  AMAZON: "Shopping", TARGET: "Shopping", APPLE: "Shopping", "HOME DEPOT": "Shopping",
  CVS: "Health", WALGREENS: "Health", PHARMACY: "Health", FITNESS: "Health", EQUINOX: "Health",
  AMC: "Entertainment", STEAM: "Entertainment", GAME: "Entertainment",
  DELTA: "Travel", MARRIOTT: "Travel", AIRBNB: "Travel", HOTEL: "Travel", AIR: "Travel",
  PAYCHECK: "Income", DEPOSIT: "Income", SALARY: "Income",
  VENMO: "Transfers", ATM: "Transfers", CASHOUT: "Transfers",
  BANK: "Fees", FEE: "Fees", PG: "Utilities", COMCAST: "Utilities", ELECTRIC: "Utilities",
};

function fallbackCategorize(merchant: string): { category: string; confidence: number } {
  const m = merchant.toUpperCase();
  for (const [kw, cat] of Object.entries(FALLBACK_MAP)) {
    if (m.includes(kw)) return { category: cat, confidence: 0.6 };
  }
  return { category: "Other", confidence: 0.3 };
}

/** Fallback question router */
function fallbackRoute(text: string): any {
  const t = text.toLowerCase();
  let intent = "unsupported";
  let category = "none";

  if (/categor|breakdown|where.*money|spend.*on/.test(t)) intent = "spend_by_category";
  else if (/merchant|store|shop.*at/.test(t)) intent = "spend_by_merchant";
  else if (/compare|vs|versus|last.*this|difference/.test(t)) intent = "compare_periods";
  else if (/top|biggest|largest|most/.test(t)) intent = "top_merchants";
  else if (/budget|limit|over.*budget/.test(t)) intent = "budget_status";
  else if (/income|earn|make|deposit|paycheck/.test(t)) intent = "income_vs_spend";
  else if (/recurring|subscription|monthly|repeated/.test(t)) intent = "recurring_list";
  else if (/find|search|when.*did|show me/.test(t)) intent = "find_transaction";

  for (const cat of Object.values(CATEGORY_MAP)) {
    if (t.includes(cat.toLowerCase())) {
      category = cat;
      break;
    }
  }

  return { intent, confidence: 0.5, period: "this_month", category, fallback: true };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Daily cap: the DAILY_CALL_LIMIT secret if it is a positive integer, else 200 */
function dailyCap(): number {
  const limit = Number(Deno.env.get("DAILY_CALL_LIMIT"));
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_DAILY_CAP;
}

/** Read the request body, rejecting with 413 as soon as it exceeds maxBytes */
async function readJsonBody(req: Request, maxBytes: number): Promise<any> {
  if (Number(req.headers.get("Content-Length")) > maxBytes) {
    throw new HttpError(413, "Request body too large");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Invalid JSON body");
  }
  return body;
}

/**
 * Reserve `units` paid Jev calls against the daily cap. Fails closed: an RPC
 * error or a null/non-integer result is reported as an error (503), never as OK.
 */
async function checkCap(supabase: any, units = 1): Promise<{ allowed: boolean; count: number; error?: string }> {
  const { data, error } = await supabase.rpc("increment_usage_counter_by", {
    p_fn: "jev-classify",
    p_units: units,
    p_cap: dailyCap(),
  });
  if (error) {
    console.error("Counter error:", error);
    return { allowed: false, count: 0, error: "Usage counter unavailable" };
  }
  if (typeof data !== "number" || !Number.isInteger(data)) {
    console.error("Counter returned a non-integer:", data);
    return { allowed: false, count: 0, error: "Usage counter unavailable" };
  }
  // -1 means the reservation would exceed the cap and nothing was added
  return { allowed: data >= units, count: data };
}

function capResponse(cap: { allowed: boolean; error?: string }): Response | null {
  if (cap.error) return jsonResponse({ error: cap.error }, 503);
  if (!cap.allowed) return jsonResponse({ error: DAILY_LIMIT_MESSAGE, code: "daily_limit" }, 429);
  return null;
}

/** Keep custom categories bounded before they reach Jev's choice list */
function sanitizeCustomCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .slice(0, MAX_CUSTOM_CATEGORIES)
    .map((c) => c.slice(0, MAX_CUSTOM_CATEGORY_CHARS));
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Call Jev. Retries only on 429/529 or a network error, at most
 * MAX_JEV_ATTEMPTS in total, and every retry first reserves one more unit
 * against the daily cap; if that reservation fails, it stops retrying.
 */
async function callJev(
  apiKey: string,
  state: Record<string, any>,
  questions: Record<string, any>,
  reserveRetry: () => Promise<boolean>
): Promise<any> {
  const body = JSON.stringify({
    model: JEV_MODEL,
    state,
    questions,
  });

  for (let attempt = 1; attempt <= MAX_JEV_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 2) * 1000));
      if (!(await reserveRetry())) throw new Error("Daily cap reached, not retrying Jev");
    }

    let resp: Response;
    try {
      resp = await fetch(JEV_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (err) {
      console.error(`Jev network error (attempt ${attempt}):`, err);
      continue;
    }

    if (resp.status === 429 || resp.status === 529) {
      await resp.body?.cancel();
      console.error(`Jev rate limited (${resp.status}, attempt ${attempt})`);
      continue;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Jev error ${resp.status}:`, errText);
      throw new Error(`Jev error ${resp.status}`);
    }

    const json = await resp.json();
    console.log("Jev response.model:", json.model);
    return json;
  }

  throw new Error("Jev unavailable after retries");
}

/** Build categorization request for a batch of up to 10 transactions */
function buildCategorizeQuestions(txs: any[], customCats: string[] = []): { state: any; questions: any } {
  const state: Record<string, any> = { transactions: {} };
  const questions: Record<string, any> = {};

  const allCats: Record<string, string> = {};
  for (const c of CATEGORIES) {
    allCats[c] = CATEGORY_MAP[c] || c;
  }
  for (const c of customCats) {
    allCats[c.toLowerCase().replace(/[^a-z]/g, "_")] = c;
  }

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const id = `tx${i}`;
    state.transactions[id] = {
      merchant: clip(tx.merchant, MAX_JEV_FIELD_CHARS),
      description: clip(tx.description, MAX_JEV_FIELD_CHARS),
      amount: String(tx.amount_cents / 100),
      date: clip(tx.date, 32),
    };

    questions[`${id}__category`] = {
      type: "choice",
      instructions: `Which category best fits \`transactions.${id}\`?`,
      criteria: allCats,
    };

    questions[`${id}__recurring`] = {
      type: "noul",
      instructions: `Does \`transactions.${id}\` look like a recurring bill or subscription?`,
      criteria: { true: "Likely recurring.", false: "Likely one-off." },
    };
  }

  return { state, questions };
}

/** Build question routing request */
function buildRouteQuestions(text: string, customCats: string[] = []): { state: any; questions: any } {
  const state: Record<string, any> = { question: { text } };

  const allCats: Record<string, string> = {};
  for (const c of CATEGORIES) {
    if (c === "uncertain") continue;
    allCats[c] = CATEGORY_MAP[c] || c;
  }
  for (const c of customCats) {
    allCats[c.toLowerCase().replace(/[^a-z]/g, "_")] = c;
  }
  allCats["none"] = "No specific category";
  allCats["uncertain"] = "Can't tell from this information.";

  const questions: Record<string, any> = {
    intent: {
      type: "choice",
      instructions: "What is the user asking about?",
      criteria: {
        spend_by_category: "Spend by category",
        spend_by_merchant: "Spend at a specific merchant",
        compare_periods: "Compare two time periods",
        top_merchants: "Top merchants by spend",
        budget_status: "Budget status",
        set_budget: "Set or update a budget",
        find_transaction: "Find a specific transaction",
        income_vs_spend: "Income vs spending",
        recurring_list: "List recurring charges",
        unsupported: "Not a supported question type",
        uncertain: "Can't tell from this information.",
      },
    },
    period: {
      type: "choice",
      instructions: "What time period is the user asking about?",
      criteria: {
        this_month: "This month",
        last_month: "Last month",
        last_30_days: "Last 30 days",
        last_90_days: "Last 90 days",
        this_year: "This year",
        custom: "A custom date range",
        uncertain: "Can't tell from this information.",
      },
    },
    category: {
      type: "choice",
      instructions: "Is there a specific category in the question?",
      criteria: allCats,
    },
  };

  return { state, questions };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
      return jsonResponse({ error: "Usage counter unavailable" }, 503);
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const { action } = body;
    const customCategories = sanitizeCustomCategories(body.customCategories);
    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    const reserveRetry = async () => (await checkCap(supabase, 1)).allowed;

    if (action === "categorize") {
      const { transactions } = body;
      if (!transactions || !Array.isArray(transactions)) {
        throw new HttpError(400, "Missing transactions array");
      }
      if (transactions.length > MAX_TRANSACTIONS) {
        throw new HttpError(400, `Too many transactions (max ${MAX_TRANSACTIONS})`);
      }
      if (!transactions.every((t: any) => t && typeof t === "object" && !Array.isArray(t))) {
        throw new HttpError(400, "Invalid transaction");
      }

      // Check rules table — skip Jev for merchants with rules
      const merchants = [...new Set(transactions.map((t: any) => t.merchant))];
      const { data: rules } = await supabase
        .from("rules")
        .select("merchant, category")
        .in("merchant", merchants);

      const ruleMap: Record<string, string> = {};
      for (const r of rules || []) {
        ruleMap[r.merchant] = r.category;
      }

      const needsJev: any[] = [];
      const results: any[] = [];

      for (const tx of transactions) {
        if (ruleMap[tx.merchant]) {
          results.push({
            ...tx,
            category: ruleMap[tx.merchant],
            category_conf: 1.0,
            category_source: "rule",
            recurring_p: 0,
            needs_review: false,
          });
        } else {
          needsJev.push(tx);
        }
      }

      // Batch needsJev in groups of 10
      const batches: any[][] = [];
      for (let i = 0; i < needsJev.length; i += BATCH_SIZE) {
        batches.push(needsJev.slice(i, i + BATCH_SIZE));
      }

      // One unit per batch, reserved before the first Jev call; retries reserve their own
      if (apiKey && batches.length > 0) {
        const capResp = capResponse(await checkCap(supabase, batches.length));
        if (capResp) return capResp;
      }

      let usage: any = null;
      for (const batch of batches) {
        const { state, questions } = buildCategorizeQuestions(batch, customCategories);
        let jevResp: any;
        let usedFallback = false;

        try {
          if (!apiKey) throw new Error("No TYPESAFE_API_KEY configured");
          jevResp = await callJev(apiKey, state, questions, reserveRetry);
          usage = jevResp?.usage || usage;
        } catch (e) {
          console.error("Jev failed, using fallback:", e);
          usedFallback = true;
        }

        for (let i = 0; i < batch.length; i++) {
          const tx = batch[i];
          if (usedFallback) {
            const fb = fallbackCategorize(clip(tx.merchant, MAX_JEV_FIELD_CHARS));
            results.push({
              ...tx,
              category: fb.category,
              category_conf: fb.confidence,
              category_source: "fallback",
              recurring_p: 0,
              needs_review: fb.confidence < 0.75,
              fallback: true,
            });
          } else {
            const catKey = `tx${i}__category`;
            const recKey = `tx${i}__recurring`;
            const catAnswer = jevResp?.answers?.[catKey];
            const recAnswer = jevResp?.answers?.[recKey];

            const choice = catAnswer?.choice || "uncertain";
            const confidence = catAnswer?.confidence || 0;
            const recurringNoul = recAnswer?.noul || 0;
            const recurringP = Math.abs(2 * recurringNoul - 1);

            const category = CATEGORY_MAP[choice] || "Other";
            const needsReview = confidence < 0.75 || choice === "uncertain";

            results.push({
              ...tx,
              category,
              category_conf: confidence,
              category_source: "jev",
              recurring_p: recurringP,
              needs_review: needsReview,
              jev_response: { choice, confidence, probabilities: catAnswer?.probabilities },
            });
          }
        }
      }

      return jsonResponse({
        action: "categorize",
        results,
        batches: batches.length,
        rules_skipped: transactions.length - needsJev.length,
        usage,
      });
    }

    if (action === "route") {
      const { text } = body;
      if (!text || typeof text !== "string") throw new HttpError(400, "Missing text");
      if (text.length > MAX_ROUTE_TEXT_CHARS) {
        throw new HttpError(400, `Text too long (max ${MAX_ROUTE_TEXT_CHARS} characters)`);
      }

      if (apiKey) {
        const capResp = capResponse(await checkCap(supabase, 1));
        if (capResp) return capResp;
      }

      let jevResp: any;
      let usedFallback = false;

      try {
        if (!apiKey) throw new Error("No TYPESAFE_API_KEY configured");
        const { state, questions } = buildRouteQuestions(text, customCategories);
        jevResp = await callJev(apiKey, state, questions, reserveRetry);
      } catch (e) {
        console.error("Jev routing failed, using fallback:", e);
        usedFallback = true;
      }

      if (usedFallback) {
        const fb = fallbackRoute(text);
        return jsonResponse({
          action: "route",
          ...fb,
          fallback: true,
        });
      }

      const intentAns = jevResp?.answers?.intent;
      const periodAns = jevResp?.answers?.period;
      const categoryAns = jevResp?.answers?.category;

      const intent = intentAns?.choice || "unsupported";
      const intentConfidence = intentAns?.confidence || 0;
      const period = periodAns?.choice || "this_month";
      const category = CATEGORY_MAP[categoryAns?.choice || "none"] || "none";

      const isUncertain = intent === "uncertain" || intent === "unsupported" || intentConfidence < 0.6;

      return jsonResponse({
        action: "route",
        intent,
        intent_confidence: intentConfidence,
        period,
        category: category === "None" ? "none" : category,
        uncertain: isUncertain,
        usage: jevResp?.usage || null,
      });
    }

    throw new HttpError(400, `Unknown action: ${String(action).slice(0, 40)}`);
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    console.error("jev-classify error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
