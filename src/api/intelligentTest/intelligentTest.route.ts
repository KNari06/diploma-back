import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import { Router } from 'express';
import {
  getTestFindings,
  getTestFlow,
  getTestSession,
  getTestSessions,
} from './intelligentTest.controller';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Intelligent Tests
 *   description: API для работы с intelligent test сессиями и визуализацией
 */

/**
 * @swagger
 * /api/v1/intelligent-test/session/{sessionId}:
 *   get:
 *     summary: Получить полную информацию о test сессии
 *     description: |
 *       Возвращает детальную информацию о intelligent test сессии:
 *       - Общая информация (goal, duration, cost)
 *       - Список посещенных страниц
 *       - Все действия на каждой странице
 *       - Найденные баги и проблемы
 *       - Скриншоты
 *     tags: [Intelligent Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID intelligent test сессии
 *     responses:
 *       200:
 *         description: Данные сессии
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
 *                     session:
 *                       type: object
 *                       description: Основная информация о сессии
 *                     pages:
 *                       type: array
 *                       description: Список страниц с действиями
 *                     findings:
 *                       type: array
 *                       description: Найденные баги
 *       403:
 *         description: Доступ запрещен
 *       404:
 *         description: Сессия не найдена
 */
router.get('/session/:sessionId', requireAuth, asyncHandler(getTestSession));

/**
 * @swagger
 * /api/v1/intelligent-test/session/{sessionId}/flow:
 *   get:
 *     summary: Получить flow diagram для визуализации
 *     description: |
 *       Возвращает упрощенный flow для построения диаграммы тестирования
 *     tags: [Intelligent Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Flow данные
 */
router.get('/session/:sessionId/flow', requireAuth, asyncHandler(getTestFlow));

/**
 * @swagger
 * /api/v1/intelligent-test/test/{testId}/sessions:
 *   get:
 *     summary: Получить все intelligent сессии для теста
 *     description: |
 *       Возвращает список всех intelligent test сессий для конкретного теста
 *     tags: [Intelligent Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID теста
 *     responses:
 *       200:
 *         description: Список сессий
 */
router.get('/test/:testId/sessions', requireAuth, asyncHandler(getTestSessions));

/**
 * @swagger
 * /api/v1/intelligent-test/session/{sessionId}/findings:
 *   get:
 *     summary: Получить найденные баги и проблемы
 *     description: |
 *       Возвращает список всех багов и проблем обнаруженных во время тестирования
 *     tags: [Intelligent Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: severity
 *         schema:
 *           type: string
 *           enum: [critical, high, medium, low, info]
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [bug, warning, improvement, security, performance, ux_issue]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [new, confirmed, false_positive, fixed, wont_fix]
 *     responses:
 *       200:
 *         description: Список находок
 */
router.get(
  '/session/:sessionId/findings',
  requireAuth,
  asyncHandler(getTestFindings)
);

export default router;
