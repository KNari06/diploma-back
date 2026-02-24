/**
 * Regression Plans Routes
 * CRUD routes for regression plans
 */

import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
    addItem,
    createPlan,
    deletePlan,
    expandPlan,
    getPlan,
    getPlanAnalytics,
    getPlanBugsSummary,
    getPlanHealthReport,
    getScopeItems,
    listPlans,
    removeItem,
    updatePlan,
} from './plans.controller';

const router = Router();

/**
 * @swagger
 * /api/v1/regression-plans:
 *   get:
 *     summary: List regression plans for a project (with stats)
 *     description: Returns plans enriched with scope (test/flow counts), latest run info, and health status
 *     tags: [Regression Plans]
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
 *         description: List of plans with stats
 *   post:
 *     summary: Create a new regression plan
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - name
 *             properties:
 *               projectId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               isDefault:
 *                 type: boolean
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               automationConfig:
 *                 type: object
 *                 description: Automation settings (schedule, git triggers, runtime)
 *                 properties:
 *                   schedule:
 *                     type: object
 *                     properties:
 *                       enabled:
 *                         type: boolean
 *                       days:
 *                         type: array
 *                         items:
 *                           type: string
 *                       time:
 *                         type: string
 *                         description: "HH:MM format"
 *                       timezone:
 *                         type: string
 *                   gitTriggers:
 *                     type: object
 *                     properties:
 *                       enabled:
 *                         type: boolean
 *                       triggerTypes:
 *                         type: array
 *                         items:
 *                           type: string
 *                           enum: [merge_to_main, pr_opened, release]
 *                       branch:
 *                         type: string
 *                         description: Branch to trigger on (e.g. main, develop)
 *                       integrationId:
 *                         type: string
 *                         format: uuid
 *                         description: Git integration ID (from GET /git-integrations). Use when repo already added.
 *                       repositoryUrl:
 *                         type: string
 *                         description: "Repo URL from GET /integrations/github/repos (e.g. https://github.com/owner/repo). Used when dropdown shows user's repos."
 *                       webhookSecret:
 *                         type: string
 *                         description: Required when repositoryUrl is set and no git-integration exists for this project+repo
 *                   runtime:
 *                     type: object
 *                     properties:
 *                       environment:
 *                         type: string
 *                         enum: [staging, production, development]
 *                       browser:
 *                         type: string
 *                         enum: [chrome, firefox, safari, edge]
 *               notificationsEnabled:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Plan created
 */
router.get('/', requireAuth, listPlans);
router.post('/', requireAuth, createPlan);

/**
 * @swagger
 * /api/v1/regression-plans/scope-items:
 *   get:
 *     summary: Get scope items for plan builder (modules, flows, test cases with counts)
 *     description: Returns all modules, flows, and test cases for a project with test/flow counts and platform info. Used by the "Create Regression" scope picker UI.
 *     tags: [Regression Plans]
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
 *         description: Scope items with counts
 */
router.get('/scope-items', requireAuth, getScopeItems);

/**
 * @swagger
 * /api/v1/regression-plans/{id}/health:
 *   get:
 *     summary: Get plan health report
 *     description: Returns current health, run history trend, and flaky tests
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: historyLimit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 50
 *     responses:
 *       200:
 *         description: Plan health report
 *       404:
 *         description: Plan not found
 */
router.get('/:id/health', requireAuth, getPlanHealthReport);

/**
 * @swagger
 * /api/v1/regression-plans/{id}/analytics:
 *   get:
 *     summary: Get plan-level analytics (trends over time)
 *     description: Returns trend data for pass_rate, duration, or flaky_rate bucketed by interval
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: metric
 *         required: true
 *         schema:
 *           type: string
 *           enum: [pass_rate, duration, flaky_rate]
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *           minimum: 1
 *           maximum: 365
 *       - in: query
 *         name: interval
 *         schema:
 *           type: string
 *           default: 1d
 *           description: "Interval format: Nd (days), Nh (hours), Nw (weeks)"
 *     responses:
 *       200:
 *         description: Analytics trend data
 *       404:
 *         description: Plan not found
 */
router.get('/:id/analytics', requireAuth, getPlanAnalytics);

/**
 * @swagger
 * /api/v1/regression-plans/{id}/bugs/summary:
 *   get:
 *     summary: Get bug summary aggregated from recent runs
 *     description: Aggregates bugs from the latest N runs of a plan with severity/category breakdown and deduplication
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 5
 *           minimum: 1
 *           maximum: 20
 *           description: Number of recent runs to analyze
 *     responses:
 *       200:
 *         description: Bug summary with severity/category breakdown and trends
 *       404:
 *         description: Plan not found
 */
router.get('/:id/bugs/summary', requireAuth, getPlanBugsSummary);

/**
 * @swagger
 * /api/v1/regression-plans/{id}:
 *   get:
 *     summary: Get plan by ID with items
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Plan with items
 *   patch:
 *     summary: Update a plan
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               isDefault:
 *                 type: boolean
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               automationConfig:
 *                 type: object
 *                 description: Automation settings (schedule, git triggers, runtime)
 *               notificationsEnabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Plan updated
 *   delete:
 *     summary: Delete a plan
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Plan deleted
 */
router.get('/:id', requireAuth, getPlan);
router.patch('/:id', requireAuth, updatePlan);
router.delete('/:id', requireAuth, deletePlan);

/**
 * @swagger
 * /api/v1/regression-plans/{id}/items:
 *   post:
 *     summary: Add an item to a plan
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
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
 *             required:
 *               - itemType
 *             properties:
 *               itemType:
 *                 type: string
 *                 enum: [module, flow, test_case]
 *               moduleId:
 *                 type: string
 *                 format: uuid
 *               flowId:
 *                 type: string
 *                 format: uuid
 *               testCaseId:
 *                 type: string
 *                 format: uuid
 *               testCaseType:
 *                 type: string
 *                 enum: [ui, api]
 *     responses:
 *       200:
 *         description: Item added
 */
router.post('/:id/items', requireAuth, addItem);

/**
 * @swagger
 * /api/v1/regression-plans/{id}/items/{itemId}:
 *   delete:
 *     summary: Remove an item from a plan
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Item removed
 */
router.delete('/:id/items/:itemId', requireAuth, removeItem);

/**
 * @swagger
 * /api/v1/regression-plans/{id}/expand:
 *   get:
 *     summary: Expand plan to individual test cases
 *     tags: [Regression Plans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Expanded test cases
 */
router.get('/:id/expand', requireAuth, expandPlan);

export default router;
