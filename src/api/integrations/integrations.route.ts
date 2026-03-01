import express from 'express';
import { requireAuth as authenticateUser } from '@/middleware/auth.middleware';
import {
  listIntegrations,
  getIntegrationStatus,
  startAuthorization,
  handleCallback,
  disconnectIntegration,
  listGitHubRepos,
  listGitHubBranches,
  listGitLabRepos,
  listGitLabBranches,
  setupSlack,
  setupTelegram,
} from './integrations.controller';

const router = express.Router();

/**
 * @swagger
 * /integrations:
 *   get:
 *     summary: List connected integrations
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         schema:
 *           type: string
 *         description: Filter by workspace ID
 *     responses:
 *       200:
 *         description: List of connected integrations
 *       401:
 *         description: Unauthorized
 */
router.get('/', authenticateUser, listIntegrations);

/**
 * @swagger
 * /integrations/status:
 *   get:
 *     summary: Get connection status for all integration providers
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         schema:
 *           type: string
 *         description: Filter by workspace ID
 *     responses:
 *       200:
 *         description: Per-provider connection status
 *       401:
 *         description: Unauthorized
 */
router.get('/status', authenticateUser, getIntegrationStatus);

/**
 * @swagger
 * /integrations/github/repos:
 *   get:
 *     summary: List GitHub repos for the authenticated user (for repo dropdown)
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Repos per page (max 100)
 *     responses:
 *       200:
 *         description: List of repos
 *       403:
 *         description: GitHub not connected
 *       401:
 *         description: Unauthorized
 */
router.get('/github/repos', authenticateUser, listGitHubRepos);

/**
 * @swagger
 * /integrations/github/repos/{owner}/{repo}/branches:
 *   get:
 *     summary: List branches for a GitHub repo (for branch dropdown)
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: owner
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: repo
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of branches
 *       403:
 *         description: GitHub not connected
 *       401:
 *         description: Unauthorized
 */
router.get('/github/repos/:owner/:repo/branches', authenticateUser, listGitHubBranches);

/**
 * @swagger
 * /integrations/gitlab/repos:
 *   get:
 *     summary: List GitLab projects (repos) for the authenticated user
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: per_page
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Projects per page (max 100)
 *     responses:
 *       200:
 *         description: List of projects
 *       403:
 *         description: GitLab not connected
 *       401:
 *         description: Unauthorized
 */
router.get('/gitlab/repos', authenticateUser, listGitLabRepos);

/**
 * @swagger
 * /integrations/gitlab/projects/{projectId}/branches:
 *   get:
 *     summary: List branches for a GitLab project
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: GitLab project ID (numeric) or URL-encoded path (e.g. owner%2Frepo)
 *     responses:
 *       200:
 *         description: List of branches
 *       403:
 *         description: GitLab not connected
 *       401:
 *         description: Unauthorized
 */
router.get('/gitlab/projects/:projectId/branches', authenticateUser, listGitLabBranches);

/**
 * @swagger
 * /integrations/{provider}/authorize:
 *   get:
 *     summary: Start OAuth authorization flow
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *           enum: [jira, github, gitlab, notion, trello, slack, telegram]
 *         description: Integration provider
 *       - in: query
 *         name: workspace_id
 *         schema:
 *           type: string
 *         description: Workspace ID to associate integration with
 *     responses:
 *       302:
 *         description: Redirect to OAuth provider
 *       400:
 *         description: Invalid provider
 *       401:
 *         description: Unauthorized
 */
router.get('/:provider/authorize', authenticateUser, startAuthorization);

/**
 * @swagger
 * /integrations/{provider}/callback:
 *   get:
 *     summary: OAuth callback handler
 *     tags: [Integrations]
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *         description: Integration provider
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: OAuth authorization code
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: OAuth state parameter
 *     responses:
 *       302:
 *         description: Redirect to frontend
 */
router.get('/:provider/callback', handleCallback);

/**
 * @swagger
 * /integrations/{provider}:
 *   delete:
 *     summary: Disconnect integration
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *         description: Integration provider
 *       - in: query
 *         name: external_id
 *         schema:
 *           type: string
 *         description: External ID (optional, for multiple integrations of same provider)
 *     responses:
 *       200:
 *         description: Integration disconnected
 *       401:
 *         description: Unauthorized
 */
router.delete('/:provider', authenticateUser, disconnectIntegration);

/**
 * @swagger
 * /integrations/telegram/setup:
 *   post:
 *     summary: Setup Telegram bot integration
 *     tags: [Integrations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         schema:
 *           type: string
 *         description: Workspace ID to associate bot with
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bot_token
 *             properties:
 *               bot_token:
 *                 type: string
 *                 description: Bot token from @BotFather
 *                 example: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
 *               chat_id:
 *                 type: string
 *                 description: Default chat ID (optional)
 *                 example: "-1001234567890"
 *               description:
 *                 type: string
 *                 description: User-provided description/label for the bot
 *                 example: "QA Notifications Bot"
 *     responses:
 *       200:
 *         description: Telegram bot configured successfully
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
 *                     id:
 *                       type: string
 *                     provider:
 *                       type: string
 *                     bot_username:
 *                       type: string
 *                     bot_name:
 *                       type: string
 *                     bot_id:
 *                       type: number
 *                     chat_id:
 *                       type: string
 *                     external_url:
 *                       type: string
 *                     enabled:
 *                       type: boolean
 *                     created_at:
 *                       type: string
 *                     updated_at:
 *                       type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid bot token or missing required fields
 *       401:
 *         description: Unauthorized
 */
router.post('/slack/setup', authenticateUser, setupSlack);
router.post('/telegram/setup', authenticateUser, setupTelegram);

export default router;
