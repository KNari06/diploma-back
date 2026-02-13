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
