import { env } from '@/config/environment/env';
import { QueueManager } from '@/config/infrastructure/queues';
import { dbAdminService } from '@/db/supabase';
import { aiService } from '@/services/ai/analysis/test-results.service';
import { AIUsageTracker } from '@/services/ai/tracking/ai-usage-tracker';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TestReportGeneratorService } from '@/services/testing/results/test-report-generator.service';
import { JiraReportService } from '@/services/integrations/jira-report.service';
import { resolveTestCasePriorityForTestId } from '@/services/testing/regression/resolve-test-case-priority.util';
import { handleAIError } from '@/utils/core/error-handler';
import { logAIAnalysis, logger, logQueueEvent } from '@/utils/core/logger';
import {
  AIAnalysisCompletedPayload,
  AIAnalysisStartedPayload,
  AIBugFoundPayload,
} from '@/websocket/types/types';
import { webSocketService } from '@/websocket/core/websocket.service';
import { Job } from 'bullmq';
import { NotificationService } from '@/services/notifications/notification.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { generateEmbeddings } from '@/services/ai/core/embedding.service';

/** Credits charged for generating a bug report when bugs are found */
export const BUG_REPORT_CREDITS = 5;

// Types for better type safety
interface BugSeverity {
  severity: 'critical' | 'high' | 'medium' | 'low';
}

interface ProcessedBug extends BugSeverity {
  message: string;
  location?: string;
}

interface AIAnalysisJobData {
  testResultId?: string;
  /**
   * Backward-compatible alias.
   * Some producers/loggers historically used `resultId`.
   */
  resultId?: string;
  testId: string;
}

export class AIAnalysisJobHandler {
  /**
   * Process AI analysis job
   */
  static async process(job: Job<AIAnalysisJobData>) {
    const testResultId = job.data?.testResultId ?? job.data?.resultId;
    const testId = job.data?.testId;

    // Validate input parameters
    if (!testResultId || !testId) {
      throw new Error('Missing required parameters: testResultId/resultId or testId');
    }

    logger.info(`[AI-ANALYSIS] Processing analysis for test result: ${testResultId}`);
    logQueueEvent('processing', job.id!, { testResultId, testId });

    try {
      // Get test result from database
      const testResult = await this.getTestResult(testResultId);
      if (!testResult) {
        throw new Error(`Test result not found: ${testResultId}`);
      }

      // Emit WebSocket: AI analysis started (non-fatal — WS failure must not kill analysis)
      try {
        const analysisStartedPayload: AIAnalysisStartedPayload = {
          testId,
          resultId: testResultId,
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitAIAnalysisStarted(testId, analysisStartedPayload);
      } catch (wsError) {
        logger.warn('[AI-ANALYSIS] WebSocket emit failed (analysis started)', {
          testId, error: wsError instanceof Error ? wsError.message : String(wsError),
        });
      }

      // Convert database result to TestResult type
      const testResultData = this.convertToTestResult(testResult);

      // Skip bug detection for NEGATIVE tests. A failed negative means the app
      // rejected bad input as intended OR a non-mutated setup step drifted —
      // neither is an app bug. Running the analyzer here produces false bug
      // reports (e.g. "login endpoint broken") AND charges the user 5 credits
      // for a phantom bug. Bail before the LLM call so we don't pay for it.
      if (await this.isNegativeTest(testId)) {
        logger.info('[AI-ANALYSIS] Skipping bug detection for negative test', {
          testId, testResultId,
        });
        try {
          await dbAdminService.updateTestResult(testResultId, {
            ai_summary: {
              skipped: true,
              skippedReason: 'negative_test',
              summary: 'Bug detection skipped — negative test (a failure here means the app rejected bad input as intended, or a setup step drifted).',
              bugs: [],
            },
          });
        } catch (persistErr) {
          logger.warn('[AI-ANALYSIS] Failed to persist negative-test skip summary', {
            testResultId, error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
        }
        logQueueEvent('completed', job.id!, { testResultId, testId, skipped: 'negative_test' });
        return;
      }

      // Load integration context (non-fatal, best-effort)
      let integrationContext = '';
      try {
        const analysisUserId = testResult?.tests?.user_id;
        const analysisWorkspaceId = (testResult?.tests?.projects as any)?.workspace_id;
        if (analysisUserId) {
          const { IntegrationTokenService } = await import('@/services/api/integration-token.service');
          integrationContext = await IntegrationTokenService.getIntegrationSummary(analysisUserId, analysisWorkspaceId || '');
        }
      } catch { /* non-fatal */ }

      // AI-usage tracking + run correlation. This is the most AI-heavy,
      // hallucination-prone step (bug detection), so its LLM calls must land in
      // ai_usage_log with a run_id — enabling "show every LLM decision for run X".
      // All best-effort: tracking/runId resolution must never break analysis.
      const trackWorkspaceId = (testResult?.tests?.projects as any)?.workspace_id as string | undefined;
      const trackUserId = testResult?.tests?.user_id as string | undefined;
      const runId = await this.resolveRunIdForTest(testId);
      const trackingSessionId =
        trackWorkspaceId ? `analysis-${testResultId}` : null;
      if (trackingSessionId && trackWorkspaceId) {
        AIUsageTracker.beginSession(trackingSessionId, {
          workspaceId: trackWorkspaceId,
          userId: trackUserId,
          testId,
          runId: runId ?? undefined,
          operationType: 'analysis',
        });
      }

      // Perform AI analysis
      const aiSummary = trackingSessionId && trackWorkspaceId
        ? await withAIContext(
            {
              workspaceId: trackWorkspaceId,
              userId: trackUserId,
              testId,
              runId: runId ?? undefined,
              operationType: 'analysis',
            },
            () => aiService.analyzeTestResults(testResultData, {
              integrationContext: integrationContext || undefined,
            }),
          )
        : await aiService.analyzeTestResults(testResultData, {
            integrationContext: integrationContext || undefined,
          });

      if (trackingSessionId) {
        try {
          await AIUsageTracker.endSession(trackingSessionId);
        } catch (e) {
          logger.warn('[AI-ANALYSIS] usage endSession failed (non-fatal)', {
            testResultId, error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Idempotency guard: if a previous job run already charged for the bug
      // report, don't charge again on BullMQ retry. The flag lives inside
      // ai_summary (JSONB) so no schema migration is needed — attempts=2 on
      // this queue otherwise means transient post-deduct failures (WebSocket,
      // Jira push, DB hiccups) re-run the whole handler and re-charge.
      const alreadyCharged = !!(testResult as any)?.ai_summary?.bugReportChargedAt;

      // Emit WebSocket: AI bugs found (one by one, non-fatal)
      if (aiSummary.bugs && aiSummary.bugs.length > 0) {
        const processedBugs = this.processBugsForWebSocket(aiSummary.bugs);

        for (const bug of processedBugs) {
          try {
            const bugFoundPayload: AIBugFoundPayload = {
              testId,
              resultId: testResultId,
              bug,
              timestamp: new Date().toISOString(),
            };
            webSocketService.emitAIBugFound(testId, bugFoundPayload);
          } catch (wsError) {
            logger.warn('[AI-ANALYSIS] WebSocket emit failed (bug found)', {
              testId, error: wsError instanceof Error ? wsError.message : String(wsError),
            });
          }
        }

        // Charge for bug report generation (5 credits) — one-time per test_result.
        const bugReportUserId = testResult?.tests?.user_id;
        if (bugReportUserId && !alreadyCharged) {
          // Persist the charge marker BEFORE deducting. If the deduct succeeds
          // and a later step fails, retry sees the marker and skips. If the
          // deduct itself fails, the marker is still set — but that's the
          // safer failure mode (user is NOT charged on retry either).
          const chargedAt = new Date().toISOString();
          await dbAdminService.updateTestResult(testResultId, {
            ai_summary: { ...aiSummary, bugReportChargedAt: chargedAt, bugReportCredits: BUG_REPORT_CREDITS },
          });

          try {
            await CreditCostTrackerService.deductCreditsForTest({
              userId: bugReportUserId,
              testType: 'intelligent',
              credits: BUG_REPORT_CREDITS,
              costUSD: 0,
              testId: testResultId,
              description: `Bug report: ${processedBugs.length} bug(s) found in test ${testId}`,
            });
            logger.info('[AI-ANALYSIS] Bug report credits deducted', {
              userId: bugReportUserId,
              credits: BUG_REPORT_CREDITS,
              bugsCount: processedBugs.length,
              testResultId,
            });
          } catch (creditError) {
            // Non-fatal — report is already generated, don't fail the analysis
            logger.warn('[AI-ANALYSIS] Failed to deduct bug report credits', {
              userId: bugReportUserId,
              error: creditError instanceof Error ? creditError.message : String(creditError),
              testResultId,
            });
          }
        } else if (alreadyCharged) {
          logger.info('[AI-ANALYSIS] Skipping bug report charge — already charged on prior attempt', {
            testResultId,
            chargedAt: (testResult as any)?.ai_summary?.bugReportChargedAt,
          });
        }
      }

      // Save AI summary to database (after charge — preserve bugReportChargedAt
      // marker if it was set in the block above).
      const finalSummary = alreadyCharged
        ? { ...aiSummary, bugReportChargedAt: (testResult as any).ai_summary.bugReportChargedAt, bugReportCredits: (testResult as any).ai_summary.bugReportCredits ?? BUG_REPORT_CREDITS }
        : aiSummary;
      await dbAdminService.updateTestResult(testResultId, {
        ai_summary: finalSummary,
      });

      // Emit WebSocket: AI analysis completed (non-fatal)
      try {
        const processedBugs = this.processBugsForWebSocket(aiSummary.bugs || []);
        const analysisCompletedPayload: AIAnalysisCompletedPayload = {
          testId,
          resultId: testResultId,
          summary: {
            summary: aiSummary.summary,
            bugs: processedBugs,
            recommendations: aiSummary.recommendations || [],
            confidence: aiSummary.confidence || 0,
            // V14: Step-aware classification
            failureClassification: aiSummary.failureClassification || null,
            rootCauseStep: aiSummary.rootCauseStep ?? null,
            classificationEvidence: aiSummary.classificationEvidence || [],
          },
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitAIAnalysisCompleted(testId, analysisCompletedPayload);
      } catch (wsError) {
        logger.warn('[AI-ANALYSIS] WebSocket emit failed (analysis completed)', {
          testId, error: wsError instanceof Error ? wsError.message : String(wsError),
        });
      }

      // Create in-app notifications for background tests
      await this.createBackgroundAINotifications(testId, testResultId, aiSummary, testResult);

      // Send notifications if critical issues found
      await this.handleCriticalIssues(testId, aiSummary);

      // Pre-fetch project once for integrations (Jira sync + webhook)
      const test = testResult?.tests;
      let project: any = null;
      if (test?.project_id) {
        try { project = await dbAdminService.getProject(test.project_id); } catch { /* non-fatal */ }
      }

      // Send webhook notifications
      await this.sendWebhookNotifications(testId, aiSummary, project);

      // Sync on bug creation: create Jira issue if project has syncOnCreate enabled
      await this.handleSyncOnCreate(testId, testResult, aiSummary, project);

      // Auto-extract bug patterns to workspace memory for agent learning
      await this.extractBugPatterns(testId, testResult, aiSummary);

      // Send feedback to source Jira issue (if triggered from Jira QA orchestrator)
      await this.sendJiraFeedback(testId, testResultId, testResult, aiSummary);

      logger.info(`[AI-ANALYSIS] Analysis completed successfully: ${testResultId}`);
      logAIAnalysis(testId, aiSummary);

    } catch (error) {
      logger.error(`[AI-ANALYSIS] Analysis failed for ${testResultId}:`, error);

      // Mark analysis as failed in database
      await dbAdminService.updateTestResult(testResultId, {
        ai_summary: {
          summary: 'AI analysis failed',
          bugs: [],
          recommendations: ['Manual review required'],
          confidence: 0,
          generatedAt: new Date(),
        },
      });

      throw handleAIError(error);
    }
  }

  /**
   * Process bugs for WebSocket emission with proper type safety
   */
  private static processBugsForWebSocket(bugs: any[]): ProcessedBug[] {
    if (!Array.isArray(bugs)) {
      logger.warn('[AI-ANALYSIS] Invalid bugs format, expected array');
      return [];
    }

    return bugs.map((bug) => {
      // Validate and normalize severity
      const validSeverities: Array<'critical' | 'high' | 'medium' | 'low'> = ['critical', 'high', 'medium', 'low'];
      const severity = validSeverities.includes(bug.severity) ? bug.severity : 'medium';

      return {
        severity,
        message: bug.message || bug.description || 'Unknown issue detected',
        location: bug.location || bug.selector || undefined,
      };
    });
  }

  /**
   * Create in-app notifications for background AI analysis
   * Only called when test has no linked chat sessions (background/CI run)
   */
  private static async createBackgroundAINotifications(
    testId: string,
    testResultId: string,
    aiSummary: any,
    testResult: any
  ): Promise<void> {
    try {
      // Check if test has linked chat sessions
      const chatSessions = await TestChatMappingService.getChatSessionsForTest(testId);
      
      if (chatSessions && chatSessions.length > 0) {
        // Test is linked to chat = live run, don't create in-app notification
        logger.debug('[AI-ANALYSIS] Test has chat sessions, skipping in-app notification', {
          testId,
          chatSessionsCount: chatSessions.length,
        });
        return;
      }

      // Get user_id from test result
      const userId = testResult?.tests?.user_id;
      if (!userId) {
        logger.debug('[AI-ANALYSIS] No user_id, skipping notification', {
          testId,
          testResultId,
        });
        return;
      }

      const bugs = aiSummary?.bugs || [];
      const criticalBugs = bugs.filter((b: any) => b.severity === 'critical');
      const highBugs = bugs.filter((b: any) => b.severity === 'high');
      const rawConfidence = Number(aiSummary?.confidence);
      const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0;
      // Some models return 0..1, others 0..100
      const confidencePct = confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);

      // Create notification for AI report ready.
      // `testId` is `tests.id` — the AI test, NOT a regression run.
      // Action target is `/tests/:testId` (ai-tests view), not
      // `/runs/:runId` (regression-run-report). Pass actionUrl explicitly
      // so the FE doesn't synthesize the wrong URL from metadata.
      await NotificationService.createNotification({
        userId,
        type: 'personal',
        category: 'system',
        title: 'AI analysis completed',
        message: `Analysis found ${bugs.length} issue(s) with ${confidencePct}% confidence`,
        actionUrl: `/tests/${testId}`,
        metadata: {
          testId,
          resultId: testResultId,
          bugsCount: bugs.length,
          criticalCount: criticalBugs.length,
          highCount: highBugs.length,
          confidence: confidencePct,
          rawConfidence: aiSummary?.confidence,
          dedupeKey: `ai:${testResultId}:completed`,
        },
      });

      // Create separate notification for critical bugs if found
      if (criticalBugs.length > 0) {
        const topIssues = criticalBugs.slice(0, 3).map((b: any) => 
          b.message || b.description || 'Unknown issue'
        );

        await NotificationService.createNotification({
          userId,
          type: 'personal',
          category: 'system',
          title: 'Critical issues detected',
          message: `Found ${criticalBugs.length} critical issue(s) in your test`,
          // Same routing rationale as the AI-completed notification above —
          // testId resolves to /tests/:testId (ai-tests view).
          actionUrl: `/tests/${testId}`,
          metadata: {
            testId,
            resultId: testResultId,
            criticalCount: criticalBugs.length,
            topIssues,
            dedupeKey: `ai:${testResultId}:critical`,
          },
        });
      }

      logger.info('[AI-ANALYSIS] Created background AI notifications', {
        testId,
        userId,
        bugsCount: bugs.length,
        criticalCount: criticalBugs.length,
      });

      // Telegram: non-critical analyses that found issues. A 0-bug "all clear"
      // result stays in-app only (not actionable enough for a push notification).
      // Critical bugs are EXCLUDED here — handleCriticalIssues (elsewhere in
      // this job) already sends its own dedicated Telegram message for those,
      // so this would otherwise double-notify the user for the same analysis.
      if (bugs.length > 0 && criticalBugs.length === 0) {
        await this.sendAIAnalysisTelegramNotification(userId, testId, bugs.length, confidencePct);
      }
    } catch (error) {
      logger.error('[AI-ANALYSIS] Failed to create background AI notifications', {
        error: error instanceof Error ? error.message : String(error),
        testId,
        testResultId,
      });
      // Don't throw - notification failure shouldn't break AI analysis
    }
  }

  /**
   * Send Telegram notification for a completed AI analysis that found
   * issues (any severity). Best-effort — logs and swallows on failure.
   */
  private static async sendAIAnalysisTelegramNotification(
    userId: string,
    testId: string,
    bugsCount: number,
    confidencePct: number
  ): Promise<void> {
    try {
      const { getTelegramToken, sendTelegramNotification } = await import('@/utils/notifications/telegram-notify');
      const tokenData = await getTelegramToken(userId);
      if (!tokenData?.external_id) {
        return;
      }

      const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
      await sendTelegramNotification(tokenData, {
        icon: '🤖',
        title: 'AI analysis completed',
        fields: [
          { label: 'Issues found', value: String(bugsCount) },
          { label: 'Confidence', value: `${confidencePct}%` },
        ],
        ctaLabel: 'View AI analysis →',
        ctaUrl: `${frontendUrl}/tests/${testId}`,
      });

      logger.info(`[AI-ANALYSIS] Sent Telegram notification for analysis completion: ${testId}`);
    } catch (error) {
      logger.warn(`[AI-ANALYSIS] Failed to send Telegram notification for analysis completion ${testId}:`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get test result from either the shared `test_results` table (web)
   * or the forked `mobile_test_results` table (mobile). The id is unique
   * within each table but not across them, so we look up sequentially:
   * web first (the common case — most analyses come from manual-test-run),
   * mobile as fallback when the id was minted by mobile-test-run.job.ts.
   *
   * The nested select shape is identical for both tables — both have
   * `test_id` FK → `tests(id)` (shared) and the rest of the fields the
   * analyzer reads (`status`, `errors`, `logs`, `network_logs`, `metadata`,
   * etc.) overlap. Mobile-only columns (`steps_total`, `pass_rate`, etc.)
   * are returned via `*` and ignored by the analyzer if absent on the
   * web shape.
   */
  /**
   * Resolve the regression run id a test belongs to, via test_executions
   * (the table that carries the run_id → testId relationship). Mirrors the
   * lookup in TestCompletionHandlerService. Best-effort: returns null on any
   * miss/error — analysis must run regardless. Standalone/preview tests have
   * no run, so null is the normal case there.
   */
  private static async resolveRunIdForTest(testId: string): Promise<string | null> {
    try {
      const { data } = await dbAdminService.supabaseAdmin
        .from('test_executions')
        .select('run_id')
        .eq('result->>testId', testId)
        .limit(1)
        .maybeSingle();
      return (data as { run_id?: string } | null)?.run_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Whether this test is a generated negative case. `test_executions.is_negative`
   * is set by the regression run service (regression-run.service.ts). A failed
   * negative usually means the app CORRECTLY rejected bad input (or a setup step
   * drifted) — NOT an app bug — so bug detection must be skipped to avoid false
   * bug reports and the 5-credit charge. Fail-open to false (treat as positive)
   * so a lookup error never silently suppresses real bug detection.
   */
  private static async isNegativeTest(testId: string): Promise<boolean> {
    try {
      const { data } = await dbAdminService.supabaseAdmin
        .from('test_executions')
        .select('is_negative')
        .eq('result->>testId', testId)
        .limit(1)
        .maybeSingle();
      return !!(data as { is_negative?: boolean } | null)?.is_negative;
    } catch {
      return false;
    }
  }

  private static async getTestResult(testResultId: string) {
    const SELECT = `
      *,
      tests (
        id,
        url,
        project_id,
        user_id,
        options,
        projects (
          workspace_id
        )
      )
    `;

    try {
      // Try shared (web) table first.
      const web = await dbAdminService.supabaseAdmin
        .from('test_results')
        .select(SELECT)
        .eq('id', testResultId)
        .maybeSingle();

      if (web.error) {
        logger.error(`[AI-ANALYSIS] Database error fetching test result ${testResultId} from test_results:`, web.error);
        // Fall through to mobile lookup — a transient web-table error
        // shouldn't prevent finding a mobile-table row.
      } else if (web.data) {
        return web.data;
      }

      // Fall back to mobile_test_results.
      const mobile = await dbAdminService.supabaseAdmin
        .from('mobile_test_results')
        .select(SELECT)
        .eq('id', testResultId)
        .maybeSingle();

      if (mobile.error) {
        logger.error(`[AI-ANALYSIS] Database error fetching test result ${testResultId} from mobile_test_results:`, mobile.error);
        throw mobile.error;
      }

      if (!mobile.data) {
        logger.warn(`[AI-ANALYSIS] Test result not found in either table: ${testResultId}`);
        return null;
      }

      return mobile.data;
    } catch (error) {
      logger.error(`[AI-ANALYSIS] Failed to get test result ${testResultId}:`, error);
      return null;
    }
  }

  /**
   * Convert database result to TestResult type
   */
  private static convertToTestResult(dbResult: any) {
    // Mobile runs store their rich per-step evidence (device logcat, WebView
    // CDP console/network errors, system alerts, per-step error classification)
    // under metadata.steps[].evidence — NOT in the flat errors/logs/network_logs
    // columns the analyzer reads. Without folding it in, mobile bug detection
    // ran on a screenshot + a generic "element not found" string. Merge that
    // evidence into the SAME channels the analyzer already consumes (errors /
    // logs / networkLogs) so no analyzer or prompt change is needed.
    const mobileEvidence = this.extractMobileEvidence(dbResult);

    return {
      id: dbResult.id,
      testId: dbResult.test_id,
      browser: dbResult.browser,
      status: dbResult.status,
      screenshot: dbResult.screenshot,
      dom: dbResult.dom,
      logs: [...(dbResult.logs || []), ...mobileEvidence.logs],
      networkLogs: [...(dbResult.network_logs || []), ...mobileEvidence.networkLogs],
      errors: [...(dbResult.errors || []), ...mobileEvidence.errors],
      performance: dbResult.performance,
      qualityChecks: dbResult.quality_checks,
      aiSummary: dbResult.ai_summary,
      videoUrl: dbResult.video_url || dbResult.videoUrl,
      traceUrl: dbResult.trace_url || dbResult.traceUrl,
      createdAt: new Date(dbResult.created_at),
      completedAt: dbResult.completed_at ? new Date(dbResult.completed_at) : undefined,
    };
  }

  /**
   * Fold mobile per-step evidence (metadata.steps[].evidence / errorClassification)
   * into the flat error/log/network channels the analyzer reads. No-op for web
   * results (no metadata.platform === 'mobile'). Best-effort — any shape mismatch
   * is swallowed so a malformed step never breaks analysis.
   */
  private static extractMobileEvidence(dbResult: any): {
    errors: string[];
    logs: string[];
    networkLogs: any[];
  } {
    const out = { errors: [] as string[], logs: [] as string[], networkLogs: [] as any[] };
    try {
      const meta = dbResult?.metadata;
      if (!meta || meta.platform !== 'mobile' || !Array.isArray(meta.steps)) return out;

      meta.steps.forEach((step: any, idx: number) => {
        const label = `Step ${idx + 1}${step?.stepId ? ` (${step.stepId})` : ''}`;
        const ev = step?.evidence;

        // Per-step classification is the analyzer's strongest signal: it already
        // names the failure kind (app_crash / anr / network_error / …) with a
        // one-line summary. Surface it as a high-signal error line.
        const cls = step?.errorClassification;
        if (cls?.type && cls.type !== 'unknown') {
          out.errors.push(`${label}: [${cls.type}] ${cls.summary || 'classified failure'}`);
        }

        if (ev) {
          // Device logcat / iOS syslog lines → logs channel.
          if (Array.isArray(ev.logErrors)) {
            for (const line of ev.logErrors) out.logs.push(`${label} device: ${line}`);
          }
          // WebView JS console errors/exceptions → errors channel.
          if (Array.isArray(ev.consoleErrors)) {
            for (const c of ev.consoleErrors) {
              out.errors.push(`${label} console ${c.type}: ${c.message}${c.source ? ` (${c.source}${c.line ? `:${c.line}` : ''})` : ''}`);
            }
          }
          // WebView network failures → networkLogs channel (analyzer truncates).
          if (Array.isArray(ev.networkErrors)) {
            for (const n of ev.networkErrors) {
              out.networkLogs.push({ url: n.url, method: n.method, status: n.status, statusText: n.statusText, error: n.error });
            }
          }
          // On-screen error alert/toast → errors channel.
          if (ev.systemAlert?.isError && ev.systemAlert.text) {
            out.errors.push(`${label} alert: ${ev.systemAlert.text}`);
          }
        }

        // Per-step AI visual issues (text truncation, overlap, contrast, blank
        // screen, …) → high-signal errors channel so the analyzer reasons over
        // them alongside functional failures. Sibling of evidence on the step.
        const visualIssues = step?.visualIssues;
        if (Array.isArray(visualIssues)) {
          for (const v of visualIssues as Array<Record<string, unknown>>) {
            const sev = v.severity === 'critical' ? 'CRITICAL' : 'warning';
            const desc = typeof v.description === 'string' ? v.description : '';
            if (!desc) continue;
            out.errors.push(
              `${label} visual-issue (${sev}) [${v.type ?? 'other'}]: ${desc}` +
              (typeof v.location === 'string' && v.location ? ` @ ${v.location}` : ''),
            );
          }
        }
      });
    } catch (err) {
      logger.debug('[AI-ANALYSIS] extractMobileEvidence failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return out;
  }

  /**
   * Handle sync on bug creation: create Jira issue when project has syncOnCreate enabled
   */
  private static async handleSyncOnCreate(
    testId: string,
    dbResult: any,
    aiSummary: any,
    prefetchedProject?: any
  ): Promise<void> {
    try {
      const bugs = aiSummary?.bugs || [];
      if (bugs.length === 0) {
        return;
      }

      const test = dbResult?.tests;
      if (!test?.project_id || !test?.user_id) {
        logger.debug('[AI-ANALYSIS] No project/user for syncOnCreate', { testId });
        return;
      }

      const project = (prefetchedProject ?? await dbAdminService.getProject(test.project_id)) as any;
      if (!project?.settings?.integrations?.jira) {
        logger.debug('[AI-ANALYSIS] No Jira integration settings for project', {
          projectId: test.project_id,
        });
        return;
      }

      const jiraSettings = project.settings.integrations.jira;
      if (!jiraSettings.syncOnCreate || !jiraSettings.projectKey?.trim()) {
        logger.debug('[AI-ANALYSIS] syncOnCreate disabled or projectKey missing', {
          projectId: test.project_id,
        });
        return;
      }

      logger.info('[AI-ANALYSIS] Creating Jira issue (syncOnCreate)', {
        testId,
        projectId: test.project_id,
        projectKey: jiraSettings.projectKey,
        bugsCount: bugs.length,
      });

      const testResultData = this.convertToTestResult(dbResult);
      const aiAnalysisForReport = {
        bugs: (aiSummary.bugs || []).map((b: any) => ({
          severity: b.severity || 'medium',
          type: b.category || 'unknown',
          message: b.description || b.title || b.message || 'No description',
          selector: b.domSelector || b.selector,
          recommendation: b.expectedResult || b.recommendation || 'No recommendation',
        })),
        recommendations: aiSummary.recommendations || [],
        confidence: aiSummary.confidence ?? 0.8,
      };

      const report = await TestReportGeneratorService.generateFinalReport({
        testId,
        testResult: testResultData,
        aiAnalysis: aiAnalysisForReport,
      });

      // Best-effort: pull the saved test_case priority so the Jira issue
      // matches what the curator marked the test as ("critical" test →
      // Highest Jira priority). Helper hides the 2-hop join (tests →
      // test_executions.test_case_id → intent_test_cases.priority) and
      // guarantees fail-open: any DB / schema error returns undefined,
      // never blocks the Jira sync path. Same helper is reused by the
      // Telegram and webhook notification paths below so all three
      // integrations see consistent priority resolution. Static import
      // at top of file — no dynamic-require gymnastics; the helper has
      // no circular deps and module resolution is verified at boot.
      const testCasePriority = await resolveTestCasePriorityForTestId(testId);

      await JiraReportService.createJiraIssueFromReport({
        userId: test.user_id,
        projectKey: jiraSettings.projectKey.trim(),
        testReport: report,
        issueType: 'Bug',
        testCasePriority,
      });

      logger.info('[AI-ANALYSIS] Jira issue created (syncOnCreate)', {
        testId,
        projectKey: jiraSettings.projectKey,
      });
    } catch (error) {
      logger.error('[AI-ANALYSIS] syncOnCreate failed (non-fatal)', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle critical issues found by AI
   */
  private static async handleCriticalIssues(testId: string, aiSummary: any) {
    try {
      const criticalBugs = aiSummary.bugs?.filter((bug: any) => bug.severity === 'critical') || [];

      if (criticalBugs.length === 0) {
        logger.debug(`[AI-ANALYSIS] No critical issues found for test: ${testId}`);
        return;
      }

      logger.info(`[AI-ANALYSIS] Found ${criticalBugs.length} critical issues for test: ${testId}`);

      // Get test details
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) {
        logger.warn(`[AI-ANALYSIS] Test not found when handling critical issues: ${testId}`);
        return;
      }

      // Resolve recipient email (tests.user_id is a UUID, not an email)
      let recipient = 'admin@qai.so';
      if (test.user_id) {
        try {
          const user: any = await dbAdminService.getUser(test.user_id);
          if (user?.email && typeof user.email === 'string') {
            recipient = user.email;
          } else {
            logger.warn(`[AI-ANALYSIS] User has no email, sending critical notification to default email: ${testId}`, {
              userId: test.user_id,
            });
          }
        } catch (userError) {
          logger.warn(`[AI-ANALYSIS] Failed to resolve user email, sending critical notification to default email: ${testId}`, {
            userId: test.user_id,
            error: userError instanceof Error ? userError.message : String(userError),
          });
        }
      }

      // Build rich email
      const { EmailService } = await import('@/services/core/email.service');
      const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
      const bugs = criticalBugs.map((bug: any) => ({
        severity: bug.severity || 'critical',
        message: bug.message || bug.description || 'Unknown issue',
        category: bug.category,
      }));
      const email = EmailService.buildCriticalIssuesEmail({
        testId,
        testUrl: test.url || 'Unknown URL',
        bugs,
        dashboardUrl: `${frontendUrl}/tests/${testId}`,
      });

      // Send critical issue notification
      await QueueManager.addNotificationJob({
        type: 'email',
        recipient,
        subject: email.subject,
        message: email.text,
        htmlContent: email.html,
        data: { testId, criticalBugs, aiSummary },
      });

      // Send Slack notification if configured
      const issuesSummary = bugs.map((b: any) => `- ${b.message}`).join('\n');
      await QueueManager.addNotificationJob({
        type: 'slack',
        recipient: '#qa-alerts',
        subject: `Critical Issues: ${test.url || testId}`,
        message: `Critical issues found in test on ${test.url || testId}:\n${issuesSummary}`,
        data: { testId, criticalBugs },
      });

      // Send Telegram notification (if user has it connected)
      if (test.user_id) {
        try {
          const { getTelegramToken, sendTelegramNotification } = await import('@/utils/notifications/telegram-notify');
          const tokenData = await getTelegramToken(test.user_id);
          if (tokenData?.external_id) {
            const testUrl = test.url || 'Unknown URL';
            const dashboardUrl = `${frontendUrl}/tests/${testId}`;

            // Resolve curator-set priority for the saved test case
            // (same helper Jira sync uses, imported statically at top
            // of file). Optional row \u2014 absent for ad-hoc / chat-lite
            // runs and API tests. Capitalised to match the existing
            // "Critical Issues Found" header tone.
            const tcPriority = await resolveTestCasePriorityForTestId(testId);
            const fields = [
              { label: 'URL', value: testUrl },
              ...(tcPriority
                ? [{
                  label: 'Test priority',
                  value: tcPriority.charAt(0).toUpperCase() + tcPriority.slice(1),
                }]
                : []),
            ];

            await sendTelegramNotification(tokenData, {
              icon: '\u26A0\uFE0F',
              title: `${bugs.length} Critical Issue${bugs.length > 1 ? 's' : ''} Found`,
              fields,
              bugs: bugs.slice(0, 5).map((b: any) => ({
                severity: b.severity,
                category: b.category,
                message: b.message,
              })),
              bugsTotal: bugs.length,
              ctaLabel: 'View AI analysis \u2192',
              ctaUrl: dashboardUrl,
            });
            logger.info(`[AI-ANALYSIS] Sent Telegram critical issues notification for test: ${testId}`);
          }
        } catch (tgError) {
          logger.warn(`[AI-ANALYSIS] Failed to send Telegram notification for test ${testId}:`, {
            error: tgError instanceof Error ? tgError.message : String(tgError),
          });
        }
      }

    } catch (error) {
      logger.error(`[AI-ANALYSIS] Failed to handle critical issues for test ${testId}:`, error);
    }
  }

  /**
   * Send webhook notifications
   */
  private static async sendWebhookNotifications(testId: string, aiSummary: any, prefetchedProject?: any) {
    try {
      // Get test details
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) {
        logger.warn(`[AI-ANALYSIS] Test not found for webhook notification: ${testId}`);
        return;
      }

      // Get project settings for webhook configuration
      const project = (prefetchedProject ?? await dbAdminService.getProject(test.project_id)) as any;
      if (!project?.settings?.integrations?.webhook) {
        logger.debug(`[AI-ANALYSIS] No webhook configured for project: ${test.project_id}`);
        return;
      }

      const webhookUrl = project.settings.integrations.webhook;
      logger.info(`[AI-ANALYSIS] Sending webhook notification for test: ${testId}`);

      // ✅ FIX #12: Use actual test status instead of hardcoding 'completed'
      const testStatus = test.status || 'completed';
      const eventName = `test.${testStatus}`; // test.completed, test.failed, test.cancelled

      // Resolve curator-set priority for the saved test case so external
      // integrations (Zapier, n8n, custom routers) can branch on it —
      // e.g. "page on-call when a critical test fails". Helper is
      // imported statically at top of file; it's fail-open and returns
      // undefined for ad-hoc / chat-lite runs and API tests. We forward
      // null in that case so the field shape stays stable across all
      // webhook events.
      const testCasePriority = await resolveTestCasePriorityForTestId(testId);

      // Send webhook notification
      await QueueManager.addWebhookJob({
        url: webhookUrl,
        event: eventName,
        data: {
          testId,
          projectId: test.project_id,
          status: testStatus, // ✅ FIX #12: Use actual status
          // Always present (null when unknown) so downstream routers can
          // rely on `data.priority` existing in the schema.
          priority: testCasePriority ?? null,
          aiSummary,
          timestamp: new Date().toISOString(),
        },
        headers: {
          'Content-Type': 'application/json',
          'X-QAIT-Event': eventName, // ✅ FIX #12: Use actual event name
        },
      });

    } catch (error) {
      logger.error(`[AI-ANALYSIS] Failed to send webhook notifications for test ${testId}:`, error);
    }
  }

  /**
   * Auto-extract bug patterns from AI analysis into intelligent_test_findings.
   * Stored as patterns (not skills) so they appear in the Patterns tab of KB.
   * Non-fatal: if write fails, analysis still completes.
   */
  private static async extractBugPatterns(
    testId: string,
    testResult: any,
    aiSummary: any
  ): Promise<void> {
    try {
      const bugs = aiSummary?.bugs;
      if (!bugs || !Array.isArray(bugs) || bugs.length === 0) return;

      const projectId = testResult?.tests?.project_id;
      if (!projectId) return;

      // Find the intelligent_test_session for this test to link findings
      const { data: session } = await dbAdminService.supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id')
        .eq('test_id', testId)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!session) {
        logger.debug('[AI-ANALYSIS] No intelligent session found for bug pattern extraction', { testId });
        return;
      }

      const findings = bugs.slice(0, 3).map((bug: any) => ({
        session_id: session.id,
        finding_type: 'bug' as const,
        severity: bug.severity || 'medium',
        title: (bug.title || bug.description?.slice(0, 80) || 'Unknown bug').slice(0, 255),
        description: (bug.description || '').slice(0, 2000),
        ai_confidence: aiSummary.confidence || 0.7,
        status: 'new' as const,
      }));

      // Generate embeddings for semantic search (non-fatal)
      let findingsToInsert = findings as Array<(typeof findings)[0] & { embedding?: string | null }>;
      try {
        const embeddingTexts = findings.map(f =>
          [f.title, f.description].filter(Boolean).join(' — ')
        );
        const embeddings = await generateEmbeddings(embeddingTexts);
        findingsToInsert = findings.map((f, i) => ({
          ...f,
          embedding: embeddings[i] ? JSON.stringify(embeddings[i]) : null,
        }));
      } catch (embError) {
        logger.warn('[AI-ANALYSIS] Failed to generate finding embeddings (non-fatal)', {
          testId,
          error: embError instanceof Error ? embError.message : String(embError),
        });
      }

      const { error: insertError } = await dbAdminService.supabaseAdmin
        .from('intelligent_test_findings')
        .insert(findingsToInsert);

      if (insertError) {
        logger.warn('[AI-ANALYSIS] Failed to insert bug pattern findings', {
          testId,
          error: insertError.message,
        });
        return;
      }

      logger.info('[AI-ANALYSIS] Bug patterns extracted to intelligent_test_findings', {
        testId,
        patternsCount: findings.length,
        sessionId: session.id,
      });
    } catch (error) {
      logger.warn('[AI-ANALYSIS] Failed to extract bug patterns (non-fatal)', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send feedback to source Jira issue if test was triggered from Jira QA orchestrator.
   * Non-fatal: errors logged but not thrown.
   */
  private static async sendJiraFeedback(
    testId: string,
    testResultId: string,
    testResult: any,
    aiSummary: any,
  ): Promise<void> {
    try {
      const test = testResult?.tests;
      const metadata = (test as any)?.options?.metadata;
      if (!metadata?.sourceJiraIssueKey || !metadata?.sourceJiraCloudId) return;

      const { JiraFeedbackService } = await import(
        '@/services/integrations/jira-feedback.service'
      );

      const bugs = (aiSummary?.bugs || []).map((b: any) => ({
        severity: b.severity || 'medium',
        title: b.message || b.description || 'Unknown issue',
      }));

      await JiraFeedbackService.sendTestFeedback({
        testId,
        testResultId,
        sourceJiraIssueKey: metadata.sourceJiraIssueKey,
        sourceJiraCloudId: metadata.sourceJiraCloudId,
        userId: test.user_id,
        projectId: test.project_id,
        testPassed: bugs.length === 0,
        bugs,
        summary: aiSummary?.summary || '',
        confidence: aiSummary?.confidence || 0,
        testUrl: test.url,
      });

      logger.info('[AI-ANALYSIS] Jira feedback sent to source issue', {
        testId,
        issueKey: metadata.sourceJiraIssueKey,
        bugsCount: bugs.length,
      });
    } catch (error) {
      logger.warn('[AI-ANALYSIS] Jira feedback failed (non-fatal)', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Notification job handler
 */
export class NotificationJobHandler {
  /**
   * Process notification job
   */
  static async process(job: Job<{
    type: 'email' | 'slack' | 'webhook';
    recipient: string;
    subject: string;
    message: string;
    htmlContent?: string;
    data?: any;
  }>) {
    const { type, recipient, subject, message, htmlContent, data } = job.data;

    logger.info(`Processing notification: ${type} to ${recipient}`);
    logQueueEvent('processing', job.id!, { type, recipient });

    try {
      switch (type) {
        case 'email':
          await this.sendEmailNotification(recipient, subject, message, htmlContent);
          break;
        case 'slack':
          await this.sendSlackNotification(recipient, subject, message);
          break;
        case 'webhook':
          await this.sendWebhookNotification(recipient, subject, data);
          break;
        default:
          throw new Error(`Unknown notification type: ${type}`);
      }

      logger.info(`Notification sent successfully: ${type} to ${recipient}`);

    } catch (error) {
      logger.error(`Notification failed: ${type} to ${recipient}`, error);
      throw error;
    }
  }

  /**
   * Send email notification via SMTP (nodemailer).
   */
  private static async sendEmailNotification(
    recipient: string,
    subject: string,
    message: string,
    htmlContent?: string,
  ) {
    const { EmailService } = await import('@/services/core/email.service');
    const result = await EmailService.sendGenericEmail({
      recipientEmail: recipient,
      subject,
      textContent: message,
      htmlContent,
    });
    if (!result.success) {
      throw new Error(result.error || 'Email send failed');
    }
  }

  /**
   * Send Slack notification via Incoming Webhook.
   * `recipient` is expected to be a Slack Incoming Webhook URL.
   */
  private static async sendSlackNotification(
    recipient: string,
    subject: string,
    message: string
  ) {
    if (!recipient.startsWith('https://hooks.slack.com/')) {
      logger.warn(`[NOTIFICATION] Slack recipient is not a webhook URL, skipping: ${recipient}`);
      return;
    }
    const response = await fetch(recipient, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${subject}*\n${message}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
    }
    logger.info(`Slack notification sent: ${recipient} - ${subject}`);
  }

  /**
   * Send webhook notification via HTTP POST.
   */
  private static async sendWebhookNotification(
    url: string,
    event: string,
    data: any
  ) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
    logger.info(`Webhook notification sent: ${url} - ${event}`);
  }
}

/**
 * Webhook job handler
 *
 * Sends outbound HTTP POST to external webhook URLs.
 * Used for CI/CD callbacks and event notifications.
 * Retries are handled by BullMQ (3 attempts, exponential backoff).
 */
export class WebhookJobHandler {
  /** Timeout for outbound webhook requests (10s) */
  private static readonly TIMEOUT_MS = 10_000;

  /**
   * CI/CD events that should always be delivered.
   * Legacy events (test.completed, etc.) remain log-only until explicitly enabled
   * to avoid surprising existing projects that had a webhook URL configured
   * when the handler was a no-op stub.
   */
  private static readonly LIVE_EVENT_PREFIXES = ['mobile_ci_run.'];

  /**
   * Process webhook job — sends HTTP POST to the target URL.
   */
  static async process(job: Job<{
    url: string;
    event: string;
    data: any;
    headers?: Record<string, string>;
  }>) {
    const { url, event, data, headers: customHeaders } = job.data;

    logger.info('[WEBHOOK] Processing outbound webhook', {
      jobId: job.id,
      event,
      url,
      attempt: job.attemptsMade + 1,
    });
    logQueueEvent('processing', job.id!, { event, url });

    // Guard: only CI/CD events are delivered for now.
    // Legacy events (test.completed, bug.found, etc.) stay log-only
    // to avoid breaking production for projects that set a webhook URL
    // when the handler was a stub. Remove this guard when ready to go live.
    const isLiveEvent = this.LIVE_EVENT_PREFIXES.some((p) => event.startsWith(p));
    if (!isLiveEvent) {
      logger.info('[WEBHOOK] Legacy event — log only (not delivered)', {
        jobId: job.id,
        event,
        url,
      });
      return;
    }

    try {
      const body = JSON.stringify(data);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'QAIT-Webhook/1.0',
        'X-QAIT-Event': event,
        ...customHeaders,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const responseBody = await response.text().catch(() => '');
          const errorMsg = `Webhook returned ${response.status}: ${responseBody.slice(0, 200)}`;

          logger.warn('[WEBHOOK] Non-OK response', {
            jobId: job.id,
            event,
            url,
            status: response.status,
            responseBody: responseBody.slice(0, 200),
          });

          // Throw to trigger BullMQ retry for 5xx errors
          if (response.status >= 500) {
            throw new Error(errorMsg);
          }

          // 4xx errors — log but don't retry (client error)
          logger.error('[WEBHOOK] Client error (no retry)', {
            jobId: job.id,
            event,
            url,
            status: response.status,
          });
          return;
        }

        logger.info('[WEBHOOK] Webhook delivered successfully', {
          jobId: job.id,
          event,
          url,
          status: response.status,
        });
      } catch (fetchError) {
        clearTimeout(timer);

        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') {
          throw new Error(`Webhook timed out after ${this.TIMEOUT_MS}ms: ${url}`);
        }

        throw fetchError;
      }
    } catch (error) {
      logger.error('[WEBHOOK] Webhook delivery failed', {
        jobId: job.id,
        event,
        url,
        attempt: job.attemptsMade + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // Re-throw for BullMQ retry
    }
  }
}
