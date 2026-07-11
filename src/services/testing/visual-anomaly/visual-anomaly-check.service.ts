/**
 * Sampled visual anomaly sweep — ADR-0012, multi-finding schema per ADR-0016.
 *
 * Findings pass through the recurrence gate in `upsertObservation` before
 * becoming visible (`status='surfaced'`). `VISUAL_ANOMALY_MIN_RECURRENCE`
 * defaults to 1 as of 2026-07-10 (explicit user decision — surface on first
 * detection), so in practice a single observation now clears the gate
 * immediately. The gate/tracking machinery itself (affected_run_ids,
 * recurrence_count, the one-way ratchet, staleness window) is unchanged and
 * still applies if the threshold is ever configured back up. See
 * `visual_anomaly_findings`'s table comment (migration
 * 20260707_visual_anomaly_findings.sql) for the original rationale.
 *
 * ADR-0016 (2026-07-11): one Gemini vision call can now return MULTIPLE
 * findings per screenshot instead of being forced to pick one category. No
 * schema/migration change was needed — the fingerprint `upsertObservation`
 * already gates on (test_case_id, role, category), so each distinct category
 * from one screenshot naturally lands in its own row. See
 * `normalizeFindings`/`dedupeByCategory` below for the parsing side.
 *
 * Post-review fix (2026-07-11): the fingerprint's collision domain is wider
 * than "one screenshot" — different screenshots of the same role in one
 * sweep (or a shared `'other'` category) can also collide. `upsertExisting`
 * now distinguishes a same-run collision (this row already has `runId` in
 * `affected_run_ids` from earlier in THIS sweep) from genuine cross-run
 * recurrence, and only overwrites description/confidence/screenshot on a
 * same-run collision when the new observation's confidence is at least as
 * high — logged either way, instead of the prior silent unconditional
 * overwrite.
 */
import { createHash } from 'crypto';
import { generateTextWithGeminiVision } from '@/services/ai/core/gemini.service';
import { buildVisualAnomalyPrompt, VisualAnomalyCategory } from '@/ai/prompts/visual-anomaly-prompts';
import { VisualAnomalySweepFeature } from '@/config/features/visual-anomaly-sweep';
import { extractJson } from '@/services/testing/api/flow/ai-json.util';
import { logger } from '@/utils/core/logger';
import { dedupeByCategory, normalizeFindings } from './visual-anomaly-response-parser';
import {
  getExecutedStepsForTest,
  getFindingByPatternKey,
  insertFinding,
  updateFinding,
  type SweepTestContext,
  type VisualAnomalyFindingRow,
} from './db/visual-anomaly.db';

interface SampledScreenshot {
  url: string;
  role: 'final' | 'failure';
}

/**
 * Reads already-persisted step screenshots for a test off `tests.executed_steps`
 * (no new capture, no new storage — reuses whatever the replay path already
 * uploaded) and applies the configured sample strategy + hard cap.
 */
export function sampleScreenshots(executedSteps: any[]): SampledScreenshot[] {
  const completed = (executedSteps || []).filter((s: any) => s?.type === 'step_completed');
  const strategy = VisualAnomalySweepFeature.getSampleStrategy();
  const maxCount = VisualAnomalySweepFeature.getMaxScreenshotsPerTestCase();

  const urlOf = (s: any): string | undefined => {
    const url = s?.data?.runtimeMeta?.stepScreenshotUrl;
    return typeof url === 'string' && url && !url.startsWith('data:') ? url : undefined;
  };

  const failureUrls: SampledScreenshot[] = completed
    .filter((s: any) => s?.data?.success === false)
    .map((s: any) => urlOf(s))
    .filter((u): u is string => !!u)
    .map((url) => ({ url, role: 'failure' as const }));

  const lastCompletedUrl = [...completed].reverse().map(urlOf).find((u) => !!u);
  const finalShot: SampledScreenshot[] = lastCompletedUrl ? [{ url: lastCompletedUrl, role: 'final' as const }] : [];

  let picked: SampledScreenshot[];
  if (strategy === 'final_only') {
    picked = finalShot;
  } else if (strategy === 'all_failures') {
    picked = [...finalShot, ...failureUrls];
  } else {
    // 'final_and_failure' — default. Dedup by URL (a failing last step would
    // otherwise appear twice as both "final" and "failure").
    const seen = new Set(finalShot.map((s) => s.url));
    picked = [...finalShot, ...failureUrls.filter((s) => !seen.has(s.url))];
  }

  return picked.slice(0, maxCount);
}

function fingerprint(testCaseId: string, role: string, category: string): string {
  return createHash('sha1').update([testCaseId, role, category].join('␟')).digest('hex');
}

async function fetchAsBase64(url: string): Promise<{ base64: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch screenshot (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const lower = url.toLowerCase();
  const mimeType = lower.endsWith('.webp') ? 'image/webp' : lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { base64: buf.toString('base64'), mimeType };
}

interface UpsertParams {
  projectId: string;
  testCaseId: string;
  userId: string;
  runId: string;
  role: 'final' | 'failure';
  category: VisualAnomalyCategory;
  description: string;
  confidence: number;
  screenshotUrl: string;
}

/**
 * The recurrence-gating decision — business logic, deliberately NOT in the
 * db/ sublayer. Appends `runId` to `affected_run_ids` (idempotent — a retry
 * of the same run never double-counts), resets the window if the finding
 * has gone stale (no observation in VISUAL_ANOMALY_RECURRENCE_WINDOW_DAYS —
 * approximated by `last_seen_at` staleness since individual entries in
 * `affected_run_ids` carry no per-entry timestamp), and flips
 * `below_threshold` -> `surfaced` as a ONE-WAY RATCHET once recurrence
 * clears `VISUAL_ANOMALY_MIN_RECURRENCE`. Never touches an already
 * `dismissed`/`resolved` finding's status — a human already made that call.
 */
export interface UpsertOutcome {
  recurrenceCount: number;
  status: VisualAnomalyFindingRow['status'];
}

export async function upsertObservation(params: UpsertParams): Promise<UpsertOutcome | null> {
  const patternKey = fingerprint(params.testCaseId, params.role, params.category);
  const existing = await getFindingByPatternKey(params.projectId, patternKey);
  const now = new Date().toISOString();
  const threshold = VisualAnomalySweepFeature.getMinRecurrenceThreshold();
  const windowDays = VisualAnomalySweepFeature.getRecurrenceWindowDays();

  if (!existing) {
    const recurrenceCount = 1;
    const status = recurrenceCount >= threshold ? 'surfaced' : 'below_threshold';
    const { error } = await insertFinding({
      project_id: params.projectId,
      test_case_id: params.testCaseId,
      user_id: params.userId,
      pattern_key: patternKey,
      screenshot_role: params.role,
      category: params.category,
      description: params.description,
      confidence: params.confidence,
      example_screenshot_url: params.screenshotUrl,
      affected_run_ids: [params.runId],
      recurrence_count: recurrenceCount,
      status,
      first_seen_at: now,
      last_seen_at: now,
    });
    if (error) {
      // A concurrent first-observation may have won the unique-index race —
      // fall back to updating the now-existing row instead of losing this
      // observation entirely.
      const raced = await getFindingByPatternKey(params.projectId, patternKey);
      if (raced) return upsertExisting(raced, params, now, threshold, windowDays);
      logger.warn('[VISUAL_ANOMALY] Failed to insert finding and no concurrent row found', { error, patternKey });
      return null;
    }
    return { recurrenceCount, status };
  }

  return upsertExisting(existing, params, now, threshold, windowDays);
}

async function upsertExisting(
  existing: VisualAnomalyFindingRow,
  params: UpsertParams,
  now: string,
  threshold: number,
  windowDays: number,
): Promise<UpsertOutcome | null> {
  const staleMs = windowDays * 24 * 60 * 60 * 1000;
  const isStale = Date.now() - new Date(existing.last_seen_at).getTime() > staleMs;

  // A collision where this row's affected_run_ids ALREADY includes
  // params.runId (appended by an earlier finding/screenshot processed
  // earlier in THIS SAME runSweep call) means two potentially-DIFFERENT
  // findings share one (test_case_id, role, category) fingerprint within one
  // run — e.g. two different failure screenshots both reporting
  // 'broken_image', or two 'other' findings dedupeByCategory deliberately
  // didn't collapse. This is distinct from genuine CROSS-RUN recurrence
  // (the original, intended case this function exists for), where blindly
  // refreshing to the latest description/confidence/screenshot is correct —
  // see visual_anomaly_findings' pattern_key column comment. Unconditionally
  // overwriting on a same-run collision risks silently discarding a real,
  // distinct defect with no trace. Gate content overwrite on confidence and
  // log either way so the trade-off is visible instead of silent — while
  // recurrence tracking (affected_run_ids/recurrence_count/status) is always
  // updated regardless, since that bookkeeping must reflect every
  // observation, win or lose.
  const isSameRunCollision = !isStale && existing.affected_run_ids.includes(params.runId);
  const shouldOverwriteContent = !isSameRunCollision || params.confidence >= existing.confidence;

  if (isSameRunCollision) {
    logger.info('[VISUAL_ANOMALY] Same-fingerprint collision within one run', {
      testCaseId: params.testCaseId,
      role: params.role,
      category: params.category,
      keptDescription: shouldOverwriteContent ? params.description : existing.description,
      droppedDescription: shouldOverwriteContent ? existing.description : params.description,
    });
  }

  const affectedRunIds = isStale
    ? [params.runId]
    : existing.affected_run_ids.includes(params.runId)
      ? existing.affected_run_ids
      : [...existing.affected_run_ids, params.runId];
  const recurrenceCount = affectedRunIds.length;

  const nextStatus =
    existing.status === 'dismissed' || existing.status === 'resolved'
      ? existing.status // human already decided — the sweep never overrides that
      : recurrenceCount >= threshold
        ? 'surfaced'
        : existing.status; // one-way ratchet: never revert 'surfaced' back down

  const { error } = await updateFinding(existing.id, {
    ...(shouldOverwriteContent
      ? { description: params.description, confidence: params.confidence, example_screenshot_url: params.screenshotUrl }
      : {}),
    affected_run_ids: affectedRunIds,
    recurrence_count: recurrenceCount,
    status: nextStatus,
    last_seen_at: now,
  });
  if (error) {
    logger.warn('[VISUAL_ANOMALY] Failed to update finding', { error, findingId: existing.id });
    return null;
  }
  return { recurrenceCount, status: nextStatus };
}

export type SweepDispatchDecision =
  | { action: 'proceed'; testId: string; testCaseId: string; runId: string; projectId: string; userId: string }
  | { action: 'skip'; reason: string }
  | { action: 'retry'; reason: string };

/**
 * Decide whether a sweep job should run the check, permanently skip, or
 * throw to let BullMQ retry — moved out of visual-anomaly-sweep.job.ts
 * (job-handler domain logic violates this repo's "job handlers delegate
 * immediately" rule, .claude/rules/architecture.md) so it's a plain,
 * testable function instead of inline `if`s in the handler.
 *
 * `skip`: no testCaseId/projectId/userId means this was never a
 * saved-test-case regression execution (ad-hoc/chat-lite run) — permanent,
 * not a timing issue, never retry.
 *
 * `retry`: testCaseId/projectId/userId are present but runId is still null.
 * The regression-run link is written by `TestCompletionHandlerService
 * .updateRegressionRuns` — a SEPARATE, later step in test-completion
 * handling than this job's own enqueue point. CONFIRMED LIVE (2026-07-10):
 * the link genuinely does not exist in the DB yet at the job's first
 * attempt — it typically appears ~2-3s later, so throwing (not returning,
 * which would look identical to "correctly found nothing") lets BullMQ's
 * configured retry/backoff (`visualAnomalySweepQueue` in queues.ts) give the
 * other code path time to finish before giving up.
 */
export function classifySweepDispatch(context: SweepTestContext | null): SweepDispatchDecision {
  if (!context || !context.testCaseId || !context.projectId || !context.userId) {
    return {
      action: 'skip',
      reason: `not a saved-test-case execution (contextFound=${!!context}, missingTestCaseId=${!context?.testCaseId}, missingProjectId=${!context?.projectId}, missingUserId=${!context?.userId})`,
    };
  }
  if (!context.runId) {
    return { action: 'retry', reason: 'regression run not yet linked' };
  }
  return {
    action: 'proceed',
    testId: context.testId,
    testCaseId: context.testCaseId,
    runId: context.runId,
    projectId: context.projectId,
    userId: context.userId,
  };
}

export interface RunSweepParams {
  testId: string;
  testCaseId: string;
  runId: string;
  projectId: string;
  userId: string;
}

/**
 * Entry point called by `visual-anomaly-sweep.job.ts`. Best-effort per
 * screenshot — one bad fetch/LLM call never aborts the rest of the sweep.
 */
export async function runSweep(params: RunSweepParams): Promise<void> {
  const executedSteps = await getExecutedStepsForTest(params.testId);
  const screenshots = sampleScreenshots(executedSteps);
  if (screenshots.length === 0) {
    logger.info('[VISUAL_ANOMALY] No screenshots sampled — skipping sweep', {
      testId: params.testId,
      testCaseId: params.testCaseId,
    });
    return;
  }

  const model = VisualAnomalySweepFeature.getModel();
  logger.info('[VISUAL_ANOMALY] Starting sweep', {
    testId: params.testId,
    testCaseId: params.testCaseId,
    runId: params.runId,
    model,
    screenshots: screenshots.map((s) => ({ url: s.url, role: s.role })),
  });

  const { system } = buildVisualAnomalyPrompt();

  for (const shot of screenshots) {
    try {
      const { base64, mimeType } = await fetchAsBase64(shot.url);
      const response = await generateTextWithGeminiVision({
        prompt: system,
        imageBase64: base64,
        mimeType,
        model: model as 'gemini-2.5-flash' | 'gemini-2.5-pro' | 'gemini-2.5-flash-lite',
        temperature: 0,
        // gemini-2.5-flash is a THINKING model — thinking tokens count toward
        // maxOutputTokens (default 300 here). An empty `findings: []` verdict
        // is short enough to survive a small budget, but a real non-empty
        // findings list gets truncated mid-JSON, which extractJson correctly
        // can't recover — silently dropping exactly the positive detections
        // this sweep exists to catch. Confirmed live (2026-07-10) TWICE: 2048 was
        // itself insufficient for one scene (finishReason=MAX_TOKENS on the
        // response's own `response.candidates[0].finishReason`, surfaced by
        // gemini.service.ts's explicit non-STOP check) — thinking-token
        // consumption is scene-dependent and not reliably bounded by a
        // "should be enough" guess. This SDK version (@google/generative-ai
        // 0.24.1) has no `thinkingConfig.thinkingBudget` to disable thinking
        // outright (checked: absent from both its .d.ts and runtime JS), so
        // the only lever available is a generous ceiling — same principle as
        // element-resolver.service.ts's precedent fix: cost is billed on
        // tokens actually emitted, not the ceiling, so overshooting is cheap
        // insurance, not waste.
        maxTokens: 8192,
        // Scales with maxTokens above: the 2048-token attempt that hit
        // MAX_TOKENS still took ~12s to generate before being cut off (~170
        // tok/s) — a 20s ceiling would starve an 8192-token generation before
        // it could even reach that budget, reintroducing the timeout failure
        // mode this same investigation already hit once. visualAnomalySweepWorker
        // shares the worker pool's 5-minute BullMQ lockDuration (src/worker/index.ts),
        // so there's ample headroom to wait this long per shot.
        timeout: 45000,
      });

      // Gemini vision responses (esp. thinking-mode 2.5 Flash) sometimes wrap
      // the JSON in a ```json fence despite the prompt saying not to —
      // extractJson tolerates that instead of hard-failing the shot.
      const parsed = extractJson(response.content);
      if (!parsed) {
        throw new Error(`Could not extract JSON from Gemini vision response: ${response.content.slice(0, 200)}`);
      }
      // Normalized once, used everywhere below — every log and DB write
      // must reflect the SAME values, not re-derive from the raw `parsed.*`
      // fields (a prior bug logged 'Observation recorded' with the raw,
      // un-normalized category, which mismatched what was actually
      // persisted whenever normalization actually changed something).
      // ADR-0016: a screenshot can now yield MULTIPLE findings.
      const rawFindings = normalizeFindings(parsed);

      // The raw model verdict, logged BEFORE dedup and regardless of
      // outcome — this must reflect what Gemini actually returned, not what
      // survived dedupeByCategory's collapse. Logging AFTER dedup would make
      // this log's own documented purpose ("what did the AI actually
      // return") false as soon as dedup collapses anything.
      logger.info('[VISUAL_ANOMALY] LLM verdict', {
        testId: params.testId,
        testCaseId: params.testCaseId,
        url: shot.url,
        role: shot.role,
        findingCount: rawFindings.length,
        categories: rawFindings.map((f) => f.category),
      });

      // Per-category dedup — see normalizeFindings/dedupeByCategory doc
      // comments for why expansion + dedup are separate steps from the raw
      // verdict just logged above.
      const findings = dedupeByCategory(rawFindings);
      if (findings.length === 0) continue;

      for (const finding of findings) {
        try {
          const outcome = await upsertObservation({
            projectId: params.projectId,
            testCaseId: params.testCaseId,
            userId: params.userId,
            runId: params.runId,
            role: shot.role,
            category: finding.category,
            description: finding.description,
            confidence: finding.confidence,
            screenshotUrl: shot.url,
          });

          if (outcome) {
            logger.info('[VISUAL_ANOMALY] Observation recorded', {
              testId: params.testId,
              testCaseId: params.testCaseId,
              category: finding.category,
              recurrenceCount: outcome.recurrenceCount,
              status: outcome.status,
            });
          }
        } catch (error) {
          // Isolated per finding — a single finding's persistence failure
          // must not be misreported as the whole shot being skipped, which
          // would be misleading for any earlier finding in this SAME shot
          // that already succeeded and logged 'Observation recorded' above.
          logger.warn('[VISUAL_ANOMALY] Failed to persist one finding — continuing with the rest of this shot', {
            testId: params.testId,
            testCaseId: params.testCaseId,
            category: finding.category,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn('[VISUAL_ANOMALY] Screenshot check failed — skipping this shot', {
        testId: params.testId,
        url: shot.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
