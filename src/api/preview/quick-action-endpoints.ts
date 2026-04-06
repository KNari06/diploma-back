/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUICK ACTION ENDPOINT WHITELIST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Security-critical: this is the ONLY list of HTTP endpoints that the
 * frontend Quick Actions framework is allowed to invoke on behalf of an
 * AI-generated action descriptor.
 *
 * Why a whitelist?
 *   AI tool results inject `actions[]` into chat message metadata. Without
 *   a whitelist, a prompt-injection attack could craft an action like
 *   `DELETE /api/users/:id` and trick the frontend into executing it.
 *   The whitelist ensures the universe of possible actions is bounded and
 *   reviewed by humans, regardless of what an LLM tries to emit.
 *
 * Adding a new entry:
 *   1. The target route must already exist behind requireAuth middleware
 *      (this whitelist does NOT bypass authentication — every call still
 *      goes through the normal Express stack)
 *   2. Add an entry below with a clear description of what it does
 *   3. The endpoint string format is "METHOD /path" (uppercase verb, single space)
 *   4. The action descriptor MUST use the same exact string in its `endpoint` field
 *
 * Frontend behavior:
 *   - The frontend Quick Action handler validates that the endpoint string
 *     exists in this list before issuing any HTTP request
 *   - Unknown endpoints are silently rejected with a console error
 *
 * Backend behavior:
 *   - This file is import-only — it exports a Set for O(1) lookup
 *   - The injector (src/api/chat/general/sub-agents/quick-actions-injector.ts)
 *     defensively re-checks every emitted action against this whitelist before
 *     sending it to the frontend (catches programming mistakes early)
 *   - The frontend ships its own copy of this list at
 *     apps/web/src/services/quickActions/endpointWhitelist.js — keep in sync
 *     character-for-character. Drift = the action silently fails on the client
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The full list of endpoint identifiers in "METHOD /path" form.
 * Always uppercase the verb. Always single space between verb and path.
 */
export const QUICK_ACTION_ENDPOINTS = [
  /**
   * Persist a cached draft run as an intent_test_case.
   * Triggered by the "Save as test case" Quick Action that follows a
   * successful qa_run_draft_steps in editor mode.
   * Owner: src/api/preview/draft.controller.ts → saveDraftRunAsTestCase
   */
  'POST /api/v1/preview/draft/save-as-test-case',
] as const;

export type QuickActionEndpoint = typeof QUICK_ACTION_ENDPOINTS[number];

/**
 * O(1) membership check used by the framework wiring (and any future
 * server-side validators that want to defensively re-check action descriptors
 * before sending them to the frontend).
 */
const endpointSet: Set<string> = new Set(QUICK_ACTION_ENDPOINTS);

/**
 * Returns true if the given "METHOD /path" string is on the whitelist.
 */
export function isWhitelistedQuickActionEndpoint(endpoint: string): boolean {
  return endpointSet.has(endpoint);
}
