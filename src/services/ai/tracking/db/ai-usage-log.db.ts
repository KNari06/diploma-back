import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for `ai_usage_log` — the per-session AI cost ledger.
 * Pure Supabase access, no business logic. Aggregation lives in
 * `AIUsageTracker.aggregate`.
 */

export interface AIUsageLogRow {
  workspace_id: string;
  user_id: string | null;
  test_id: string | null;
  run_id: string | null;
  operation_type: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  ai_call_count: number;
  call_breakdown: unknown;
  session_duration_ms: number;
  pipeline_metrics?: Record<string, unknown>;
}

/**
 * PostgREST's signature for "you named a column that does not exist".
 *
 * This matters because it is not a transient error and must never be retried or
 * treated as noise: it means the code and the database schema have diverged,
 * and EVERY subsequent write will fail identically until a migration is run.
 * Exactly that happened between 2026-06-07 and 2026-08-13 — `run_id` was added
 * to the insert while `20260605_add_run_id_to_ai_usage_log.sql` was never
 * applied, and two months of AI cost data were lost to a swallowed `.catch()`.
 */
export function isSchemaDriftError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('pgrst204') ||
    (m.includes('column') && m.includes('does not exist')) ||
    m.includes('could not find the') ||
    m.includes('schema cache')
  );
}

/** Insert one aggregated session row. Throws on failure; the caller decides. */
export async function insertAIUsageLog(row: AIUsageLogRow): Promise<void> {
  const { error } = await supabaseAdmin.from('ai_usage_log').insert(row);
  if (error) throw new Error(error.message);
}
