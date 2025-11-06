import { Router } from 'express';
import { optionalAuth, requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import { getUserCredits, resetUserCredits, purchaseCredits, getCreditHistory, getPricingPlans } from './user.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/user/credits:
 *   get:
 *     summary: Получить информацию о кредитах/лимитах пользователя
 *     description: Возвращает информацию о лимитах для анонимных пользователей или статус unlimited для авторизованных
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: User ID (optional, для анонимных пользователей)
 *       - in: query
 *         name: context
 *         schema:
 *           type: object
 *         description: Context with projectId (optional)
 *     responses:
 *       200:
 *         description: Информация о кредитах
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     type:
 *                       type: string
 *                       enum: [authenticated, anonymous]
 *                 credits:
 *                   type: object
 *                   properties:
 *                     plan:
 *                       type: string
 *                       enum: [unlimited, free]
 *                     limit:
 *                       type: number
 *                       nullable: true
 *                     used:
 *                       type: number
 *                       nullable: true
 *                     remaining:
 *                       type: number
 *                       nullable: true
 *                     resetAt:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                     isLimitReached:
 *                       type: boolean
 *                 message:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       500:
 *         description: Ошибка сервера
 */
router.get('/credits', optionalAuth, asyncHandler(getUserCredits));

/**
 * @swagger
 * /api/v1/user/credits/reset:
 *   post:
 *     summary: Сбросить лимит для анонимного пользователя
 *     description: Сбрасывает счетчик запросов (используется после авторизации или для админа)
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               anonymousId:
 *                 type: string
 *                 description: ID анонимного пользователя (project_xxx)
 *     responses:
 *       200:
 *         description: Лимит сброшен
 *       400:
 *         description: Отсутствует anonymousId
 *       500:
 *         description: Ошибка сервера
 */
router.post('/credits/reset', optionalAuth, asyncHandler(resetUserCredits));

/**
 * @swagger
 * /api/v1/user/credits/purchase:
 *   post:
 *     summary: Купить кредиты
 *     description: Покупка кредитов для авторизованного пользователя
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amount:
 *                 type: number
 *                 description: Количество кредитов для покупки
 *               paymentId:
 *                 type: string
 *                 description: ID платежа (optional)
 *     responses:
 *       200:
 *         description: Кредиты успешно куплены
 *       401:
 *         description: Требуется авторизация
 *       400:
 *         description: Некорректное количество
 */
router.post('/credits/purchase', requireAuth, asyncHandler(purchaseCredits));

/**
 * @swagger
 * /api/v1/user/credits/history:
 *   get:
 *     summary: История транзакций кредитов
 *     description: Получить историю покупок и использования кредитов
 *     tags: [User]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: number
 *           default: 50
 *         description: Количество записей
 *     responses:
 *       200:
 *         description: История транзакций
 *       401:
 *         description: Требуется авторизация
 */
router.get('/credits/history', requireAuth, asyncHandler(getCreditHistory));

/**
 * @swagger
 * /api/v1/user/pricing-plans:
 *   get:
 *     summary: Получить список тарифных планов
 *     description: Публичный endpoint - доступен без авторизации. Возвращает все доступные тарифные планы с ценами и описанием.
 *     tags: [User]
 *     responses:
 *       200:
 *         description: Список тарифных планов
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 plans:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       credits:
 *                         type: number
 *                       price:
 *                         type: number
 *                       currency:
 *                         type: string
 *                       features:
 *                         type: array
 *                         items:
 *                           type: string
 *                       popular:
 *                         type: boolean
 *                       discount:
 *                         type: number
 *                 count:
 *                   type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       500:
 *         description: Ошибка сервера
 */
router.get('/pricing-plans', asyncHandler(getPricingPlans));

export default router;
