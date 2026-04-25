/**
 * Progress emission helpers for the mobile-agent pipeline.
 *
 * Bridges our internal tool names to the WebSocket `chat:processing:step`
 * contract the frontend already listens to (web + desktop). No new event
 * types — the frontend's <ChatProcessingIndicator/> renders our messages
 * verbatim once `sessionId` matches the active chat session.
 *
 * Two pieces of glue:
 *   1. humanizeMobileToolName: snake_case → "Sentence case" with
 *      mobile-specific labels (e.g. "Reading screen" instead of
 *      "Observe mobile page"). Tighter than the generic web humanizer
 *      because mobile tool names already encode platform metaphors.
 *   2. mobileToolProgress: maps round number → 55-95% range, matching the
 *      web pipeline's progress curve so visual UX stays consistent across
 *      web and mobile chats.
 *
 * Helper is non-blocking: emitProcessingStep itself swallows WS errors
 * and validates payload (see api/chat/shared/utils.ts:180-247). Callers
 * fire-and-forget; no try/catch needed at call sites.
 */

import { emitProcessingStep } from '@/api/chat/shared/utils';

// ─────────────────────────────────────────────────────────────────────────
// Tool name → human label
// ─────────────────────────────────────────────────────────────────────────

/**
 * Human-readable labels for mobile tool names. Surfaced in the streaming
 * timeline as "Reading screen…" / "Reading screen done".
 *
 * Keep entries terse — frontend renders them inline next to a pulsing
 * spinner. Long labels truncate awkwardly.
 */
const TOOL_LABELS: Record<string, string> = {
  observe_mobile_page: 'Reading screen',
  tap_element: 'Tapping element',
  type_text: 'Typing',
  swipe: 'Swiping',
  scroll: 'Scrolling',
  press_key: 'Pressing key',
  launch_app: 'Launching app',
  plan_flow: 'Drafting flow plan',
  start_plan_step: 'Starting step',
  finish_plan_step: 'Finishing step',
  mobile_run_draft_steps: 'Running draft steps',
  mobile_create_test_case: 'Saving test case',
};

export function humanizeMobileToolName(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  // Fallback: turn `some_unknown_tool` → `Some unknown tool`
  return name
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────
// Progress curve
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map round index → 55-95% progress, matching the web sub-agent pipeline.
 * Anchors:
 *   55%  — pipeline starts
 *   70%  — first observe lands (one round in)
 *   95%  — final round
 *
 * Saturates at 95% so the frontend never shows "100%" until the HTTP
 * response actually returns.
 */
export function mobileToolProgress(round: number, max: number = 30): number {
  if (round <= 0) return 55;
  const fraction = Math.min(round, max) / max;
  return Math.min(95, Math.round(55 + fraction * 40));
}

// ─────────────────────────────────────────────────────────────────────────
// Thin emit wrappers — saves a few characters at every call site and
// centralises the step-type choice so future contract changes are one-edit.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Generic "agent is thinking about this phase" event. Use for
 * coarse-grained transitions (turn started, planner invoked, replying).
 */
export function emitMobileAgentThinking(
  chatSessionId: string | undefined,
  message: string,
  progress: number,
  metadata?: Record<string, unknown>,
): void {
  emitProcessingStep(chatSessionId, 'agent_thinking', message, progress, metadata);
}

/**
 * Per-tool start / finish event. Frontend renders these as timeline rows.
 */
export function emitMobileToolStep(
  chatSessionId: string | undefined,
  toolName: string,
  phase: 'started' | 'finished' | 'failed',
  progress: number,
  metadata?: Record<string, unknown>,
): void {
  const label = humanizeMobileToolName(toolName);
  const message =
    phase === 'started' ? `${label}…` :
    phase === 'finished' ? `${label} done` :
    `${label} had an issue`;
  emitProcessingStep(chatSessionId, 'agent_executing_tool', message, progress, {
    toolName,
    phase,
    ...metadata,
  });
}

/**
 * Planner-specific event — the LLM just finished decomposing the goal
 * into a checklist. Frontend can show "Plan ready: 5 steps".
 */
export function emitMobilePlanningStep(
  chatSessionId: string | undefined,
  message: string,
  progress: number,
  metadata?: Record<string, unknown>,
): void {
  emitProcessingStep(chatSessionId, 'agent_planning', message, progress, metadata);
}
