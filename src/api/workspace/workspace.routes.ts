import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/error-handler';
import {
  createWorkspace,
  getWorkspaces,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from './workspace.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/workspaces:
 *   post:
 *     summary: Создать новый workspace
 *     description: Создает новый workspace для текущего пользователя. Workspace обязателен для работы с проектами.
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - project_name
 *               - platforms
 *               - devBaseUrl
 *             properties:
 *               project_name:
 *                 type: string
 *                 description: Название workspace (основное поле)
 *                 example: "My QA Team"
 *               name:
 *                 type: string
 *                 description: Альтернативное название (для совместимости, используется если project_name не указан)
 *                 example: "My QA Team"
 *               platforms:
 *                 type: array
 *                 description: Массив поддерживаемых платформ
 *                 items:
 *                   type: string
 *                 example: ["web(chrome, safari, firefox)", "mobile(ios, android, emulators)"]
 *               api_testing:
 *                 type: boolean
 *                 description: Включено ли API тестирование
 *                 default: false
 *                 example: true
 *               devBaseUrl:
 *                 type: string
 *                 description: Базовый URL для dev окружения
 *                 example: "https://staging.myapp.com"
 *               prodBaseUrl:
 *                 type: string
 *                 description: Базовый URL для prod окружения (опционально)
 *                 example: "https://prod.myapp.com"
 *     responses:
 *       201:
 *         description: Workspace успешно создан
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
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     name:
 *                       type: string
 *                     userId:
 *                       type: string
 *                       format: uuid
 *                     platforms:
 *                       type: array
 *                       items:
 *                         type: string
 *                     apiTesting:
 *                       type: boolean
 *                     devBaseUrl:
 *                       type: string
 *                     prodBaseUrl:
 *                       type: string
 *                       nullable: true
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                 message:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Ошибка валидации
 *       401:
 *         description: Требуется авторизация
 *       500:
 *         description: Ошибка сервера
 *   get:
 *     summary: Получить все workspaces пользователя
 *     description: Возвращает список всех workspaces текущего пользователя
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Список workspaces
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                 count:
 *                   type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Требуется авторизация
 *       500:
 *         description: Ошибка сервера
 */
router.post('/', asyncHandler(createWorkspace)); // Removed requireAuth for anonymous users
router.get('/', asyncHandler(getWorkspaces));   // Removed requireAuth for anonymous users

/**
 * @swagger
 * /api/v1/workspaces/{id}:
 *   get:
 *     summary: Получить workspace по ID
 *     description: Возвращает информацию о workspace по его ID
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID workspace
 *     responses:
 *       200:
 *         description: Workspace найден
 *       404:
 *         description: Workspace не найден
 *       401:
 *         description: Требуется авторизация
 *   put:
 *     summary: Обновить workspace
 *     description: Обновляет информацию о workspace
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID workspace
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               platforms:
 *                 type: array
 *                 items:
 *                   type: string
 *               api_testing:
 *                 type: boolean
 *               devBaseUrl:
 *                 type: string
 *               prodBaseUrl:
 *                 type: string
 *     responses:
 *       200:
 *         description: Workspace обновлен
 *       404:
 *         description: Workspace не найден
 *       401:
 *         description: Требуется авторизация
 *   delete:
 *     summary: Удалить workspace
 *     description: Удаляет workspace (все связанные проекты также будут удалены)
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID workspace
 *     responses:
 *       200:
 *         description: Workspace удален
 *       404:
 *         description: Workspace не найден
 *       401:
 *         description: Требуется авторизация
 */
router.get('/:id', requireAuth, asyncHandler(getWorkspace));
router.put('/:id', requireAuth, asyncHandler(updateWorkspace));
router.delete('/:id', requireAuth, asyncHandler(deleteWorkspace));

export default router;
