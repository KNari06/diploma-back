import { supabaseAdmin } from '@/db/supabase';
import { FeedbackAnalyticsService } from '@/services/feedback/feedback-analytics.service';
import { FeedbackService } from '@/services/feedback/feedback.service';
import { CreateFeedbackRequest } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create or update feedback for a message
 * POST /api/v1/chat/feedback
 */
export const createFeedback = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { message_id, feedback_type, intent_type, context, session_id } =
      req.body as CreateFeedbackRequest & { session_id?: string };

    logger.info('[FEEDBACK_API] Creating feedback', {
      userId,
      messageId: message_id,
      feedbackType: feedback_type,
    });

    // Validate message_id format (UUID)
    if (!UUID_REGEX.test(message_id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid message ID format',
      });
      return;
    }

    // Determine session_id (from body or from message)
    let sessionId = session_id;

    if (!sessionId) {
      // Get session_id from message if not provided
      const { data: message, error: messageError } = await supabaseAdmin
        .from('chat_messages')
        .select('session_id')
        .eq('id', message_id)
        .maybeSingle();

      if (messageError || !message) {
        logger.warn('[FEEDBACK_API] Message not found', { messageId: message_id, error: messageError });
        res.status(404).json({
          success: false,
          error: 'Message not found',
        });
        return;
      }

      if (message) {
        sessionId = message.session_id;
      }
    }

    // Validate session_id if provided
    if (sessionId && !UUID_REGEX.test(sessionId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid session ID format',
      });
      return;
    }

    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: 'Could not determine session_id for message',
      });
      return;
    }

    const feedback = await FeedbackService.createFeedback(userId, sessionId, {
      message_id,
      feedback_type,
      intent_type,
      context,
    });

    res.status(200).json({
      success: true,
      data: feedback,
      message: 'Feedback saved successfully',
    });
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error creating feedback:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(error.message === 'Unauthorized: Message does not belong to user' ? 403 : 500).json({
      success: false,
      error: error.message || 'Failed to save feedback',
    });
  }
};

/**
 * Get feedback for a specific message
 * GET /api/v1/chat/feedback/:messageId
 */
export const getFeedback = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { messageId } = req.params;

    // Validate messageId format (UUID)
    if (!UUID_REGEX.test(messageId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid message ID format',
      });
      return;
    }

    const feedback = await FeedbackService.getFeedbackForMessage(messageId, userId);

    res.status(200).json({
      success: true,
      data: feedback,
    });
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error getting feedback:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get feedback',
    });
  }
};

/**
 * Delete feedback
 * DELETE /api/v1/chat/feedback/:feedbackId
 */
export const deleteFeedback = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { feedbackId } = req.params;

    // Validate feedbackId format (UUID)
    if (!UUID_REGEX.test(feedbackId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid feedback ID format',
      });
      return;
    }

    const success = await FeedbackService.deleteFeedback(feedbackId, userId);

    if (success) {
      res.status(200).json({
        success: true,
        message: 'Feedback deleted successfully',
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Feedback not found or unauthorized',
      });
    }
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error deleting feedback:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete feedback',
    });
  }
};

/**
 * Get feedback analytics for current user
 * GET /api/v1/chat/feedback/analytics
 */
export const getUserAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 30)); // Limit 1-365 days

    logger.info('[FEEDBACK_API] Getting user analytics', { userId, days });

    const stats = await FeedbackService.getUserFeedbackStats(userId, days);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error getting analytics:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get analytics',
    });
  }
};

/**
 * Get global feedback analytics (admin only)
 * GET /api/v1/chat/feedback/analytics/global
 */
export const getGlobalAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    // TODO: Add admin role check when roles are implemented
    const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 30)); // Limit 1-365 days

    logger.info('[FEEDBACK_API] Getting global analytics', { days });

    const stats = await FeedbackService.getGlobalFeedbackStats(days);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error getting global analytics:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get global analytics',
    });
  }
};

/**
 * Get time-series analytics
 * GET /api/v1/chat/feedback/analytics/timeseries
 */
export const getTimeSeriesAnalytics = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 30)); // Limit 1-365 days

    const analytics = await FeedbackService.getAnalyticsTimeSeries(userId, days);

    res.status(200).json({
      success: true,
      data: analytics,
    });
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error getting time series:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get time series',
    });
  }
};

/**
 * Get top liked/disliked messages for learning (admin)
 * GET /api/v1/chat/feedback/top/:type
 */
export const getTopMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { type } = req.params; // 'like' or 'dislike'
    const intentType = req.query.intent as string | undefined;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit as string) || 50)); // Limit 1-500

    if (type !== 'like' && type !== 'dislike') {
      res.status(400).json({
        success: false,
        error: 'Type must be "like" or "dislike"',
      });
      return;
    }

    const messages = await FeedbackService.getTopFeedbackMessages(
      type,
      intentType,
      limit
    );

    res.status(200).json({
      success: true,
      data: messages,
    });
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error getting top messages:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get top messages',
    });
  }
};

/**
 * Get AI insights and recommendations
 * GET /api/v1/chat/feedback/insights
 */
export const getInsights = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 30)); // Limit 1-365 days
    const global = req.query.global === 'true';

    logger.info('[FEEDBACK_API] Getting insights', { userId, days, global });

    const insights = await FeedbackAnalyticsService.getInsights(
      global ? undefined : userId,
      days
    );

    res.status(200).json({
      success: true,
      data: insights,
    });
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error getting insights:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get insights',
    });
  }
};

/**
 * Compare performance between periods
 * GET /api/v1/chat/feedback/compare
 */
export const comparePerformance = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const currentDays = Math.max(1, Math.min(365, parseInt(req.query.current_days as string) || 7)); // Limit 1-365 days
    const previousDays = Math.max(1, Math.min(365, parseInt(req.query.previous_days as string) || 7)); // Limit 1-365 days
    const global = req.query.global === 'true';

    logger.info('[FEEDBACK_API] Comparing performance', {
      userId,
      currentDays,
      previousDays,
      global,
    });

    const comparison = await FeedbackAnalyticsService.comparePerformance(
      global ? undefined : userId,
      currentDays,
      previousDays
    );

    res.status(200).json({
      success: true,
      data: comparison,
    });
  } catch (error: any) {
    logger.error('[FEEDBACK_API] Error comparing performance:', error);

    if (res.headersSent) {
      logger.warn('[FEEDBACK_API] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to compare performance',
    });
  }
};
