/*
# Remove UPDATE and DELETE policies from demo tables

## Overview
The browser (anon key) must not be able to UPDATE or DELETE rows directly.
All edits and deletes are now routed through the `mutate` Edge Function,
which uses the service-role key (bypasses RLS) and counts against the daily cap.

## Changes
Drop the anon UPDATE and DELETE policies on:
- transactions
- rules
- budgets
- receipts
- questions

SELECT and INSERT policies remain unchanged — the browser can still read data
and insert new rows (e.g. logging a question, inserting a parsed transaction).
*/

DROP POLICY IF EXISTS "anon_update_transactions" ON transactions;
DROP POLICY IF EXISTS "anon_delete_transactions" ON transactions;

DROP POLICY IF EXISTS "anon_update_rules" ON rules;
DROP POLICY IF EXISTS "anon_delete_rules" ON rules;

DROP POLICY IF EXISTS "anon_update_budgets" ON budgets;
DROP POLICY IF EXISTS "anon_delete_budgets" ON budgets;

DROP POLICY IF EXISTS "anon_update_receipts" ON receipts;
DROP POLICY IF EXISTS "anon_delete_receipts" ON receipts;

DROP POLICY IF EXISTS "anon_update_questions" ON questions;
DROP POLICY IF EXISTS "anon_delete_questions" ON questions;
