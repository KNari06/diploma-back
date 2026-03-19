/**
 * Email Inbox Routes — V12
 */

import { Router } from 'express';
import { requireAuth, requireApproved } from '@/middleware/auth.middleware';
import { generateAddress, listEmails, getStatus } from './email-inbox.controller';

const router = Router();

// All routes require authentication
router.use(requireAuth, requireApproved);

// Status check (no auth needed for availability check)
router.get('/status', getStatus);

// Generate inbox address for a test case
router.post('/address', generateAddress);

// List emails for debugging
router.get('/emails', listEmails);

export default router;
