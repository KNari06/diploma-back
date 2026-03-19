import {
  getJiraToken,
  ensureValidToken,
  addJiraComment,
  transitionJiraIssue,
} from '@/services/api/jira.service';
import { dbAdminService } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export interface JiraFeedbackParams {
  testId: string;
  testResultId: string;
  sourceJiraIssueKey: string;
  sourceJiraCloudId: string;
  userId: string;
  projectId: string;
  testPassed: boolean;
  bugs: Array<{ severity: string; title: string }>;
  summary: string;
  confidence: number;
  testUrl?: string;
}

export class JiraFeedbackService {
  /**
   * Send test results feedback to source Jira issue.
   * Non-fatal: all errors logged but not thrown.
   */
  static async sendTestFeedback(params: JiraFeedbackParams): Promise<void> {
    const { sourceJiraIssueKey, sourceJiraCloudId, userId } = params;

    try {
      // 1. Get Jira auth
      const tokenData = await getJiraToken(userId, sourceJiraCloudId);
      if (!tokenData?.cloud_id) {
        logger.warn('[JIRA_FEEDBACK] No Jira token found', { userId, issueKey: sourceJiraIssueKey });
        return;
      }
      const accessToken = await ensureValidToken(tokenData);
      const cloudId = sourceJiraCloudId || tokenData.cloud_id;

      // 2. Post comment with results
      const comment = this.buildFeedbackComment(params);
      await addJiraComment(accessToken, cloudId, sourceJiraIssueKey, comment);

      logger.info('[JIRA_FEEDBACK] Comment posted to source issue', {
        issueKey: sourceJiraIssueKey,
        testId: params.testId,
        testPassed: params.testPassed,
      });

      // 3. Transition issue if configured
      await this.transitionIfConfigured(accessToken, cloudId, params);
    } catch (error) {
      logger.error('[JIRA_FEEDBACK] Failed to send feedback (non-fatal)', {
        issueKey: sourceJiraIssueKey,
        testId: params.testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private static buildFeedbackComment(params: JiraFeedbackParams): string {
    const { testId, testPassed, bugs, summary, confidence, testUrl } = params;

    const criticalCount = bugs.filter(b => b.severity === 'critical').length;
    const highCount = bugs.filter(b => b.severity === 'high').length;

    const statusText = testPassed
      ? '✅ PASSED (no bugs found)'
      : `❌ FAILED (${bugs.length} bug(s) found)`;

    const lines: string[] = [
      `[QAI] Test Results: ${statusText}`,
      '',
    ];

    if (bugs.length > 0) {
      const parts = [`${bugs.length} total`];
      if (criticalCount > 0) parts.push(`${criticalCount} critical`);
      if (highCount > 0) parts.push(`${highCount} high`);
      lines.push(`Bugs: ${parts.join(', ')}`);

      bugs.slice(0, 3).forEach((bug, i) => {
        lines.push(`${i + 1}. [${bug.severity.toUpperCase()}] ${bug.title}`);
      });
      if (bugs.length > 3) lines.push(`  ... and ${bugs.length - 3} more`);
      lines.push('');
    }

    if (summary) {
      lines.push(`Summary: ${summary.slice(0, 300)}`);
      lines.push('');
    }

    const pct = confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);
    lines.push(`Confidence: ${pct}%`);
    lines.push(`Test ID: ${testId}`);
    if (testUrl) lines.push(`URL tested: ${testUrl}`);

    return lines.join('\n');
  }

  private static async transitionIfConfigured(
    accessToken: string,
    cloudId: string,
    params: JiraFeedbackParams,
  ): Promise<void> {
    try {
      const project = await dbAdminService.getProject(params.projectId) as any;
      const jiraSettings = (project?.settings as any)?.integrations?.jira;
      if (!jiraSettings) return;

      const targetStatus = params.testPassed
        ? jiraSettings.doneStatusName
        : jiraSettings.failStatusName;

      if (!targetStatus) {
        logger.debug('[JIRA_FEEDBACK] No transition status configured', {
          issueKey: params.sourceJiraIssueKey,
          testPassed: params.testPassed,
        });
        return;
      }

      await transitionJiraIssue(accessToken, cloudId, params.sourceJiraIssueKey, targetStatus);

      logger.info('[JIRA_FEEDBACK] Source issue transitioned', {
        issueKey: params.sourceJiraIssueKey,
        targetStatus,
        testPassed: params.testPassed,
      });
    } catch (error) {
      logger.warn('[JIRA_FEEDBACK] Transition failed (non-fatal)', {
        issueKey: params.sourceJiraIssueKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
