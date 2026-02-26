// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONSTANTS (FIX #9: Centralized magic numbers)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const CONSTANTS = {
  // Chat history
  RECENT_MESSAGES_LIMIT: 30, // Increased from 20 for single workspace chat with richer context

  // Knowledge base search
  KB_MATCH_COUNT: 3,
  KB_MATCH_THRESHOLD: 0.5, // Lowered from 0.6 for better recall on short/ambiguous questions

  // Timeouts
  FUZZING_TIMEOUT: 30000, // 30 seconds
  AUTO_EMBED_TIMEOUT: 30000, // 30 seconds (increased from 5s to allow more messages to embed)
  CHAT_REQUEST_TIMEOUT: 180000, // 3 minutes (180 seconds) - increased from 30s to allow OpenAI retries

  // Test plan expiration
  TEST_PLAN_EXPIRY_HOURS: 72, // 3 days

  // Auto-summarization
  SUMMARIZE_THRESHOLD: 50, // Trigger summarization when total messages exceed this
  MESSAGES_TO_SUMMARIZE: 30, // Number of oldest messages to summarize per batch
  KEEP_RECENT: 20, // Never summarize the last N messages
  MAX_SUMMARY_TOKENS: 2000, // Cap total summary context in tokens
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FAST PATH COMMANDS (Centralized for frontend quick commands)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const FAST_PATH_COMMANDS = {
  // Message prefix commands (from frontend message field)
  API_TEST_PREFIX: 'RUN_API_TEST:',
  // TODO: Add more prefix commands here in the future
  // PLATFORM_TEST_PREFIX: 'RUN_PLATFORM_TEST:',
  // GENERAL_CHAT_PREFIX: 'GENERAL_CHAT:',

  // Context action commands (from frontend context.action field)
  ACTIONS: {
    RUN_API_TEST: 'run_api_test',
    // TODO: Add more action commands here in the future
    // RUN_PLATFORM_TEST: 'run_platform_test',
    // RUN_GENERAL_CHAT: 'run_general_chat',
  },
} as const;

// Progress percentages for consistent WebSocket updates
export const PROGRESS = {
  START: 0,
  ENRICHING: 10,
  INTENT_PARSING: 20,
  INTENT_PARSED: 40,
  ROUTING: 50,
  // Sub-agent pipeline phases (55-95 range)
  PIPELINE_ROUTING: 55,
  PIPELINE_ROUTING_DONE: 60,
  PIPELINE_PLANNING: 62,
  PIPELINE_PLANNING_DONE: 68,
  PIPELINE_TOOL_BASE: 70,
  PIPELINE_TOOL_CEILING: 88,
  PIPELINE_REVIEWING: 89,
  PIPELINE_FORMATTING: 90,
  PIPELINE_SPAWNING: 71,
  PIPELINE_DONE: 95,
} as const;

// Response messages
export const MESSAGES = {
  APPROVAL_UNCLEAR: '❓ I didn\'t quite understand. Could you please clarify?\n\n✅ Approve and run the test?\n❌ Cancel?',
  TEST_REJECTED: '❌ Test plan canceled. Feel free to request a different test or ask any questions!',
  REQUEST_TIMEOUT: '⏱️ Request timeout - please try again',
  INVALID_REQUEST: '❌ Invalid request - message is required',
  AUTH_REQUIRED: '🔒 Authentication required',
} as const;
