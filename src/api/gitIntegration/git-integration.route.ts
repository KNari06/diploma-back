import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
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

// All CRUD routes require authentication
router.use(requireAuth);

router.post('/', createIntegration);
router.get('/', listIntegrations);
router.get('/:id', getIntegration);
router.put('/:id', updateIntegration);
router.delete('/:id', deleteIntegration);

export default router;

