/**
 * Regression Doctor job handler
 *
 * ONE job per completed regression run. For each failed test it locates the
 * FIRST step that failed, gathers the evidence that already exists for it
 * (runtime error, plain-language explanation, the screenshot taken at failure,
 * the authored step itself), asks the step-fix agent whether the TEST or the
 * APPLICATION is at fault, and persists one finding per step.
 *
 * What changed from the original (April) implementation, and why:
 *   • It analyzed cross-test drift PATTERNS keyed on url × element × errorShape,
 *     sourced from `ai_summary.driftSignals`. That field is null on every web
 *     result and "unknown" on mobile, and mobile results live in a table the
 *     job never read — so it produced zero findings in its entire lifetime.
 *   • It needed two failed tests sharing one pattern before it would speak. A
 *     single broken test — the common case — never qualified.
 *   • Its prompt contained a hash, KB excerpts and row ids. It never saw the
 *     failure.
 *
 * The job is thin by design (jobs/CLAUDE.md): collection lives in
 * `failed-step-collector.ts`, analysis in `step-fix-agent.ts`, queries in
 * `db/regression-doctor.db.ts`.
 *
 * Non-goals, unchanged: no auto-apply, no device re-run to verify a fix. The
 * job only ever writes suggestions.
 */

import type { Job } from 'bullmq';
import { logger, logQueueEvent } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { searchKB, expandChunkForLLM, type KBChunk } from '@/services/kb/kb.service';
import { collectFailedSteps, type CollectionSkip } from '@/services/regression-doctor/failed-step-collector';
import {
  analyzeFailedStep,
  TransientAnalysisError,
} from '@/services/regression-doctor/step-fix-agent';
import { computeStepPatternKey } from '@/services/regression-doctor/pattern-key';
import {
  analyzedStepKey,
  getAnalyzedStepIds,
  getWorkspaceIdForProject,
  insertFinding,
} from '@/services/regression-doctor/db/regression-doctor.db';
import { AIUsageTracker } from '@/services/ai/tracking/ai-usage-tracker';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import { recordAnalysis } from '@/services/regression-doctor/analysis-record';
import type { FailedStepEvidence, StepFixVerdict } from '@/services/regression-doctor/types';

export interface RegressionDoctorJobData {
  runId: string;
  projectId: string;
  userId: string;
}

/**
 * Ceiling on findings (and therefore LLM calls) per run.
 *
 * One finding per failed test, so a suite where everything broke — a bad
 * deploy, an expired account, a dead environment — would otherwise fan out one
 * vision call per test. Whatever is dropped is logged by name; a silent
 * truncation reads as "the agent had nothing to say about those".
 */
const MAX_FINDINGS_PER_RUN = 10;

/**
 * KB search parameters. 0.55 is intentionally below `searchKB`'s 0.7 default —
 * a marginally-relevant chunk ("the checkout redesign") is worth showing the
 * agent even when it doesn't score highly. The agent decides what to use.
 */
const KB_THRESHOLD = 0.55;
const KB_MATCH_COUNT = 5;
const KB_EVIDENCE_LIMIT = 3;

export class RegressionDoctorJobHandler {
  static async process(job: Job<RegressionDoctorJobData>) {
    const { runId, projectId, userId } = job.data || ({} as RegressionDoctorJobData);

    if (!runId || !projectId || !userId) {
      throw new Error(`Missing required job fields: ${JSON.stringify(job.data)}`);
    }

    logger.info('[REGRESSION_DOCTOR] Starting', { runId, projectId, userId });
    logQueueEvent('processing', job.id!, { runId });

    try {
      // ─── 1. Collect evidence ─────────────────────────────────────────────
      const { evidence, skipped } = await collectFailedSteps(runId);
      const skipReasons = summarizeSkips(skipped);

      if (evidence.length === 0) {
        // Legitimate and common: the run died at setup (no steps ran at all),
        // every failure was a negative test, or the failing steps were injected
        // prologue/precondition steps that belong to no authored test case.
        logger.info('[REGRESSION_DOCTOR] No analyzable failed steps', {
          runId,
          skippedCount: skipped.length,
          reasons: skipReasons,
        });
        await recordAnalysis(runId, {
          state: 'completed',
          findingsCreated: 0,
          skipped: skipped.length,
          skipReasons,
          cappedOut: 0,
        });
        // Emit anyway so a subscribed report renders "nothing to fix" instead
        // of spinning forever on a request that will never arrive.
        this.emitReady(userId, runId, 0);
        return { findingsCreated: 0, skipped: skipped.length, skipReasons, cappedOut: 0 };
      }

      // Order before capping. `getTestsByIds` returns rows in whatever order
      // Postgres produced them, so an unsorted slice drops an arbitrary subset
      // and a re-run of the same job can analyze a different one. Failures that
      // carry a screenshot come first — the agent reaches a usable verdict far
      // more often with one — then alphabetically for a stable tie-break.
      const ordered = [...evidence].sort((a, b) => {
        const shotDelta = Number(Boolean(b.failScreenshotUrl)) - Number(Boolean(a.failScreenshotUrl));
        if (shotDelta !== 0) return shotDelta;
        return a.testCaseName.localeCompare(b.testCaseName) || a.stepIndex - b.stepIndex;
      });

      const analyzable = ordered.slice(0, MAX_FINDINGS_PER_RUN);
      // Reported to the user, not just logged. A run of 21 failures that yields
      // 10 cards and says nothing reads as "the agent had nothing to say about
      // the other 11" — the same silent-truncation problem the cap itself was
      // supposed to make explicit.
      const cappedOut = ordered.length - analyzable.length;
      if (cappedOut > 0) {
        logger.warn('[REGRESSION_DOCTOR] Capped findings for this run', {
          runId,
          totalFailedSteps: evidence.length,
          analyzed: analyzable.length,
          droppedTestCases: ordered.slice(MAX_FINDINGS_PER_RUN).map((e) => e.testCaseName),
        });
      }

      logger.info('[REGRESSION_DOCTOR] Analyzing failed steps', {
        runId,
        count: analyzable.length,
        steps: analyzable.map((e) => ({
          testCase: e.testCaseName,
          stepIndex: e.stepIndex,
          type: e.step.type,
          failedReason: e.failedReason,
        })),
      });

      // ─── 2. Analyze + persist, under a usage-tracking session ────────────
      // Every finding costs a vision call, which is the entire reason this job
      // is behind a button — so the spend has to land in `ai_usage_log`. The
      // tracker files calls by AI context, and a worker job has none unless it
      // opens one, so without this wrapper each call logged "Untracked AI call
      // (no context)" and was billed invisibly.
      //
      // Best-effort: a workspace we cannot resolve costs the run its cost row,
      // never the analysis. `endSession` runs in `finally` so a provider outage
      // mid-run still records what was already spent.
      const workspaceId = await getWorkspaceIdForProject(projectId);
      const trackingSessionId = workspaceId ? `doctor-${runId}` : null;
      const trackingContext = workspaceId
        ? {
            workspaceId,
            userId,
            runId,
            operationType: 'analysis' as const,
            sessionId: trackingSessionId ?? undefined,
            logActionType: 'regression-step-fix',
          }
        : null;

      if (trackingSessionId && trackingContext) {
        AIUsageTracker.beginSession(trackingSessionId, trackingContext);
      } else {
        logger.warn('[REGRESSION_DOCTOR] No workspace for project — analysis will be untracked', {
          runId,
          projectId,
        });
      }

      let findingsCreated = 0;
      try {
        findingsCreated = trackingContext
          ? await withAIContext(trackingContext, () =>
              this.analyzeAndPersist({ runId, projectId, userId, analyzable }),
            )
          : await this.analyzeAndPersist({ runId, projectId, userId, analyzable });
      } finally {
        if (trackingSessionId) {
          try {
            const usage = await AIUsageTracker.endSession(trackingSessionId);
            if (usage) {
              logger.info('[REGRESSION_DOCTOR] Analysis cost', {
                runId,
                aiCallCount: usage.aiCallCount,
                totalTokens: usage.totalTokens,
                totalCostUSD: usage.totalCostUSD,
              });
            }
          } catch (e) {
            logger.warn('[REGRESSION_DOCTOR] usage endSession failed (non-fatal)', {
              runId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }

      // ─── 3. Record the outcome, then notify the frontend ─────────────────
      // `skipReasons` is what the run report shows when an analysis finishes
      // with nothing to propose — without it the panel can only say "no
      // findings", which reads exactly like "the analysis never ran".
      // `cappedOut` is the same honesty for the other direction: failures the
      // cap kept the agent from ever looking at.
      await recordAnalysis(runId, {
        state: 'completed',
        findingsCreated,
        skipped: skipped.length,
        skipReasons,
        cappedOut,
      });

      this.emitReady(userId, runId, findingsCreated);

      logger.info('[REGRESSION_DOCTOR] Completed', { runId, findingsCreated, cappedOut });
      return { findingsCreated, skipped: skipped.length, skipReasons, cappedOut };
    } catch (error) {
      logger.error('[REGRESSION_DOCTOR] Fatal error', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Tell the panel it is over even though it went badly. The spinner is
      // cleared ONLY by this event, so returning here without emitting leaves
      // "Analyzing…" on screen until the user reloads — the same dead end the
      // missing bridge case produced, reached down the error path instead.
      // Emitted before the rethrow so a BullMQ retry does not sit on a silent
      // UI for the whole backoff.
      await recordAnalysis(runId, {
        state: 'failed',
        findingsCreated: null,
        skipped: null,
        skipReasons: null,
        cappedOut: null,
      }).catch(() => undefined);
      this.emitReady(userId, runId, 0, true);
      throw error;
    }
  }

  /**
   * One LLM call and one finding per failing step.
   *
   * A BullMQ retry re-enters `process` from the top, so steps a previous
   * attempt already wrote are skipped rather than re-analyzed — a second pass
   * pays only for what is new.
   */
  private static async analyzeAndPersist(params: {
    runId: string;
    projectId: string;
    userId: string;
    analyzable: FailedStepEvidence[];
  }): Promise<number> {
    const { runId, projectId, userId, analyzable } = params;
    const alreadyAnalyzed = await getAnalyzedStepIds(runId);
    let findingsCreated = 0;

    for (const item of analyzable) {
      if (alreadyAnalyzed.has(analyzedStepKey(item.testCaseId, item.stepId))) {
        logger.info('[REGRESSION_DOCTOR] Step already has a finding — skipping', {
          runId,
          testCaseId: item.testCaseId,
          stepId: item.stepId,
        });
        continue;
      }

      try {
        const kbChunks = await this.fetchKBContext(projectId, item);
        const verdict = await analyzeFailedStep({ evidence: item, kbChunks });

        await this.persistFinding({ runId, projectId, userId, evidence: item, verdict, kbChunks });
        findingsCreated += 1;

        logger.info('[REGRESSION_DOCTOR] Finding persisted', {
          runId,
          testCaseId: item.testCaseId,
          stepIndex: item.stepIndex,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          patchAction: verdict.patch?.action ?? null,
        });
      } catch (stepError) {
        // The provider being down says nothing about this step, and every
        // remaining step would hit the same wall. Abort so BullMQ retries the
        // run later; findings already written are skipped on the way back in.
        // Swallowing it here would persist an outage as a verdict the user
        // reads as "the agent could not tell", with nothing to re-run it.
        if (stepError instanceof TransientAnalysisError) {
          logger.warn('[REGRESSION_DOCTOR] Provider unavailable — aborting for retry', {
            runId,
            findingsCreated,
            error: stepError.message,
          });
          throw stepError;
        }

        // Anything else is specific to this step — keep the other findings.
        logger.warn('[REGRESSION_DOCTOR] Step analysis failed', {
          runId,
          testCaseId: item.testCaseId,
          stepId: item.stepId,
          error: stepError instanceof Error ? stepError.message : String(stepError),
        });
      }
    }

    return findingsCreated;
  }

  /**
   * KB chunks relevant to this failure. The query is built to read like prose,
   * because that is what the embedding model was trained on:
   *
   *   "FAQ entry in Profile / Гид section click selector not found"
   *
   * Fail-safe: any KB error yields no chunks. The agent works without them.
   */
  private static async fetchKBContext(
    projectId: string,
    evidence: FailedStepEvidence,
  ): Promise<KBChunk[]> {
    try {
      const query = [
        evidence.step.description,
        evidence.step.type,
        (evidence.failedReason ?? '').replace(/_/g, ' '),
      ]
        .filter(Boolean)
        .join(' ');

      const result = await searchKB(query, projectId, {
        matchThreshold: KB_THRESHOLD,
        matchCount: KB_MATCH_COUNT,
      });
      return result.chunks ?? [];
    } catch (err) {
      logger.warn('[REGRESSION_DOCTOR] KB search failed (non-fatal)', {
        testCaseId: evidence.testCaseId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private static async persistFinding(params: {
    runId: string;
    projectId: string;
    userId: string;
    evidence: FailedStepEvidence;
    verdict: StepFixVerdict;
    kbChunks: KBChunk[];
  }): Promise<void> {
    const { runId, projectId, userId, evidence, verdict, kbChunks } = params;

    const kbEvidence = kbChunks.slice(0, KB_EVIDENCE_LIMIT).map((c) => ({
      file_name: c.file_name ?? c.source_file ?? 'unknown',
      content_preview: expandChunkForLLM(c).slice(0, 240),
      similarity: c.similarity ?? null,
    }));

    await insertFinding({
      run_id: runId,
      project_id: projectId,
      user_id: userId,
      test_case_id: evidence.testCaseId,
      step_id: evidence.stepId,
      step_index: evidence.stepIndex,
      platform: evidence.platform,
      verdict: verdict.verdict,
      evidence: {
        test_case_name: evidence.testCaseName,
        step_type: evidence.step.type,
        step_description: evidence.step.description,
        action: evidence.action,
        failed_reason: evidence.failedReason,
        failure_explanation: evidence.failureExplanation,
        fail_screenshot_url: evidence.failScreenshotUrl,
        prior_screenshot_url: evidence.priorScreenshotUrl,
      },
      pattern_key: computeStepPatternKey({
        testCaseId: evidence.testCaseId,
        stepId: evidence.stepId,
        failureKind: evidence.failedReason || evidence.action || evidence.step.type,
      }),
      diagnosis: verdict.diagnosis,
      confidence: verdict.confidence,
      proposed_patch: verdict.patch,
      kb_evidence: kbEvidence,
      // Apply currently targets the test case the evidence came from. The
      // column stays an array because the apply path takes a subset — a future
      // dedupe pass can widen it to other cases sharing the same step.
      affected_test_ids: [evidence.testCaseId],
      // Legacy columns from the drift-pattern model. `example_test_result_ids`
      // pointed at `test_results`, which mobile runs never write to; the
      // per-step evidence supersedes it, so it stays empty rather than carrying
      // an id that resolves in one platform and not the other.
      example_test_result_ids: [],
      url_pattern: null,
      target_element_key: null,
      error_shape: null,
      status: 'open',
    });
  }

  private static emitReady(
    userId: string,
    runId: string,
    findingsCount: number,
    failed = false,
  ): void {
    try {
      webSocketService.emitToUser(userId, 'regression:doctor:ready', {
        runId,
        findingsCount,
        failed,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // Non-fatal — the data is in the DB either way, and the panel also
      // fetches on mount.
      logger.debug('[REGRESSION_DOCTOR] WS emit failed (non-fatal)', {
        userId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function summarizeSkips(skipped: CollectionSkip[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of skipped) {
    counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  }
  return counts;
}
