import { QueueManager } from '@/config/queues';
import { dbAdminService } from '@/db/supabase';
import { aiService } from '@/services/ai/ai.service';
import { handleAIError } from '@/utils/error-handler';
import { logAIAnalysis, logger, logQueueEvent } from '@/utils/logger';
import {
  AIAnalysisCompletedPayload,
  AIAnalysisStartedPayload,
  AIBugFoundPayload,
} from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';
import { Job } from 'bullmq';

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

      // Emit WebSocket: AI analysis started
      const analysisStartedPayload: AIAnalysisStartedPayload = {
        testId,
        resultId: testResultId,
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitAIAnalysisStarted(testId, analysisStartedPayload);

      // Convert database result to TestResult type
      const testResultData = this.convertToTestResult(testResult);

      // Perform AI analysis
      const aiSummary = await aiService.analyzeTestResults(testResultData);

      // Save AI summary to database
      await dbAdminService.updateTestResult(testResultId, {
        ai_summary: aiSummary,
      });

      // Emit WebSocket: AI bugs found (one by one)
      if (aiSummary.bugs && aiSummary.bugs.length > 0) {
        const processedBugs = this.processBugsForWebSocket(aiSummary.bugs);

        for (const bug of processedBugs) {
          const bugFoundPayload: AIBugFoundPayload = {
            testId,
            resultId: testResultId,
            bug,
            timestamp: new Date().toISOString(),
          };
          webSocketService.emitAIBugFound(testId, bugFoundPayload);
        }
      }

      // Emit WebSocket: AI analysis completed
      const processedBugs = this.processBugsForWebSocket(aiSummary.bugs || []);
      const analysisCompletedPayload: AIAnalysisCompletedPayload = {
        testId,
        resultId: testResultId,
        summary: {
          summary: aiSummary.summary,
          bugs: processedBugs,
          recommendations: aiSummary.recommendations || [],
          confidence: aiSummary.confidence || 0,
        },
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitAIAnalysisCompleted(testId, analysisCompletedPayload);

      // Send notifications if critical issues found
      await this.handleCriticalIssues(testId, aiSummary);

      // Send webhook notifications
      await this.sendWebhookNotifications(testId, aiSummary);

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
          severity: 'medium',
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
            user_id
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
      aiSummary: dbResult.ai_summary,
      createdAt: new Date(dbResult.created_at),
      completedAt: dbResult.completed_at ? new Date(dbResult.completed_at) : undefined,
    };
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
  private static async sendWebhookNotifications(testId: string, aiSummary: any) {
    try {
      // Get test details
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) {
        logger.warn(`[AI-ANALYSIS] Test not found for webhook notification: ${testId}`);
        return;
      }

      // Get project settings for webhook configuration
      const project = await dbAdminService.getProject(test.project_id) as any;
      if (!project?.settings?.integrations?.webhook) {
        logger.debug(`[AI-ANALYSIS] No webhook configured for project: ${test.project_id}`);
        return;
      }

      const webhookUrl = project.settings.integrations.webhook;
      logger.info(`[AI-ANALYSIS] Sending webhook notification for test: ${testId}`);

      // Send webhook notification
      await QueueManager.addWebhookJob({
        url: webhookUrl,
        event: 'test.completed',
        data: {
          testId,
          projectId: test.project_id,
          status: 'completed',
          aiSummary,
          timestamp: new Date().toISOString(),
        },
        headers: {
          'Content-Type': 'application/json',
          'X-QAIT-Event': 'test.completed',
        },
      });

    } catch (error) {
      logger.error(`[AI-ANALYSIS] Failed to send webhook notifications for test ${testId}:`, error);
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
 */
export class WebhookJobHandler {
  /**
   * Process webhook job
   */
  static async process(job: Job<{
    url: string;
    event: string;
    data: any;
    headers?: Record<string, string>;
  }>) {
    const { url, event, data } = job.data;

    logger.info(`Processing webhook: ${event} to ${url}`);
    logQueueEvent('processing', job.id!, { event, url });

    try {
      // In a real implementation, you would make HTTP requests
      // For now, just log the webhook
      logger.info(`Webhook sent: ${event} to ${url}`);
      logger.info(`Data: ${JSON.stringify(data, null, 2)}`);

      // TODO: Implement actual webhook sending with retry logic

    } catch (error) {
      logger.error(`Webhook failed: ${event} to ${url}`, error);
      throw error;
    }
  }
}
