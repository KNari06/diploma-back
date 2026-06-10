import { requireAuth, requireApproved, requireCredits } from '@/middleware/auth.middleware';
import { Router } from 'express';
import { EXPLORATION_DISCOVERY_CREDITS } from '@/config/testing/intelligent-test-limits';
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
// as an id param. The credit gate requires the SAME amount that the job
// charges on completion (EXPLORATION_DISCOVERY_CREDITS) — otherwise a user
// could pass a smaller gate then fail the real charge (free tier grace = 0),
// getting the discovery for free. Running the discovered tests is billed
// separately, per step, on the run-discovered path.
router.post('/start', requireAuth, requireApproved, requireCredits(EXPLORATION_DISCOVERY_CREDITS), startExploration);

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
