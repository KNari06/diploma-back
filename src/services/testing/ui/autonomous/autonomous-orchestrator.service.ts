/**
 * Autonomous testing workflow orchestrator
 *
 * Most of the approval-based workflow (runAutonomousExploration, confirmTestPlan,
 * rejectPlan) was removed — tests now run immediately via Lite mode in handler.ts.
 *
 * Only the helper for requesting missing information is still used.
 */

// Re-export helper function for external use (used by ai_test/handler.ts)
export { requestMissingInformation } from './helpers/missing-info';
