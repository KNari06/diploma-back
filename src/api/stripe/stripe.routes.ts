import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/utils/core/error-handler';
import { Router } from 'express';
import {
  createCheckoutSession,
  createPortalSession,
  getBillingTransactions,
  getBillingStatus,
} from './stripe.controller';

const router = Router();

/**
 * @swagger
 * /api/billing/checkout:
 *   post:
 *     summary: Create Stripe Checkout Session
 *     description: Creates a Stripe Checkout session for subscription purchase
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - plan_code
 *             properties:
 *               plan_code:
 *                 type: string
 *                 example: pro_2500
 *     responses:
 *       200:
 *         description: Checkout session created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 url:
 *                   type: string
 *                   description: Stripe Checkout URL
 *                 session_id:
 *                   type: string
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.post('/checkout', requireAuth, asyncHandler(createCheckoutSession));

/**
 * @swagger
 * /api/billing/portal:
 *   post:
 *     summary: Create Stripe Customer Portal Session
 *     description: Creates a session for Stripe Customer Portal to manage subscription
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Portal session created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 url:
 *                   type: string
 *                   description: Stripe Customer Portal URL
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: No Stripe customer found
 *       500:
 *         description: Server error
 */
router.post('/portal', requireAuth, asyncHandler(createPortalSession));

/**
 * @swagger
 * /api/billing/status:
 *   get:
 *     summary: Get billing status
 *     description: Get current user's billing status including plan, credits, and subscription info
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Billing status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 plan:
 *                   type: string
 *                 plan_status:
 *                   type: string
 *                 credits_balance:
 *                   type: number
 *                 current_period_end:
 *                   type: string
 *                   format: date-time
 *                 cancel_at_period_end:
 *                   type: boolean
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get('/status', requireAuth, asyncHandler(getBillingStatus));

/**
 * @swagger
 * /api/billing/transactions:
 *   get:
 *     summary: Get billing transactions
 *     description: Get current user's Stripe transactions
 *     tags: [Billing]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Transactions retrieved successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get('/transactions', requireAuth, asyncHandler(getBillingTransactions));

// NOTE: the Stripe webhook is intentionally NOT defined on this shared router.
// This router is mounted at BOTH /billing and /stripe, but the raw-body parser
// (required for signature verification) is scoped only to /stripe/webhook. A
// webhook reachable via /billing/webhook would get a JSON-parsed body and fail
// signature verification on every event. The webhook is mounted exactly once,
// directly on the raw-body path, in index.ts.

export default router;
