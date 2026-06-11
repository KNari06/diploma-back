/**
 * API Flow Spec Routes
 *
 * POST   /api/v1/api-flow-spec/parse             — Parse Swagger/OpenAPI/Postman/etc spec
 * GET    /api/v1/api-flow-spec/project/:projectId — List flow specs for a project
 * GET    /api/v1/api-flow-spec/:id                — Get flow spec + visualization
 * PUT    /api/v1/api-flow-spec/:id                — Update flow spec (DAG, error strategy)
 * DELETE /api/v1/api-flow-spec/:id                — Delete flow spec
 * POST   /api/v1/api-flow-spec/:id/run            — Start flow execution
 * POST   /api/v1/api-flow-spec/:id/stop           — Cancel running execution
 * POST   /api/v1/api-flow-spec/:id/reparse        — Re-fetch spec and rebuild DAG
 * GET    /api/v1/api-flow-spec/:id/runs            — List execution history
 * GET    /api/v1/api-flow-spec/:id/runs/:runId     — Get specific run details
 */

import { Router } from 'express';
import {
  parseSpec,
  listByProject,
  getById,
  updateSpec,
  deleteSpec,
  runFlow,
  stopFlow,
  getRuns,
  getRunById,
  reparseSpec,
  refineNode,
  generateNodeCases,
  saveNodeCases,
} from './apiFlowSpec.controller';

const router = Router();

// Parse spec (must come before /:id routes to avoid conflicts)
router.post('/parse', parseSpec);

// Project-scoped listing
router.get('/project/:projectId', listByProject);

// Flow spec CRUD
router.get('/:id', getById);
router.put('/:id', updateSpec);
router.delete('/:id', deleteSpec);

// Execution
router.post('/:id/run', runFlow);
router.post('/:id/stop', stopFlow);
router.post('/:id/reparse', reparseSpec);

// Per-node AI refine
router.post('/:id/nodes/:nodeId/refine', refineNode);

// Case Matrix: AI-generate / save cases for a node
router.post('/:id/nodes/:nodeId/cases/generate', generateNodeCases);
router.put('/:id/nodes/:nodeId/cases', saveNodeCases);

// Run history
router.get('/:id/runs', getRuns);
router.get('/:id/runs/:runId', getRunById);

export default router;
