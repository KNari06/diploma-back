/**
 * Rules Reload Routes
 *
 * Routes for managing AI response rules cache
 */

import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import * as rulesReloadController from './rules-reload.controller';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * @swagger
 * /api/v1/kb/rules/reload:
 *   post:
 *     summary: Reload AI response rules cache
 *     description: Reloads the AI response rules (general_ai_rules.md) from global KB into memory cache. Use after updating rules files.
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               language:
 *                 type: string
 *                 enum: [en, ru]
 *                 description: Specific language to reload. If not provided, reloads all languages.
 *                 example: en
 *     responses:
 *       200:
 *         description: Rules reloaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Rules reloaded for all languages
 *                 duration:
 *                   type: string
 *                   example: 245ms
 *                 stats:
 *                   type: object
 *                   description: Cache statistics after reload
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       500:
 *         description: Failed to reload rules
 */
router.post('/rules/reload', asyncHandler(rulesReloadController.reloadRules));

/**
 * @swagger
 * /api/v1/kb/rules/stats:
 *   get:
 *     summary: Get rules cache statistics
 *     description: Returns statistics about the current state of the AI response rules cache
 *     tags: [Knowledge Base]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cache statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 stats:
 *                   type: object
 *                   properties:
 *                     isInitialized:
 *                       type: boolean
 *                       example: true
 *                     languages:
 *                       type: object
 *                       properties:
 *                         en:
 *                           type: object
 *                           properties:
 *                             isCached:
 *                               type: boolean
 *                             chunksCount:
 *                               type: number
 *                             contentLength:
 *                               type: number
 *                             age:
 *                               type: number
 *                               description: Age in milliseconds
 *                         ru:
 *                           type: object
 *                           properties:
 *                             isCached:
 *                               type: boolean
 *                             chunksCount:
 *                               type: number
 *                             contentLength:
 *                               type: number
 *                             age:
 *                               type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       500:
 *         description: Failed to get stats
 */
router.get('/rules/stats', asyncHandler(rulesReloadController.getRulesCacheStats));

export default router;
