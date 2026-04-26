-- Make credit_transactions append-only.
--
-- Why: credit_transactions is the single source of truth for the credit audit
-- trail. It must never be mutated or deleted, otherwise reconciliation between
-- user_credits.credits_balance and the sum of transactions becomes impossible.
--
-- How: triggers on UPDATE and DELETE that always RAISE EXCEPTION. Triggers fire
-- regardless of role (including service_role and superuser DDL by default), so
-- they actually protect the table — RLS policies would not, because service_role
-- bypasses RLS.
--
-- Escape hatch: a maintenance role can temporarily disable the trigger
-- (`ALTER TABLE ... DISABLE TRIGGER ...`) inside a controlled migration, run
-- the data fix, then re-enable. This is intentional — irreversible blocks are
-- worse than auditable blocks for an internal data store.

CREATE OR REPLACE FUNCTION public.deny_credit_transactions_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'credit_transactions is append-only — % is not allowed. To fix data, disable this trigger in a controlled migration.',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS no_update_credit_transactions ON public.credit_transactions;
CREATE TRIGGER no_update_credit_transactions
  BEFORE UPDATE ON public.credit_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_credit_transactions_mutation();

DROP TRIGGER IF EXISTS no_delete_credit_transactions ON public.credit_transactions;
CREATE TRIGGER no_delete_credit_transactions
  BEFORE DELETE ON public.credit_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_credit_transactions_mutation();

-- Sanity comment on the table
COMMENT ON TABLE public.credit_transactions IS
  'Append-only audit log for credit balance changes. UPDATE/DELETE blocked by triggers.';
