import { Router } from 'express';
import { startJiraAuth, getConnectUrl, handleJiraCallback, getProjects, getBoards, getBoardConfigurationHandler, getIssues, createIssue, updateIssue, updateIssueStatus, getConnectionStatus, disconnectJira, getConnections, getJiraSettings, updateJiraSettings, qaAnalyze, runFromJiraViaChat } from './jira.controller';
import { asyncHandler } from '@/utils/core/error-handler';
import { requireAuth, requireApproved } from '@/middleware/auth.middleware';

const router = Router();

// OAuth callback must be public (Atlassian redirects with code/state, no Bearer token)
router.get('/callback', asyncHandler(handleJiraCallback));

// All other routes require auth and approved status
router.use(requireAuth, requireApproved);

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
 * /api/v1/jira/boards:
 *   get:
 *     summary: Получить список досок Jira
 *     description: "Jira Agile API GET /rest/agile/1.0/board. Ответ: { success: true, data: [ { id, name, type } ] }"
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cloudId
 *         required: false
 *         schema:
 *           type: string
 *         description: Jira Cloud ID
 *     responses:
 *       200:
 *         description: Список досок
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
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: number
 *                         example: 84
 *                       name:
 *                         type: string
 *                         example: "scrum board"
 *                       type:
 *                         type: string
 *                         example: "scrum"
 *       403:
 *         description: Jira не подключена
 *       500:
 *         description: Ошибка Jira API
 */
router.get('/boards', requireAuth, asyncHandler(getBoards));

/**
 * @swagger
 * /api/v1/jira/board-configuration:
 *   get:
 *     summary: Получить конфигурацию доски (колонки со статусами)
 *     description: GET /rest/agile/1.0/board/{boardId}/configuration + GET /rest/api/3/status для маппинга id→name
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: boardId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID доски
 *       - in: query
 *         name: cloudId
 *         required: false
 *         schema:
 *           type: string
 *         description: Jira Cloud ID
 *     responses:
 *       200:
 *         description: Колонки с statusNames
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     columns:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name:
 *                             type: string
 *                             example: "To Do"
 *                           statusNames:
 *                             type: array
 *                             items:
 *                               type: string
 *                             example: ["To Do", "Open", "Backlog"]
 *       400:
 *         description: boardId обязателен
 *       403:
 *         description: Jira не подключена
 *       500:
 *         description: Ошибка Jira API
 */
router.get('/board-configuration', requireAuth, asyncHandler(getBoardConfigurationHandler));

/**
 * @swagger
 * /api/v1/jira/issues:
 *   get:
 *     summary: Получить задачи Jira (вкладка Bugs)
 *     description: boardId — Agile board issues. spaceKey — board?projectKeyOrId={spaceKey} → board issues. Без них — JQL по projectKey. Пагинация limit/offset.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: boardId
 *         required: false
 *         schema:
 *           type: string
 *         description: ID доски — Agile API GET /rest/agile/1.0/board/{boardId}/issue
 *       - in: query
 *         name: spaceKey
 *         required: false
 *         schema:
 *           type: string
 *         description: Ключ Space/проекта (KAN) — GET board?projectKeyOrId={spaceKey}, затем board/{boardId}/issue
 *       - in: query
 *         name: projectKey
 *         required: false
 *         schema:
 *           type: string
 *         description: Ключ проекта Jira (при отсутствии boardId)
 *       - in: query
 *         name: issueType
 *         required: false
 *         schema:
 *           type: string
 *         description: Фильтр по типу задачи — Bug, Task, Story или несколько через запятую (Bug,Task). Без параметра — все типы.
 *       - in: query
 *         name: cloudId
 *         required: false
 *         schema:
 *           type: string
 *         description: Jira Cloud ID
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 100
 *           minimum: 1
 *           maximum: 100
 *         description: Количество задач
 *       - in: query
 *         name: offset
 *         required: false
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: Смещение для пагинации
 *     responses:
 *       200:
 *         description: Список задач
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
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       key:
 *                         type: string
 *                       summary:
 *                         type: string
 *                       description:
 *                         type: string
 *                         nullable: true
 *                       status:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           name:
 *                             type: string
 *                           statusCategory:
 *                             type: object
 *                       priority:
 *                         type: object
 *                         nullable: true
 *                       issuetype:
 *                         type: object
 *                       reporter:
 *                         type: object
 *                         nullable: true
 *                       assignee:
 *                         type: object
 *                         nullable: true
 *                       created:
 *                         type: string
 *                       updated:
 *                         type: string
 *                       labels:
 *                         type: array
 *                         items:
 *                           type: string
 *                       project:
 *                         type: object
 *                 columns:
 *                   type: array
 *                   description: Board columns (from config + auto-added for statuses in issues not in config)
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       statusNames:
 *                         type: array
 *                         items:
 *                           type: string
 *                 total:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 timestamp:
 *                   type: string
 *       400:
 *         description: Невалидные параметры
 *       401:
 *         description: Не авторизован
 *       403:
 *         description: Jira не подключен
 *       404:
 *         description: Проект не найден
 *       500:
 *         description: Ошибка Jira API
 */
router.get('/issues', requireAuth, asyncHandler(getIssues));

/**
 * @swagger
 * /api/v1/jira/issues:
 *   post:
 *     summary: Создать задачу в Jira (из Bugs-доски)
 *     description: "Body: projectKey, summary, description?, issueType?, priority?"
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [projectKey, summary]
 *             properties:
 *               projectKey:
 *                 type: string
 *                 example: "KAN"
 *               summary:
 *                 type: string
 *               description:
 *                 type: string
 *               issueType:
 *                 type: string
 *                 default: "Bug"
 *               priority:
 *                 type: string
 *                 default: "Medium"
 *               cloudId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Задача создана
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
 *                     key:
 *                       type: string
 *                     id:
 *                       type: string
 *                     summary:
 *                       type: string
 *                     self:
 *                       type: string
 *       400:
 *         description: Невалидные параметры
 *       403:
 *         description: Jira не подключена
 *       500:
 *         description: Ошибка Jira API
 */
router.post('/issues', requireAuth, asyncHandler(createIssue));

/**
 * @swagger
 * /api/v1/jira/issues:
 *   put:
 *     summary: Обновить задачу Jira (summary, description, priority)
 *     description: Обновляются только переданные поля. description конвертируется в ADF.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [issueKey]
 *             properties:
 *               issueKey:
 *                 type: string
 *                 example: "KAN-42"
 *               summary:
 *                 type: string
 *                 description: Новый заголовок
 *               description:
 *                 type: string
 *                 description: Новое описание
 *               priority:
 *                 type: string
 *                 example: "High"
 *               cloudId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Задача обновлена
 *       400:
 *         description: issueKey обязателен, нужен хотя бы один из summary/description/priority
 *       403:
 *         description: Jira не подключена
 *       500:
 *         description: Ошибка Jira API
 */
router.put('/issues', requireAuth, asyncHandler(updateIssue));

/**
 * @swagger
 * /api/v1/jira/issues:
 *   patch:
 *     summary: Обновить статус задачи в Jira
 *     description: "Body: issueKey, status"
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [issueKey, status]
 *             properties:
 *               issueKey:
 *                 type: string
 *                 example: "KAN-42"
 *               status:
 *                 type: string
 *                 example: "In Progress"
 *               cloudId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Статус обновлён
 *       400:
 *         description: Невалидные параметры
 *       403:
 *         description: Jira не подключена
 *       500:
 *         description: Ошибка Jira API
 */
router.patch('/issues', requireAuth, asyncHandler(updateIssueStatus));

/**
 * @swagger
 * /api/v1/jira/intent-test-cases/from-jira:
 *   post:
 *     summary: Запустить Jira тикет через чат-обработчик (алиас preview-flow)
 *     description: |
 *       Склеивает summary+description в message и прокидывает в общий чат-флоу
 *       (тот же, что POST /api/v1/chat). Используется для генерации тестов из Jira.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 */
router.post('/intent-test-cases/from-jira', requireAuth, asyncHandler(runFromJiraViaChat));

/**
 * @swagger
 * /api/v1/jira/qa-analyze:
 *   post:
 *     summary: Analyze Jira task for QA (run test / rework / prepare manual)
 *     description: Analyzes task with KB + context, then runs platform test, sends to rework, or creates test case for manual QA.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [issueKey, projectId]
 *             properties:
 *               issueKey:
 *                 type: string
 *                 example: "KAN-42"
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               cloudId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Analysis result (outcome, message, testId or testCaseId)
 *       400:
 *         description: issueKey and projectId required
 *       500:
 *         description: Analysis or Jira error
 */
router.post('/qa-analyze', requireAuth, asyncHandler(qaAnalyze));

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

/**
 * @swagger
 * /api/v1/jira/settings:
 *   get:
 *     summary: Get Jira sync settings for project
 *     description: Returns syncOnCreate, autoSyncIssues, projectKey for the given project.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Jira sync settings
 *       400:
 *         description: projectId required
 *       404:
 *         description: Project not found
 */
router.get('/settings', requireAuth, asyncHandler(getJiraSettings));

/**
 * @swagger
 * /api/v1/jira/settings:
 *   put:
 *     summary: Update Jira sync settings for project
 *     description: Updates syncOnCreate, autoSyncIssues, projectKey. Used for "Sync on bug creation" feature.
 *     tags: [Jira]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [projectId]
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               syncOnCreate:
 *                 type: boolean
 *               autoSyncIssues:
 *                 type: boolean
 *               projectKey:
 *                 type: string
 *     responses:
 *       200:
 *         description: Settings updated
 *       400:
 *         description: projectId required
 *       404:
 *         description: Project not found
 */
router.put('/settings', requireAuth, asyncHandler(updateJiraSettings));

export default router;
