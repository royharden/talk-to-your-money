// mutate Edge Function — all privileged write operations (UPDATE, DELETE, upsert)
// Uses the service-role client. Counts against the daily cap.
// The browser anon key can only SELECT and INSERT; all edits/deletes go through here.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DAILY_CAP = 200;

async function checkCap(supabase: any): Promise<{ allowed: boolean; count: number; error?: string }> {
  const { data, error } = await supabase.rpc("increment_usage_counter", { p_fn: "mutate" });
  if (error) return { allowed: false, count: 0, error: "Usage counter unavailable" };
  return { allowed: (data as number) <= DAILY_CAP, count: data as number };
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
      JSON.stringify({ error: "Demo daily limit reached — Offline demo still works." }),
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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    const cap = await checkCap(supabase);
    const capResp = capResponse(cap);
    if (capResp) return capResp;

    const body = await req.json();
    const { action } = body;

    // --- transactions ---

    if (action === "confirm_category") {
      // Confirm a category for a transaction (from Needs Review or inline edit)
      const { id, category } = body;
      if (!id || !category) throw new Error("Missing id or category");

      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .select("merchant")
        .eq("id", id)
        .maybeSingle();
      if (txErr) throw txErr;
      if (!tx) throw new Error("Transaction not found");

      const { error } = await supabase
        .from("transactions")
        .update({ needs_review: false, category, category_source: "user", category_conf: 1.0 })
        .eq("id", id);
      if (error) throw error;

      // Create a rule for this merchant
      await supabase.from("rules").upsert(
        { merchant: tx.merchant, category },
        { onConflict: "merchant" }
      );

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "bulk_confirm") {
      // Bulk-accept items above a confidence threshold
      const { ids } = body;
      if (!ids || !Array.isArray(ids)) throw new Error("Missing ids array");

      for (const id of ids) {
        const { data: tx } = await supabase
          .from("transactions")
          .select("merchant, category")
          .eq("id", id)
          .maybeSingle();
        if (!tx) continue;

        await supabase
          .from("transactions")
          .update({ needs_review: false, category_source: "user" })
          .eq("id", id);

        await supabase.from("rules").upsert(
          { merchant: tx.merchant, category: tx.category },
          { onConflict: "merchant" }
        );
      }

      return new Response(JSON.stringify({ ok: true, count: ids.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_transaction_category") {
      // Inline edit from Transactions table
      const { id, category } = body;
      if (!id || !category) throw new Error("Missing id or category");

      const { error } = await supabase
        .from("transactions")
        .update({ category, needs_review: false, category_source: "user" })
        .eq("id", id);
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete_transaction") {
      const { id } = body;
      if (!id) throw new Error("Missing id");

      const { error } = await supabase.from("transactions").delete().eq("id", id);
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete_all_data") {
      // Wipe all transactions, rules, budgets, receipts, questions
      await supabase.from("receipts").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("transactions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("rules").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("budgets").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("questions").delete().neq("id", "00000000-0000-0000-0000-000000000000");

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- rules ---

    if (action === "upsert_rule") {
      // Create/update a merchant rule (after confirming a chat transaction)
      const { merchant, category } = body;
      if (!merchant || !category) throw new Error("Missing merchant or category");

      const { error } = await supabase.from("rules").upsert(
        { merchant, category },
        { onConflict: "merchant" }
      );
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- budgets ---

    if (action === "upsert_budget") {
      const { category, month, amount_cents } = body;
      if (!category || !month || amount_cents === undefined) throw new Error("Missing budget fields");

      const { data: existing } = await supabase
        .from("budgets")
        .select("id")
        .eq("category", category)
        .eq("month", month)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("budgets")
          .update({ amount_cents })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("budgets")
          .insert({ category, month, amount_cents });
        if (error) throw error;
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete_budget") {
      const { id } = body;
      if (!id) throw new Error("Missing id");

      const { error } = await supabase.from("budgets").delete().eq("id", id);
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (err) {
    console.error("mutate error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
