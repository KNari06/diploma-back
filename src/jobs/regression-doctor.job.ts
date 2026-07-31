/**
 * Regression Doctor job handler
 *
 * ONE job per completed regression run. Reads every failed
 * `test_results.ai_summary` under the run, filters for
 * `failureClassification === 'test_drift'` (filled by the per-test Bug
 * Inspector), groups by (urlPattern × targetElementKey × errorShape),
 * enriches each group with Knowledge Base context, calls the LLM once
 * per group to produce a diagnosis + proposed patch, and persists the
 * result to `regression_doctor_findings`.
 *
 * Why this lives as a separate job (and not inside the completion hook):
 *   • LLM calls are slow (1-3 s each). Inlining them would block the
 *     completion hook that also fires notifications and WS events.
 *   • BullMQ retry (2 attempts, exponential) gives rate-limit resilience.
 *   • Idempotent — duplicate enqueue rejected by `doctor-${runId}` jobId.
 *
 * Explicit non-goals (Phase-1):
 *   • No bulk-apply of patches. We only PERSIST suggestions. A future
 *     API endpoint will let the user apply them via a Bulk Fix UI.
 *   • No mutation of test_cases. Read-only aggregation today.
 *   • No failure escalation when the LLM returns low confidence — we
 *     save the finding with its confidence, the UI decides what to show.
 */

import type { Job } from 'bullmq';
import { dbAdminService } from '@/db/supabase';
import { logger, logQueueEvent } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { AISummary, DriftSignals } from '@/types';
import { searchKB, expandChunkForLLM, type KBChunk } from '@/services/kb/kb.service';
import {
  groupByPattern,
  computePatternKey,
  type DriftFailureInput,
  type DriftGroup,
} from '@/services/regression-doctor/grouping';
import { analyzeDriftGroup, type DriftAgentVerdict } from '@/services/regression-doctor/drift-agent';

export interface RegressionDoctorJobData {
  runId: string;
  projectId: string;
  userId: string;
}

/**
 * Max number of patterns we analyze per run. If a regression produces >N
 * distinct drift patterns, we process the biggest N (by failure count)
 * and skip the long tail. This protects against a pathological run
 * burning 50 LLM calls; realistic runs have 1–5 patterns.
 */
const MAX_PATTERNS_PER_RUN = 10;

/**
 * Max failures we sample from each group to feed into the LLM prompt.
 * Three is enough for the LLM to see the pattern variation (different
 * test names, slightly different contexts) without blowing the token
 * budget or inviting over-fitting to a single failure instance.
 */
const SAMPLE_FAILURES_PER_GROUP = 3;

/**
 * KB search parameters. 0.55 threshold is intentionally below the
 * `searchKB` default of 0.7 — Doctor benefits from SEEING marginally-
 * relevant chunks (e.g. "the captcha module" when analyzing a login
 * drift) even if they don't score >0.7. The LLM decides what to use.
 */
const KB_THRESHOLD = 0.55;
const KB_MATCH_COUNT = 5;

export class RegressionDoctorJobHandler {
  static async process(job: Job<RegressionDoctorJobData>) {
    const { runId, projectId, userId } = job.data || ({} as RegressionDoctorJobData);

    if (!runId || !projectId || !userId) {
      throw new Error(`Missing required job fields: ${JSON.stringify(job.data)}`);
    }

    logger.info('[REGRESSION_DOCTOR] Starting', { runId, projectId, userId });
    logQueueEvent('processing', job.id!, { runId });

    try {
      // ─── Step 1: fetch drift failures ────────────────────────────────────
      const failures = await this.fetchDriftFailures(runId);

      if (failures.length < 2) {
        logger.info('[REGRESSION_DOCTOR] Not enough drift failures — exiting', {
          runId,
          driftFailureCount: failures.length,
        });
        // Still emit the event so a subscribed UI can refresh "no findings"
        // state instead of hanging on a spinner.
        this.emitReady(userId, runId, 0);
        return { findingsCreated: 0 };
      }

      // ─── Step 2: group by pattern ────────────────────────────────────────
      const allGroups = groupByPattern(failures);
      // Keep only the biggest N groups — long-tail patterns with 1 failure
      // can't form a "pattern" anyway (they didn't repeat).
      const groupsToProcess = allGroups
        .filter((g) => g.failures.length >= 2)
        .slice(0, MAX_PATTERNS_PER_RUN);

      if (groupsToProcess.length === 0) {
        logger.info('[REGRESSION_DOCTOR] No multi-failure patterns — exiting', {
          runId,
          totalGroups: allGroups.length,
        });
        this.emitReady(userId, runId, 0);
        return { findingsCreated: 0 };
      }

      logger.info('[REGRESSION_DOCTOR] Groups ready for analysis', {
        runId,
        totalFailures: failures.length,
        groupsCount: groupsToProcess.length,
        distribution: groupsToProcess.map((g) => ({
          key: g.patternKey.slice(0, 8),
          count: g.failures.length,
          element: g.targetElementKey,
        })),
      });

      // ─── Step 3: for each group, enrich + analyze + persist ──────────────
      let findingsCreated = 0;

      for (const group of groupsToProcess) {
        try {
          const kbChunks = await this.fetchKBContext(projectId, group);
          const affectedTestIds = this.collectAffectedTestIds(group);
          const exampleTestResultIds = group.failures
            .slice(0, SAMPLE_FAILURES_PER_GROUP)
            .map((f) => f.testResultId);

          const verdict = await analyzeDriftGroup({
            group,
            sampleFailures: group.failures.slice(0, SAMPLE_FAILURES_PER_GROUP),
            kbChunks,
            affectedTestCount: affectedTestIds.length,
          });

          await this.persistFinding({
            runId,
            projectId,
            userId,
            group,
            verdict,
            kbChunks,
            affectedTestIds,
            exampleTestResultIds,
          });

          findingsCreated += 1;
        } catch (groupError) {
          // One group failing must not abort the whole run — we log and
          // continue. The finding is simply not created; the UI won't
          // show a suggestion for this pattern but the rest still land.
          logger.warn('[REGRESSION_DOCTOR] Group analysis failed', {
            runId,
            patternKey: group.patternKey,
            failureCount: group.failures.length,
            error: groupError instanceof Error ? groupError.message : String(groupError),
          });
        }
      }

      // ─── Step 4: notify frontend ─────────────────────────────────────────
      this.emitReady(userId, runId, findingsCreated);

      logger.info('[REGRESSION_DOCTOR] Completed', {
        runId,
        findingsCreated,
      });

      return { findingsCreated };
    } catch (error) {
      logger.error('[REGRESSION_DOCTOR] Fatal error', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Fetch every failed test_results row under this run whose Bug Inspector
   * classified it as test_drift AND produced valid driftSignals.
   *
   * A failed test WITHOUT driftSignals (e.g. real_bug) is silently skipped
   * — it's not Doctor's concern.
   *
   * Data source — we go through `test_executions` because that's the table
   * that actually carries the (run_id → test id) relationship; then JOIN
   * to `test_results` for the ai_summary payload.
   *
   * The test id is NOT a column — it lives inside the `result` JSONB as
   * `result->>'testId'`. Rows without it (e.g. mobile runs, which write to
   * `mobile_test_results`) simply drop out and are not Doctor's concern.
   */
  private static async fetchDriftFailures(runId: string): Promise<DriftFailureInput[]> {
    // 1. Find all test_executions in this run (gives us test ids).
    const { data: executions, error: exErr } = await dbAdminService.supabaseAdmin
      .from('test_executions')
      .select('result, status')
      .eq('run_id', runId);

    if (exErr) {
      throw new Error(`Failed to load test_executions: ${exErr.message}`);
    }
    if (!executions || executions.length === 0) return [];

    const failedTestIds = executions
      .filter((e) => e.status === 'failed' || e.status === 'timeout')
      .map((e) => (e.result as { testId?: string } | null)?.testId)
      .filter((id): id is string => Boolean(id));

    if (failedTestIds.length === 0) return [];

    // 2. Fetch test_results with ai_summary for these tests. `test_results`
    //    has one row per browser — Phase-1 takes the first row per test
    //    (99% of runs are single-browser; multi-browser dedup is a future
    //    edge case).
    const { data: results, error: resErr } = await dbAdminService.supabaseAdmin
      .from('test_results')
      .select('id, test_id, ai_summary, tests(intent_test_case_id)')
      .in('test_id', failedTestIds);

    if (resErr) {
      throw new Error(`Failed to load test_results: ${resErr.message}`);
    }
    if (!results) return [];

    const failures: DriftFailureInput[] = [];
    for (const row of results as any[]) {
      const summary = row.ai_summary as AISummary | null | undefined;
      if (!summary) continue;
      if (summary.failureClassification !== 'test_drift') continue;
      const signals = summary.driftSignals as DriftSignals | null | undefined;
      if (!signals || !signals.urlPattern || !signals.targetElementKey) continue;

      failures.push({
        testResultId: row.id,
        testId: row.test_id,
        testCaseId: row.tests?.intent_test_case_id ?? null,
        driftSignals: signals,
      });
    }

    return failures;
  }

  /**
   * Query the KB (project + global) for chunks most relevant to this
   * drift group. We build the query string from the pattern so it looks
   * like natural prose to the embedding model:
   *
   *   "button 'Подготовка к ВОУД' on /tutors/:id not found"
   *
   * Fail-safe: any KB error → empty chunks. Doctor still runs, LLM just
   * works without extra context. Better than aborting the whole job.
   */
  private static async fetchKBContext(projectId: string, group: DriftGroup): Promise<KBChunk[]> {
    try {
      const query = `${group.targetElementKey} on ${group.urlPattern} ${group.errorShape.replace(/_/g, ' ')}`;
      const result = await searchKB(query, projectId, {
        matchThreshold: KB_THRESHOLD,
        matchCount: KB_MATCH_COUNT,
      });
      return result.chunks ?? [];
    } catch (err) {
      logger.warn('[REGRESSION_DOCTOR] KB search failed (non-fatal)', {
        patternKey: group.patternKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Collect affected test_case ids for persistence. Phase-1 scope:
   * only the test cases that actually failed in this run. A future
   * enhancement can query `intent_test_cases.steps_json @> [{...}]` to
   * find OTHER test cases targeting the same URL pattern + element even
   * if they haven't run yet — useful for proactive alerts.
   */
  private static collectAffectedTestIds(group: DriftGroup): string[] {
    const ids = new Set<string>();
    for (const f of group.failures) {
      if (f.testCaseId) ids.add(f.testCaseId);
    }
    return Array.from(ids);
  }

  /**
   * Insert one finding row per group. We defensively re-compute
   * patternKey instead of trusting the in-memory value — a micro-
   * optimization not worth a correctness risk if grouping logic ever
   * changes its hash input.
   */
  private static async persistFinding(params: {
    runId: string;
    projectId: string;
    userId: string;
    group: DriftGroup;
    verdict: DriftAgentVerdict;
    kbChunks: KBChunk[];
    affectedTestIds: string[];
    exampleTestResultIds: string[];
  }): Promise<void> {
    const patternKey = computePatternKey({
      urlPattern: params.group.urlPattern,
      targetElementKey: params.group.targetElementKey,
      errorShape: params.group.errorShape,
    });

    const kbEvidence = params.kbChunks.slice(0, 3).map((c) => ({
      file_name: c.file_name ?? c.source_file ?? 'unknown',
      content_preview: expandChunkForLLM(c).slice(0, 240),
      similarity: c.similarity ?? null,
    }));

    const { error } = await dbAdminService.supabaseAdmin
      .from('regression_doctor_findings')
      .insert({
        run_id: params.runId,
        project_id: params.projectId,
        user_id: params.userId,
        pattern_key: patternKey,
        url_pattern: params.group.urlPattern,
        target_element_key: params.group.targetElementKey,
        error_shape: params.group.errorShape,
        diagnosis: params.verdict.diagnosis,
        confidence: params.verdict.confidence,
        proposed_patch: params.verdict.proposedPatch ?? null,
        kb_evidence: kbEvidence,
        affected_test_ids: params.affectedTestIds,
        example_test_result_ids: params.exampleTestResultIds,
        status: 'open',
      });

    if (error) {
      throw new Error(`Failed to persist doctor finding: ${error.message}`);
    }
  }

  private static emitReady(userId: string, runId: string, findingsCount: number): void {
    try {
      webSocketService.emitToUser(userId, 'regression:doctor:ready', {
        runId,
        findingsCount,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // Non-fatal — data is in DB either way.
      logger.debug('[REGRESSION_DOCTOR] WS emit failed (non-fatal)', {
        userId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
