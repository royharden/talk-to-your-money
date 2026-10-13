/*
# Owner-scoped data + locked-down delete_all_data

## Overview
Every visitor gets their own workspace, identified by an unguessable owner
token (32 random bytes, base64url) minted by the `mutate` Edge Function. Only
the SHA-256 hash of the token is stored server-side, in `workspaces`. The
browser sends the token in the `x-owner-token` header; every read, insert,
edit and delete is scoped to the workspace that token resolves to.

## Changes
1. `workspaces` (id, token_hash, created_at): RLS on, no policies, all
   privileges revoked from anon/authenticated. Service role only.
2. `owner_id` (FK → workspaces, ON DELETE CASCADE) on `transactions`, `rules`,
   `budgets`, `receipts` and `questions`. Existing rows keep `owner_id = NULL`:
   they become the read-only demo template, invisible to anon, and are copied
   into each new workspace by `create_workspace`.
3. `rules` is unique per (owner_id, merchant) and `budgets` per
   (owner_id, category, month), replacing the old global unique constraints.
4. `current_owner_id()`: resolves the `x-owner-token` request header to a
   workspace id (NULL if missing or unknown). SECURITY DEFINER so it can read
   `workspaces`; EXECUTE for anon/authenticated because RLS policies call it.
5. RLS on the data tables is rebuilt from scratch (every existing policy is
   dropped): anon/authenticated may SELECT only their own rows, and INSERT only
   their own rows into `transactions` and `questions`. There are no UPDATE or
   DELETE policies, and the UPDATE/DELETE/TRUNCATE privileges themselves are
   revoked, so anon cannot edit or delete anything directly.
6. `create_workspace(p_token_hash)` and `delete_all_data(p_owner)`:
   SECURITY DEFINER, EXECUTE for service_role only. `delete_all_data` deletes
   only `p_owner`'s rows and raises if the owner is NULL or unknown. Any older
   argument-less `delete_all_data()` is dropped.
7. EXECUTE on every function in `public` is revoked from PUBLIC, anon and
   authenticated; only `current_owner_id()` is granted back.
*/

-- ============================================================
-- workspaces — service role only
-- ============================================================
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE workspaces FROM PUBLIC, anon, authenticated;

-- ============================================================
-- current_owner_id — the caller's workspace, from x-owner-token
-- ============================================================
CREATE OR REPLACE FUNCTION current_owner_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH tok AS (
    SELECT NULLIF(current_setting('request.headers', true), '')::json ->> 'x-owner-token' AS t
  )
  SELECT w.id
  FROM workspaces w, tok
  WHERE tok.t ~ '^[A-Za-z0-9_-]{43}$'
    AND w.token_hash = encode(sha256(convert_to(tok.t, 'UTF8')), 'hex');
$$;

-- ============================================================
-- owner_id on every data table
-- ============================================================
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE rules        ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE budgets      ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE receipts     ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE questions    ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;

-- The browser inserts transactions and questions directly; the row is stamped
-- with the caller's workspace (and RLS rejects anything else)
ALTER TABLE transactions ALTER COLUMN owner_id SET DEFAULT current_owner_id();
ALTER TABLE questions    ALTER COLUMN owner_id SET DEFAULT current_owner_id();

CREATE INDEX IF NOT EXISTS idx_transactions_owner_date ON transactions (owner_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_rules_owner ON rules (owner_id);
CREATE INDEX IF NOT EXISTS idx_budgets_owner ON budgets (owner_id);
CREATE INDEX IF NOT EXISTS idx_receipts_owner ON receipts (owner_id);
CREATE INDEX IF NOT EXISTS idx_questions_owner ON questions (owner_id);

-- Replace the global unique constraints with per-owner ones
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conrelid::regclass AS tbl, con.conname
    FROM pg_constraint con
    WHERE con.contype = 'u'
      AND con.conrelid IN ('public.rules'::regclass, 'public.budgets'::regclass)
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey) AND a.attname = 'owner_id'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END
$$;

ALTER TABLE rules DROP CONSTRAINT IF EXISTS rules_owner_merchant_key;
ALTER TABLE rules ADD CONSTRAINT rules_owner_merchant_key UNIQUE (owner_id, merchant);

ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_owner_category_month_key;
ALTER TABLE budgets ADD CONSTRAINT budgets_owner_category_month_key UNIQUE (owner_id, category, month);

-- ============================================================
-- RLS: own rows only, read + insert (transactions, questions) only
-- ============================================================
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('transactions', 'rules', 'budgets', 'receipts', 'questions', 'workspaces')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END
$$;

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_select_transactions" ON transactions FOR SELECT
  TO anon, authenticated USING (owner_id = (SELECT current_owner_id()));
CREATE POLICY "owner_insert_transactions" ON transactions FOR INSERT
  TO anon, authenticated WITH CHECK (owner_id = (SELECT current_owner_id()));

CREATE POLICY "owner_select_rules" ON rules FOR SELECT
  TO anon, authenticated USING (owner_id = (SELECT current_owner_id()));

CREATE POLICY "owner_select_budgets" ON budgets FOR SELECT
  TO anon, authenticated USING (owner_id = (SELECT current_owner_id()));

CREATE POLICY "owner_select_receipts" ON receipts FOR SELECT
  TO anon, authenticated USING (owner_id = (SELECT current_owner_id()));

CREATE POLICY "owner_select_questions" ON questions FOR SELECT
  TO anon, authenticated USING (owner_id = (SELECT current_owner_id()));
CREATE POLICY "owner_insert_questions" ON questions FOR INSERT
  TO anon, authenticated WITH CHECK (owner_id = (SELECT current_owner_id()));

-- Privileges back the policies up: no UPDATE/DELETE/TRUNCATE for anon at all
REVOKE ALL ON TABLE transactions, rules, budgets, receipts, questions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE transactions, rules, budgets, receipts, questions TO anon, authenticated;
GRANT INSERT ON TABLE transactions, questions TO anon, authenticated;

-- ============================================================
-- create_workspace — new workspace seeded with the demo template
-- ============================================================
CREATE OR REPLACE FUNCTION create_workspace(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  INSERT INTO workspaces (token_hash) VALUES (p_token_hash) RETURNING id INTO v_owner;

  INSERT INTO transactions (
    owner_id, date, amount_cents, merchant_raw, merchant, description, source, category,
    category_conf, category_source, recurring_p, needs_review, jev_response, created_at
  )
  SELECT
    v_owner, date, amount_cents, merchant_raw, merchant, description, source, category,
    category_conf, category_source, recurring_p, needs_review, jev_response, created_at
  FROM transactions
  WHERE owner_id IS NULL;

  INSERT INTO rules (owner_id, merchant, category, created_at)
  SELECT v_owner, merchant, category, created_at
  FROM rules
  WHERE owner_id IS NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO budgets (owner_id, category, month, amount_cents)
  SELECT v_owner, category, month, amount_cents
  FROM budgets
  WHERE owner_id IS NULL
  ON CONFLICT DO NOTHING;

  RETURN v_owner;
END;
$$;

-- ============================================================
-- delete_all_data — the caller's rows only, never every row
-- ============================================================
DROP FUNCTION IF EXISTS delete_all_data();

CREATE OR REPLACE FUNCTION delete_all_data(p_owner uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_owner IS NULL OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = p_owner) THEN
    RAISE EXCEPTION 'delete_all_data: unknown owner';
  END IF;

  DELETE FROM receipts WHERE owner_id = p_owner;
  DELETE FROM questions WHERE owner_id = p_owner;
  DELETE FROM rules WHERE owner_id = p_owner;
  DELETE FROM budgets WHERE owner_id = p_owner;
  DELETE FROM transactions WHERE owner_id = p_owner;
END;
$$;

-- ============================================================
-- Function privileges: nothing in public is callable by anon except
-- current_owner_id(), which the RLS policies above need
-- ============================================================
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION current_owner_id() TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION create_workspace(text) TO service_role;
GRANT EXECUTE ON FUNCTION delete_all_data(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION increment_usage_counter_by(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION increment_usage_counter(text) TO service_role;
