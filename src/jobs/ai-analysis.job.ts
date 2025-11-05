import { Job } from 'bullmq';
import { logger, logQueueEvent, logAIAnalysis } from '@/utils/logger';
import { handleAIError } from '@/utils/error-handler';
import { aiService } from '@/services/ai.service';
import { dbAdminService } from '@/db/supabase';
import { QueueManager } from '@/config/queues';
import { webSocketService } from '@/websocket/websocket.service';
import {
  AIAnalysisStartedPayload,
  AIAnalysisCompletedPayload,
  AIBugFoundPayload,
} from '@/websocket/types';

export class AIAnalysisJobHandler {
  /**
   * Process AI analysis job
   */
  static async process(job: Job<{ testResultId: string; testId: string }>) {
    const { testResultId, testId } = job.data;

    logger.info(`Processing AI analysis: ${testResultId}`);
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
        for (const bug of aiSummary.bugs) {
          const bugFoundPayload: AIBugFoundPayload = {
            testId,
            resultId: testResultId,
            bug: {
              severity: bug.severity as 'critical' | 'high' | 'medium' | 'low',
              message: (bug as any).message || bug.description,
              location: (bug as any).location || (bug as any).selector,
            },
            timestamp: new Date().toISOString(),
          };
          webSocketService.emitAIBugFound(testId, bugFoundPayload);
        }
      }

      // Emit WebSocket: AI analysis completed
      const analysisCompletedPayload: AIAnalysisCompletedPayload = {
        testId,
        resultId: testResultId,
        summary: {
          summary: aiSummary.summary,
          bugs: aiSummary.bugs.map((bug: any) => ({
            severity: bug.severity as 'critical' | 'high' | 'medium' | 'low',
            message: bug.message || bug.description,
            location: bug.location || bug.selector,
          })),
          recommendations: aiSummary.recommendations,
          confidence: aiSummary.confidence,
        },
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitAIAnalysisCompleted(testId, analysisCompletedPayload);

      // Send notifications if critical issues found
      await this.handleCriticalIssues(testId, aiSummary);

      // Send webhook notifications
      await this.sendWebhookNotifications(testId, aiSummary);

      logger.info(`AI analysis completed: ${testResultId}`);
      logAIAnalysis(testId, aiSummary);

    } catch (error) {
      logger.error(`AI analysis failed: ${testResultId}`, error);

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

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error(`Failed to get test result: ${testResultId}`, error);
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
        return;
      }

      // Get test details
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) return;

      // Send critical issue notification
      await QueueManager.addNotificationJob({
        type: 'email',
        recipient: test.user_id || 'admin@qai.so',
        subject: `🚨 Critical Issues Found: ${testId}`,
        message: `Critical issues detected in test ${testId}:\n\n${criticalBugs.map((bug: any) => `- ${bug.title}: ${bug.description}`).join('\n')}`,
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
      logger.error('Failed to handle critical issues:', error);
    }
  }

  /**
   * Send webhook notifications
   */
  private static async sendWebhookNotifications(testId: string, aiSummary: any) {
    try {
      // Get test details
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) return;

      // Get project settings for webhook configuration
      const project = await dbAdminService.getProject(test.project_id) as any;
      if (!project?.settings?.integrations?.webhook) {
        return;
      }

      const webhookUrl = project.settings.integrations.webhook;

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
          'X-QAI-Event': 'test.completed',
        },
      });

    } catch (error) {
      logger.error('Failed to send webhook notifications:', error);
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
