import { QueueManager } from '@/config/infrastructure/queues';
import { dbAdminService } from '@/db/supabase';
import { aiService } from '@/services/ai/analysis/test-results.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TestReportGeneratorService } from '@/services/testing/results/test-report-generator.service';
import { JiraReportService } from '@/services/integrations/jira-report.service';
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
const BUG_REPORT_CREDITS = 5;

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

      // Perform AI analysis
      const aiSummary = await aiService.analyzeTestResults(testResultData, {
        integrationContext: integrationContext || undefined,
      });

      // Save AI summary to database
      await dbAdminService.updateTestResult(testResultId, {
        ai_summary: aiSummary,
      });

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

        // Charge for bug report generation (5 credits)
        const bugReportUserId = testResult?.tests?.user_id;
        if (bugReportUserId) {
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
        }
      }

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

      // Create notification for AI report ready
      await NotificationService.createNotification({
        userId,
        type: 'personal',
        category: 'system',
        title: 'AI analysis completed',
        message: `Analysis found ${bugs.length} issue(s) with ${confidencePct}% confidence`,
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
   * Get test result from database
   */
  private static async getTestResult(testResultId: string) {
    try {
      const { data, error } = await dbAdminService.supabaseAdmin
        .from('test_results')
        .select(`
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
        `)
        .eq('id', testResultId)
        .single();

      if (error) {
        logger.error(`[AI-ANALYSIS] Database error fetching test result ${testResultId}:`, error);
        throw error;
      }

      if (!data) {
        logger.warn(`[AI-ANALYSIS] Test result not found: ${testResultId}`);
        return null;
      }

      return data;
    } catch (error) {
      logger.error(`[AI-ANALYSIS] Failed to get test result ${testResultId}:`, error);
      return null;
    }
  }

  /**
   * Convert database result to TestResult type
   */
  private static convertToTestResult(dbResult: any) {
    return {
      id: dbResult.id,
      testId: dbResult.test_id,
      browser: dbResult.browser,
      status: dbResult.status,
      screenshot: dbResult.screenshot,
      dom: dbResult.dom,
      logs: dbResult.logs || [],
      networkLogs: dbResult.network_logs || [],
      errors: dbResult.errors || [],
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

      await JiraReportService.createJiraIssueFromReport({
        userId: test.user_id,
        projectKey: jiraSettings.projectKey.trim(),
        testReport: report,
        issueType: 'Bug',
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

      // Prepare critical issues summary
      const issuesSummary = criticalBugs
        .map((bug: any) => `- ${bug.message || bug.description || 'Unknown issue'}`)
        .join('\n');

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

      // Send critical issue notification
      await QueueManager.addNotificationJob({
        type: 'email',
        recipient,
        subject: `🚨 Critical Issues Found: ${testId}`,
        message: `Critical issues detected in test ${testId}:\n${issuesSummary}`,
        data: { testId, criticalBugs, aiSummary },
      });

      // Send Slack notification if configured
      await QueueManager.addNotificationJob({
        type: 'slack',
        recipient: '#qa-alerts',
        subject: `Critical Issues: ${testId}`,
        message: `🚨 Critical issues found in test ${testId}: ${criticalBugs.length} issues detected`,
        data: { testId, criticalBugs },
      });

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

      // Send webhook notification
      await QueueManager.addWebhookJob({
        url: webhookUrl,
        event: eventName,
        data: {
          testId,
          projectId: test.project_id,
          status: testStatus, // ✅ FIX #12: Use actual status
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
    data?: any;
  }>) {
    const { type, recipient, subject, message, data } = job.data;

    logger.info(`Processing notification: ${type} to ${recipient}`);
    logQueueEvent('processing', job.id!, { type, recipient });

    try {
      switch (type) {
        case 'email':
          await this.sendEmailNotification(recipient, subject, message);
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
   * Send email notification
   */
  private static async sendEmailNotification(
    recipient: string,
    subject: string,
    message: string
  ) {
    // In a real implementation, you would integrate with an email service
    // like SendGrid, AWS SES, or similar
    logger.info(`Email notification: ${recipient} - ${subject}`);
    logger.info(`Message: ${message}`);

    // For now, just log the email
    // TODO: Implement actual email sending
  }

  /**
   * Send Slack notification
   */
  private static async sendSlackNotification(
    recipient: string,
    subject: string,
    message: string
  ) {
    // In a real implementation, you would use Slack Web API
    logger.info(`Slack notification: ${recipient} - ${subject}`);
    logger.info(`Message: ${message}`);

    // For now, just log the Slack message
    // TODO: Implement actual Slack integration
  }

  /**
   * Send webhook notification
   */
  private static async sendWebhookNotification(
    url: string,
    event: string,
    data: any
  ) {
    // In a real implementation, you would make HTTP requests to webhook URLs
    logger.info(`Webhook notification: ${url} - ${event}`);
    logger.info(`Data: ${JSON.stringify(data, null, 2)}`);

    // For now, just log the webhook
    // TODO: Implement actual webhook sending
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
