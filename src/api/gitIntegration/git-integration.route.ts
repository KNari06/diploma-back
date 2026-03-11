import { Router } from 'express';
import { requireApproved, requireAuth } from '@/middleware/auth.middleware';
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  handleWebhook,
  listIntegrations,
  updateIntegration,
} from './git-integration.controller';

const router = Router();

// Webhook endpoint must be public (validated by signature/token)
router.post('/webhook', handleWebhook);
// GET so browser/health checks don't hit requireAuth and get 401
router.get('/webhook', (req, res) =>
  res.status(405).json({ success: true, message: 'Use POST to deliver webhook events' })
);

// All CRUD routes require authentication and approved status
router.use(requireAuth, requireApproved);

router.post('/', createIntegration);
router.get('/', listIntegrations);
router.get('/:id', getIntegration);
router.put('/:id', updateIntegration);
router.delete('/:id', deleteIntegration);

export default router;

