/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUICK ACTIONS INJECTOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Inspects tool execution results and synthesizes contextual quick action
 * descriptors that the frontend can render as inline buttons under AI messages.
 *
 * This file is the SINGLE source of truth for "what actions appear after which
 * tool result". Adding new actions = adding new entries here, not new endpoints
 * scattered across the codebase.
 *
 * Design constraints:
 * - Pure function — no DB calls, no I/O. Receives tool results and context,
 *   returns descriptors. Easy to unit test.
 * - All endpoints used in `kind: 'api'` actions MUST exist in the
 *   QUICK_ACTION_ENDPOINTS whitelist (security boundary). Defensively validates
 *   on emit so a programming mistake here doesn't ship a broken action.
 * - Placeholder sentinels like `<ctx:previewSessionId>` are resolved on the
 *   frontend at click time — keeps the injector stateless.
 *
 * Adding a new action:
 *   1. Add a new branch in `injectQuickActions()` matching `r.toolName`
 *   2. If using `kind: 'api'`, register the endpoint in
 *      src/api/preview/quick-action-endpoints.ts first
 *   3. Mirror any new endpoint string in the frontend whitelist
 *      (apps/web/src/services/quickActions/endpointWhitelist.js)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import { isWhitelistedQuickActionEndpoint } from '@/api/preview/quick-action-endpoints';
import type { QuickAction } from '@/api/chat/shared/quick-action.types';
import type { ToolExecutionRecord } from './types';

/**
 * Context required for action synthesis. Optional fields are populated only
 * in editor mode — non-editor chats simply won't get editor-only actions.
 */
export interface InjectorContext {
  mode?: 'lite' | 'pro' | 'editor';
  previewSessionId?: string;
  chatSessionId?: string;
  projectId?: string;
  userId: string;
}

/**
 * Inspect tool execution results and return any contextual quick actions.
 *
 * @param toolResults - Tool execution records from the executor agent
 * @param context     - Runtime context (mode, session ids, project)
 * @returns Array of QuickAction descriptors. Empty array if no actions apply.
 */
export function injectQuickActions(
  toolResults: ToolExecutionRecord[],
  context: InjectorContext,
): QuickAction[] {
  const actions: QuickAction[] = [];

  // Editor-only: actions are emitted only when the user is in editor mode
  // AND we have both session identifiers needed for placeholder resolution.
  const isEditorContext =
    context.mode === 'editor' &&
    !!context.previewSessionId &&
    !!context.chatSessionId;

  for (const record of toolResults) {
    // ── qa_run_draft_steps ───────────────────────────────────────────
    // After a successful draft run, offer "Save as test case" so the user
    // can persist the steps with one click. Steps + AI-suggested name are
    // already in DraftStepsCache (set by handleRunDraftSteps before the
    // run starts), so the endpoint just reads cache → creates DB row.
    if (
      record.toolName === 'qa_run_draft_steps' &&
      record.result.success &&
      isEditorContext
    ) {
      actions.push({
        id: 'save-draft-as-test-case',
        label: 'Save as test case',
        icon: 'save',
        variant: 'primary',
        kind: 'api',
        endpoint: 'POST /api/v1/preview/draft/save-as-test-case',
        params: {
          previewSessionId: '<ctx:previewSessionId>',
          chatSessionId: '<ctx:chatSessionId>',
        },
        oneShot: true,
        successMessage: 'Saved as "{{testCase.name}}"',
      });
    }
  }

  // Defensive: filter out any api actions whose endpoint is not on the whitelist.
  // Catches programming mistakes (typo, forgot to register) before they reach
  // the wire. Logs a warning so we notice in dev/staging.
  const safeActions = actions.filter(action => {
    if (action.kind !== 'api') return true;
    if (isWhitelistedQuickActionEndpoint(action.endpoint)) return true;
    logger.warn('[QUICK_ACTIONS_INJECTOR] Dropping action with non-whitelisted endpoint', {
      actionId: action.id,
      endpoint: action.endpoint,
    });
    return false;
  });

  // Deduplicate by id — the same tool can theoretically appear twice in
  // toolResults (parallel calls, retry rounds, etc.) and we don't want the
  // frontend to render duplicate buttons with the same key.
  const seen = new Set<string>();
  const uniqueActions = safeActions.filter(action => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });

  return uniqueActions;
}

/**
 * Structured draft-step payload surfaced from a `qa_run_draft_steps` tool
 * result so the chat can render the steps as EDITABLE widgets (parity with the
 * mobile agent). Present on both the author-only (`confirm:false`) and the
 * executed (`confirm:true`) paths — the handler sets `draftMeta.executed`.
 */
export interface DraftStepsPayload {
  draftSteps: unknown[];
  draftMeta: Record<string, unknown>;
}

/**
 * Extract the draft-step payload from the LAST `qa_run_draft_steps` tool
 * result (last authoring call wins, mirroring the cache overwrite). Returns
 * null when no draft was authored this turn. Pure — no I/O.
 */
export function extractDraftSteps(toolResults: ToolExecutionRecord[]): DraftStepsPayload | null {
  let found: DraftStepsPayload | null = null;
  for (const record of toolResults) {
    if (record.toolName !== 'qa_run_draft_steps') continue;
    const data = record.result?.data as { draftSteps?: unknown; draftMeta?: unknown } | undefined;
    if (data && Array.isArray(data.draftSteps) && data.draftMeta && typeof data.draftMeta === 'object') {
      found = { draftSteps: data.draftSteps, draftMeta: data.draftMeta as Record<string, unknown> };
    }
  }
  return found;
}
