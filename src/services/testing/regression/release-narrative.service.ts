/**
 * Optional LLM narrative over a release verdict already decided by
 * `computeReleaseVerdict` (release-verdict.util.ts) — ADR-0012.
 *
 * Lazy-generate-on-first-fetch: called from
 * `RegressionReportAssemblerService.buildFullReport`/`buildPublicReport`
 * right after `assembleReport()` returns (NOT from `RegressionRunService`'s
 * same-named methods — those are one-line delegating wrappers with no
 * logic; verified against live code before this was written).
 *
 * Cost-gated (`RELEASE_NARRATIVE_CREDITS`), mirroring the ONLY real
 * precedent in this codebase for this class of best-effort AI credit
 * charge — `ai-analysis.job.ts`'s bug-report charge (marker persisted
 * BEFORE `deductCreditsForTest`, never a pre-flight `checkCreditsForTest`;
 * confirmed that call doesn't exist in the precedent either).
 */
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { buildReleaseNarrativePrompt } from '@/ai/prompts/release-narrative-prompts';
import { ReleaseNarrativeFeature } from '@/config/features/release-narrative';
import { RELEASE_VERDICT_RULESET_VERSION } from './release-verdict.util';
import { updateRunById, getRunNarrativeFields } from './db/regression-run.db';
import { logger } from '@/utils/core/logger';
import type { ReleaseNarrative, ReleaseVerdict, EnrichedBug, HealthSummary, RunReportSummary } from '@/types/testing.types';

export const RELEASE_NARRATIVE_CREDITS = 3;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// Own, self-contained per-run mutex — deliberately NOT sharing
// regression-doctor/apply.service.ts's `applyMutexes` map. That map is
// generic enough to reuse, but keying it with a `runId` alongside its
// existing `testCaseId` keys (both UUIDs) is a same-string collision risk
// for zero benefit; a 10-line local duplicate is cheaper than touching an
// already-working shared file for a change this small.
const narrativeMutexes = new Map<string, Promise<void>>();

function withRunMutex<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const prev = narrativeMutexes.get(runId) || Promise.resolve();
  let resolveNext!: () => void;
  const next = new Promise<void>((resolve) => { resolveNext = resolve; });
  narrativeMutexes.set(runId, next);
  return prev.then(fn).finally(() => {
    resolveNext();
    if (narrativeMutexes.get(runId) === next) {
      narrativeMutexes.delete(runId);
    }
  });
}

export interface ReleaseNarrativeResult {
  narrative: ReleaseNarrative | null;
  verdictAtCompletion?: string;
}

export class ReleaseNarrativeService {
  /**
   * Returns the cached narrative if one exists, generates one if the run is
   * terminal + the feature is enabled + nothing is cached yet, or returns
   * `{ narrative: null }` otherwise (disabled, non-terminal, or generation
   * failed — never throws, the report ships verdict-only on any failure).
   */
  static async getOrGenerate(run: any, verdict: ReleaseVerdict, bugs: EnrichedBug[], healthSummary: HealthSummary | undefined, summary: RunReportSummary, userId: string | null): Promise<ReleaseNarrativeResult> {
    if (run.release_narrative) {
      return {
        narrative: {
          ...(run.release_narrative as Omit<ReleaseNarrative, 'generatedAt'>),
          generatedAt: run.release_narrative_generated_at,
        },
        verdictAtCompletion: run.release_verdict_at_completion ?? undefined,
      };
    }

    if (!TERMINAL_STATUSES.has(run.status)) return { narrative: null };
    if (!ReleaseNarrativeFeature.isEnabled()) return { narrative: null };
    if (!userId) return { narrative: null };

    return withRunMutex(run.id, async () => {
      // Re-check inside the mutex — a concurrent fetch (e.g. dashboard +
      // public share link opened together) may have already generated the
      // narrative while this caller was waiting on the lock.
      const fresh = await getRunNarrativeFields(run.id);
      if (fresh?.release_narrative) {
        return {
          narrative: {
            ...(fresh.release_narrative as Omit<ReleaseNarrative, 'generatedAt'>),
            generatedAt: fresh.release_narrative_generated_at as string,
          },
        };
      }

      try {
        return await ReleaseNarrativeService.generate(run, verdict, bugs, healthSummary, summary, userId);
      } catch (error) {
        logger.warn('[RELEASE_NARRATIVE] Generation failed — report ships verdict-only', {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { narrative: null };
      }
    });
  }

  private static async generate(run: any, verdict: ReleaseVerdict, bugs: EnrichedBug[], healthSummary: HealthSummary | undefined, summary: RunReportSummary, userId: string): Promise<ReleaseNarrativeResult> {
    const topBugs = [...bugs]
      .sort((a, b) => {
        const rank = (s: string) => (s === 'critical' ? 3 : s === 'high' ? 2 : s === 'medium' ? 1 : 0);
        const bySeverity = rank(b.severity) - rank(a.severity);
        if (bySeverity !== 0) return bySeverity;
        return (b.occurrences || 1) - (a.occurrences || 1);
      })
      .slice(0, 10)
      .map((b) => ({ id: b.id, title: b.title, severity: b.severity, category: b.category, testCaseName: b.testCaseName, occurrences: b.occurrences }));

    const bugCounts: Record<string, number> = {};
    for (const b of bugs) bugCounts[b.severity] = (bugCounts[b.severity] || 0) + 1;

    const { system, user } = buildReleaseNarrativePrompt({
      verdict: verdict.status,
      verdictReasons: verdict.reasons,
      bugCounts,
      topBugs,
      healthChecks: (healthSummary?.findings ?? []).map((f) => ({ category: f.category, severity: f.severity, message: f.message })),
      stats: {
        totalTests: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
      },
    });

    const response = await getChatCompletionWithMessages(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { model: ReleaseNarrativeFeature.getModel(), response_format: { type: 'json_object' }, temperature: 0 },
    );

    const parsed = JSON.parse(response.content) as { headline: string; prioritizedActions: Array<{ bugId: string; why: string }>; summary: string };

    // Raw model output, logged before the hallucination filter runs — the
    // "what did the AI actually return" visibility, distinct from what
    // ends up persisted after filtering below.
    logger.info('[RELEASE_NARRATIVE] LLM response', {
      runId: run.id,
      verdict: verdict.status,
      raw: parsed,
    });

    // Hallucination guard: drop any bugId the model referenced that isn't in
    // the whitelist it was actually given. Logged, not hard-failed.
    const validIds = new Set(topBugs.map((b) => b.id));
    const prioritizedActions = (parsed.prioritizedActions || []).filter((a) => {
      const ok = validIds.has(a.bugId);
      if (!ok) {
        logger.warn('[RELEASE_NARRATIVE] Dropped hallucinated bugId reference', { runId: run.id, bugId: a.bugId });
      }
      return ok;
    });

    const generatedAt = new Date().toISOString();
    const narrative: ReleaseNarrative = { headline: parsed.headline, prioritizedActions, summary: parsed.summary, generatedAt };

    // Marker + payload written BEFORE the credit deduction — same ordering as
    // ai-analysis.job.ts's bug-report charge, so a retry after a transient
    // post-write failure never double-charges.
    const chargedAt = new Date().toISOString();
    const { error } = await updateRunById(run.id, {
      release_narrative: { headline: narrative.headline, prioritizedActions: narrative.prioritizedActions, summary: narrative.summary },
      release_narrative_generated_at: generatedAt,
      release_narrative_charged_at: chargedAt,
      release_verdict_at_completion: verdict.status,
      release_verdict_ruleset_version: RELEASE_VERDICT_RULESET_VERSION,
    });
    if (error) {
      logger.warn('[RELEASE_NARRATIVE] Failed to persist narrative', { runId: run.id, error });
    }

    try {
      await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: 'intelligent',
        credits: RELEASE_NARRATIVE_CREDITS,
        costUSD: 0,
        testId: run.id,
        description: `Release-readiness narrative for run ${run.id}`,
      });
    } catch (creditError) {
      // Non-fatal — narrative already generated and persisted, mirrors
      // ai-analysis.job.ts's "don't fail the analysis over a credit hiccup".
      logger.warn('[RELEASE_NARRATIVE] Failed to deduct narrative credits', {
        runId: run.id,
        error: creditError instanceof Error ? creditError.message : String(creditError),
      });
    }

    return { narrative, verdictAtCompletion: verdict.status };
  }
}
