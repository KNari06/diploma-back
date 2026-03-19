/**
 * Email Inbox Controller — V12
 *
 * REST endpoints for email inbox management.
 * Used by frontend editor for address generation and email debugging.
 */

import { Request, Response } from 'express';
import { asyncHandler } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';
import { EmailInboxService } from '@/services/testing/email-inbox/email-inbox.service';

/**
 * POST /api/v1/email-inbox/address
 * Generate a unique inbox address for a test case.
 */
export const generateAddress = asyncHandler(async (req: Request, res: Response) => {
  const { testCaseId } = req.body;

  if (!testCaseId || typeof testCaseId !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'testCaseId is required',
    });
  }

  if (!EmailInboxService.isConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Email inbox not configured. Contact administrator.',
    });
  }

  const address = EmailInboxService.generateAddress(testCaseId);

  logger.info('[EMAIL_INBOX_API] Address generated', {
    testCaseId,
    address,
    userId: (req as any).user?.id,
  });

  return res.json({
    success: true,
    data: { address },
  });
});

/**
 * GET /api/v1/email-inbox/emails
 * List emails received at an address (for debugging in editor).
 */
export const listEmails = asyncHandler(async (req: Request, res: Response) => {
  const { address, since } = req.query;

  if (!address || typeof address !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'address query parameter is required',
    });
  }

  if (!EmailInboxService.isConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Email inbox not configured. Contact administrator.',
    });
  }

  const sinceDate = since ? new Date(since as string) : undefined;
  const emails = await EmailInboxService.listEmails(address, sinceDate);

  return res.json({
    success: true,
    data: {
      emails: emails.map(e => ({
        uid: e.uid,
        from: e.from,
        to: e.to,
        subject: e.subject,
        date: e.date.toISOString(),
        // Don't expose full body in API — just a preview
        bodyPreview: (e.textBody || e.htmlBody || '').substring(0, 200),
      })),
      count: emails.length,
    },
  });
});

/**
 * GET /api/v1/email-inbox/status
 * Check if email inbox is configured and available.
 */
export const getStatus = asyncHandler(async (_req: Request, res: Response) => {
  return res.json({
    success: true,
    data: {
      configured: EmailInboxService.isConfigured(),
      domain: process.env.IMAP_USER?.split('@')[1] || null,
    },
  });
});
