import { requireAuth, requireAdmin } from '@/middleware/auth.middleware';
import { asyncHandler, handleValidationError } from '@/utils/core/error-handler';
import { Request, Response, Router } from 'express';
import multer from 'multer';
import path from 'path';
import { z } from 'zod';
import { deleteAvatar, uploadAvatar } from './auth-avatar.controller';
import {
  completeOAuthHandler,
  getOAuthUrlHandler,
  getPendingUsers,
  login,
  logout,
  me,
  passwordResetRequest,
  passwordUpdate,
  refresh,
  resendVerification,
  sendMagicLink,
  signup,
  updateProfile,
  updateUserStatus,
  verifyEmail,
} from './auth.controller';

const router = Router();

// Validation schemas
const signupSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

const magicLinkSchema = z.object({
  email: z.string().email('Invalid email format'),
  redirectTo: z.string().url().optional(),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

const passwordResetSchema = z.object({
  email: z.string().email('Invalid email format'),
  redirectTo: z.string().url().optional(),
});

const resendVerificationSchema = z.object({
  email: z.string().email('Invalid email format'),
  redirectTo: z.string().url().optional(),
});

const passwordUpdateSchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

const updateProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255, 'Name must be less than 255 characters'),
});

const completeOAuthSchema = z.object({
  provider: z.enum(['google'], { errorMap: () => ({ message: 'Provider must be "google"' }) }),
  code: z.string().min(10, 'Authorization code is required'),
  state: z.string().optional(),
});

/**
 * @swagger
 * /api/v1/auth/signup:
 *   post:
 *     summary: Регистрация нового пользователя
 *     description: Создает нового пользователя через Supabase Auth с Email и Password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "user@example.com"
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 example: "password123"
 *               name:
 *                 type: string
 *                 example: "John Doe"
 *     responses:
 *       201:
 *         description: Пользователь зарегистрирован успешно
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
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/AuthUser'
 *                     tokens:
 *                       $ref: '#/components/schemas/AuthTokens'
 *       400:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/signup', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = signupSchema.parse(req.body);
    req.body = validatedData;
    await signup(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Вход с Email и Password
 *     description: Авторизация пользователя через Supabase Auth
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "user@example.com"
 *               password:
 *                 type: string
 *                 example: "password123"
 *     responses:
 *       200:
 *         description: Вход выполнен успешно
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
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/AuthUser'
 *                     tokens:
 *                       $ref: '#/components/schemas/AuthTokens'
 *       401:
 *         description: Неверные credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = loginSchema.parse(req.body);
    req.body = validatedData;
    await login(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/auth/magic-link:
 *   post:
 *     summary: Отправить Magic Link
 *     description: Отправляет ссылку для входа без пароля на email
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "user@example.com"
 *               redirectTo:
 *                 type: string
 *                 format: uri
 *                 example: "http://localhost:3000/auth/verify"
 *     responses:
 *       200:
 *         description: Magic link отправлен
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
 *                   example: "Magic link sent to your email"
 *       400:
 *         description: Ошибка валидации
 */
router.post('/magic-link', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = magicLinkSchema.parse(req.body);
    req.body = validatedData;
    await sendMagicLink(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/auth/oauth/{provider}:
 *   get:
 *     summary: OAuth авторизация
 *     description: Редирект на OAuth провайдера (Google, GitHub, GitLab, Bitbucket)
 *     tags: [Auth]
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *           enum: [google, github, gitlab, bitbucket]
 *         description: OAuth провайдер
 *       - in: query
 *         name: redirect_uri
 *         schema:
 *           type: string
 *           format: uri
 *         description: URL для редиректа после OAuth
 *       - in: query
 *         name: use_pkce
 *         schema:
 *           type: boolean
 *         description: Использовать PKCE flow (для desktop приложений)
 *     responses:
 *       200:
 *         description: OAuth URL сгенерирован
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
 *                     url:
 *                       type: string
 *                       example: "https://accounts.google.com/o/oauth2/v2/auth?..."
 *                     state:
 *                       type: string
 *                       description: State token (только при use_pkce=true)
 *       400:
 *         description: Неверный провайдер
 */
router.get('/oauth/:provider', asyncHandler(getOAuthUrlHandler));

/**
 * @swagger
 * /api/v1/auth/oauth/complete:
 *   post:
 *     summary: Завершить OAuth flow
 *     description: Обменяет authorization code на access/refresh токены (для desktop приложений с PKCE)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - provider
 *               - code
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: [google]
 *                 example: "google"
 *                 description: OAuth провайдер
 *               code:
 *                 type: string
 *                 example: "4/0AeanS..."
 *                 description: Authorization code от OAuth провайдера
 *               state:
 *                 type: string
 *                 example: "abc123xyz..."
 *                 description: State token (опционально, но рекомендуется для PKCE)
 *     responses:
 *       200:
 *         description: Токены получены успешно
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
 *                     tokens:
 *                       type: object
 *                       properties:
 *                         access_token:
 *                           type: string
 *                           example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *                         refresh_token:
 *                           type: string
 *                           example: "v1.abc123..."
 *                         expires_in:
 *                           type: number
 *                           example: 3600
 *                     user:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           format: uuid
 *                         email:
 *                           type: string
 *                         name:
 *                           type: string
 *                         avatar:
 *                           type: string
 *                           nullable: true
 *                         role:
 *                           type: string
 *       400:
 *         description: Ошибка валидации или неверный код
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Invalid authorization code"
 *       500:
 *         description: Ошибка обмена токенов
 */
router.post('/oauth/complete', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = completeOAuthSchema.parse(req.body);
    req.body = validatedData;
    await completeOAuthHandler(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Выход из системы
 *     description: Инвалидирует текущую сессию пользователя
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Выход выполнен успешно
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
 *                   example: "Logged out successfully"
 *       400:
 *         description: Ошибка выхода
 */
router.post('/logout', asyncHandler(logout));

/**
 * @swagger
 * /api/v1/auth/refresh:
 *   post:
 *     summary: Обновить access token
 *     description: Получить новый access token используя refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refresh_token
 *             properties:
 *               refresh_token:
 *                 type: string
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: Токен обновлен успешно
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/AuthTokens'
 *       401:
 *         description: Неверный refresh token
 */
router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = refreshSchema.parse(req.body);
    req.body = validatedData;
    await refresh(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/auth/me:
 *   get:
 *     summary: Получить текущего пользователя
 *     description: Возвращает данные текущего авторизованного пользователя
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Данные пользователя
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
 *                     email:
 *                       type: string
 *                     name:
 *                       type: string
 *                     role:
 *                       type: string
 *                     credits:
 *                       type: integer
 *                     subscription:
 *                       type: object
 *       401:
 *         description: Не авторизован
 */
router.get('/me', asyncHandler(me));

/**
 * @swagger
 * /api/v1/auth/password/reset-request:
 *   post:
 *     summary: Запрос на сброс пароля
 *     description: Отправляет ссылку для сброса пароля на email
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "user@example.com"
 *               redirectTo:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: Ссылка отправлена
 *       400:
 *         description: Ошибка отправки
 */
router.post('/password/reset-request', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = passwordResetSchema.parse(req.body);
    req.body = validatedData;
    await passwordResetRequest(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/auth/resend-verification:
 *   post:
 *     summary: Resend signup verification email
 *     description: Re-sends the Supabase signup confirmation email to the given address.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               redirectTo:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: Verification email sent
 *       400:
 *         description: Invalid request or resend failed
 */
router.post('/resend-verification', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = resendVerificationSchema.parse(req.body);
    req.body = validatedData;
    await resendVerification(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/auth/verify-email:
 *   get:
 *     summary: Verify email via token from confirmation link
 *     description: Exchanges Supabase signup confirmation token for a session. Returns tokens for auto-login.
 *     tags: [Auth]
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Email verified, returns user + tokens
 *       400:
 *         description: Invalid or expired token
 */
router.get('/verify-email', asyncHandler(async (req: Request, res: Response) => {
  await verifyEmail(req, res);
}));

/**
 * @swagger
 * /api/v1/auth/password/update:
 *   post:
 *     summary: Обновить пароль
 *     description: Обновляет пароль авторизованного пользователя
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - newPassword
 *             properties:
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *                 example: "newpassword123"
 *     responses:
 *       200:
 *         description: Пароль обновлен
 *       401:
 *         description: Не авторизован
 */
router.post('/password/update', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = passwordUpdateSchema.parse(req.body);
    req.body = validatedData;
    await passwordUpdate(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/auth/profile:
 *   put:
 *     summary: Обновить профиль пользователя
 *     description: Обновляет имя пользователя в профиле
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 255
 *                 example: "John Doe"
 *                 description: "Новое имя пользователя"
 *     responses:
 *       200:
 *         description: Профиль обновлен успешно
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
 *                   example: "Profile updated successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                       example: "c79e2bd7-ad07-4e56-9251-1492dd01e635"
 *                     email:
 *                       type: string
 *                       example: "user@example.com"
 *                     name:
 *                       type: string
 *                       example: "John Doe"
 *                     role:
 *                       type: string
 *                       example: "user"
 *                     credits:
 *                       type: integer
 *                       example: 100
 *                     subscription:
 *                       type: object
 *                       nullable: true
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-11-06T10:30:00Z"
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-11-06T15:45:00Z"
 *       400:
 *         description: Невалидные данные
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Invalid name format"
 *                 code:
 *                   type: string
 *                   example: "VALIDATION_ERROR"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Не авторизован
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Unauthorized"
 *       422:
 *         description: Ошибка валидации
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Name is required"
 */
router.put('/profile', asyncHandler(async (req: Request, res: Response) => {
  try {
    const validatedData = updateProfileSchema.parse(req.body);
    req.body = validatedData;
    await updateProfile(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

// ============================================================================
// AVATAR UPLOAD CONFIGURATION
// ============================================================================

const avatarStorage = multer.memoryStorage();

const avatarFileFilter = (
  req: any,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only PNG, JPG, and WebP files are allowed'));
  }
};

const uploadAvatarMulter = multer({
  storage: avatarStorage,
  fileFilter: avatarFileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB max
  },
});

/**
 * POST /auth/avatar
 * Upload user avatar (authenticated)
 */
router.post('/avatar', requireAuth, uploadAvatarMulter.single('avatar'), asyncHandler(uploadAvatar));

/**
 * DELETE /auth/avatar
 * Delete user avatar (authenticated)
 */
router.delete('/avatar', requireAuth, asyncHandler(deleteAvatar));

// ============================================================================
// ADMIN: User approval management
// ============================================================================

/**
 * GET /auth/users/pending
 * List users pending approval (admin only)
 */
router.get('/users/pending', requireAuth, requireAdmin, asyncHandler(getPendingUsers));

/**
 * PATCH /auth/users/:userId/status
 * Update user approval status (admin only)
 * Body: { status: 'approved' | 'rejected' | 'pending_approval' }
 */
router.patch('/users/:userId/status', requireAuth, requireAdmin, asyncHandler(updateUserStatus));

export default router;
