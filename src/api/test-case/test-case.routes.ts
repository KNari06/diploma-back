/**
 * Test Case Routes
 * API endpoints for structured test case execution
 */

import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import { executeTestCase } from './test-case.controller';

const router = Router();

/**
 * POST /api/v1/test-case/execute
 * Execute a structured test case
 *
 * Body:
 * {
 *   testCase: TestCase,
 *   credentials?: { username?: string, password?: string },
 *   chatSessionId?: string
 * }
 */
router.post('/execute', requireAuth, executeTestCase);

export default router;
