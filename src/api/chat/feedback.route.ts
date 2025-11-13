import { Router, Request, Response } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import { z } from 'zod';
import {
  createFeedback,
  getFeedback,
  deleteFeedback,
  getUserAnalytics,
  getGlobalAnalytics,
  getTimeSeriesAnalytics,
  getTopMessages,
  getInsights,
  comparePerformance,
} from './feedback.controller';

const router = Router();

// Validation schemas
const createFeedbackSchema = z.object({
  message_id: z.string().uuid('Invalid message ID'),
  feedback_type: z.enum(['like', 'dislike'], {
    errorMap: () => ({ message: 'Feedback type must be "like" or "dislike"' }),
  }),
  intent_type: z.string().optional(),
  session_id: z.string().uuid().optional(),
  context: z
    .object({
      prompt_tokens: z.number().optional(),
      response_tokens: z.number().optional(),
      response_time_ms: z.number().optional(),
      model: z.string().optional(),
      temperature: z.number().optional(),
      user_agent: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

/**
 * @swagger
 * /api/v1/chat/feedback:
 *   post:
 *     summary: Submit feedback (like/dislike) for a chat message
 *     description: |
 *       Allows users to provide feedback on AI responses to improve future interactions.
 *       If feedback already exists for a message, it will be updated.
 *     tags: [Chat, Feedback]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message_id
 *               - feedback_type
 *             properties:
 *               message_id:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the chat message to rate
 *                 example: "123e4567-e89b-12d3-a456-426614174000"
 *               feedback_type:
 *                 type: string
 *                 enum: [like, dislike]
 *                 description: Type of feedback
 *                 example: "like"
 *               intent_type:
 *                 type: string
 *                 description: Intent type of the message (api_test, general_chat, etc)
 *                 example: "api_test"
 *               session_id:
 *                 type: string
 *                 format: uuid
 *                 description: Chat session ID (optional, will be derived from message if not provided)
 *               context:
 *                 type: object
 *                 description: Additional context about the feedback
 *                 properties:
 *                   prompt_tokens:
 *                     type: number
 *                   response_tokens:
 *                     type: number
 *                   response_time_ms:
 *                     type: number
 *                   model:
 *                     type: string
 *                   temperature:
 *                     type: number
 *     responses:
 *       200:
 *         description: Feedback saved successfully
 *       400:
 *         description: Invalid request data
 *       403:
 *         description: Message does not belong to user
 *       500:
 *         description: Server error
 */
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const result = createFeedbackSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        details: result.error.errors,
      });
      return;
    }
    return createFeedback(req, res);
  })
);

/**
 * @swagger
 * /api/v1/chat/feedback/{messageId}:
 *   get:
 *     summary: Get feedback for a specific message
 *     description: Retrieve user's feedback for a chat message
 *     tags: [Chat, Feedback]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID of the chat message
 *     responses:
 *       200:
 *         description: Feedback retrieved successfully
 *       404:
 *         description: Feedback not found
 *       500:
 *         description: Server error
 */
router.get('/:messageId', requireAuth, asyncHandler(getFeedback));

/**
 * @swagger
 * /api/v1/chat/feedback/{feedbackId}:
 *   delete:
 *     summary: Delete feedback
 *     description: Remove previously submitted feedback
 *     tags: [Chat, Feedback]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: feedbackId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID of the feedback to delete
 *     responses:
 *       200:
 *         description: Feedback deleted successfully
 *       404:
 *         description: Feedback not found
 *       500:
 *         description: Server error
 */
router.delete('/:feedbackId', requireAuth, asyncHandler(deleteFeedback));

/**
 * @swagger
 * /api/v1/chat/feedback/analytics/user:
 *   get:
 *     summary: Get feedback analytics for current user
 *     description: |
 *       Returns aggregated feedback statistics for the authenticated user.
 *       Includes total counts, satisfaction rate, and breakdown by intent type.
 *     tags: [Chat, Feedback]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Number of days to include in analytics
 *     responses:
 *       200:
 *         description: Analytics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     total_feedback:
 *                       type: number
 *                     likes:
 *                       type: number
 *                     dislikes:
 *                       type: number
 *                     satisfaction_rate:
 *                       type: number
 *                       description: Percentage (0-100)
 *                     by_intent:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           intent_type:
 *                             type: string
 *                           likes:
 *                             type: number
 *                           dislikes:
 *                             type: number
 *                           satisfaction_rate:
 *                             type: number
 *                     recent_feedback:
 *                       type: array
 *       500:
 *         description: Server error
 */
router.get('/analytics/user', requireAuth, asyncHandler(getUserAnalytics));

/**
 * @swagger
 * /api/v1/chat/feedback/analytics/global:
 *   get:
 *     summary: Get global feedback analytics (admin only)
 *     description: Returns aggregated feedback statistics across all users
 *     tags: [Chat, Feedback, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Number of days to include in analytics
 *     responses:
 *       200:
 *         description: Global analytics retrieved successfully
 *       403:
 *         description: Unauthorized - admin only
 *       500:
 *         description: Server error
 */
router.get('/analytics/global', requireAuth, asyncHandler(getGlobalAnalytics));

/**
 * @swagger
 * /api/v1/chat/feedback/analytics/timeseries:
 *   get:
 *     summary: Get time-series feedback analytics
 *     description: Returns feedback data grouped by date for charting
 *     tags: [Chat, Feedback]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Number of days to include
 *     responses:
 *       200:
 *         description: Time series data retrieved successfully
 *       500:
 *         description: Server error
 */
router.get('/analytics/timeseries', requireAuth, asyncHandler(getTimeSeriesAnalytics));

/**
 * @swagger
 * /api/v1/chat/feedback/top/{type}:
 *   get:
 *     summary: Get top liked or disliked messages (admin only)
 *     description: |
 *       Returns messages with the most likes or dislikes.
 *       Used for RLHF (Reinforcement Learning from Human Feedback) and prompt improvement.
 *     tags: [Chat, Feedback, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [like, dislike]
 *         description: Type of feedback to retrieve
 *       - in: query
 *         name: intent
 *         schema:
 *           type: string
 *         description: Filter by intent type (optional)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of messages to return
 *     responses:
 *       200:
 *         description: Top messages retrieved successfully
 *       400:
 *         description: Invalid type parameter
 *       500:
 *         description: Server error
 */
router.get('/top/:type', requireAuth, asyncHandler(getTopMessages));

/**
 * @swagger
 * /api/v1/chat/feedback/insights:
 *   get:
 *     summary: Get AI performance insights and recommendations
 *     description: |
 *       Returns comprehensive analytics including:
 *       - Overall satisfaction trends
 *       - Problem areas that need attention
 *       - Top performing intent types
 *       - Actionable recommendations for improvement
 *       - Time series data for visualization
 *     tags: [Chat, Feedback, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Number of days to analyze
 *       - in: query
 *         name: global
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get global insights (all users) instead of personal
 *     responses:
 *       200:
 *         description: Insights retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     summary:
 *                       type: object
 *                       properties:
 *                         overall_satisfaction:
 *                           type: number
 *                         total_responses:
 *                           type: number
 *                         feedback_rate:
 *                           type: number
 *                         trend:
 *                           type: string
 *                           enum: [improving, declining, stable]
 *                     problem_areas:
 *                       type: array
 *                       items:
 *                         type: object
 *                     top_performers:
 *                       type: array
 *                       items:
 *                         type: object
 *                     recommendations:
 *                       type: array
 *                       items:
 *                         type: object
 *                     time_series:
 *                       type: array
 *                       items:
 *                         type: object
 *       500:
 *         description: Server error
 */
router.get('/insights', requireAuth, asyncHandler(getInsights));

/**
 * @swagger
 * /api/v1/chat/feedback/compare:
 *   get:
 *     summary: Compare feedback performance between time periods
 *     description: |
 *       Compares current period with previous period to identify:
 *       - Changes in satisfaction rate
 *       - Improved intent types
 *       - Declined intent types
 *       - Overall trends
 *     tags: [Chat, Feedback, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: current_days
 *         schema:
 *           type: integer
 *           default: 7
 *         description: Number of days in current period
 *       - in: query
 *         name: previous_days
 *         schema:
 *           type: integer
 *           default: 7
 *         description: Number of days in previous period
 *       - in: query
 *         name: global
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Compare global data (all users)
 *     responses:
 *       200:
 *         description: Comparison retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     current_period:
 *                       type: object
 *                     previous_period:
 *                       type: object
 *                     changes:
 *                       type: object
 *                       properties:
 *                         satisfaction_rate_change:
 *                           type: number
 *                         likes_change:
 *                           type: number
 *                         dislikes_change:
 *                           type: number
 *                     improved_intents:
 *                       type: array
 *                       items:
 *                         type: string
 *                     declined_intents:
 *                       type: array
 *                       items:
 *                         type: string
 *       500:
 *         description: Server error
 */
router.get('/compare', requireAuth, asyncHandler(comparePerformance));

export default router;
