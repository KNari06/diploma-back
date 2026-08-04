import { logger } from '@/utils/core/logger';
import { FinalTestReport, JiraIssueRequest, JiraIssue } from '@/types';
import {
  addJiraComment,
  ensureValidToken,
  getJiraToken,
  type AdfDoc,
} from '@/services/api/jira.service';
import {
  buildCodeCommentADF,
  buildDescriptionADF,
  buildFixPromptCommentADF,
} from './jira-report-formatter';
import { uploadReportAttachments, type JiraAuth } from './jira-report-attachments';
import { insertTestJiraIssueLink } from './db/jira-report.db';

/**
 * Files a Jira issue from a completed test report: create the issue, attach the
 * run's artifacts, then add the follow-up comments (generated code, developer
 * fix prompt). Formatting lives in `jira-report-formatter.ts`, uploads in
 * `jira-report-attachments.ts` — this class is orchestration.
 */
export class JiraReportService {
  /**
   * Create a Jira issue from a test report, with attachments and comments.
   * Throws if the issue itself cannot be created; every post-creation step is
   * best-effort (the issue exists, and losing an attachment must not look like
   * a failed filing).
   */
  static async createJiraIssueFromReport(params: JiraIssueRequest): Promise<JiraIssue> {
    const { userId, projectKey, testReport, issueType = 'Bug', priority, testCasePriority, fixPrompt } = params;

    logger.info('[JIRA_REPORT] Creating Jira issue', {
      userId,
      projectKey,
      testId: testReport.testId,
      issueType,
    });

    try {
      const jiraAuth = await this.getJiraAuth(userId);
      if (!jiraAuth) {
        throw new Error('Jira not connected. Please connect your Jira account first.');
      }

      const issuePriority = this.resolvePriority(testReport, priority, testCasePriority);

      const createdIssue = await this.createIssue({
        jiraAuth,
        projectKey,
        issueType,
        priority: issuePriority,
        report: testReport,
      });

      logger.info('[JIRA_REPORT] Issue created successfully', {
        issueKey: createdIssue.key,
        issueId: createdIssue.id,
        testId: testReport.testId,
      });

      await uploadReportAttachments(createdIssue.key, testReport, jiraAuth);

      // Optional-chained on purpose: a `test_reports` row can carry a null
      // `generated_code`, and a throw HERE would skip saveJiraIssueLink below,
      // leaving an issue in Jira that nothing links back to the run while the
      // caller is told the filing failed.
      await this.postComment(createdIssue.key, buildCodeCommentADF(testReport.generatedCode?.code ?? ''), jiraAuth, 'code');

      // The paste-ready fix prompt. Present only when the run found a bug AND
      // DEVELOPER_FIX_PROMPT_ENABLED was on when the run was analysed — absent
      // otherwise, in which case no comment is posted at all.
      await this.postComment(createdIssue.key, buildFixPromptCommentADF(fixPrompt), jiraAuth, 'fix-prompt');

      await this.saveJiraIssueLink(testReport.testId, createdIssue.key, createdIssue.self);

      return createdIssue;
    } catch (error) {
      logger.error('[JIRA_REPORT] Failed to create Jira issue', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        projectKey,
        testId: testReport.testId,
      });
      throw error;
    }
  }

  /** POST the issue itself. Throws on a non-2xx — this is the one step that must succeed. */
  private static async createIssue(input: {
    jiraAuth: JiraAuth;
    projectKey: string;
    issueType: string;
    priority: string;
    report: FinalTestReport;
  }): Promise<JiraIssue> {
    const { jiraAuth, projectKey, issueType, priority, report } = input;

    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${jiraAuth.cloudId}/rest/api/3/issue`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jiraAuth.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            summary: `[QAI Test] ${report.testUrl} - ${report.summary.bugsFound} bugs found`,
            description: buildDescriptionADF(report),
            issuetype: { name: issueType },
            priority: { name: priority },
            labels: [
              'automated-test',
              'qai',
              `severity-${report.analysis.severity}`,
              `status-${report.status}`,
            ],
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jira API error: ${response.status} - ${errorText}`);
    }

    return await response.json() as JiraIssue;
  }

  /**
   * Add one follow-up comment. A null doc means there was nothing to say
   * (no code, no fix prompt) — skip silently. Never throws: the issue is
   * already filed, and a lost comment must not surface as a failed filing.
   */
  private static async postComment(
    issueKey: string,
    body: AdfDoc | null,
    jiraAuth: JiraAuth,
    kind: 'code' | 'fix-prompt',
  ): Promise<void> {
    if (!body) return;

    try {
      await addJiraComment(jiraAuth.accessToken, jiraAuth.cloudId, issueKey, body);
      logger.info('[JIRA_REPORT] Comment added', { issueKey, kind });
    } catch (error) {
      logger.error('[JIRA_REPORT] Failed to add comment', {
        error: error instanceof Error ? error.message : String(error),
        issueKey,
        kind,
      });
    }
  }

  /**
   * Determine the Jira priority via 3-tier precedence:
   *   a) Explicit `priority` from the caller — already a Jira label, wins
   *      (used by the API endpoint when the user manually picked one).
   *   b) `testCasePriority` from the saved intent_test_case row — lets a user
   *      who marks a test as "critical" auto-file Highest-priority issues
   *      without re-setting it per run.
   *   c) AI-derived severity from the test report (legacy behaviour).
   *
   * Why test-case priority sits BETWEEN explicit and severity:
   *   - explicit caller priority is a deliberate per-call decision, usually
   *     from a UI button — must win.
   *   - test-case priority is a per-test-case curator choice that should beat
   *     AI severity (which is per-run and can drift), because curators know
   *     what's actually business-critical.
   *   - severity is the safety net when neither signal is present (ad-hoc /
   *     chat-lite runs with no saved test case).
   */
  private static resolvePriority(
    report: FinalTestReport,
    explicit: JiraIssueRequest['priority'],
    testCasePriority: JiraIssueRequest['testCasePriority'],
  ): string {
    const chosen =
      explicit
      || (testCasePriority ? this.mapTestCasePriorityToJira(testCasePriority) : undefined)
      || this.determinePriority(report.analysis.severity);

    logger.info('[JIRA_REPORT] Priority resolution', {
      testId: report.testId,
      chosen,
      prioritySource: explicit ? 'explicit' : testCasePriority ? 'test_case' : 'severity_fallback',
      testCasePriority,
      severity: report.analysis.severity,
    });

    return chosen;
  }

  /** Get Jira authentication tokens from database */
  private static async getJiraAuth(userId: string): Promise<JiraAuth | null> {
    try {
      const tokenData = await getJiraToken(userId);
      if (!tokenData) {
        logger.warn('[JIRA_REPORT] No Jira tokens found', { userId });
        return null;
      }
      const accessToken = await ensureValidToken(tokenData);
      return {
        accessToken,
        cloudId: tokenData.cloud_id!,
      };
    } catch (error) {
      logger.error('[JIRA_REPORT] Error getting Jira auth', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      return null;
    }
  }

  /** Determine Jira priority from severity */
  private static determinePriority(severity: string): string {
    switch (severity) {
      case 'critical':
        return 'Highest';
      case 'high':
        return 'High';
      case 'medium':
        return 'Medium';
      case 'low':
        return 'Low';
      default:
        return 'Medium';
    }
  }

  /**
   * Map an `intent_test_cases.priority` value to a Jira priority label.
   *
   * Mirrors `determinePriority()` but typed against the test-case enum
   * (no 'none' bucket — test cases either have a priority or undefined /
   * NULL, in which case the caller falls through to severity).
   *
   * Kept as a SEPARATE helper from `determinePriority` so:
   *   - the two input vocabularies stay decoupled (test-case priority is a
   *     curator choice on the saved test; severity is an AI run-time judgment
   *     of the bugs found). If we ever extend one without the other, the
   *     mapping doesn't accidentally drift.
   *   - call sites read clearly: "we're mapping test-case priority" vs
   *     "we're mapping AI severity".
   */
  private static mapTestCasePriorityToJira(
    p: 'critical' | 'high' | 'medium' | 'low',
  ): string {
    switch (p) {
      case 'critical':
        return 'Highest';
      case 'high':
        return 'High';
      case 'medium':
        return 'Medium';
      case 'low':
        return 'Low';
    }
  }

  /** Save Jira issue link to database */
  private static async saveJiraIssueLink(
    testId: string,
    issueKey: string,
    issueUrl: string
  ): Promise<void> {
    try {
      const { error } = await insertTestJiraIssueLink({ testId, issueKey, issueUrl });

      if (error) {
        logger.error('[JIRA_REPORT] Failed to save Jira issue link', { error, testId, issueKey });
      } else {
        logger.info('[JIRA_REPORT] Jira issue link saved', { testId, issueKey });
      }
    } catch (error) {
      logger.error('[JIRA_REPORT] Error saving Jira issue link', {
        error: error instanceof Error ? error.message : String(error),
        testId,
      });
    }
  }
}
