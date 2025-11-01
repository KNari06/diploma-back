import { Job } from 'bullmq';
import { logger, logQueueEvent, logAgentCommunication } from '@/utils/logger';
import { handleAgentError, shouldRetry, calculateRetryDelay } from '@/utils/error-handler';
import { TestJobData, AgentResponse } from '@/types';
import { dbAdminService } from '@/db/supabase';
import { QueueManager } from '@/config/queues';
import { env } from '@/config/env';
import axios from 'axios';

export class ManualTestRunJobHandler {
  /**
   * Process test run job
   */
  static async process(job: Job<TestJobData>) {
    const { testId, url, browser, options, projectId, userId, retryCount = 0 } = job.data;

    logger.info(`Processing test run job: ${testId} (${browser})`);
    logQueueEvent('processing', job.id!, { testId, browser });

    try {
      // Update test status to running
      await dbAdminService.updateTest(testId, {
        status: 'running',
        started_at: new Date().toISOString(),
      });

      // Find available agent
      const agentUrl = await this.findAvailableAgent();
      if (!agentUrl) {
        throw new Error('No available test agents');
      }

      // Send test to agent
      const agentResponse = await this.sendTestToAgent(agentUrl, {
        testId,
        url,
        browser,
        options,
        projectId,
        userId,
      }) as any;

      // Process agent response
      if (agentResponse.success) {
        // Add result processing job
        await QueueManager.addTestResultJob(agentResponse);

        logger.info(`Test sent to agent successfully: ${testId} (${browser})`);
        logAgentCommunication('test_sent', agentUrl, { testId, browser });
      } else {
        throw new Error(agentResponse.error || 'Agent failed to process test');
      }

    } catch (error) {
      logger.error(`Test run job failed: ${testId} (${browser})`, error);

      // Check if we should retry
      if (shouldRetry(error, retryCount, env.AGENT_MAX_RETRIES)) {
        const delay = calculateRetryDelay(retryCount);
        logger.info(`Retrying test run job in ${delay}ms: ${testId} (${browser})`);

        // Update retry count and delay
        await job.updateData({ ...job.data, retryCount: retryCount + 1 });
        throw new Error(`Retry ${retryCount + 1}/${env.AGENT_MAX_RETRIES}: ${(error as Error).message}`);
      }

      // Mark test as failed
      await dbAdminService.updateTest(testId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });

      // Send failure notification
      await this.sendFailureNotification(testId, error);

      throw handleAgentError(error as Error);
    }
  }

  /**
   * Find available test agent
   */
  private static async findAvailableAgent(): Promise<string | null> {
    try {
      // In a real implementation, you would query a service registry
      // or maintain a list of available agents
      const agents = [
        `${env.AGENT_BASE_URL}/agent1`,
        `${env.AGENT_BASE_URL}/agent2`,
        `${env.AGENT_BASE_URL}/agent3`,
      ];

      // Check each agent for availability
      for (const agentUrl of agents) {
        try {
          const response = await axios.get(`${agentUrl}/health`, {
            timeout: 5000,
          });

          if (response.status === 200 && response.data.status === 'healthy') {
            return agentUrl;
          }
        } catch (error) {
          logger.warn(`Agent ${agentUrl} is not available:`, (error as Error).message);
          continue;
        }
      }

      return null;
    } catch (error) {
      logger.error('Failed to find available agent:', error);
      return null;
    }
  }

  /**
   * Send test to agent
   */
  private static async sendTestToAgent(
    agentUrl: string,
    testData: TestJobData
  ): Promise<AgentResponse> {
    try {
      const response = await axios.post(`${agentUrl}/test/run`, testData, {
        timeout: env.AGENT_TIMEOUT,
        headers: {
          'Content-Type': 'application/json',
          'X-QAI-Source': 'backend',
        },
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Agent communication failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Send failure notification
   */
  private static async sendFailureNotification(testId: string, error: any) {
    try {
      // Get test details
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) return;

      // Send notification
      await QueueManager.addNotificationJob({
        type: 'email',
        recipient: test.user_id || 'admin@qai.so',
        subject: `Test Failed: ${testId}`,
        message: `Test ${testId} failed with error: ${(error as Error).message}`,
        data: { testId, error: (error as Error).message },
      });
    } catch (notificationError) {
      logger.error('Failed to send failure notification:', notificationError);
    }
  }
}

/**
 * Test result processing job handler
 */
export class ManualTestResultJobHandler {
  /**
   * Process test result job
   */
  static async process(job: Job<AgentResponse>) {
    const { testId, browser, result, error } = job.data;

    logger.info(`Processing test result: ${testId} (${browser})`);
    logQueueEvent('processing', job.id!, { testId, browser });

    try {
      if (error) {
        throw new Error(error);
      }

      if (!result) {
        throw new Error('No result data received from agent');
      }

      // Save test result to database
      const savedResult = await dbAdminService.createTestResult({
        test_id: testId,
        browser,
        status: result.status || 'completed',
        screenshot: result.screenshot,
        dom: result.dom,
        logs: result.logs || [],
        network_logs: result.networkLogs || [],
        errors: result.errors || [],
        performance: result.performance,
        completed_at: new Date().toISOString(),
      });

      // Add AI analysis job
      await QueueManager.addAIAnalysisJob((savedResult as any).id, testId);

      // Update test status
      await this.updateTestStatus(testId);

      logger.info(`Test result processed successfully: ${testId} (${browser})`);

    } catch (error) {
      logger.error(`Test result processing failed: ${testId} (${browser})`, error);

      // Mark test result as failed
      await dbAdminService.createTestResult({
        test_id: testId,
        browser,
        status: 'failed',
        errors: [{
          type: 'other',
          message: (error as Error).message,
          timestamp: new Date()
        }],
        completed_at: new Date().toISOString(),
      });

      // Update test status
      await this.updateTestStatus(testId);

      throw error;
    }
  }

  /**
   * Update test status based on results
   */
  private static async updateTestStatus(testId: string) {
    try {
      // Get all results for this test
      const results = await dbAdminService.getTestResults(testId) as any[];

      if (results.length === 0) {
        return;
      }

      // Determine overall test status
      const hasFailed = results.some((r: any) => r.status === 'failed');
      const hasRunning = results.some((r: any) => r.status === 'running' || r.status === 'pending');
      const allCompleted = results.every((r: any) => r.status === 'completed' || r.status === 'failed');

      let status: 'running' | 'completed' | 'failed' = 'running';

      if (allCompleted) {
        status = hasFailed ? 'failed' : 'completed';
      }

      // Update test status
      await dbAdminService.updateTest(testId, {
        status,
        completed_at: allCompleted ? new Date().toISOString() : undefined,
      });

      // Send completion notification if all tests are done
      if (allCompleted) {
        await this.sendCompletionNotification(testId, status, results);
      }

    } catch (error) {
      logger.error(`Failed to update test status: ${testId}`, error);
    }
  }

  /**
   * Send completion notification
   */
  private static async sendCompletionNotification(
    testId: string,
    status: string,
    results: any[]
  ) {
    try {
      const test = await dbAdminService.getTest(testId) as any;
      if (!test) return;

      const successCount = results.filter((r: any) => r.status === 'completed').length;
      const totalCount = results.length;

      await QueueManager.addNotificationJob({
        type: 'email',
        recipient: test.user_id || 'admin@qai.so',
        subject: `Test ${status}: ${testId}`,
        message: `Test ${testId} ${status}. ${successCount}/${totalCount} browsers completed successfully.`,
        data: { testId, status, results: results.length },
      });
    } catch (error) {
      logger.error('Failed to send completion notification:', error);
    }
  }
}
