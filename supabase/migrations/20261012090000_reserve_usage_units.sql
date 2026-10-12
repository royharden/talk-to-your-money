/*
# Reserve N usage units atomically + finish locking down writes

## Overview
Edge Functions now reserve one unit per paid upstream call (Jev/TypeSafe,
OpenAI chat, transcription), including retries and per-batch calls, so a single
request can no longer make several paid calls while only counting once.

## Changes
1. `increment_usage_counter_by(p_fn, p_units, p_cap)` — in one statement, adds
   `p_units` to today's counter only if `calls + p_units <= p_cap`, and returns the
   new count. Returns -1 (and adds nothing) if the reservation would exceed the
   cap or `p_units` is not between 1 and `p_cap`.
   SECURITY DEFINER, `search_path = public`, EXECUTE for service_role only.
2. `usage_counters`: RLS stays on, any policies are dropped, and all table
   privileges are revoked from anon/authenticated.
3. Drop the anon/authenticated INSERT policies on `rules`, `budgets` and
   `receipts`. The UI never inserts into these directly (rules and budgets go
   through the `mutate` Edge Function; receipts are not written by the UI).
   `transactions` and `questions` keep anon SELECT + INSERT, which the UI uses.

## Notes
- The older `increment_usage_counter(text)` is left in place (still
  service_role only) so already-deployed functions keep working until they are
  redeployed. Nothing in the repo calls it anymore.
*/

-- ============================================================
-- usage_counters — service role only
-- ============================================================
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'usage_counters'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.usage_counters', pol.policyname);
  END LOOP;
END
$$;

REVOKE ALL ON TABLE usage_counters FROM anon, authenticated;

-- ============================================================
-- increment_usage_counter_by — reserve N units or nothing
-- ============================================================
CREATE OR REPLACE FUNCTION increment_usage_counter_by(
  p_fn text,
  p_units integer,
  p_cap integer DEFAULT 200
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH reserved AS (
    INSERT INTO usage_counters AS uc (fn, day, calls)
    SELECT p_fn, CURRENT_DATE, p_units
    WHERE p_units BETWEEN 1 AND p_cap
    ON CONFLICT (fn, day)
    DO UPDATE SET calls = uc.calls + EXCLUDED.calls
    WHERE uc.calls + EXCLUDED.calls <= p_cap
    RETURNING uc.calls
  )
  SELECT COALESCE((SELECT calls FROM reserved), -1);
$$;

REVOKE EXECUTE ON FUNCTION increment_usage_counter_by(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage_counter_by(text, integer, integer) TO service_role;

-- Re-assert the lockdown on the older single-unit function
REVOKE EXECUTE ON FUNCTION increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage_counter(text) TO service_role;

-- ============================================================
-- Data tables: anon keeps INSERT only where the UI needs it
-- ============================================================
DROP POLICY IF EXISTS "anon_insert_rules" ON rules;
DROP POLICY IF EXISTS "anon_insert_budgets" ON budgets;
DROP POLICY IF EXISTS "anon_insert_receipts" ON receipts;
