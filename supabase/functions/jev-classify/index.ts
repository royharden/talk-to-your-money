// jev-classify Edge Function — categorizes transactions in batches + routes questions
// Uses TypeSafe AI's Jev model (jev-1.13.0)
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DAILY_CAP = 200;
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-1.13.0";

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

async function checkCap(supabase: any): Promise<{ allowed: boolean; count: number; error?: string }> {
  const { data, error } = await supabase.rpc("increment_usage_counter", { p_fn: "jev-classify" });
  if (error) return { allowed: false, count: 0, error: "Usage counter unavailable" };
  return { allowed: (data as number) <= DAILY_CAP, count: data as number };
}

/** Call Jev with retry + exponential backoff */
async function callJev(
  state: Record<string, any>,
  questions: Record<string, any>,
  customCategories: string[] = []
): Promise<any> {
  const apiKey = Deno.env.get("TYPESAFE_API_KEY");
  if (!apiKey) throw new Error("No TYPESAFE_API_KEY configured");

  const body = {
    model: JEV_MODEL,
    state,
    questions,
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(JEV_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (resp.status === 429 || resp.status === 529) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        lastError = new Error(`Jev rate limited (${resp.status})`);
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Jev error ${resp.status}: ${errText}`);
      }

      const json = await resp.json();
      console.log("Jev response.model:", json.model);
      return json;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError || new Error("Jev unreachable");
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
      merchant: tx.merchant || "",
      description: tx.description || "",
      amount: String(tx.amount_cents / 100),
      date: tx.date,
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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    const body = await req.json();
    const { action, customCategories } = body;

    if (action === "categorize") {
      const cap = await checkCap(supabase);
      if (cap.error) {
        return new Response(
          JSON.stringify({ error: cap.error }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!cap.allowed) {
        return new Response(
          JSON.stringify({ error: "Demo daily limit reached — Offline demo still works." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let { transactions } = body;
      if (!transactions || !Array.isArray(transactions)) {
        throw new Error("Missing transactions array");
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
      for (let i = 0; i < needsJev.length; i += 10) {
        batches.push(needsJev.slice(i, i + 10));
      }

      for (const batch of batches) {
        const { state, questions } = buildCategorizeQuestions(batch, customCategories || []);
        let jevResp: any;
        let usedFallback = false;

        try {
          jevResp = await callJev(state, questions, customCategories || []);
        } catch (e) {
          console.error("Jev failed, using fallback:", e);
          usedFallback = true;
        }

        for (let i = 0; i < batch.length; i++) {
          const tx = batch[i];
          if (usedFallback) {
            const fb = fallbackCategorize(tx.merchant);
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

      return new Response(JSON.stringify({
        action: "categorize",
        results,
        batches: batches.length,
        rules_skipped: transactions.length - needsJev.length,
        usage: jevResp?.usage || null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "route") {
      const cap = await checkCap(supabase);
      if (cap.error) {
        return new Response(
          JSON.stringify({ error: cap.error }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!cap.allowed) {
        return new Response(
          JSON.stringify({ error: "Demo daily limit reached — Offline demo still works." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { text } = body;
      if (!text) throw new Error("Missing text");

      let jevResp: any;
      let usedFallback = false;

      try {
        const { state, questions } = buildRouteQuestions(text, customCategories || []);
        jevResp = await callJev(state, questions, customCategories || []);
      } catch (e) {
        console.error("Jev routing failed, using fallback:", e);
        usedFallback = true;
      }

      if (usedFallback) {
        const fb = fallbackRoute(text);
        return new Response(JSON.stringify({
          action: "route",
          ...fb,
          fallback: true,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
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

      return new Response(JSON.stringify({
        action: "route",
        intent,
        intent_confidence: intentConfidence,
        period,
        category: category === "None" ? "none" : category,
        uncertain: isUncertain,
        usage: jevResp?.usage || null,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (err) {
    console.error("jev-classify error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
