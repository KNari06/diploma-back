import { createHash } from 'crypto';
import {
  getRunWithOwnership,
  getRunByShareToken,
  getTestCaseNamesByIds,
  getTestResultsByTestIds,
  getMobileTestResultsByTestIds,
  getExecutedStepsByTestIds,
  getNegativeMetaByIds,
  getTestCasePhaseInfoByIds,
  getTestsByRegressionRunId,
} from './db/regression-report.db';
import { getProjectWorkspaceId, getActiveWorkspaceMemberIds } from './db/regression.db';
import { describeDeviceError } from './device-error-catalog';
import { ExecutionService } from '../executions/execution.service';
import { HealthCheckAggregatorService } from './health-check-aggregator.service';
import { TestReportGeneratorService } from '../results/test-report-generator.service';
import { deriveRunStatus } from '@/utils/testing/run-status.utils';
import { computeReleaseVerdict, applyVisualAnomalySoftening } from './release-verdict.util';
import { ReleaseNarrativeService } from './release-narrative.service';
import { getSurfacedFindingsForRun } from '../visual-anomaly/db/visual-anomaly.db';
import { logger } from '@/utils/core/logger';
import type {
  RunReport,
  RunReportExecution,
  RunReportStep,
  RunReportScreenshot,
  RunReportSummary,
  RunReportArtifactsSummary,
  RunReportFailureReason,
  EnrichedBug,
  ExecutionHealthChecks,
  NegativeSummary,
} from '@/types/testing.types';

/** Format a step event timestamp (ISO/epoch) to HH:MM:SS, or undefined if invalid. */
function formatClock(ts: unknown): string | undefined {
  if (typeof ts !== 'string' && typeof ts !== 'number') return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class RegressionReportAssemblerService {
  // =========================================================================
  // RUN REPORT METHODS
  // =========================================================================

  /**
   * Get a run with ownership check, including plan name
   */
  static async getRunWithOwnership(
    runId: string,
    userId: string,
  ): Promise<any | null> {
    return getRunWithOwnership(runId, userId);
  }

  /**
   * Fetch a run by its public share token (no ownership check)
   */
  static async getRunByShareToken(shareToken: string): Promise<any | null> {
    return getRunByShareToken(shareToken);
  }

  /**
   * Batch fetch test case names by IDs
   */
  static async batchGetTestCaseNames(
    testCaseIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!testCaseIds.length) return map;

    const rows = await getTestCaseNamesByIds(testCaseIds);
    for (const row of rows) {
      map.set(row.id, row.name);
    }
    return map;
  }

  /**
   * Batch fetch test results (artifacts + ai_summary) by test IDs.
   * When a test has multiple results (one per browser), picks the first one
   * with ai_summary, or falls back to the first result.
   */
  static async batchGetTestResults(
    testIds: string[],
  ): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    if (!testIds.length) return map;

    // Web results live in `test_results`, mobile in `mobile_test_results`. A
    // given testId belongs to exactly one, so fetch both and merge — otherwise
    // mobile execs surface with no artifacts/bugs.
    const [webRows, mobileRows] = await Promise.all([
      getTestResultsByTestIds(testIds),
      getMobileTestResultsByTestIds(testIds),
    ]);
    for (const row of [...webRows, ...mobileRows]) {
      // Prefer the result that has ai_summary
      const existing = map.get(row.test_id);
      if (!existing || (!existing.ai_summary && row.ai_summary)) {
        map.set(row.test_id, row);
      }
    }
    return map;
  }

  /**
   * Batch fetch executed steps from tests table
   */
  static async batchGetExecutedSteps(
    testIds: string[],
  ): Promise<Map<string, any[]>> {
    const map = new Map<string, any[]>();
    if (!testIds.length) return map;

    const rows = await getExecutedStepsByTestIds(testIds);
    for (const row of rows) {
      map.set(row.id, row.executed_steps || []);
    }
    return map;
  }

  /**
   * Chain view: assemble one `RunReportExecution`-shaped entry per segment
   * of a `link_test_case` chain, so `TestCasesTable`/`TestCaseDetail` (the
   * SAME components already used for a bulk run's `executions[]`) can
   * render the whole chain — no new UI. See `tests.regression_run_id`
   * migration for how segments get tagged to this run.
   *
   * Deliberately simpler than the full bulk-run assembly in
   * `assembleReport` below (no bug/health-check/phase enrichment) — a chain
   * segment's card is a compact summary with click-through, per the
   * "compact summary + click-through" design decision, not full parity
   * with bulk-run analytics depth.
   *
   * Returns `[]` when the run has 0 or 1 segments (a normal, unsegmented
   * run) — the single-run view renders exactly as it does today.
   */
  static async buildChainExecutions(runId: string): Promise<RunReportExecution[]> {
    const rows = await getTestsByRegressionRunId(runId);
    if (rows.length < 2) return [];

    const executedStepsMap = await RegressionReportAssemblerService.batchGetExecutedSteps(
      rows.map((r) => r.id),
    );

    // `options.metadata.intentTestCaseName` is a denormalized copy written at
    // dispatch time — usually present, but not guaranteed (e.g. an older row,
    // or a dispatch path that didn't set it). Batch-fetch the canonical name
    // as a backstop instead of falling straight to 'Unknown'.
    const fallbackIds = rows
      .map((r) => (r.options as any)?.metadata?.intentTestCaseId)
      .filter((id): id is string => typeof id === 'string');
    const fallbackNamesMap = await RegressionReportAssemblerService.batchGetTestCaseNames(fallbackIds);

    return rows.map((row): RunReportExecution => {
      const options = (row.options || {}) as any;
      const rawSteps = executedStepsMap.get(row.id) || [];
      const completedSteps = rawSteps.filter((s: any) => s.type === 'step_completed');

      const screenshots: RunReportScreenshot[] = [];
      const steps: RunReportStep[] = completedSteps.map((s: any, i: number) => {
        const meta = s.data?.runtimeMeta;
        const success = s.data?.success !== false;
        // Soft failures (e.g. an auto-injected waitFor timeout) are warnings,
        // not errors — same rule the main execution loop below applies
        // (`isSoftFailure`). Without this a chain segment's soft-failed step
        // shows as a hard 'failed' where the identical step, viewed through
        // the normal single-run report, correctly shows 'warning'.
        const isSoftFailure = !success && !!s.data?.softFailure;
        const description = s.data?.stepDescription || s.data?.step || `Step ${i + 1}`;
        const status: RunReportStep['status'] = success ? 'passed' : (isSoftFailure ? 'warning' : 'failed');
        const screenshotUrl =
          typeof meta?.stepScreenshotUrl === 'string' && meta.stepScreenshotUrl && !meta.stepScreenshotUrl.startsWith('data:')
            ? meta.stepScreenshotUrl
            : undefined;
        if (screenshotUrl) {
          screenshots.push({
            url: screenshotUrl,
            stepName: `${options.metadata?.intentTestCaseName || 'Segment'}: ${description}`,
            timestamp: formatClock(s.timestamp || s.data?.timestamp),
            status,
          });
        }
        return {
          index: i,
          description,
          status,
          durationMs: typeof s.data?.durationMs === 'number' ? s.data.durationMs : undefined,
          screenshot: screenshotUrl,
        };
      });

      const durationMs = row.started_at && row.completed_at
        ? Math.max(new Date(row.completed_at).getTime() - new Date(row.started_at).getTime(), 0)
        : 0;

      // Mobile stores the unprefixed device platform ('android'|'ios'|
      // 'flutter') in options.platform; web has no such field. Normalize to
      // the same 'mobile_<platform>' | 'web' shape RunReportExecution.platform
      // uses elsewhere (PlatformBadge / bucketing logic already expect this).
      const platform = options.platform ? `mobile_${options.platform}` : 'web';

      return {
        id: row.id,
        testCaseId: options.metadata?.intentTestCaseId,
        testCaseName: options.metadata?.intentTestCaseName
          || fallbackNamesMap.get(options.metadata?.intentTestCaseId)
          || 'Unknown',
        status: row.status === 'completed' ? 'passed' : row.status,
        durationMs,
        browser: Array.isArray(row.browsers) ? row.browsers[0] : undefined,
        platform,
        bugsCount: 0,
        steps,
        artifacts: {
          screenshots,
          bugScreenshots: [],
          consoleLogs: [],
          networkLogs: [],
        },
      } as unknown as RunReportExecution;
    });
  }

  /**
   * Build a full aggregated run report (authenticated — checks ownership)
   */
  static async buildFullReport(
    runId: string,
    userId: string,
  ): Promise<RunReport | null> {
    const run = await this.getRunWithOwnership(runId, userId);
    if (!run) return null;
    const report = await RegressionReportAssemblerService.assembleReport(run);
    return RegressionReportAssemblerService.attachReleaseNarrative(run, report);
  }

  /**
   * Build a full report for a publicly shared run (no ownership check).
   */
  static async buildPublicReport(shareToken: string): Promise<RunReport | null> {
    const run = await this.getRunByShareToken(shareToken);
    if (!run) return null;
    const report = await RegressionReportAssemblerService.assembleReport(run);
    return RegressionReportAssemblerService.attachReleaseNarrative(run, report);
  }

  /**
   * Lazy-generate-on-first-fetch the optional release narrative — ADR-0012.
   * Called from BOTH `buildFullReport` and `buildPublicReport` (not from
   * `RegressionRunService`'s same-named methods, which are one-line
   * delegating wrappers with no logic — verified against live code before
   * this was written) so authed and public-share views get it identically.
   * Charges the RUN OWNER (`run.user_id`), never the requesting viewer —
   * matters for the public-share path, which has no authenticated caller.
   * Best-effort: any failure here still ships the report verdict-only.
   */
  private static async attachReleaseNarrative(run: any, report: RunReport): Promise<RunReport> {
    try {
      const { narrative, verdictAtCompletion } = await ReleaseNarrativeService.getOrGenerate(
        run,
        report.releaseVerdict,
        report.bugs,
        report.healthSummary,
        report.summary,
        run.user_id ?? null,
      );
      return {
        ...report,
        ...(narrative && { releaseNarrative: narrative }),
        ...(verdictAtCompletion && { releaseVerdictAtCompletion: verdictAtCompletion as any }),
      };
    } catch (error) {
      logger.warn('[REGRESSION_REPORT] Release narrative attach failed — shipping verdict-only', {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return report;
    }
  }

  /**
   * Deterministic identity of a bug for cross-execution dedup. Same shape of
   * defect → same fingerprint. Keyed on severity + category + a normalized
   * title (lowercased, whitespace-collapsed, trailing digits/ids stripped so
   * "Login button not found (attempt 2)" ≡ "Login button not found") + selector.
   * SHA-1 hex — mirrors `regression_doctor_findings.pattern_hash`. Title is the
   * stable identity here (not steps/actual, which vary run-to-run).
   */
  private static fingerprintBug(bug: EnrichedBug): string {
    const normTitle = (bug.title || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[#(]?\s*(attempt|try|run|step)\s*\d+\)?/g, '') // drop "(attempt 2)" style suffixes
      .replace(/\b\d{2,}\b/g, '')                              // drop long numbers (ids/timestamps)
      .trim();
    const key = [bug.severity, bug.category, normTitle, bug.selector || ''].join('␟');
    return createHash('sha1').update(key).digest('hex');
  }

  /**
   * Collapse duplicate bugs across a run's executions. Keeps the FIRST instance
   * of each fingerprint (preserving its execution/test-case linkage for
   * drill-down) and annotates it with `occurrences` + the distinct
   * `seenInExecutions`. Order-preserving so the report's bug order is stable.
   */
  private static dedupeBugs(bugs: EnrichedBug[]): EnrichedBug[] {
    const byFp = new Map<string, EnrichedBug>();
    for (const bug of bugs) {
      const fp = RegressionReportAssemblerService.fingerprintBug(bug);
      const existing = byFp.get(fp);
      if (!existing) {
        byFp.set(fp, {
          ...bug,
          fingerprint: fp,
          occurrences: 1,
          seenInExecutions: bug.executionId ? [bug.executionId] : [],
        });
        continue;
      }
      existing.occurrences = (existing.occurrences || 1) + 1;
      if (bug.executionId && !existing.seenInExecutions!.includes(bug.executionId)) {
        existing.seenInExecutions!.push(bug.executionId);
      }
    }
    return [...byFp.values()];
  }

  /**
   * Derive a case-level failure reason from a (mobile) test_result row when the
   * run failed BEFORE any step executed — device attach / session setup / runner
   * unreachable. The mobile job persists this on `mobile_test_results` (see
   * `createFailedJobTestResult`): `metadata.failureLayer = 'job'` with an
   * `errorCode`, plus a `{ type: 'job_failure', code, message }` entry in
   * `errors`. Returns null for normal pass / step-failure rows so the banner
   * only shows when the test genuinely never ran.
   */
  private static deriveFailureReason(testResult: any, platform?: string): RunReportFailureReason | null {
    if (!testResult) return null;
    // Job-failure markers only exist on the mobile path (createFailedJobTestResult).
    // Guard on platform so a future web/API result that happens to carry a
    // job_failure-typed error can't trip a false "couldn't start" banner.
    if (!platform || !platform.startsWith('mobile')) return null;
    const meta = testResult.metadata;
    const jobErr = Array.isArray(testResult.errors)
      ? testResult.errors.find((e: any) => e?.type === 'job_failure')
      : null;
    const isJobFailure = meta?.failureLayer === 'job' || !!jobErr;
    if (!isJobFailure) return null;
    const code: string = meta?.errorCode || jobErr?.code || 'UNKNOWN';
    const message: string = meta?.errorMessage || jobErr?.message || '';
    const info = describeDeviceError(code);
    return {
      code,
      label: info.label,
      message: message || info.label,
      remediation: info.remediation,
      layer: 'job',
      category: info.category,
    };
  }

  /**
   * Shared report assembly logic used by both buildFullReport and buildPublicReport.
   * Fetches executions, test results, steps, bugs, artifacts and assembles RunReport.
   */
  static async assembleReport(run: any): Promise<RunReport> {
    // Phase 1: Parallel fetch stats + executions + chain segments.
    // `buildChainExecutions` only depends on `run.id` (same as the other
    // two), so it belongs in this same batch rather than being awaited in
    // isolation near the end of the function — that would serialize its
    // round-trip after everything else is already assembled, adding pure
    // wall-clock latency to every report fetch for no reason.
    const [stats, executions, chainExecutions] = await Promise.all([
      ExecutionService.getStats(run.id),
      ExecutionService.getByRunId(run.id),
      RegressionReportAssemblerService.buildChainExecutions(run.id),
    ]);

    const planName = (run.regression_plans as any)?.name || null;

    // Get test case names
    const testCaseIds = [...new Set(executions.map((e) => e.testCaseId))];
    const namesMap = await RegressionReportAssemblerService.batchGetTestCaseNames(testCaseIds);

    // Extract testIds from UI executions (stored in execution.result.testId)
    const testIds: string[] = [];
    for (const exec of executions) {
      const testId = exec.result?.testId;
      if (testId && exec.testType === 'ui') {
        testIds.push(testId);
      }
    }

    // Batch-fetch negativeMeta for negative test cases
    const negativeTestCaseIds = executions.filter((e) => e.isNegative).map((e) => e.testCaseId);
    const negativeMetaMap = new Map<string, import('@/types/testing.types').NegativeMeta>();
    if (negativeTestCaseIds.length > 0) {
      const negRows = await getNegativeMetaByIds(negativeTestCaseIds);
      for (const row of negRows) {
        if (row.negative_meta) {
          negativeMetaMap.set(row.id, row.negative_meta as import('@/types/testing.types').NegativeMeta);
        }
      }
    }

    // Phase 3 — post-hoc phase map.
    // The step executor doesn't (yet) echo our `phase` marker back in its
    // event trace. Rather than thread the flag through a second service
    // we don't own, we reconstruct phase locally: for each test case that
    // was stitched, grab setup_steps / teardown_steps lengths, and tag the
    // executed-step timeline by index. When the case has no extras, the
    // map stays empty and the report falls back to the legacy shape
    // (no phase field on steps).
    //
    // IMPORTANT — assumption: the executor emits `step_completed` events
    // in the same order it received the commands. The indexing here will
    // produce wrong phase labels if that ever changes (parallel execution
    // within a test case, reordering for optimisation, etc.). Today the
    // Playwright executor is strictly serial per-test-case (Mobile runner
    // too), so this is safe — but any future change to execution ordering
    // MUST update this reconstruction or have the executor echo `phase`
    // on each step event directly.
    const phaseMapByTestCaseId = new Map<string, Array<'setup' | 'main' | 'teardown'>>();
    // Surface curator-set priority alongside the phase reconstruction so
    // the run-details page can badge / colorize execution rows without an
    // extra round-trip. Display-only — does NOT change execution order.
    // Map only stores valid enum values; CHECK-violating drift collapses
    // to null on the wire.
    const priorityByTestCaseId = new Map<string, 'critical' | 'high' | 'medium' | 'low'>();
    const VALID_PRIORITY = new Set(['critical', 'high', 'medium', 'low']);
    if (testCaseIds.length > 0) {
      const caseRows = await getTestCasePhaseInfoByIds(testCaseIds);
      for (const row of caseRows) {
        if (row.priority && VALID_PRIORITY.has(row.priority)) {
          priorityByTestCaseId.set(row.id, row.priority as 'critical' | 'high' | 'medium' | 'low');
        }
        const setupCount = Array.isArray(row.setup_steps) ? row.setup_steps.length : 0;
        const teardownCount = Array.isArray(row.teardown_steps) ? row.teardown_steps.length : 0;
        const mainCount = Array.isArray(row.steps_json) ? row.steps_json.length : 0;
        if (setupCount === 0 && teardownCount === 0) continue; // legacy case — skip
        const phases: Array<'setup' | 'main' | 'teardown'> = [
          ...Array(setupCount).fill('setup' as const),
          ...Array(mainCount).fill('main' as const),
          ...Array(teardownCount).fill('teardown' as const),
        ];
        phaseMapByTestCaseId.set(row.id, phases);
      }
    }

    // Phase 2: Parallel enrichment fetch
    const [testResultsMap, testReports, executedStepsMap] = await Promise.all([
      RegressionReportAssemblerService.batchGetTestResults(testIds),
      TestReportGeneratorService.batchGetReportsByTestIds(testIds),
      RegressionReportAssemblerService.batchGetExecutedSteps(testIds),
    ]);

    // Index reports by testId
    const reportsMap = new Map<string, any>();
    for (const report of testReports) {
      reportsMap.set(report.testId, report);
    }

    // Build executions, bugs, aggregated artifacts
    const reportExecutions: RunReportExecution[] = [];
    const allBugs: EnrichedBug[] = [];
    const allRecommendations = new Set<string>();
    let totalConfidence = 0;
    let confidenceCount = 0;

    const aggArtifacts: RunReportArtifactsSummary = {
      screenshots: [],
      bugScreenshots: [],
      consoleLogs: [],
      networkLogs: [],
    };

    const validSeverities = new Set(['critical', 'high', 'medium', 'low']);
    const validCategories = new Set(['functional', 'performance', 'accessibility', 'visual', 'security']);

    for (const exec of executions) {
      const testCaseName = namesMap.get(exec.testCaseId) || 'Unknown';
      const testId = exec.result?.testId;

      // Case-level "couldn't start" reason (device attach / session setup / runner
      // unreachable) — only present when the run failed before any step ran. When
      // set, the test never executed, so health aggregation below is skipped: its
      // "no console errors" findings would be misleadingly green.
      const failureReason = RegressionReportAssemblerService.deriveFailureReason(
        testId ? testResultsMap.get(testId) : null,
        exec.platform,
      );

      // Build steps from executed_steps
      const steps: RunReportStep[] = [];
      let execArtifacts: {
        videoUrl?: string;
        traceUrl?: string;
        screenshots: RunReportScreenshot[];
        bugScreenshots: string[];
        consoleLogs: string[];
        networkLogs: Array<{ method: string; url: string; status?: number; durationMs?: number }>;
        qualityChecks?: any;
      } = {
        videoUrl: undefined,
        traceUrl: undefined,
        screenshots: [],
        bugScreenshots: [],
        consoleLogs: [],
        networkLogs: [],
      };
      let bugsCount = 0;
      let execHealthChecks: ExecutionHealthChecks | undefined;

      if (testId && exec.testType === 'ui') {
        // Build steps
        const rawSteps = executedStepsMap.get(testId) || [];
        const allCompletedSteps = rawSteps.filter((s: any) => s.type === 'step_completed');
        // Collapse by step index, keeping the LAST event per index. The Redis
        // buffer accumulates every attempt's steps in order (attempt 0, then
        // attempt 1 on retry), and — during a worker/API mixed-version deploy —
        // a step can be appended twice. Keeping the last occurrence per step
        // index yields the final attempt's outcome and a single, un-doubled
        // timeline. A Map preserves first-seen position, so steps stay ordered
        // 0..n and the phase indexing below stays aligned. Events without a
        // numeric step index keep a positional key so they are never merged.
        const byStepIndex = new Map<string, any>();
        allCompletedSteps.forEach((s: any, i: number) => {
          const key = typeof s.data?.step === 'number' ? `step-${s.data.step}` : `pos-${i}`;
          byStepIndex.set(key, s);
        });
        const completedSteps = [...byStepIndex.values()];
        // Reconstruct phase from the test case's setup_steps / steps_json /
        // teardown_steps counts. Indexed by executed-step position so as
        // long as the executor fires step_completed events in order (it does),
        // we can label setup / main / teardown without touching the
        // executor service. Undefined entries fall back to legacy (no phase).
        const phaseList = phaseMapByTestCaseId.get(exec.testCaseId);
        // Per-step screenshots with display metadata for the Screenshots tab.
        // Built here (in the step loop) so the label carries the step name,
        // capture time, and outcome — not just a bare URL.
        const stepScreenshots: RunReportScreenshot[] = [];
        for (let i = 0; i < completedSteps.length; i++) {
          const step = completedSteps[i];
          const meta = step.data?.runtimeMeta;
          const success = step.data?.success !== false;
          const isSoftFailure = !success && !!step.data?.softFailure;
          // Surface self-healing so QA can spot fragile steps. "Healed" means a
          // self_heal rewrite actually SUCCEEDED — gate strictly on
          // runtimeStatus === 'healed'. We intentionally do NOT also accept
          // `source === 'self_heal'`: a blocked heal (low confidence) carries
          // source 'self_heal' but runtimeStatus 'failed', and that step did
          // not heal — it failed, so it must not wear a "healed" badge. Normal
          // LLM-resolver fallbacks are source 'resolver'/status 'executed' and
          // are likewise excluded. "flaky" is an independent historical signal.
          const healed = meta?.runtimeStatus === 'healed';
          const phase = phaseList?.[i];
          // Phase 3: a failing teardown step is a warning, not a failure —
          // teardown runs best-effort and never flips the overall verdict.
          const isTeardownFailure = !success && phase === 'teardown';
          const description = step.data?.stepDescription || step.data?.step || `Step ${i + 1}`;
          // V16: Soft failures (e.g. auto-injected waitFor timeout) are warnings, not errors.
          // Phase 3: teardown failures are also warnings by contract.
          const stepStatus: RunReportStep['status'] = success
            ? 'passed'
            : (isSoftFailure || isTeardownFailure ? 'warning' : 'failed');
          const stepScreenshotUrl =
            typeof meta?.stepScreenshotUrl === 'string' && meta.stepScreenshotUrl
              ? meta.stepScreenshotUrl
              : undefined;
          // Collect a labeled gallery entry: "Step N: <desc>" + HH:MM:SS + outcome.
          if (stepScreenshotUrl && !stepScreenshotUrl.startsWith('data:')) {
            stepScreenshots.push({
              url: stepScreenshotUrl,
              stepName: `Step ${i + 1}: ${description}`,
              timestamp: formatClock(step.ts),
              status: stepStatus,
            });
          }
          steps.push({
            index: i + 1,
            description,
            status: stepStatus,
            // Action type for the per-step badge (carried through from the
            // executed command). Absent on legacy runs persisted before this.
            ...(typeof step.data?.action === 'string' && step.data.action ? { action: step.data.action } : {}),
            durationMs: meta?.executionMs,
            error: !success ? {
              message: meta?.failureExplanation || meta?.failedReason || 'Step failed',
              failedReason: meta?.failedReason,
              screenshot: meta?.bugScreenshotUrl,
              rootCause: meta?.rootCause,
              networkVerdict: meta?.networkVerdict,
            } : undefined,
            // Per-step screenshot (every step, pass or fail) — surfaced inline
            // in the timeline; the labeled copy lands in the Screenshots tab.
            ...(stepScreenshotUrl ? { screenshot: stepScreenshotUrl } : {}),
            ...(healed ? { healed: true } : {}),
            ...(typeof meta?.healConfidence === 'number' ? { healConfidence: meta.healConfidence } : {}),
            // Forward self-heal before/after provenance. Only meaningful when
            // healed === true, but we keep the guards independent so a partial
            // meta still surfaces whatever fields are present.
            ...(meta?.healedFrom ? { healedFrom: meta.healedFrom } : {}),
            ...(meta?.healedTo ? { healedTo: meta.healedTo } : {}),
            ...(meta?.healWhatChanged ? { healWhatChanged: meta.healWhatChanged } : {}),
            ...(meta?.flaky ? { flaky: true } : {}),
            ...(phase ? { phase } : {}),
          });
        }

        // Build artifacts from test_results
        const testResult = testResultsMap.get(testId);
        if (testResult) {
          execArtifacts.videoUrl = testResult.video_url || undefined;
          execArtifacts.traceUrl = testResult.trace_url || undefined;
          if (testResult.screenshot) {
            const finals = Array.isArray(testResult.screenshot)
              ? testResult.screenshot
              : [testResult.screenshot];
            // URLs only (drop base64); label as the final/representative shot.
            execArtifacts.screenshots = finals
              .filter((s: string) => typeof s === 'string' && !s.startsWith('data:'))
              .map((url: string): RunReportScreenshot => ({ url, stepName: 'Final screenshot' }));
          }
          // "Step 0": the starting screen captured before any step ran (mobile).
          // Stored as a URL on mobile_test_results.metadata.initialScreenshot.
          // Lead the gallery with it so the report reads start → steps → final.
          const initialShot = testResult.metadata?.initialScreenshot;
          if (typeof initialShot === 'string' && initialShot && !initialShot.startsWith('data:')) {
            execArtifacts.screenshots.unshift({ url: initialShot, stepName: 'Step 0: Initial screen' });
          }
          if (testResult.logs) {
            execArtifacts.consoleLogs = Array.isArray(testResult.logs) ? testResult.logs : [];
          }
          if (testResult.network_logs && Array.isArray(testResult.network_logs)) {
            execArtifacts.networkLogs = testResult.network_logs.map((nl: any) => ({
              method: nl.method || '',
              url: nl.url || '',
              status: nl.status ?? undefined,
              durationMs: nl.responseTime || nl.durationMs,
            }));
          }

          // Extract quality checks from test_results
          if (testResult.quality_checks && typeof testResult.quality_checks === 'object') {
            const qc = testResult.quality_checks;
            execArtifacts.qualityChecks = {
              webVitals: qc.webVitals || undefined,
              accessibility: qc.accessibility || undefined,
              brokenResources: Array.isArray(qc.brokenResources) ? qc.brokenResources : undefined,
              slowAPIs: Array.isArray(qc.slowAPIs) ? qc.slowAPIs : undefined,
            };
          }

          // Aggregate health checks from existing test result data — but NOT when
          // the test never ran (job-level failure). A non-started test has no real
          // console/network signal; emitting "no errors" here would render as a
          // misleading green health badge next to a "couldn't start" failure.
          const isMobileExec = typeof exec.platform === 'string' && exec.platform.startsWith('mobile');
          execHealthChecks = failureReason
            ? undefined
            : HealthCheckAggregatorService.aggregateFromTestResult(testResult, { isMobile: isMobileExec });

          // Aggregate into run-level artifacts
          if (execArtifacts.videoUrl && !aggArtifacts.videoUrl) aggArtifacts.videoUrl = execArtifacts.videoUrl;
          if (execArtifacts.traceUrl && !aggArtifacts.traceUrl) aggArtifacts.traceUrl = execArtifacts.traceUrl;
          aggArtifacts.screenshots.push(...execArtifacts.screenshots);
          aggArtifacts.consoleLogs.push(...execArtifacts.consoleLogs);
          aggArtifacts.networkLogs.push(...execArtifacts.networkLogs);
        }

        // Extract bug screenshots from executed steps (stored in runtimeMeta.bugScreenshotUrl)
        for (const step of steps) {
          if (step.error?.screenshot && typeof step.error.screenshot === 'string') {
            execArtifacts.bugScreenshots.push(step.error.screenshot);
          }
        }
        aggArtifacts.bugScreenshots.push(...execArtifacts.bugScreenshots);

        // Labeled per-step screenshots → Screenshots artifact tab. Works for
        // web AND mobile (both append step_completed with stepScreenshotUrl).
        // Deduped by URL against the final/test_results screenshot collected
        // above; runs outside the testResult gate so it works even when
        // test_results has no top-level screenshot.
        const seenScreenshotUrls = new Set(execArtifacts.screenshots.map((s) => s.url));
        for (const shot of stepScreenshots) {
          if (!seenScreenshotUrls.has(shot.url)) {
            seenScreenshotUrls.add(shot.url);
            execArtifacts.screenshots.push(shot);
            aggArtifacts.screenshots.push(shot);
          }
        }

        // Aggregate quality checks at run level
        if (execArtifacts.qualityChecks) {
          if (!aggArtifacts.qualityChecks) {
            aggArtifacts.qualityChecks = { brokenResources: [], slowAPIs: [] };
          }
          const agg = aggArtifacts.qualityChecks;
          const ec = execArtifacts.qualityChecks;

          // Web vitals: keep the latest non-empty one
          if (ec.webVitals) agg.webVitals = ec.webVitals;

          // Accessibility: merge warnings arrays, sum totals
          if (ec.accessibility) {
            if (!agg.accessibility) {
              agg.accessibility = { warnings: [], totalWarnings: 0 };
            }
            agg.accessibility.warnings.push(...(ec.accessibility.warnings || []));
            agg.accessibility.totalWarnings += ec.accessibility.totalWarnings || 0;
          }

          // Broken resources / slow APIs: concatenate
          if (ec.brokenResources) {
            agg.brokenResources = [...(agg.brokenResources || []), ...ec.brokenResources];
          }
          if (ec.slowAPIs) {
            agg.slowAPIs = [...(agg.slowAPIs || []), ...ec.slowAPIs];
          }
        }

        // Extract bugs: prefer test_reports > ai_summary
        const report = reportsMap.get(testId);
        const testResultData = testResultsMap.get(testId);
        const rawBugSource =
          report?.analysis?.bugs ||
          testResultData?.ai_summary?.bugs ||
          [];
        const rawBugs: any[] = Array.isArray(rawBugSource) ? rawBugSource : [];

        for (let i = 0; i < rawBugs.length; i++) {
          const bug = rawBugs[i];
          if (!bug || typeof bug !== 'object') continue;
          allBugs.push({
            id: bug.id || `${exec.id}-bug-${i}`,
            title: bug.title || bug.message || bug.description || '',
            severity: validSeverities.has(bug.severity) ? bug.severity : 'medium',
            category: validCategories.has(bug.category) ? bug.category : 'functional',
            testCaseId: exec.testCaseId,
            testCaseName,
            executionId: exec.id,
            steps: Array.isArray(bug.steps) ? bug.steps : (Array.isArray(bug.stepsToReproduce) ? bug.stepsToReproduce : []),
            expected: bug.expectedResult || bug.expected || '',
            actual: bug.actualResult || bug.actual || '',
            selector: bug.domSelector || bug.selector,
            recommendation: bug.recommendation || '',
          });
        }
        bugsCount = rawBugs.length;

        // Collect recommendations
        const recsSource =
          report?.analysis?.recommendations ||
          testResultData?.ai_summary?.recommendations ||
          [];
        const recs: string[] = Array.isArray(recsSource) ? recsSource : [];
        for (const r of recs) {
          if (typeof r === 'string' && r.trim()) {
            allRecommendations.add(r);
          }
        }

        // Collect confidence
        const conf = report?.analysis?.confidence ?? testResultData?.ai_summary?.confidence;
        if (typeof conf === 'number') {
          totalConfidence += conf;
          confidenceCount++;
        }
      }

      // V14: Extract failure classification from AI summary
      const execAiSummary = testId ? (testResultsMap.get(testId)?.ai_summary) : null;
      const aiFailureClassification = execAiSummary?.failureClassification || null;
      const rootCauseStep = execAiSummary?.rootCauseStep ?? null;
      // An environment failure means the test never ran, so the AI verdict (run
      // on an artifact-less failed row) can't be trusted — the derived
      // 'environment' category WINS over any AI classification. `failureReason`
      // was computed at the top of the loop (also gates health aggregation).
      const failureClassification =
        failureReason?.category === 'environment' ? 'environment' : aiFailureClassification;

      reportExecutions.push({
        id: exec.id,
        testCaseId: exec.testCaseId,
        testCaseName,
        status: exec.status,
        durationMs: exec.durationMs || 0,
        browser: exec.browser || 'chrome',
        // Raw test case platform — lets the frontend render mobile-specific
        // artifacts (device screenshots, compiled plan viewer) without an
        // extra join. Undefined for legacy rows (pre-20260417 migration).
        ...(exec.platform ? { platform: exec.platform } : {}),
        // Curator-set priority of the saved test case, if any. Null for
        // ad-hoc / chat-lite runs (no saved test case) and API tests
        // (no priority column on api_test_configs). Display-only.
        priority: priorityByTestCaseId.get(exec.testCaseId) ?? null,
        bugsCount,
        steps,
        artifacts: execArtifacts,
        ...(exec.isNegative && { isNegative: true }),
        ...(exec.isNegative && negativeMetaMap.has(exec.testCaseId) && { negativeMeta: negativeMetaMap.get(exec.testCaseId) }),
        ...(execHealthChecks && { healthChecks: execHealthChecks }),
        ...(failureClassification && { failureClassification }),
        ...(rootCauseStep !== null && { rootCauseStep }),
        ...(execAiSummary?.classificationEvidence?.length > 0 && {
          classificationEvidence: execAiSummary.classificationEvidence,
        }),
        ...(failureReason && { failureReason }),
      });
    }

    // Dedup bugs across the run's executions. The AI analysis job runs once per
    // execution and has no cross-run memory, so the SAME underlying issue (e.g.
    // "Login button not found") surfaces as a separate bug in every execution
    // that hit it — 10 executions → 10 identical entries the user has to wade
    // through. Collapse by a deterministic fingerprint (see fingerprintBug),
    // keeping the first instance and recording how many collapsed + which
    // executions they came from, so the UI can show "seen in N runs" instead of
    // N duplicate cards. Done at assembly (not storage) so each execution's
    // ai_summary stays intact for drill-down.
    const dedupedBugs = RegressionReportAssemblerService.dedupeBugs(allBugs);

    // Build merged summary (stats + bugs breakdown) — over the DEDUPED set so
    // the severity/category counts match what the user actually sees.
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const bug of dedupedBugs) {
      bySeverity[bug.severity] = (bySeverity[bug.severity] || 0) + 1;
      byCategory[bug.category] = (byCategory[bug.category] || 0) + 1;
    }
    // V14: Compute real flaky count and classification breakdown from AI analysis
    const byClassification: Record<string, number> = {};
    for (const re of reportExecutions) {
      if (re.failureClassification) {
        byClassification[re.failureClassification] = (byClassification[re.failureClassification] || 0) + 1;
      }
    }

    // Phase 7 — per-platform split for this single run. Built from the
    // already-mapped `reportExecutions` so we don't re-scan the DB.
    // Uses the same bucketing as PlanHealthReport (NULL → web,
    // mobile_* → mobile, everything else depending on execution.source
    // → api). Keeps the "how many web vs mobile vs api did THIS run do"
    // question answerable without joining back to intent_test_cases.
    const platformBreakdown = {
      web:    { total: 0, passed: 0, failed: 0 },
      mobile: { total: 0, passed: 0, failed: 0 },
      api:    { total: 0, passed: 0, failed: 0 },
    };
    for (const re of reportExecutions) {
      const raw = (re as any).platform as string | undefined;
      // An execution from an API test case doesn't carry a UI platform.
      // Today we don't have a dedicated `testType` on RunReportExecution,
      // but the `testCaseId` shape + absent `steps[]` is a reasonable
      // heuristic; if/when we add a hard `testType` field the check
      // here should switch to that. For now: treat absent steps as API,
      // otherwise bucket by platform string.
      const looksLikeApi = !re.steps || re.steps.length === 0;
      const bucket: 'web' | 'mobile' | 'api' =
        looksLikeApi && !raw ? 'api'
          : raw && raw.startsWith('mobile_') ? 'mobile'
          : 'web';
      platformBreakdown[bucket].total++;
      const status = (re.status || '').toLowerCase();
      if (status === 'passed' || status === 'completed') platformBreakdown[bucket].passed++;
      else if (status === 'failed') platformBreakdown[bucket].failed++;
    }

    const summary: RunReportSummary = {
      total: stats.total,
      passed: stats.passed,
      failed: stats.failed,
      skipped: stats.skipped,
      flaky: byClassification['flaky'] || 0,
      totalBugs: dedupedBugs.length,
      bySeverity,
      byCategory,
      byClassification,
      platformBreakdown,
    };

    // Compute duration (guard against negative if clocks are skewed)
    let durationMs: number | null = null;
    if (run.started_at && run.completed_at) {
      const diff = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
      durationMs = diff > 0 ? diff : 0;
    }

    // Derive status from live execution data to avoid stale regression_runs cache.
    // ?? run.status: defensive fallback for the (practically impossible) case where
    // run.status is null/empty — regression_runs.status is NOT NULL in the DB schema.
    const normalizedStatus = deriveRunStatus({ cachedStatus: run.status, execStats: stats }) ?? run.status;

    // Build health summary from all execution health checks
    const healthSummary = HealthCheckAggregatorService.buildHealthSummary(
      reportExecutions.map((e) => e.healthChecks),
    );

    // Split executions into positive and negative
    const positiveExecutions = reportExecutions.filter((e) => !e.isNegative);
    const negativeExecs = reportExecutions.filter((e) => e.isNegative);

    let negativeSummary: NegativeSummary | undefined;
    if (negativeExecs.length > 0) {
      negativeSummary = {
        total: negativeExecs.length,
        passed: negativeExecs.filter((e) => e.status === 'passed').length,
        failed: negativeExecs.filter((e) => e.status === 'failed').length,
        skipped: negativeExecs.filter((e) => e.status === 'skipped').length,
      };
    }

    // Chain view — `chainExecutions` was already fetched in Phase 1's
    // Promise.all above; empty for the overwhelming majority of (unsegmented) runs.
    // Release-readiness verdict (ADR-0012) — pure, deterministic, computed over
    // the SAME deduped bugs + health summary this report already carries, PLUS
    // the run's own status/summary (caught live 2026-07-08: a run that failed
    // to complete must never show "ready" just because the AI bug-detector
    // didn't characterize anything as a bug — see release-verdict.util.ts's
    // header comment). Free (no LLM, no I/O) so it's always present, unlike
    // the optional narrative (attached separately by `attachReleaseNarrative`,
    // called from `buildFullReport`/`buildPublicReport` — this function has no
    // `userId`/credit-charging context available to generate it here).
    let releaseVerdict = computeReleaseVerdict(dedupedBugs, healthSummary, normalizedStatus, summary);

    // Visual anomaly findings (ADR-0012) — scoped to THIS run
    // (:runId = ANY(affected_run_ids)), only ever the ones that already
    // cleared the cross-run recurrence gate (status='surfaced'). A single
    // run's vision call can never reach this list on its own. Not pulled
    // into the Phase 1 Promise.all above for simplicity — a cheap, single
    // indexed query; revisit if report-fetch latency ever needs it.
    let visualAnomalies: import('@/types/testing.types').RunReportVisualAnomaly[] = [];
    if (run.project_id) {
      const findings = await getSurfacedFindingsForRun(run.project_id, run.id);
      visualAnomalies = findings.map((f) => ({
        id: f.id,
        testCaseId: f.test_case_id,
        testCaseName: f.intent_test_cases?.name || 'Unknown',
        category: f.category as any,
        description: f.description,
        confidence: f.confidence,
        screenshotUrl: f.example_screenshot_url,
        recurrenceCount: f.recurrence_count,
        firstSeenAt: f.first_seen_at,
      }));
      if (visualAnomalies.length > 0) {
        releaseVerdict = applyVisualAnomalySoftening(releaseVerdict, visualAnomalies);
      }
    }

    return {
      id: run.id,
      planId: run.plan_id || null,
      planName,
      status: normalizedStatus,
      trigger: run.trigger,
      startedAt: run.started_at,
      completedAt: run.completed_at || null,
      durationMs,
      aiConfidence: confidenceCount > 0 ? Math.round(totalConfidence / confidenceCount) : null,
      summary,
      executions: positiveExecutions,
      bugs: dedupedBugs,
      recommendations: [...allRecommendations],
      artifactsSummary: aggArtifacts,
      healthSummary,
      releaseVerdict,
      ...(negativeSummary && { negativeSummary }),
      ...(negativeExecs.length > 0 && { negativeExecutions: negativeExecs }),
      ...(chainExecutions.length > 0 && { chainExecutions }),
      ...(visualAnomalies.length > 0 && { visualAnomalies }),
    };
  }
}

// ============================================================================
// WORKSPACE MEMBER RESOLUTION HELPER
// ============================================================================

/**
 * Resolve all active workspace member user IDs for a project.
 * Returns at least the given ownerId, plus all workspace members if the project belongs to a workspace.
 * Non-fatal: falls back to [ownerId] on any error.
 */
export async function getProjectWorkspaceMemberIds(projectId: string, ownerId: string): Promise<string[]> {
  try {
    const workspaceId = await getProjectWorkspaceId(projectId);
    if (!workspaceId) return [ownerId];

    const memberIds = await getActiveWorkspaceMemberIds(workspaceId);

    const ids = new Set<string>();
    ids.add(ownerId);
    for (const uid of memberIds) {
      ids.add(uid);
    }
    return Array.from(ids);
  } catch {
    return [ownerId];
  }
}
