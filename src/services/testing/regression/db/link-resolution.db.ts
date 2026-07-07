import { supabaseAdmin } from '@/db/supabase';

/**
 * A completed test's status + persisted per-step results, read back after a
 * nested linked-test-case dispatch settles (see linked-test-case-runner.service.ts).
 * `executed_steps` is populated via TestExecutedStepsRedisService.appendStepCompleted
 * → finalizeToDb (Hard invariant #12) — same column test-results-formatter reads
 * for failure summaries.
 */
export function getTestStatusAndStepsById(testId: string) {
  return supabaseAdmin
    .from('tests')
    .select('id, status, executed_steps')
    .eq('id', testId)
    .single();
}
