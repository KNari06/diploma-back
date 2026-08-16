/**
 * Exploration Storage Service
 * Persists exploration runs and discovered test cases to Supabase.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { ExplorationResult, DiscoveredTestCase, ExplorationCheckpoint } from '@/agent/core/lite/exploration/types';
import { toIntentTestCase } from '@/agent/core/lite/exploration/types';

/**
 * Terminal statuses a FAILED run may carry.
 *
 * Mirrors the CHECK in 20260802_exploration_runs_honest_failure_status.sql —
 * a value absent there fails the whole UPDATE (PostgREST rejects the row), so
 * keep the two in sync. Deliberately excludes `timed_out` / `cancelled`: those
 * are written by the stale sweep (`reapStaleRunningRuns`) and by `cancelRun`
 * respectively, not by `failRun`.
 */
export type ExplorationFailureStatus =
  | 'failed'
  | 'unreachable'
  | 'blocked_by_bot';

export interface ExplorationRunRecord {
  id: string;
  exploration_id: string;
  project_id: string;
  user_id: string;
  chat_session_id: string | null;
  entry_url: string;
  /**
   * Full lifecycle set, not just the three this service writes: `timed_out` is
   * written by the stale sweep and `cancelled` by the cancel path, so a reader
   * typed to `running|completed|failed` was already wrong before the honest
   * failure statuses landed.
   */
  status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'timed_out'
    | 'cancelled'
    | 'unreachable'
    | 'blocked_by_bot';
  config: Record<string, any> | null;
  summary: Record<string, any> | null;
  budget_used: Record<string, any> | null;
  duration_ms: number | null;
  test_cases_count: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export class ExplorationStorageService {
  /**
   * Create a new exploration run record.
   */
  static async createRun(data: {
    explorationId: string;
    projectId: string;
    userId: string;
    chatSessionId?: string;
    entryUrl: string;
    config?: Record<string, any>;
  }): Promise<ExplorationRunRecord | null> {
    try {
      const { data: record, error } = await supabaseAdmin
        .from('exploration_runs')
        .insert({
          exploration_id: data.explorationId,
          project_id: data.projectId,
          user_id: data.userId,
          chat_session_id: data.chatSessionId || null,
          entry_url: data.entryUrl,
          status: 'running',
          config: data.config || null,
        })
        .select('*')
        .single();

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to create run', {
          error: error.message,
          explorationId: data.explorationId,
        });
        return null;
      }

      logger.info('[EXPLORATION_STORAGE] Run created', {
        explorationId: data.explorationId,
        id: record.id,
      });

      return record as ExplorationRunRecord;
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error creating run', {
        error: error instanceof Error ? error.message : String(error),
        explorationId: data.explorationId,
      });
      return null;
    }
  }

  /**
   * Mark exploration run as completed with results.
   */
  static async completeRun(explorationId: string, result: ExplorationResult): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('exploration_runs')
        .update({
          status: 'completed',
          summary: result.summary,
          budget_used: result.budgetUsed,
          duration_ms: result.durationMs,
          // Rows this run actually WROTE — explored flows plus the generated
          // negatives, which are `explored:false` but step-bearing and therefore
          // persisted by `saveTestCases`. `result.testCases.length` over-counts
          // (it includes zero-step not_explored placeholders, which made the
          // card read "34 tests" against the panel's "All (22)"), while
          // `runnableTestCases` UNDER-counts by one row per form flow — the card
          // said 3 while `/explorations/:id/test-cases` returned 5. This column
          // backs the history card, whose job is "what did this run add to my
          // project", so it must equal the row count that endpoint returns.
          test_cases_count: result.summary.persistedTestCases,
          completed_at: new Date().toISOString(),
        })
        .eq('exploration_id', explorationId);

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to complete run', {
          error: error.message,
          explorationId,
        });
      }
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error completing run', {
        error: error instanceof Error ? error.message : String(error),
        explorationId,
      });
    }
  }

  /**
   * Persist discovered MOBILE test cases straight from the runner snapshot.
   *
   * Mobile runs don't produce web `DiscoveredTestCase` objects — the runner
   * returns nested cases under `flows[].mobile.cases[]`, each already
   * carrying replay-ready `intentSteps` (the exact shape intent_test_cases
   * .steps_json wants). So we insert directly here rather than round-trip
   * through the web `toIntentTestCase` adapter (which would lose the mobile
   * step shape). Returns inserted ids; never throws (best-effort, mirrors
   * saveTestCases).
   *
   * `snapshotFlows` is `UiExplorationSnapshot.flows` from the runner — typed
   * loosely on purpose so the backend doesn't import the runner's contract.
   */
  static async saveMobileTestCasesFromSnapshot(
    snapshotFlows: Array<{
      name?: string;
      category?: string;
      priority?: string;
      mobile?: {
        cases?: Array<{
          name?: string;
          description?: string;
          status?: string;
          intentSteps?: unknown[];
          assertions?: Array<{ type?: string; expect?: string; afterStep?: number; source?: 'tree' | 'screenshot' }>;
          preconditions?: string[];
        }>;
      };
    }>,
    projectId: string,
    userId: string,
    platform: 'android' | 'ios' | 'flutter',
    /**
     * The run that discovered these — same role as on the web path. Without it
     * the mobile rows land with `exploration_id = NULL`, so
     * `/explorations/:id/test-cases` (which filters on it, with no fallback by
     * design) returns an empty list and the results panel shows nothing for a
     * mobile run that actually saved cases. Optional so any caller that has no
     * run id still compiles.
     */
    explorationId?: string,
  ): Promise<string[]> {
    const browserTag = platform === 'ios' ? 'mobile_ios' : platform === 'flutter' ? 'mobile_flutter' : 'mobile_android';
    const records: Array<Record<string, unknown>> = [];

    for (const flow of snapshotFlows || []) {
      const cases = flow.mobile?.cases || [];
      for (const c of cases) {
        const steps = Array.isArray(c.intentSteps) ? c.intentSteps : [];
        // Skip empty cases — nothing replayable to save.
        if (steps.length === 0) continue;
        // Turn the case's observation assertions into runnable ai_check steps,
        // INSERTED at the step they were observed after (not blindly appended) —
        // a mid-flow check ("cart badge shows 1" after step 1 of 2) must replay
        // against that screen, not the final one. Non-observation assertions
        // (network/url/console) can't run on the mobile tree; they're preserved
        // as `assert:` tags (mirroring the web path) rather than silently dropped.
        const stepsWithChecks = insertMobileAssertionSteps(steps, c.assertions);
        const assertionTags = buildAssertionTags(c.assertions);
        const priority = ['high', 'medium', 'low'].includes(flow.priority || '')
          ? (flow.priority as string)
          : 'medium';
        records.push({
          project_id: projectId,
          user_id: userId,
          name: c.name || flow.name || 'Mobile flow',
          description: c.description || null,
          start_url: null, // mobile has no URL
          steps_json: stepsWithChecks,
          // Set the platform column (not just the tag) so mobile exploration
          // cases are queryable by platform like every other mobile test — the
          // tag alone left `platform` defaulting to 'web'. browserTag already
          // holds the enum form (mobile_android|mobile_ios|mobile_flutter).
          platform: browserTag,
          tags: [browserTag, ...(flow.category ? [flow.category] : []), ...assertionTags],
          priority,
          expected_result: null,
          // B5: entry precondition derived by the runner from the flow's
          // first screen ("App is on the X screen"). Column is TEXT[]; keep
          // only non-empty strings, else leave the column at its default.
          preconditions: Array.isArray(c.preconditions)
            ? c.preconditions.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            : null,
          status: 'draft',
          kind: 'standalone',
          source: 'exploration',
          // Stamp the run so the results screen can list exactly this run's
          // output. The web path has done this since 2026-08-03; mobile was
          // left NULL, which made `/explorations/:id/test-cases` return nothing
          // for a mobile run (that reader filters on the column and
          // deliberately has no project-wide fallback).
          exploration_id: explorationId ?? null,
        });
      }
    }

    if (records.length === 0) return [];

    try {
      const { data, error } = await supabaseAdmin
        .from('intent_test_cases')
        .insert(records)
        .select('id');

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to save mobile test cases', {
          error: error.message,
          count: records.length,
        });
        return [];
      }
      const ids = (data || []).map((r: { id: string }) => r.id);
      logger.info('[EXPLORATION_STORAGE] Mobile test cases saved', { count: ids.length, projectId });
      return ids;
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error saving mobile test cases', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Mark a MOBILE exploration run as completed.
   *
   * Mobile runs come from the runner (not the in-process ExplorationEngine),
   * so we don't have a web `ExplorationResult` — only the relay's terminal
   * outcome (status + summary + counts). This persists those directly,
   * mirroring `completeRun`'s columns. `failRun` covers the failed path.
   */
  static async completeMobileRun(
    explorationId: string,
    data: {
      summary: Record<string, unknown>;
      durationMs?: number | null;
      testCasesCount?: number;
    },
  ): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('exploration_runs')
        .update({
          status: 'completed',
          summary: data.summary,
          duration_ms: data.durationMs ?? null,
          test_cases_count: data.testCasesCount ?? 0,
          completed_at: new Date().toISOString(),
        })
        .eq('exploration_id', explorationId);

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to complete mobile run', {
          error: error.message,
          explorationId,
        });
      }
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error completing mobile run', {
        error: error instanceof Error ? error.message : String(error),
        explorationId,
      });
    }
  }

  /**
   * Mark exploration run as failed.
   *
   * `status` narrows WHY it ended when the cause is known (see
   * 20260802_exploration_runs_honest_failure_status.sql). It defaults to
   * `'failed'`, so every existing caller keeps its behaviour and only a caller
   * that can actually tell the difference passes something else — a wrong
   * specific status is worse than an honest generic one.
   *
   * `error_message` is still written in every case: the status makes the
   * outcome queryable, it does not replace the human-readable reason.
   */
  static async failRun(
    explorationId: string,
    errorMessage: string,
    status: ExplorationFailureStatus = 'failed',
  ): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('exploration_runs')
        .update({
          status,
          error_message: errorMessage,
          completed_at: new Date().toISOString(),
        })
        .eq('exploration_id', explorationId);

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to mark run as failed', {
          error: error.message,
          explorationId,
        });
      }
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error failing run', {
        error: error instanceof Error ? error.message : String(error),
        explorationId,
      });
    }
  }

  /**
   * Flip a run to 'cancelled'. Idempotent by construction: the
   * `status = 'running'` filter means a run that already finished (or was
   * already cancelled) is untouched, so a double-click cannot rewrite a
   * terminal row or resurrect a completed one.
   *
   * @returns true when THIS call performed the cancellation. False means the
   *   run was already terminal — the caller reports that honestly instead of
   *   claiming it stopped something.
   */
  static async cancelRun(explorationId: string): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .from('exploration_runs')
        .update({
          status: 'cancelled',
          error_message: 'Cancelled by user',
          completed_at: new Date().toISOString(),
        })
        .eq('exploration_id', explorationId)
        .eq('status', 'running')
        .select('exploration_id');

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to cancel run', {
          error: error.message,
          explorationId,
        });
        return false;
      }
      return (data?.length ?? 0) > 0;
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error cancelling run', {
        error: error instanceof Error ? error.message : String(error),
        explorationId,
      });
      return false;
    }
  }

  /**
   * Record what a CANCELLED run produced, without touching its status.
   *
   * `completeRun` would stamp 'completed' over 'cancelled' and erase the fact
   * that the user stopped it. The partial output still has to land, though —
   * the flows that finished were saved to `intent_test_cases`, so the history
   * card must show a matching count instead of 0.
   */
  static async recordCancelledRunOutput(
    explorationId: string,
    result: ExplorationResult,
  ): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('exploration_runs')
        .update({
          summary: result.summary,
          budget_used: result.budgetUsed,
          duration_ms: result.durationMs,
          test_cases_count: result.summary.persistedTestCases,
        })
        .eq('exploration_id', explorationId)
        .eq('status', 'cancelled');

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to record cancelled run output', {
          error: error.message,
          explorationId,
        });
      }
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error recording cancelled run output', {
        error: error instanceof Error ? error.message : String(error),
        explorationId,
      });
    }
  }

  /**
   * Has this run been cancelled? Polled by the worker so a cancel issued on the
   * API process reaches the engine, which runs in a different process and
   * therefore cannot see an in-memory flag.
   *
   * Fails OPEN (returns false): a transient DB blip must not abort a healthy
   * run the user never asked to stop. A missed poll just means the run stops at
   * the next check.
   */
  static async isRunCancelled(explorationId: string): Promise<boolean> {
    try {
      const { data, error } = await supabaseAdmin
        .from('exploration_runs')
        .select('status')
        .eq('exploration_id', explorationId)
        .maybeSingle();

      if (error || !data) return false;
      return (data as { status: string }).status === 'cancelled';
    } catch {
      return false;
    }
  }

  /**
   * Backstop reaper: mark exploration runs stuck in 'running' since before
   * `cutoffIso` as 'timed_out'. Exploration finalization is event-driven
   * (completeRun/failRun in the job); if the worker dies without throwing
   * (OOM / killed mid-deploy / stall-death) no terminal write ever lands and
   * the row stays 'running' forever (perpetual spinner in history, no cancel).
   * This single bulk UPDATE is the missing trigger, called from the periodic
   * StaleReaperService sweep.
   *
   * Idempotent: the `status = 'running'` filter excludes already-terminal rows,
   * so re-runs only ever touch genuinely-stuck rows. Requires the 'timed_out'
   * status (migration 20260618_exploration_runs_terminal_status.sql).
   *
   * @returns count of rows flipped this sweep (0 on error — best-effort).
   */
  static async reapStaleRunningRuns(cutoffIso: string): Promise<number> {
    try {
      const { data, error } = await supabaseAdmin
        .from('exploration_runs')
        .update({
          status: 'timed_out',
          error_message: 'Run abandoned — no terminal status before timeout (worker died or stalled)',
          completed_at: new Date().toISOString(),
        })
        .eq('status', 'running')
        .lt('started_at', cutoffIso)
        .select('exploration_id');

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to reap stale runs', { error: error.message });
        return 0;
      }

      const count = data?.length ?? 0;
      if (count > 0) {
        logger.info('[EXPLORATION_STORAGE] Reaped stale exploration runs', { count });
      }
      return count;
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error reaping stale runs', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Save discovered test cases to intent_test_cases table.
   * Returns inserted IDs.
   *
   * Cases with no steps are DROPPED, not saved. `TestCaseBuilder` emits one
   * zero-step `not_explored` placeholder per unexplored entry point (budget
   * exhausted / skipped by the Strategist), and persisting those produced real
   * `intent_test_cases` rows with `steps_json: []` — unrunnable, indistinguishable
   * from a genuine draft except by a `not-explored` tag, and cluttering the user's
   * project after every run. The mobile snapshot path already guarded this exact
   * case (`if (steps.length === 0) continue`); the web path did not.
   */
  static async saveTestCases(
    testCases: DiscoveredTestCase[],
    projectId: string,
    userId: string,
    /**
     * The run that discovered these. Stamped onto each row so the results
     * screen can list exactly this run's output — without it the reader can
     * only filter `source='exploration'` and returns every exploration case
     * the project ever accumulated (516 rows from 8 runs, measured on prod).
     * Optional so existing callers keep compiling; a null column falls back
     * to the old project-wide read.
     */
    explorationId?: string,
  ): Promise<string[]> {
    if (testCases.length === 0) return [];

    const runnable = testCases.filter((tc) => Array.isArray(tc.steps) && tc.steps.length > 0);
    if (runnable.length < testCases.length) {
      logger.info('[EXPLORATION_STORAGE] Skipping step-less discovered cases', {
        projectId,
        skipped: testCases.length - runnable.length,
        saving: runnable.length,
      });
    }
    if (runnable.length === 0) return [];

    try {
      const records = runnable.map((tc) => {
        const intent = toIntentTestCase(tc, projectId, userId);
        // Carry network assertions forward into tags as a compact tag
        // `assert:METHOD:pattern:family`. This lets users filter regression
        // runs by API touchpoint without a schema migration — the full
        // TestAssertion shape is lost on round-trip but the operational
        // information ("this flow hits POST /api/auth") survives. Capped
        // to keep the tags array reviewable.
        const assertionTags = (tc.assertions || [])
          .slice(0, 8)
          .map((a) => `assert:${a.type}:${a.source?.method ?? ''}:${a.source?.urlPattern ?? ''}:${a.source?.status ? Math.floor(a.source.status / 100) + 'xx' : ''}`);
        const mergedTags = [...(intent.tags || []), ...assertionTags];
        return {
          project_id: projectId,
          user_id: userId,
          name: intent.name,
          description: intent.description || null,
          start_url: intent.startUrl || intent.url || null,
          steps_json: intent.stepsJson || [],
          tags: mergedTags,
          priority: intent.priority || 'medium',
          expected_result: intent.expectedResult || null,
          preconditions: intent.preconditions || null,
          status: 'draft',
          kind: 'standalone',
          source: 'exploration',
          exploration_id: explorationId ?? null,
          // The entry-point id this case came from. Name is NOT a usable key:
          // 42 names collide within a single run on prod (worst case 5 rows),
          // so a results screen matching on name would add the wrong cases.
          entry_point_id: intent.id ?? null,
          // The FULL assertion shape, so replay can actually verify it. The
          // `assert:` tags above stay for human filtering, but they are
          // write-only (nothing reads them back) and drop `expect` entirely —
          // they were never verification. NULL when there is nothing recorded,
          // which replay must read as "nothing to verify", not "verified empty".
          network_assertions: intent.networkAssertions?.length
            ? intent.networkAssertions
            : null,
        };
      });

      const insertOnce = (rows: Array<Record<string, unknown>>) =>
        supabaseAdmin.from('intent_test_cases').insert(rows).select('id');

      let { data, error } = await insertOnce(records);

      // Backward-compatible fallback: `network_assertions` ships with a migration
      // (20260801_intent_test_cases_network_assertions.sql) that may not be
      // applied yet. PostgREST answers PGRST204 for a missing column and fails
      // the WHOLE insert — so without this retry, adding the column to the
      // payload would break every exploration save until the migration lands.
      // Losing the assertions is a degraded save; losing the test cases is a
      // regression. Mirrors the artifact-column fallback in db/supabase.ts.
      if (error && (error as { code?: string }).code === 'PGRST204') {
        logger.warn('[EXPLORATION_STORAGE] intent_test_cases missing network_assertions column; retrying without it', {
          originalError: error.message,
          hint: 'Apply supabase-migrations/20260801_intent_test_cases_network_assertions.sql and restart the Supabase API to refresh the PostgREST schema cache.',
        });
        const withoutAssertions = records.map(({ network_assertions: _dropped, ...rest }) => rest);
        ({ data, error } = await insertOnce(withoutAssertions));
      }

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to save test cases', {
          error: error.message,
          count: testCases.length,
        });
        return [];
      }

      const ids = (data || []).map((r: any) => r.id);
      logger.info('[EXPLORATION_STORAGE] Test cases saved', {
        count: ids.length,
        projectId,
      });

      return ids;
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error saving test cases', {
        error: error instanceof Error ? error.message : String(error),
        count: testCases.length,
      });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHECKPOINT / RESUME
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Save exploration checkpoint for crash recovery.
   */
  static async saveCheckpoint(explorationId: string, checkpoint: ExplorationCheckpoint): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('exploration_runs')
        .update({ checkpoint })
        .eq('exploration_id', explorationId);

      if (error) {
        logger.error('[EXPLORATION_STORAGE] Failed to save checkpoint', {
          error: error.message,
          explorationId,
          phase: checkpoint.phase,
        });
      }
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error saving checkpoint', {
        error: error instanceof Error ? error.message : String(error),
        explorationId,
      });
    }
  }

  /**
   * Load exploration checkpoint for resume after crash.
   */
  static async loadCheckpoint(explorationId: string): Promise<ExplorationCheckpoint | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('exploration_runs')
        .select('checkpoint')
        .eq('exploration_id', explorationId)
        .single();

      if (error || !data?.checkpoint) return null;
      return data.checkpoint as ExplorationCheckpoint;
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error loading checkpoint', {
        error: error instanceof Error ? error.message : String(error),
        explorationId,
      });
      return null;
    }
  }

  /**
   * Increment resume count and return new value.
   */
  static async incrementResumeCount(explorationId: string): Promise<number> {
    try {
      // Atomic increment via Postgres RPC to avoid read-then-write race condition
      const { data, error } = await supabaseAdmin
        .rpc('increment_exploration_resume_count', { p_exploration_id: explorationId });

      if (error || data == null) {
        logger.error('[EXPLORATION_STORAGE] Failed to increment resume count', {
          error: error?.message,
          explorationId,
        });
        return 999; // Fail-safe: high number → will stop retrying
      }

      return data as number;
    } catch (error) {
      logger.error('[EXPLORATION_STORAGE] Error incrementing resume count', {
        error: error instanceof Error ? error.message : String(error),
        explorationId,
      });
      return 999;
    }
  }

  /**
   * Clear checkpoint after successful completion.
   */
  static async clearCheckpoint(explorationId: string): Promise<void> {
    try {
      await supabaseAdmin
        .from('exploration_runs')
        .update({ checkpoint: null })
        .eq('exploration_id', explorationId);
    } catch {
      // Non-critical, ignore errors
    }
  }
}

type MobileAssertion = { type?: string; expect?: string; afterStep?: number; source?: 'tree' | 'screenshot' };

/** Build one runnable ai_check step from an observation assertion. Shape mirrors
 *  the negative-generator's mobile ai_check (aiCheckSource → the runner maps it
 *  to an `ai_visual_check`; assertionText is REQUIRED). expectedOutcome:'success'
 *  — exploration flows are happy paths (inverse of a negative).
 *
 *  `source` comes from the explorer's assert_observation tool: 'screenshot' for
 *  visual / which-screen facts the single-frame a11y tree can't prove (a bare
 *  'tree' check of those fails as Inconclusive even when the app is correct),
 *  else 'tree'. Defaults to 'tree' when the explorer didn't flag it — the safe,
 *  cheaper path for text/state assertions, which are the majority. */
function makeAiCheckStep(
  expect: string,
  seq: number,
  source: 'tree' | 'screenshot' = 'tree',
): Record<string, unknown> {
  return {
    id: `expl_check_${seq}_${Date.now().toString(36)}`,
    type: 'ai_check',
    description: expect,
    assertionText: expect,
    value: expect,
    expectedOutcome: 'success' as const,
    options: { aiCheckSource: source },
  };
}

/**
 * Insert observation-assertion ai_check steps into steps_json AT the position
 * each was observed (assertion.afterStep, 1-based; 0/undefined/out-of-range =
 * end-of-flow). A mid-flow check must replay against the screen it was seen on,
 * not the final screen. Non-observation assertions (network/url/console) can't
 * run on the a11y tree — handled by buildAssertionTags, not here.
 *
 * Insertion is done back-to-front by target index so earlier splices don't shift
 * later ones. Steps with no positioned checks are untouched.
 */
function insertMobileAssertionSteps(
  steps: unknown[],
  assertions: MobileAssertion[] | undefined,
): unknown[] {
  const result = [...steps];
  if (!Array.isArray(assertions)) return result;
  // Collect observation checks with a resolved insert index (after the Nth step).
  const positioned = assertions
    .filter((a) => a?.type === 'observation' && (a.expect || '').trim())
    .map((a, i) => {
      const raw = typeof a.afterStep === 'number' ? a.afterStep : steps.length;
      // Clamp 1..steps.length; 0 or out-of-range → append at end.
      const idx = raw >= 1 && raw <= steps.length ? raw : steps.length;
      const source = a.source === 'screenshot' ? 'screenshot' as const : 'tree' as const;
      return { idx, seq: i, expect: (a.expect as string).trim(), source };
    })
    // Descending by insert index so splices don't invalidate earlier indices;
    // ties keep authoring order (stable via seq).
    .sort((x, y) => y.idx - x.idx || y.seq - x.seq);
  for (const p of positioned) {
    result.splice(p.idx, 0, makeAiCheckStep(p.expect, p.seq, p.source));
  }
  return result;
}

/**
 * Preserve non-runnable assertions (network/url/console) as compact `assert:`
 * tags — the same breadcrumb the web path (saveTestCases) keeps — instead of
 * dropping them silently. Capped so a chatty flow can't bloat the tags array.
 */
function buildAssertionTags(assertions: MobileAssertion[] | undefined): string[] {
  if (!Array.isArray(assertions)) return [];
  return assertions
    .filter((a) => a?.type && a.type !== 'observation' && (a.expect || '').trim())
    .slice(0, 8)
    .map((a) => `assert:${a.type}:${(a.expect as string).trim().slice(0, 40)}`);
}
