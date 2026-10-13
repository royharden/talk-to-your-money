// mutate Edge Function — all privileged write operations (UPDATE, DELETE, upsert)
// Uses the service-role client. Counts against the daily cap.
// The browser anon key can only SELECT and INSERT its own rows; all edits/deletes go through here.
// Every action except create_session is scoped to the caller's workspace, resolved
// from the unguessable owner token in the x-owner-token header.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Owner-Token",
};

const DEFAULT_DAILY_CAP = 200;

// Request bounds
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BULK_IDS = 500;
const MAX_CATEGORY_CHARS = 100;
const MAX_MERCHANT_CHARS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 32 random bytes, base64url without padding
const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
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

function isId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function isText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new unguessable owner token: 32 random bytes, base64url */
function newOwnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The caller's workspace id from the x-owner-token header; 401 if missing or unknown */
async function resolveOwner(supabase: any, req: Request): Promise<string> {
  const token = req.headers.get("x-owner-token");
  if (!token || !OWNER_TOKEN_RE.test(token)) {
    throw new HttpError(401, "Missing or invalid session");
  }
  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(401, "Missing or invalid session");
  return data.id;
}

/**
 * Count this write against the daily cap. Fails closed: an RPC error or a
 * null/non-integer result is reported as an error (503), never as OK.
 */
async function checkCap(supabase: any): Promise<{ allowed: boolean; count: number; error?: string }> {
  const { data, error } = await supabase.rpc("increment_usage_counter_by", {
    p_fn: "mutate",
    p_units: 1,
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
  // -1 means the cap is reached and nothing was added
  return { allowed: data >= 1, count: data };
}

function capResponse(cap: { allowed: boolean; error?: string }) {
  if (cap.error) {
    return new Response(
      JSON.stringify({ error: cap.error }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (!cap.allowed) {
    return new Response(
      JSON.stringify({ error: "Demo daily limit reached — Offline demo still works.", code: "daily_limit" }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  return null;
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
      return new Response(
        JSON.stringify({ error: "Usage counter unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const body = await readJsonBody(req, MAX_BODY_BYTES);
    const { action } = body;

    // Resolve the caller before spending a unit; only create_session has no owner yet
    const owner = action === "create_session" ? null : await resolveOwner(supabase, req);

    const cap = await checkCap(supabase);
    const capResp = capResponse(cap);
    if (capResp) return capResp;

    // --- session ---

    if (action === "create_session") {
      // New workspace (seeded with the demo template). Only the token's hash is stored.
      const token = newOwnerToken();
      const { error } = await supabase.rpc("create_workspace", { p_token_hash: await sha256Hex(token) });
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true, token }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- transactions ---

    if (action === "confirm_category") {
      // Confirm a category for a transaction (from Needs Review or inline edit)
      const { id, category } = body;
      if (!isId(id) || !isText(category, MAX_CATEGORY_CHARS)) throw new HttpError(400, "Missing id or category");

      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .select("merchant")
        .eq("id", id)
        .eq("owner_id", owner)
        .maybeSingle();
      if (txErr) throw txErr;
      if (!tx) throw new HttpError(404, "Transaction not found");

      const { error } = await supabase
        .from("transactions")
        .update({ needs_review: false, category, category_source: "user", category_conf: 1.0 })
        .eq("id", id)
        .eq("owner_id", owner);
      if (error) throw error;

      // Create a rule for this merchant
      await supabase.from("rules").upsert(
        { owner_id: owner, merchant: tx.merchant, category },
        { onConflict: "owner_id,merchant" }
      );

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "bulk_confirm") {
      // Bulk-accept items above a confidence threshold
      const { ids } = body;
      if (!ids || !Array.isArray(ids)) throw new HttpError(400, "Missing ids array");
      if (ids.length > MAX_BULK_IDS) throw new HttpError(400, `Too many ids (max ${MAX_BULK_IDS})`);
      if (!ids.every(isId)) throw new HttpError(400, "Invalid id");

      for (const id of ids) {
        const { data: tx } = await supabase
          .from("transactions")
          .select("merchant, category")
          .eq("id", id)
          .eq("owner_id", owner)
          .maybeSingle();
        if (!tx) continue;

        await supabase
          .from("transactions")
          .update({ needs_review: false, category_source: "user" })
          .eq("id", id)
          .eq("owner_id", owner);

        await supabase.from("rules").upsert(
          { owner_id: owner, merchant: tx.merchant, category: tx.category },
          { onConflict: "owner_id,merchant" }
        );
      }

      return new Response(JSON.stringify({ ok: true, count: ids.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_transaction_category") {
      // Inline edit from Transactions table
      const { id, category } = body;
      if (!isId(id) || !isText(category, MAX_CATEGORY_CHARS)) throw new HttpError(400, "Missing id or category");

      const { error } = await supabase
        .from("transactions")
        .update({ category, needs_review: false, category_source: "user" })
        .eq("id", id)
        .eq("owner_id", owner);
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete_transaction") {
      const { id } = body;
      if (!isId(id)) throw new HttpError(400, "Missing id");

      const { error } = await supabase.from("transactions").delete().eq("id", id).eq("owner_id", owner);
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete_all_data") {
      // Wipe the caller's transactions, rules, budgets, receipts and questions — nobody else's.
      // delete_all_data(p_owner) is service-role only and raises on a NULL/unknown owner.
      const { error } = await supabase.rpc("delete_all_data", { p_owner: owner });
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- rules ---

    if (action === "upsert_rule") {
      // Create/update a merchant rule (after confirming a chat transaction)
      const { merchant, category } = body;
      if (!isText(merchant, MAX_MERCHANT_CHARS) || !isText(category, MAX_CATEGORY_CHARS)) {
        throw new HttpError(400, "Missing merchant or category");
      }

      const { error } = await supabase.from("rules").upsert(
        { owner_id: owner, merchant, category },
        { onConflict: "owner_id,merchant" }
      );
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- budgets ---

    if (action === "upsert_budget") {
      const { category, month, amount_cents } = body;
      if (
        !isText(category, MAX_CATEGORY_CHARS) ||
        typeof month !== "string" || !DATE_RE.test(month) ||
        !Number.isInteger(amount_cents) || Math.abs(amount_cents) > 2147483647
      ) {
        throw new HttpError(400, "Missing budget fields");
      }

      const { data: existing } = await supabase
        .from("budgets")
        .select("id")
        .eq("owner_id", owner)
        .eq("category", category)
        .eq("month", month)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("budgets")
          .update({ amount_cents })
          .eq("id", existing.id)
          .eq("owner_id", owner);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("budgets")
          .insert({ owner_id: owner, category, month, amount_cents });
        if (error) throw error;
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete_budget") {
      const { id } = body;
      if (!isId(id)) throw new HttpError(400, "Missing id");

      const { error } = await supabase.from("budgets").delete().eq("id", id).eq("owner_id", owner);
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new HttpError(400, `Unknown action: ${String(action).slice(0, 40)}`);
  } catch (err) {
    if (err instanceof HttpError) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: err.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.error("mutate error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
