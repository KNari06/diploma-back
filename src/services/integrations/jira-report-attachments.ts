/**
 * Attachment upload for Jira issues filed from a test report.
 *
 * Downloads the run's artifacts (video, trace, screenshots) and pushes them to
 * the issue. Entirely best-effort: attachments are nice-to-have, so every
 * failure is logged and swallowed — the issue itself already exists by the
 * time this runs.
 */

import { logger } from '@/utils/core/logger';
import { downloadFromStorage } from '@/services/storage/test-artifacts-storage.service';
import type { FinalTestReport, JiraAttachment } from '@/types';

/** Jira gets noisy past a handful of images; the rest stay in the run report. */
const MAX_SCREENSHOTS = 5;

export interface JiraAuth {
  accessToken: string;
  cloudId: string;
}

/** Upload video + trace + screenshots to an existing issue. Never throws. */
export async function uploadReportAttachments(
  issueKey: string,
  report: FinalTestReport,
  jiraAuth: JiraAuth,
): Promise<void> {
  try {
    logger.info('[JIRA_REPORT] Uploading attachments', {
      issueKey,
      hasVideo: !!report.artifacts.video,
      hasTrace: !!report.artifacts.trace,
      screenshotsCount: report.artifacts.screenshots.length,
    });

    const attachments = await collectAttachments(report);

    for (const attachment of attachments) {
      await uploadOne(issueKey, attachment, jiraAuth);
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
  }
}

/** Download and buffer every artifact worth attaching. Skips what it can't fetch. */
async function collectAttachments(report: FinalTestReport): Promise<JiraAttachment[]> {
  const attachments: JiraAttachment[] = [];

  if (report.artifacts.video) {
    try {
      attachments.push({
        filename: `test-${report.testId}-video.webm`,
        buffer: await downloadFromStorage(report.artifacts.video),
        mimeType: 'video/webm',
      });
    } catch (error) {
      logger.warn('[JIRA_REPORT] Failed to download video', { error });
    }
  }

  if (report.artifacts.trace) {
    try {
      attachments.push({
        filename: `test-${report.testId}-trace.zip`,
        buffer: await downloadFromStorage(report.artifacts.trace),
        mimeType: 'application/zip',
      });
    } catch (error) {
      logger.warn('[JIRA_REPORT] Failed to download trace', { error });
    }
  }

  const screenshots = report.artifacts.screenshots.slice(0, MAX_SCREENSHOTS);
  for (let i = 0; i < screenshots.length; i++) {
    const screenshot = screenshots[i];
    if (!screenshot) continue;
    try {
      attachments.push(await toScreenshotAttachment(screenshot, i));
    } catch (error) {
      logger.warn('[JIRA_REPORT] Failed to process screenshot', { index: i, error });
    }
  }

  return attachments;
}

/** A screenshot is either a storage URL or a raw/data-URI base64 payload. */
async function toScreenshotAttachment(screenshot: string, index: number): Promise<JiraAttachment> {
  const isJpeg = screenshot.startsWith('data:image/jpeg') || screenshot.startsWith('/9j/');

  const buffer = screenshot.startsWith('http')
    ? await downloadFromStorage(screenshot)
    : Buffer.from(screenshot.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');

  return {
    filename: `screenshot-${index + 1}.${isJpeg ? 'jpg' : 'png'}`,
    buffer,
    mimeType: isJpeg ? 'image/jpeg' : 'image/png',
  };
}

async function uploadOne(
  issueKey: string,
  attachment: JiraAttachment,
  jiraAuth: JiraAuth,
): Promise<void> {
  try {
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([attachment.buffer], { type: attachment.mimeType }),
      attachment.filename,
    );

    const response = await fetch(
      `https://api.atlassian.com/ex/jira/${jiraAuth.cloudId}/rest/api/3/issue/${issueKey}/attachments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jiraAuth.accessToken}`,
          'X-Atlassian-Token': 'no-check',
        },
        body: formData,
      },
    );

    if (!response.ok) {
      logger.warn('[JIRA_REPORT] Failed to upload attachment', {
        filename: attachment.filename,
        status: response.status,
      });
      return;
    }

    logger.info('[JIRA_REPORT] Attachment uploaded', { filename: attachment.filename, issueKey });
  } catch (error) {
    logger.warn('[JIRA_REPORT] Attachment upload error', {
      filename: attachment.filename,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
