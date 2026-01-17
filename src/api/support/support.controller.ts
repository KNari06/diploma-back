import { QueueManager } from '@/config/infrastructure/queues';
import { UserReportService } from '@/services/core/user-report.service';
import { handleValidationError } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { submitReportSchema } from './support.schemas';

/**
 * POST /api/v1/support/report
 * Submit a user report (bug, UI issue, feature request)
 */
export const submitReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    // Check authentication
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate request body
    const validationResult = submitReportSchema.safeParse(req.body);

    if (!validationResult.success) {
      const firstError = validationResult.error.errors[0];
      res.status(400).json({
        success: false,
        error: 'Validation error',
        message: firstError.message,
        field: firstError.path.join('.'),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const reportData = validationResult.data;

    logger.info('[SUPPORT] Creating user report', {
      userId,
      category: reportData.category,
      title: reportData.title.substring(0, 50),
    });

    // Create report
    const report = await UserReportService.createReport(userId, {
      title: reportData.title,
      category: reportData.category,
      details: reportData.details,
      workspace_name: reportData.workspace_name,
      view: reportData.view,
    });

    // Send response immediately
    res.status(201).json({
      success: true,
      id: report.id,
      status: report.status,
      message: 'Report submitted successfully',
      timestamp: new Date().toISOString(),
    });

    // Send email notifications to admins (async, non-blocking)
    // Use setImmediate to ensure response is sent first
    setImmediate(async () => {
      try {
        logger.debug('[SUPPORT] Sending admin notifications for report', {
          reportId: report.id,
        });

        const adminEmails = await UserReportService.getAdminEmails();

        if (adminEmails.length === 0) {
          logger.warn('[SUPPORT] No admin emails found, skipping notification', {
            reportId: report.id,
          });
          return;
        }

        // Get user email for context
        const userEmail = req.user?.email || 'Unknown';

        // Send notification to each admin
        for (const adminEmail of adminEmails) {
          try {
            await QueueManager.addNotificationJob({
              type: 'email',
              recipient: adminEmail,
              subject: `New User Report: ${report.title}`,
              message: `
New user report submitted:

Title: ${report.title}
Category: ${report.category}
Status: ${report.status}
User: ${userEmail} (${userId})
${reportData.workspace_name ? `Workspace: ${reportData.workspace_name}` : ''}
${reportData.view ? `View: ${reportData.view}` : ''}

Details:
${report.details}

Report ID: ${report.id}
Submitted at: ${report.created_at}
              `.trim(),
              data: {
                reportId: report.id,
                userId,
                category: report.category,
                title: report.title,
              },
            });

            logger.debug('[SUPPORT] Notification queued for admin', {
              adminEmail,
              reportId: report.id,
            });
          } catch (notifError) {
            logger.error('[SUPPORT] Failed to queue notification for admin', {
              error: notifError instanceof Error ? notifError.message : String(notifError),
              adminEmail,
              reportId: report.id,
            });
            // Continue to next admin even if one fails
          }
        }

        logger.info('[SUPPORT] Admin notifications queued successfully', {
          reportId: report.id,
          adminCount: adminEmails.length,
        });
      } catch (error) {
        // Log error but don't throw - notifications are optional
        logger.error('[SUPPORT] Error sending admin notifications', {
          error: error instanceof Error ? error.message : String(error),
          reportId: report.id,
        });
      }
    });
  } catch (error) {
    logger.error('[SUPPORT] Error submitting report', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.user?.id,
    });

    if (res.headersSent) {
      logger.warn('[SUPPORT] Response already sent, cannot send error response');
      return;
    }

    const errorMessage = error instanceof Error ? error.message : 'Failed to submit report';

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/support/reports
 * Get user's own reports
 */
export const getUserReports = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Parse pagination params
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    logger.debug('[SUPPORT] Getting user reports', { userId, limit, offset });

    const { reports, total } = await UserReportService.getUserReports(userId, limit, offset);

    res.json({
      success: true,
      data: reports,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[SUPPORT] Error getting user reports', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to get reports',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/support/reports/:id
 * Get a specific report by ID
 */
export const getReportById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const reportId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!reportId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Report ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.debug('[SUPPORT] Getting report by ID', { userId, reportId });

    const report = await UserReportService.getReportById(reportId, userId);

    if (!report) {
      res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'Report not found',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: report,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[SUPPORT] Error getting report by ID', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.user?.id,
      reportId: req.params.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to get report',
      timestamp: new Date().toISOString(),
    });
  }
};
