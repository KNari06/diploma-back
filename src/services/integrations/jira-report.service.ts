import { logger } from '@/utils/core/logger';
import { FinalTestReport, JiraIssueRequest, JiraIssue, JiraAttachment } from '@/types';
import { supabaseAdmin } from '@/db/supabase';
import { downloadFromStorage } from '@/services/storage/test-artifacts-storage.service';
import { getJiraToken, ensureValidToken } from '@/services/api/jira.service';

/**
 * Service for creating Jira issues from test reports
 */
export class JiraReportService {
  /**
   * Create Jira issue from test report with full details and attachments
   */
  static async createJiraIssueFromReport(params: JiraIssueRequest): Promise<JiraIssue> {
    const { userId, projectKey, testReport, issueType = 'Bug', priority } = params;

    logger.info('[JIRA_REPORT] Creating Jira issue', {
      userId,
      projectKey,
      testId: testReport.testId,
      issueType,
    });

    try {
      // 1. Get Jira credentials
      const jiraAuth = await this.getJiraAuth(userId);
      if (!jiraAuth) {
        throw new Error('Jira not connected. Please connect your Jira account first.');
      }

      // 2. Format description with all test details
      const description = this.formatJiraDescription(testReport);

      // 3. Determine priority if not specified
      const issuePriority = priority || this.determinePriority(testReport.analysis.severity);

      // 4. Create Jira issue
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
              summary: `[QAI Test] ${testReport.testUrl} - ${testReport.summary.bugsFound} bugs found`,
              description: this.formatDescriptionADF(description, testReport),
              issuetype: { name: issueType },
              priority: { name: issuePriority },
              labels: [
                'automated-test',
                'qai',
                `severity-${testReport.analysis.severity}`,
                `status-${testReport.status}`,
              ],
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Jira API error: ${response.status} - ${errorText}`);
      }

      const createdIssue = await response.json() as JiraIssue;

      logger.info('[JIRA_REPORT] Issue created successfully', {
        issueKey: createdIssue.key,
        issueId: createdIssue.id,
        testId: testReport.testId,
      });

      // 5. Upload attachments (video, trace, screenshots) in parallel
      await this.uploadAttachments(createdIssue.key, testReport, jiraAuth);

      // 6. Add generated code as comment
      await this.addCodeComment(createdIssue.key, testReport.generatedCode.code, jiraAuth);

      // 7. Save Jira issue link to database
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

  /**
   * Format Jira description with full test details (plain text version)
   */
  private static formatJiraDescription(report: FinalTestReport): string {
    const duration = (report.duration / 1000).toFixed(2);

    return `
🤖 *Automated Test Report*

📊 *Test Summary*
• Test ID: ${report.testId}
• URL: ${report.testUrl}
• Status: ${report.status.toUpperCase()}
• Duration: ${duration}s
• Executed: ${new Date(report.executedAt).toLocaleString()}

📋 *Test Steps*
• Total: ${report.summary.totalSteps} steps
• ✅ Passed: ${report.summary.passedSteps}
• ❌ Failed: ${report.summary.failedSteps}

🐛 *Bugs Found: ${report.summary.bugsFound}*
${report.summary.criticalBugs > 0 ? `🔴 Critical: ${report.summary.criticalBugs}` : ''}

📝 *Detailed Findings*
${report.analysis.bugs.map((bug, i) => `
${i + 1}. [${bug.severity.toUpperCase()}] ${bug.message}
   • Type: ${bug.type}
   ${bug.selector ? `• Selector: ${bug.selector}` : ''}
   • Fix: ${bug.recommendation}
`).join('\n')}

${report.analysis.recommendations.length > 0 ? `
💡 *Recommendations*
${report.analysis.recommendations.map((rec, i) => `${i + 1}. ${rec}`).join('\n')}
` : ''}

🎬 *Artifacts*
${report.artifacts.video ? `• 📹 Video: Available` : '• 📹 Video: Not recorded'}
${report.artifacts.trace ? `• 📊 Trace: Available` : '• 📊 Trace: Not available'}
• 📸 Screenshots: ${report.artifacts.screenshots.length} attached
• 🌐 Network Logs: ${report.artifacts.networkLogs.length} requests
• 📜 Console Logs: ${report.artifacts.logs.length} entries

🔗 *Links*
• View in QAI: https://app.qai.so/tests/${report.testId}

---
🤖 Generated by QAI - Automated Testing Platform
📊 Confidence: ${(report.analysis.confidence * 100).toFixed(0)}%
    `.trim();
  }

  /**
   * Format description in Atlassian Document Format (ADF)
   */
  private static formatDescriptionADF(plainText: string, report: FinalTestReport): any {
    return {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '🤖 Automated Test Report' }],
        },
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Test ID: ', marks: [{ type: 'strong' }] },
                { type: 'text', text: report.testId },
              ],
            },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'URL: ', marks: [{ type: 'strong' }] },
                { type: 'text', text: report.testUrl },
              ],
            },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Status: ', marks: [{ type: 'strong' }] },
                { type: 'text', text: report.status.toUpperCase() },
              ],
            },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: `🐛 Bugs Found: ${report.summary.bugsFound}` }],
        },
        ...report.analysis.bugs.map((bug, i) => ({
          type: 'panel',
          attrs: { panelType: bug.severity === 'critical' || bug.severity === 'high' ? 'error' : 'warning' },
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: `${i + 1}. `, marks: [{ type: 'strong' }] },
                { type: 'text', text: `[${bug.severity.toUpperCase()}] ${bug.message}` },
              ],
            },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Type: ', marks: [{ type: 'strong' }] },
                        { type: 'text', text: bug.type },
                      ],
                    },
                  ],
                },
                ...(bug.selector
                  ? [
                      {
                        type: 'listItem',
                        content: [
                          {
                            type: 'paragraph',
                            content: [
                              { type: 'text', text: 'Selector: ', marks: [{ type: 'strong' }] },
                              { type: 'text', text: bug.selector, marks: [{ type: 'code' }] },
                            ],
                          },
                        ],
                      },
                    ]
                  : []),
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Fix: ', marks: [{ type: 'strong' }] },
                        { type: 'text', text: bug.recommendation },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        })),
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: '🎬 Artifacts' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `📹 Video: ${report.artifacts.video ? 'Available (see attachments)' : 'Not recorded'}` },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `📊 Trace: ${report.artifacts.trace ? 'Available (see attachments)' : 'Not available'}` },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `📸 Screenshots: ${report.artifacts.screenshots.length} attached` },
          ],
        },
      ],
    };
  }

  /**
   * Upload attachments to Jira issue
   */
  private static async uploadAttachments(
    issueKey: string,
    report: FinalTestReport,
    jiraAuth: any
  ): Promise<void> {
    try {
      logger.info('[JIRA_REPORT] Uploading attachments', {
        issueKey,
        hasVideo: !!report.artifacts.video,
        hasTrace: !!report.artifacts.trace,
        screenshotsCount: report.artifacts.screenshots.length,
      });

      const attachments: JiraAttachment[] = [];

      // Download and prepare video
      if (report.artifacts.video) {
        try {
          const videoBuffer = await downloadFromStorage(report.artifacts.video);
          attachments.push({
            filename: `test-${report.testId}-video.webm`,
            buffer: videoBuffer,
            mimeType: 'video/webm',
          });
        } catch (error) {
          logger.warn('[JIRA_REPORT] Failed to download video', { error });
        }
      }

      // Download and prepare trace
      if (report.artifacts.trace) {
        try {
          const traceBuffer = await downloadFromStorage(report.artifacts.trace);
          attachments.push({
            filename: `test-${report.testId}-trace.zip`,
            buffer: traceBuffer,
            mimeType: 'application/zip',
          });
        } catch (error) { 
          logger.warn('[JIRA_REPORT] Failed to download trace', { error });
        }
      }

      // Prepare screenshots (limit to 5 to avoid too many attachments)
      const screenshotsToAttach = report.artifacts.screenshots.slice(0, 5);
      for (let i = 0; i < screenshotsToAttach.length; i++) {
        const screenshot = screenshotsToAttach[i];
        if (screenshot) {
          try {
            // Check if it's a URL or base64
            let buffer: Buffer;
            if (screenshot.startsWith('http')) {
              buffer = await downloadFromStorage(screenshot);
            } else {
              // Base64
              const base64Data = screenshot.replace(/^data:image\/png;base64,/, '');
              buffer = Buffer.from(base64Data, 'base64');
            }

            attachments.push({
              filename: `screenshot-${i + 1}.png`,
              buffer,
              mimeType: 'image/png',
            });
          } catch (error) {
            logger.warn('[JIRA_REPORT] Failed to process screenshot', { index: i, error });
          }
        }
      }

      // Upload all attachments
      for (const attachment of attachments) {
        try {
          const formData = new FormData();
          const blob = new Blob([attachment.buffer], { type: attachment.mimeType });
          formData.append('file', blob, attachment.filename);

          const response = await fetch(
            `https://api.atlassian.com/ex/jira/${jiraAuth.cloudId}/rest/api/3/issue/${issueKey}/attachments`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${jiraAuth.accessToken}`,
                'X-Atlassian-Token': 'no-check',
              },
              body: formData,
            }
          );

          if (!response.ok) {
            logger.warn('[JIRA_REPORT] Failed to upload attachment', {
              filename: attachment.filename,
              status: response.status,
            });
          } else {
            logger.info('[JIRA_REPORT] Attachment uploaded', {
              filename: attachment.filename,
              issueKey,
            });
          }
        } catch (error) {
          logger.warn('[JIRA_REPORT] Attachment upload error', {
            filename: attachment.filename,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('[JIRA_REPORT] Attachments upload completed', {
        issueKey,
        totalAttempted: attachments.length,
      });
    } catch (error) {
      logger.error('[JIRA_REPORT] Attachments upload failed', {
        error: error instanceof Error ? error.message : String(error),
        issueKey,
      });
      // Don't throw - attachments are nice-to-have
    }
  }

  /**
   * Add generated Playwright code as comment
   */
  private static async addCodeComment(
    issueKey: string,
    code: string,
    jiraAuth: any
  ): Promise<void> {
    try {
      logger.info('[JIRA_REPORT] Adding code comment', { issueKey });

      const response = await fetch(
        `https://api.atlassian.com/ex/jira/${jiraAuth.cloudId}/rest/api/3/issue/${issueKey}/comment`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jiraAuth.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            body: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'heading',
                  attrs: { level: 3 },
                  content: [{ type: 'text', text: '🧪 Generated Playwright Test Code' }],
                },
                {
                  type: 'codeBlock',
                  attrs: { language: 'typescript' },
                  content: [{ type: 'text', text: code }],
                },
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'This code was automatically generated from the test execution. Copy and use it in your test suite.',
                      marks: [{ type: 'em' }],
                    },
                  ],
                },
              ],
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to add comment: ${response.status}`);
      }

      logger.info('[JIRA_REPORT] Code comment added', { issueKey });
    } catch (error) {
      logger.error('[JIRA_REPORT] Failed to add code comment', {
        error: error instanceof Error ? error.message : String(error),
        issueKey,
      });
      // Don't throw - comment is nice-to-have
    }
  }

  /**
   * Get Jira authentication tokens from database
   */
  private static async getJiraAuth(userId: string): Promise<{
    accessToken: string;
    cloudId: string;
  } | null> {
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

  /**
   * Determine Jira priority from severity
   */
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
   * Save Jira issue link to database
   */
  private static async saveJiraIssueLink(
    testId: string,
    issueKey: string,
    issueUrl: string
  ): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('test_jira_issues')
        .insert({
          test_id: testId,
          jira_issue_key: issueKey,
          jira_issue_url: issueUrl,
          created_at: new Date().toISOString(),
        });

      if (error) {
        logger.error('[JIRA_REPORT] Failed to save Jira issue link', {
          error,
          testId,
          issueKey,
        });
      } else {
        logger.info('[JIRA_REPORT] Jira issue link saved', {
          testId,
          issueKey,
        });
      }
    } catch (error) {
      logger.error('[JIRA_REPORT] Error saving Jira issue link', {
        error: error instanceof Error ? error.message : String(error),
        testId,
      });
    }
  }
}
