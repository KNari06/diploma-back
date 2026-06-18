/**
 * Exploration Storage Service
 * Persists exploration runs and discovered test cases to Supabase.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { ExplorationResult, DiscoveredTestCase, ExplorationCheckpoint } from '@/agent/core/lite/exploration/types';
import { toIntentTestCase } from '@/agent/core/lite/exploration/types';

export interface ExplorationRunRecord {
  id: string;
  exploration_id: string;
  project_id: string;
  user_id: string;
  chat_session_id: string | null;
  entry_url: string;
  status: 'running' | 'completed' | 'failed';
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
          test_cases_count: result.testCases.length,
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
        }>;
      };
    }>,
    projectId: string,
    userId: string,
    platform: 'android' | 'ios' | 'flutter',
  ): Promise<string[]> {
    const browserTag = platform === 'ios' ? 'mobile_ios' : platform === 'flutter' ? 'mobile_flutter' : 'mobile_android';
    const records: Array<Record<string, unknown>> = [];

    for (const flow of snapshotFlows || []) {
      const cases = flow.mobile?.cases || [];
      for (const c of cases) {
        const steps = Array.isArray(c.intentSteps) ? c.intentSteps : [];
        // Skip empty cases — nothing replayable to save.
        if (steps.length === 0) continue;
        const priority = ['high', 'medium', 'low'].includes(flow.priority || '')
          ? (flow.priority as string)
          : 'medium';
        records.push({
          project_id: projectId,
          user_id: userId,
          name: c.name || flow.name || 'Mobile flow',
          description: c.description || null,
          start_url: null, // mobile has no URL
          steps_json: steps,
          tags: [browserTag, ...(flow.category ? [flow.category] : [])],
          priority,
          expected_result: null,
          preconditions: null,
          status: 'draft',
          kind: 'standalone',
          source: 'exploration',
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
   */
  static async failRun(explorationId: string, errorMessage: string): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('exploration_runs')
        .update({
          status: 'failed',
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
   */
  static async saveTestCases(
    testCases: DiscoveredTestCase[],
    projectId: string,
    userId: string,
  ): Promise<string[]> {
    if (testCases.length === 0) return [];

    try {
      const records = testCases.map((tc) => {
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
        };
      });

      const { data, error } = await supabaseAdmin
        .from('intent_test_cases')
        .insert(records)
        .select('id');

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
