-- Extend credit_transactions.test_type CHECK to allow 'import'.
--
-- Why: AI-powered imports (Allure ZIP / PDF / CSV → intent_test_cases) run
-- multiple LLM calls but historically deducted 0 credits and left no ledger
-- row. The import charge path now deducts via CreditCostTrackerService with
-- testType='import', which flows into credit_transactions.test_type. Without
-- this the insert violates the CHECK and recordTransaction silently drops the
-- audit row (it swallows its own errors), re-creating the very "no audit trail"
-- bug the charge is meant to fix.

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_test_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_test_type_check
  CHECK (test_type = ANY (ARRAY['intelligent'::text, 'standard'::text, 'api'::text, 'chat'::text, 'import'::text]));
