import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for import credit charging.
 * Pure Supabase queries — no business logic, no orchestration.
 * Each function throws on DB/network error; the calling service wraps in try/catch.
 */

/**
 * Has this import already been charged?
 *
 * Idempotency guard for the import credit deduction: a BullMQ retry re-runs the
 * whole job, so before charging we check for an existing `usage` transaction
 * for this import. The charge is written by `deductCreditsForTest` with
 * `testId = importId` and `testType = 'import'`, which lands as
 * `metadata.test_id` + `metadata.test_type`. Matching on both avoids colliding
 * with a same-id row of another type. Mirrors the welcome-bonus marker pattern
 * (`metadata->>is_initial_bonus`). Returns true if a charge row exists.
 */
export async function importAlreadyCharged(importId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('credit_transactions')
    .select('id')
    .eq('transaction_type', 'usage')
    .eq('metadata->>test_type', 'import')
    .eq('metadata->>test_id', importId)
    .limit(1);

  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}
