import { Router } from 'express';
import { requireAuth } from '@/middleware/auth.middleware';
import {
  getEnvironments,
  getDefaultEnvironment,
  upsertEnvironment,
  getEndpoints,
  upsertEndpoint,
  analyzeApiUrl,
  executeWithConfig,
  bulkSetup,
} from './apiConfig.controller';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Environment routes
router.get('/environments/:projectId', getEnvironments);
router.get('/environments/:projectId/default', getDefaultEnvironment);
router.post('/environments/:projectId', upsertEnvironment);
router.put('/environments/:projectId', upsertEnvironment);

// Endpoint routes
router.get('/endpoints/:environmentId', getEndpoints);
router.post('/endpoints', upsertEndpoint);
router.put('/endpoints', upsertEndpoint);

// Smart configuration
router.post('/analyze/:projectId', analyzeApiUrl);
router.post('/execute', executeWithConfig);

// Bulk operations
router.post('/setup/:projectId', bulkSetup);

export default router;
