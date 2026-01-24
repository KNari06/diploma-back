import { Router } from 'express';
import { startJiraAuth, getConnectUrl, handleJiraCallback, getProjects, getConnectionStatus, disconnectJira, getConnections } from './jira.controller';
import { asyncHandler } from '@/utils/core/error-handler';
import { requireAuth } from '@/middleware/auth.middleware';

const router = Router();

/**
 * @swagger
 * /api/v1/jira/auth/start:
 *   get:
 *     summary: Начать авторизацию Jira OAuth 2.0
 *     description: Редиректит пользователя на страницу авторизации Atlassian. После авторизации пользователь будет перенаправлен на callback URL.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       302:
 *         description: Редирект на страницу авторизации Atlassian
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *               example: "https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=..."
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "User ID is required (userId query param or X-User-ID header)"
 *       500:
 *         description: Ошибка сервера
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/auth/start', requireAuth, asyncHandler(startJiraAuth));

/**
 * @swagger
 * /api/v1/jira/auth/manual:
 *   get:
 *     summary: Проверка подключения Jira (alias для /status)
 *     description: Возвращает тот же ответ, что GET /status. Используется фронтендом для проверки подключения.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Статус подключений (connections, connected)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 connections:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       cloud_id:
 *                         type: string
 *                       site_url:
 *                         type: string
 *                 connected:
 *                   type: boolean
 *       500:
 *         description: Ошибка сервера
 */
router.get('/auth/manual', requireAuth, asyncHandler(getConnectionStatus));

/**
 * @swagger
 * /api/v1/jira/connect/url:
 *   get:
 *     summary: Получить URL для подключения Jira (SPA)
 *     description: Возвращает OAuth URL. Фронт вызывает fetch с Bearer, затем редирект window.location = url. Редирект на /connect без заголовков даёт 401.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: URL для редиректа на Atlassian OAuth
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 url:
 *                   type: string
 *                   example: "https://auth.atlassian.com/authorize?..."
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Ошибка сервера
 */
router.get('/connect/url', requireAuth, asyncHandler(getConnectUrl));

/**
 * @swagger
 * /api/v1/jira/connect:
 *   get:
 *     summary: Подключить Jira (редирект, требует cookie auth)
 *     description: Редирект на OAuth. Для SPA с Bearer используйте GET /connect/url.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       302:
 *         description: Редирект на авторизацию Atlassian
 *       500:
 *         description: Ошибка сервера
 */
router.get('/connect', requireAuth, asyncHandler(startJiraAuth));

/**
 * @swagger
 * /api/v1/jira/callback:
 *   get:
 *     summary: OAuth callback от Atlassian
 *     description: Обрабатывает callback после авторизации, обменивает код на токены и сохраняет их в БД
 *     tags: [Jira]
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: Authorization code от Atlassian
 *         example: "abc123def456"
 *       - in: query
 *         name: state
 *         required: true
 *         schema:
 *           type: string
 *         description: State parameter для валидации безопасности OAuth потока
 *         example: "random_state_string"
 *     responses:
 *       200:
 *         description: Авторизация успешна, токены сохранены
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
 *                   example: "Jira authorization successful"
 *                 resources:
 *                   type: array
 *                   description: Список доступных Jira сайтов
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         description: Cloud ID
 *                         example: "abc123-456-789"
 *                       name:
 *                         type: string
 *                         description: Название Jira сайта
 *                         example: "My Company"
 *                       url:
 *                         type: string
 *                         format: uri
 *                         description: URL Jira сайта
 *                         example: "https://mycompany.atlassian.net"
 *                 tokensSaved:
 *                   type: integer
 *                   description: Количество сохранённых токенов
 *                   example: 1
 *       400:
 *         description: Ошибка валидации (неверный state, отсутствует code и т.д.)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Invalid or expired state parameter"
 *       500:
 *         description: Ошибка сервера
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/callback', asyncHandler(handleJiraCallback));

/**
 * @swagger
 * /api/v1/jira/projects:
 *   get:
 *     summary: Получить список проектов Jira
 *     description: Возвращает список проектов из Jira используя сохранённый токен пользователя. Токен автоматически обновляется если истёк.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cloudId
 *         required: false
 *         schema:
 *           type: string
 *         description: Jira Cloud ID (опционально, будет использован первый доступный если не указан)
 *         example: "abc123-456-789"
 *     responses:
 *       200:
 *         description: Список проектов Jira
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   description: Список проектов
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "10000"
 *                       key:
 *                         type: string
 *                         example: "PROJ"
 *                       name:
 *                         type: string
 *                         example: "My Project"
 *                       projectTypeKey:
 *                         type: string
 *                         example: "software"
 *                       simplified:
 *                         type: boolean
 *                         example: false
 *                       style:
 *                         type: string
 *                         example: "next-gen"
 *                       isPrivate:
 *                         type: boolean
 *                         example: false
 *                 count:
 *                   type: integer
 *                   description: Количество проектов
 *                   example: 5
 *       401:
 *         description: Jira не авторизован (токены отсутствуют или невалидны)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             example:
 *               success: false
 *               error: "Jira not connected. Please authorize first at /api/jira/auth/start"
 *       400:
 *         description: Ошибка валидации (отсутствует userId и т.д.)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Ошибка сервера
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/projects', requireAuth, asyncHandler(getProjects));

/**
 * @swagger
 * /api/v1/jira/status:
 *   get:
 *     summary: Проверить статус подключения Jira
 *     description: Возвращает список подключенных Jira аккаунтов (cloud_id, site_url) для пользователя.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список подключенных Jira аккаунтов
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 connections:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       cloud_id:
 *                         type: string
 *                         example: "abc123-456-789"
 *                       site_url:
 *                         type: string
 *                         example: "https://mycompany.atlassian.net"
 *                 connected:
 *                   type: boolean
 *                   example: true
 *       500:
 *         description: Ошибка сервера
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/status', requireAuth, asyncHandler(getConnectionStatus));

/**
 * @swagger
 * /api/v1/jira/disconnect:
 *   delete:
 *     summary: Отключить Jira аккаунт
 *     description: Удаляет токены Jira для пользователя. Можно указать cloudId для удаления только определённого подключения.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cloudId
 *         required: false
 *         schema:
 *           type: string
 *         description: Cloud ID Jira аккаунта (опционально)
 *     responses:
 *       200:
 *         description: Jira аккаунт(ы) отключены
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
 *                   example: "Jira disconnected"
 *       500:
 *         description: Ошибка сервера
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/disconnect', requireAuth, asyncHandler(disconnectJira));

/**
 * @swagger
 * /api/v1/jira/connections:
 *   get:
 *     summary: Получить список всех подключённых Jira аккаунтов
 *     description: Возвращает список всех подключённых Jira аккаунтов с деталями (cloud_id, site_url, created_at).
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список подключённых Jira аккаунтов
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 connections:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       cloud_id:
 *                         type: string
 *                         example: "abc123-456-789"
 *                       site_url:
 *                         type: string
 *                         example: "https://mycompany.atlassian.net"
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         example: "2026-01-21T12:34:56.789Z"
 *                 count:
 *                   type: integer
 *                   example: 1
 *       500:
 *         description: Ошибка сервера
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/connections', requireAuth, asyncHandler(getConnections));

export default router;
