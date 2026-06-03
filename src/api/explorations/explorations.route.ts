import { requireAuth } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
  listExplorations,
  getExploration,
  getExplorationTestCases,
  getExplorationState,
  addToRegressionPlan,
  runDiscoveredTestCases,
} from './explorations.controller';

const router = Router();

// List exploration runs for a project
router.get('/', requireAuth, listExplorations);

// Get a single exploration run
router.get('/:explorationId', requireAuth, getExploration);

// Get discovered test cases for an exploration
router.get('/:explorationId/test-cases', requireAuth, getExplorationTestCases);

// Get exploration state snapshot (debug/monitoring)
router.get('/:explorationId/state', requireAuth, getExplorationState);

// Add selected test cases to a regression plan
router.post('/:explorationId/add-to-regression', requireAuth, addToRegressionPlan);

// Run the discovered test cases in one click (creates a throwaway plan + run)
router.post('/:explorationId/run-discovered', requireAuth, runDiscoveredTestCases);

export default router;
