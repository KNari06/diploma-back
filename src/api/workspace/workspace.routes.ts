import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import {
  getOnboarding,
  saveOnboarding,
  saveProfile,
} from './onboarding.controller';
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  getWorkspaces,
  updateWorkspace,
} from './workspace.controller';
import {
  acceptInvite,
  changeMemberRole,
  createInvite,
  getAuditLog,
  getInvites,
  getMembers,
  removeMember,
  resendInvite,
  revokeInvite,
  transferOwnership,
} from './workspace-members.controller';
import {
  uploadWorkspaceLogo,
  deleteWorkspaceLogo,
} from './workspace-logo.controller';
import {
  getCredits,
  getCreditTransactions,
} from './workspace-credits.controller';
import {
  getWorkspaceAIUsage,
  getWorkspaceAIUsageHistory,
  getWorkspaceAIUsageDaily,
  getTestAIUsage,
} from './ai-usage.controller';
import { checkInviteConfig } from './health-check.controller';

const router = Router();

// ============================================================================
// HEALTH & CONFIGURATION CHECK
// ============================================================================

/**
 * @swagger
 * /api/v1/workspaces/config-check:
 *   get:
 *     summary: Check workspace invite configuration
 *     description: Verify that SMTP and other required settings are configured correctly
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Configuration check results
 */
router.get('/config-check', requireAuth, asyncHandler(checkInviteConfig));

// ============================================================================
// MULTER CONFIGURATION FOR LOGO UPLOADS
// ============================================================================

const storage = multer.memoryStorage();

const logoFileFilter = (
  req: any,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedExtensions = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only PNG, JPG, SVG, and WebP files are allowed'));
  }
};

const uploadLogo = multer({
  storage,
  fileFilter: logoFileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB max file size
  },
});

/**
 * @swagger
 * /api/v1/workspaces:
 *   post:
 *     summary: Create a new workspace
 *     description: Creates a new workspace for the current user (authenticated or anonymous via IP)
 *     tags: [Workspaces]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - project_name
 *               - platforms
 *             properties:
 *               project_name:
 *                 type: string
 *                 example: "My Test Project"
 *               platforms:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [web, mobile, api]
 *                 example: ["web", "api"]
 *               api_testing:
 *                 type: boolean
 *                 example: true
 *               dev_base_url:
 *                 type: string
 *                 example: "https://dev.example.com"
 *               prod_base_url:
 *                 type: string
 *                 example: "https://example.com"
 *               settings:
 *                 type: object
 *     responses:
 *       201:
 *         description: Workspace created successfully
 *       400:
 *         description: Invalid request
 */
router.post(
  '/',
  requireAuth,
  asyncHandler(createWorkspace)
);

/**
 * @swagger
 * /api/v1/workspaces:
 *   get:
 *     summary: Get all workspaces for current user
 *     description: Returns list of workspaces (authenticated or anonymous via IP)
 *     tags: [Workspaces]
 *     responses:
 *       200:
 *         description: List of workspaces
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(getWorkspaces)
);

/**
 * @swagger
 * /api/v1/workspaces/onboarding:
 *   post:
 *     summary: Save onboarding data
 *     description: Saves onboarding data (project name, base URLs, environments, browser type) for the user's workspace
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
 *               - name
 *               - baseUrls
 *               - environments
 *               - browserType
 *             properties:
 *               name:
 *                 type: string
 *                 example: "My Test Project"
 *               baseUrls:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["https://dev.example.com", "https://staging.example.com"]
 *               environments:
 *                 type: object
 *                 properties:
 *                   dev:
 *                     type: string
 *                     example: "https://dev.example.com"
 *                   predprod:
 *                     type: string
 *                     example: "https://staging.example.com"
 *                   prod:
 *                     type: string
 *                     example: "https://prod.example.com"
 *               browserType:
 *                 type: string
 *                 enum: [chrome, firefox, safari, edge]
 *                 default: chrome
 *                 example: "chrome"
 *     responses:
 *       200:
 *         description: Onboarding data saved successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/onboarding',
  requireAuth,
  asyncHandler(saveOnboarding)
);

// Lightweight B2C profile capture (role + goal/source) for the dashboard
// one-time modal. Does not require the full onboarding payload.
router.put(
  '/profile',
  requireAuth,
  asyncHandler(saveProfile)
);

/**
 * @swagger
 * /api/v1/workspaces/onboarding:
 *   get:
 *     summary: Get onboarding data
 *     description: |
 *       Returns onboarding data if already completed, or completed: false if not
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: |
 *           Onboarding data or completed: false
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   oneOf:
 *                     - type: object
 *                       properties:
 *                         completed:
 *                           type: boolean
 *                           example: false
 *                     - type: object
 *                       properties:
 *                         name:
 *                           type: string
 *                           example: "My Test Project"
 *                         baseUrls:
 *                           type: array
 *                           items:
 *                             type: string
 *                           example: ["https://dev.example.com", "https://prod.example.com"]
 *                         environments:
 *                           type: object
 *                           properties:
 *                             dev:
 *                               type: string
 *                             predprod:
 *                               type: string
 *                             prod:
 *                               type: string
 *                         browserType:
 *                           type: string
 *                           enum: [chrome, firefox, safari, edge]
 *                         completed:
 *                           type: boolean
 *                           example: true
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/onboarding',
  requireAuth,
  asyncHandler(getOnboarding)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}:
 *   get:
 *     summary: Get workspace by ID
 *     description: Returns a specific workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Workspace details
 *       404:
 *         description: Workspace not found
 */
router.get(
  '/:id',
  requireAuth,
  asyncHandler(getWorkspace)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}:
 *   put:
 *     summary: Update workspace
 *     description: Updates an existing workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Workspace updated
 *       404:
 *         description: Workspace not found
 */
router.put(
  '/:id',
  requireAuth,
  asyncHandler(updateWorkspace)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}:
 *   delete:
 *     summary: Delete workspace
 *     description: Deletes a workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Workspace deleted
 *       404:
 *         description: Workspace not found
 */
router.delete(
  '/:id',
  requireAuth,
  asyncHandler(deleteWorkspace)
);

// ============================================================================
// LOGO ENDPOINTS
// ============================================================================

/**
 * @swagger
 * /api/v1/workspaces/{id}/logo:
 *   post:
 *     summary: Upload workspace logo
 *     description: |
 *       Upload a logo for the workspace. Replaces existing logo if present.
 *       Requires owner or full_access role (WORKSPACE_WRITE permission).
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
 *         description: Workspace ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - logo
 *             properties:
 *               logo:
 *                 type: string
 *                 format: binary
 *                 description: Logo image file (PNG, JPG, SVG, WebP, max 2MB)
 *     responses:
 *       200:
 *         description: Logo uploaded successfully
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
 *                     logo_url:
 *                       type: string
 *                       example: "https://xxx.supabase.co/storage/v1/object/public/workspace-logos/..."
 *                     file_name:
 *                       type: string
 *                       example: "logo_1234567890.png"
 *                     file_size:
 *                       type: number
 *                       example: 102400
 *                     uploaded_at:
 *                       type: string
 *                       format: date-time
 *                 message:
 *                   type: string
 *                   example: "Logo uploaded successfully"
 *       400:
 *         description: Invalid request (missing file, invalid format, file too large)
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Access denied (requires owner or full_access role)
 *       404:
 *         description: Workspace not found
 */
router.post(
  '/:id/logo',
  requireAuth,
  uploadLogo.single('logo'),
  asyncHandler(uploadWorkspaceLogo)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/logo:
 *   delete:
 *     summary: Delete workspace logo
 *     description: |
 *       Delete the workspace logo. Requires owner or full_access role (WORKSPACE_WRITE permission).
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
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Logo deleted successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Access denied (requires owner or full_access role)
 *       404:
 *         description: Workspace not found or no logo exists
 */
router.delete(
  '/:id/logo',
  requireAuth,
  asyncHandler(deleteWorkspaceLogo)
);

// ============================================================================
// AI USAGE ENDPOINTS
// ============================================================================

/**
 * @swagger
 * /api/v1/workspaces/{id}/ai-usage:
 *   get:
 *     summary: Get AI usage statistics for workspace
 *     description: Returns aggregated AI token usage and cost statistics for the workspace
 *     tags: [AI Usage]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for filtering (ISO 8601)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for filtering (ISO 8601)
 *       - in: query
 *         name: operationType
 *         schema:
 *           type: string
 *           enum: [lite-test, pro-test, chat, test-plan, api-test, analysis]
 *         description: Filter by operation type
 *     responses:
 *       200:
 *         description: AI usage statistics
 *       403:
 *         description: Access denied
 */
router.get(
  '/:id/ai-usage',
  requireAuth,
  asyncHandler(getWorkspaceAIUsage)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/ai-usage/history:
 *   get:
 *     summary: Get AI usage history
 *     description: Returns list of AI usage records for the workspace
 *     tags: [AI Usage]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for filtering
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for filtering
 *       - in: query
 *         name: operationType
 *         schema:
 *           type: string
 *         description: Filter by operation type
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *     responses:
 *       200:
 *         description: List of AI usage records
 *       403:
 *         description: Access denied
 */
router.get(
  '/:id/ai-usage/history',
  requireAuth,
  asyncHandler(getWorkspaceAIUsageHistory)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/ai-usage/daily:
 *   get:
 *     summary: Get daily AI usage statistics
 *     description: Returns daily aggregated usage for charting
 *     tags: [AI Usage]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *       - in: query
 *         name: startDate
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date (required)
 *       - in: query
 *         name: endDate
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date (required)
 *     responses:
 *       200:
 *         description: Daily usage statistics
 *       400:
 *         description: Missing required parameters
 *       403:
 *         description: Access denied
 */
router.get(
  '/:id/ai-usage/daily',
  requireAuth,
  asyncHandler(getWorkspaceAIUsageDaily)
);

/**
 * @swagger
 * /api/v1/tests/{testId}/ai-usage:
 *   get:
 *     summary: Get AI usage for a specific test
 *     description: Returns AI token usage and cost for a single test execution
 *     tags: [AI Usage]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Test ID
 *     responses:
 *       200:
 *         description: Test AI usage data
 *       403:
 *         description: Access denied
 *       404:
 *         description: No usage data found for test
 */
// Note: This route should be mounted at a different base path (e.g., /api/v1/tests)
// For now, we export the handler for use in other route files
export { getTestAIUsage };

// ============================================================================
// MEMBERS ENDPOINTS
// ============================================================================

/**
 * @swagger
 * /api/v1/workspaces/{id}/members:
 *   get:
 *     summary: Get workspace members
 *     description: Returns all members of the workspace. Requires active membership.
 *     tags: [Workspace Members]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: List of members
 *       403:
 *         description: Not a member of this workspace
 */
router.get(
  '/:id/members',
  requireAuth,
  asyncHandler(getMembers)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/members/{userId}:
 *   patch:
 *     summary: Change member role
 *     description: Change a member's role. Owner only.
 *     tags: [Workspace Members]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Target user ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - role
 *             properties:
 *               role:
 *                 type: string
 *                 enum: [full_access, view]
 *     responses:
 *       200:
 *         description: Role updated successfully
 *       403:
 *         description: Owner access required
 */
router.patch(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(changeMemberRole)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/members/{userId}:
 *   delete:
 *     summary: Remove member
 *     description: Remove a member from the workspace (soft delete). Owner only.
 *     tags: [Workspace Members]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Target user ID
 *     responses:
 *       200:
 *         description: Member removed successfully
 *       403:
 *         description: Owner access required
 */
router.delete(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(removeMember)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/transfer-owner:
 *   post:
 *     summary: Transfer ownership
 *     description: Transfer workspace ownership to another member. Current owner only.
 *     tags: [Workspace Members]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - newOwnerUserId
 *             properties:
 *               newOwnerUserId:
 *                 type: string
 *                 format: uuid
 *                 description: User ID of the new owner
 *     responses:
 *       200:
 *         description: Ownership transferred successfully
 *       403:
 *         description: Owner access required
 */
router.post(
  '/:id/transfer-owner',
  requireAuth,
  asyncHandler(transferOwnership)
);

// ============================================================================
// INVITES ENDPOINTS
// ============================================================================

/**
 * @swagger
 * /api/v1/workspaces/{id}/invites:
 *   post:
 *     summary: Create invite
 *     description: Invite a user to the workspace by email. Owner only.
 *     tags: [Workspace Invites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - role
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               role:
 *                 type: string
 *                 enum: [full_access, view]
 *     responses:
 *       201:
 *         description: Invite created successfully
 *       403:
 *         description: Owner access required
 */
router.post(
  '/:id/invites',
  requireAuth,
  asyncHandler(createInvite)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/invites:
 *   get:
 *     summary: Get invites
 *     description: Get all invites for the workspace. Owner only.
 *     tags: [Workspace Invites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: List of invites
 *       403:
 *         description: Owner access required
 */
router.get(
  '/:id/invites',
  requireAuth,
  asyncHandler(getInvites)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/invites/{inviteId}/resend:
 *   post:
 *     summary: Resend invite
 *     description: Resend an invite email and extend expiry. Owner only.
 *     tags: [Workspace Invites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *       - in: path
 *         name: inviteId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Invite ID
 *     responses:
 *       200:
 *         description: Invite resent successfully
 *       403:
 *         description: Owner access required
 */
router.post(
  '/:id/invites/:inviteId/resend',
  requireAuth,
  asyncHandler(resendInvite)
);

/**
 * @swagger
 * /api/v1/workspaces/{id}/invites/{inviteId}/revoke:
 *   post:
 *     summary: Revoke invite
 *     description: Revoke a pending invite. Owner only.
 *     tags: [Workspace Invites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Workspace ID
 *       - in: path
 *         name: inviteId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Invite ID
 *     responses:
 *       200:
 *         description: Invite revoked successfully
 *       403:
 *         description: Owner access required
 */
router.post(
  '/:id/invites/:inviteId/revoke',
  requireAuth,
  asyncHandler(revokeInvite)
);

// ============================================================================
// CREDITS (workspace balance + transaction history)
// ============================================================================

/**
 * @swagger
 * /api/v1/workspaces/{id}/credits:
 *   get:
 *     summary: Get workspace credits
 *     description: Returns balance, plan, and monthly usage for an active member.
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Workspace credits info
 *       403:
 *         description: Not a member of this workspace
 */
router.get('/:id/credits', requireAuth, asyncHandler(getCredits));

/**
 * @swagger
 * /api/v1/workspaces/{id}/credits/transactions:
 *   get:
 *     summary: Get workspace credit transactions
 *     description: Paginated credit transaction history for an active member.
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *     responses:
 *       200:
 *         description: Paginated transactions
 *       403:
 *         description: Not a member of this workspace
 */
router.get(
  '/:id/credits/transactions',
  requireAuth,
  asyncHandler(getCreditTransactions)
);

// ============================================================================
// AUDIT LOG (workspace activity feed)
// ============================================================================

/**
 * @swagger
 * /api/v1/workspaces/{id}/audit-log:
 *   get:
 *     summary: Get workspace audit log
 *     description: Paginated activity feed for workspace owners. Supports action filter.
 *     tags: [Workspaces]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: action
 *         description: Event type filter, or "all" for no filter
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated audit log entries
 *       403:
 *         description: Owner access required
 */
router.get(
  '/:id/audit-log',
  requireAuth,
  asyncHandler(getAuditLog)
);

// ============================================================================
// GLOBAL INVITE ACCEPT ENDPOINT
// ============================================================================

/**
 * @swagger
 * /api/v1/invites/{inviteId}/accept:
 *   post:
 *     summary: Accept invite
 *     description: Accept a workspace invite. Authenticated user only. Email must match invite email.
 *     tags: [Workspace Invites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: inviteId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Invite ID
 *     responses:
 *       200:
 *         description: Invite accepted successfully
 *       400:
 *         description: Invalid invite or email mismatch
 */
// Note: This route is defined here but should be mounted at /api/v1/invites in index.ts
// For now, we'll add it as a separate route file or handle in a different way

// ============================================================================
// MULTER ERROR HANDLING FOR LOGO UPLOADS
// ============================================================================

// Error handler middleware for logo upload errors
router.use((error: any, req: any, res: any, next: any) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large',
        message: 'Logo file must be smaller than 2MB',
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(400).json({
      success: false,
      error: 'Upload error',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }

  if (error.message === 'Only PNG, JPG, SVG, and WebP files are allowed') {
    return res.status(400).json({
      success: false,
      error: 'Invalid file type',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }

  next(error);
});

export default router;

// Export accept invite handler for mounting at /api/v1/invites
export { acceptInvite };
