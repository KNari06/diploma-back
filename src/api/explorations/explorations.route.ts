import { requireAuth, requireApproved, requireCredits } from '@/middleware/auth.middleware';
import { Router } from 'express';
import {
  listExplorations,
  getExploration,
  getExplorationTestCases,
  getExplorationState,
  addToRegressionPlan,
  runDiscoveredTestCases,
  startExploration,
} from './explorations.controller';

const router = Router();

// Start an autonomous exploration from a URL (self-serve "magic first test").
// Declared before the '/:explorationId' GET routes so '/start' is not captured
// as an id param. requireCredits(1) is an entry gate (must have a positive
// balance to start); the fixed discovery cost is charged on completion in
// exploration-run.job.ts. Running the discovered tests is billed separately.
router.post('/start', requireAuth, requireApproved, requireCredits(1), startExploration);

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
