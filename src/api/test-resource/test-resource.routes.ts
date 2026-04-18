/**
 * Test Resource Routes
 *
 * POST   /api/v1/test-resource                       — Create a resource of any kind
 * GET    /api/v1/test-resource/project/:projectId    — List (optional ?kind= filter)
 * GET    /api/v1/test-resource/resolve               — Resolve default for a scope
 * PUT    /api/v1/test-resource/default               — Set default for a scope
 * DELETE /api/v1/test-resource/default               — Clear default for a scope
 * GET    /api/v1/test-resource/:id                   — Read one
 * PUT    /api/v1/test-resource/:id                   — Update
 * DELETE /api/v1/test-resource/:id                   — Delete (optional reassign)
 * POST   /api/v1/test-resource/:id/capture           — Persist freshly captured state
 * POST   /api/v1/test-resource/:id/mark-broken       — Runner: recipe no longer works
 *
 * Auth middleware is applied at mount time (src/index.ts:
 * `requireAuth + requireApproved`).
 */

import { Router } from 'express';
import {
  createResource,
  listByProject,
  getResource,
  updateResource,
  deleteResource,
  captureState,
  markBroken,
  resolveDefault,
  setDefault,
  clearDefault,
} from './test-resource.controller';

const router = Router();

// Collection + default routes first — otherwise "resolve" / "default" are
// swallowed by the /:id catch-all.
router.post('/', createResource);
router.get('/project/:projectId', listByProject);
router.get('/resolve', resolveDefault);
router.put('/default', setDefault);
router.delete('/default', clearDefault);

// Per-resource routes
router.get('/:id', getResource);
router.put('/:id', updateResource);
router.delete('/:id', deleteResource);
router.post('/:id/capture', captureState);
router.post('/:id/mark-broken', markBroken);

export default router;
