/*
# Talk-to-Your-Money: Core Database Schema

## Overview
Creates the complete schema for a chat-first personal finance agent demo app.
This is a single-tenant, no-auth demo workspace — all tables are publicly
readable/writable by the anon role, except `usage_counters` which is locked down
so only the service role (Edge Functions) can write to it.

## New Tables
1. `transactions` — normalized financial transactions (spend and income)
   - id (uuid pk), date, amount_cents (negative=spend), merchant_raw, merchant,
     description, source, category, category_conf, category_source, recurring_p,
     needs_review, jev_response, created_at
2. `rules` — merchant→category rules created by user confirmations
   - id (uuid pk), merchant (unique), category, created_at
3. `budgets` — monthly per-category budget limits
   - id (uuid pk), category, month (date), amount_cents
4. `receipts` — receipt image metadata + parsed JSON
   - id (uuid pk), transaction_id (fk), image_path, parsed (jsonb), created_at
5. `questions` — log of user questions with Jev routing + computed results + LLM answers
   - id (uuid pk), text, jev_route (jsonb), query_name, result (jsonb), answer (jsonb), created_at
6. `usage_counters` — daily call counter per Edge Function for the 200/day cap
   - fn (text), day (date), calls (int), composite pk (fn, day)
   - RLS enabled, NO policies → only service role can access

## Security
- RLS enabled on ALL tables.
- `transactions`, `rules`, `budgets`, `receipts`, `questions`: anon+authenticated CRUD (demo workspace).
- `usage_counters`: RLS enabled, NO policies at all — only the service role key can read/write.
  This prevents the browser from resetting or inflating the daily cap.
- A SECURITY DEFINER function `increment_usage_counter` safely increments the counter
  and is REVOKE'd from PUBLIC/anon/authenticated, GRANT'd only to service_role.

## Important Notes
1. Money is stored as integer cents (negative = spend, positive = income).
2. `category_source` tracks how the category was assigned: jev | rule | user | fallback.
3. `needs_review` flags low-confidence categorizations for the "Needs you" queue.
4. `usage_counters` is the daily cap guard — see the SECURITY DEFINER function below.
*/

-- ============================================================
-- transactions
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  amount_cents integer NOT NULL,
  merchant_raw text NOT NULL DEFAULT '',
  merchant text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'chat',
  category text NOT NULL DEFAULT 'Other',
  category_conf numeric DEFAULT 0,
  category_source text NOT NULL DEFAULT 'fallback',
  recurring_p numeric DEFAULT 0,
  needs_review boolean NOT NULL DEFAULT true,
  jev_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions (merchant);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category);
CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions (source);
CREATE INDEX IF NOT EXISTS idx_transactions_needs_review ON transactions (needs_review) WHERE needs_review = true;

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_transactions" ON transactions;
CREATE POLICY "anon_select_transactions" ON transactions FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_transactions" ON transactions;
CREATE POLICY "anon_insert_transactions" ON transactions FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_transactions" ON transactions;
CREATE POLICY "anon_update_transactions" ON transactions FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_transactions" ON transactions;
CREATE POLICY "anon_delete_transactions" ON transactions FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- rules
-- ============================================================
CREATE TABLE IF NOT EXISTS rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant text UNIQUE NOT NULL,
  category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_rules" ON rules;
CREATE POLICY "anon_select_rules" ON rules FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_rules" ON rules;
CREATE POLICY "anon_insert_rules" ON rules FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_rules" ON rules;
CREATE POLICY "anon_update_rules" ON rules FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_rules" ON rules;
CREATE POLICY "anon_delete_rules" ON rules FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- budgets
-- ============================================================
CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  month date NOT NULL,
  amount_cents integer NOT NULL,
  UNIQUE (category, month)
);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_budgets" ON budgets;
CREATE POLICY "anon_select_budgets" ON budgets FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_budgets" ON budgets;
CREATE POLICY "anon_insert_budgets" ON budgets FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_budgets" ON budgets;
CREATE POLICY "anon_update_budgets" ON budgets FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_budgets" ON budgets;
CREATE POLICY "anon_delete_budgets" ON budgets FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- receipts
-- ============================================================
CREATE TABLE IF NOT EXISTS receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES transactions(id) ON DELETE CASCADE,
  image_path text,
  parsed jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_receipts" ON receipts;
CREATE POLICY "anon_select_receipts" ON receipts FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_receipts" ON receipts;
CREATE POLICY "anon_insert_receipts" ON receipts FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_receipts" ON receipts;
CREATE POLICY "anon_update_receipts" ON receipts FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_receipts" ON receipts;
CREATE POLICY "anon_delete_receipts" ON receipts FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- questions
-- ============================================================
CREATE TABLE IF NOT EXISTS questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  jev_route jsonb,
  query_name text,
  result jsonb,
  answer jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_questions" ON questions;
CREATE POLICY "anon_select_questions" ON questions FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_questions" ON questions;
CREATE POLICY "anon_insert_questions" ON questions FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_questions" ON questions;
CREATE POLICY "anon_update_questions" ON questions FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_questions" ON questions;
CREATE POLICY "anon_delete_questions" ON questions FOR DELETE
  TO anon, authenticated USING (true);

-- ============================================================
-- usage_counters — locked down, service-role only
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_counters (
  fn text NOT NULL,
  day date NOT NULL DEFAULT CURRENT_DATE,
  calls integer NOT NULL DEFAULT 0,
  PRIMARY KEY (fn, day)
);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
-- NO policies: anon and authenticated get nothing. Only service_role bypasses RLS.

-- ============================================================
-- increment_usage_counter — SECURITY DEFINER, service-role only
-- Safely increments the daily counter and returns the new count.
-- Edge Functions call this with the service role key to enforce the cap.
-- ============================================================
CREATE OR REPLACE FUNCTION increment_usage_counter(p_fn text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO usage_counters (fn, day, calls)
  VALUES (p_fn, CURRENT_DATE, 1)
  ON CONFLICT (fn, day)
  DO UPDATE SET calls = usage_counters.calls + 1
  RETURNING calls INTO v_count;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION increment_usage_counter(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_usage_counter(text) TO service_role;
