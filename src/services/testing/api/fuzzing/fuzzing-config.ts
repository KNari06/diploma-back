/**
 * Centralized Fuzzing Configuration
 * FIX #3: All fuzzing-related constants in one place
 * NEW: Follow-on scenario limits and safety checks
 */
export const FUZZING_CONFIG = {
  // Timeouts
  OUTER_TIMEOUT: 30000,        // Max total time for all scenarios (30s)
  SCENARIO_TIMEOUT: 5000,      // Max time per single scenario (5s)

  // Concurrency
  MAX_CONCURRENT_REQUESTS: 5,  // Max parallel fuzzing requests

  // Response handling
  MAX_BODY_PREVIEW: 500,       // Truncate response/request bodies at (bytes)
  MAX_HEADER_COUNT: 5,         // Max headers to show in evidence

  // Progress reporting
  PROGRESS_UPDATE_INTERVAL: 1, // Report progress every N scenarios

  // Follow-on scenario limits (NEW)
  FOLLOW_ON: {
    MAX_SCENARIOS: 10,          // Max follow-on scenarios to generate
    MIN_SCENARIOS: 3,           // Min follow-on scenarios expected from GPT
    MIN_CRITICAL_ISSUES: 1,     // Min critical issues needed to trigger follow-on
    ALLOWED_SEVERITIES: ['critical', 'high'] as const, // Only these severities trigger follow-on
    MAX_RETRIES: 2,             // Max retries if follow-on generation fails
  },
} as const;

export type FuzzingConfig = typeof FUZZING_CONFIG;
