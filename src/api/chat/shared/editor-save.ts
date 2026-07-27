/**
 * Editor Save — deterministic "save" in the per-test-case editor chat.
 *
 * Why this exists (and why a prompt would not do)
 * ──────────────────────────────────────────────
 * "save" in an open test case is unambiguous: persist what was just authored
 * onto THIS test case. Routing it through `general_chat` made that outcome
 * depend on the model choosing to call a save tool — and on 2026-07-27, twice
 * in a row, it chose not to. Both times it answered "Saved as a reusable test
 * case." / "Saved the grounded SauceDemo login test case with 4 steps." while
 * the row sat at 0 steps. No tool call appears in the trace for either turn.
 *
 * The confirmation interceptor ([editor-confirmation.ts]) cannot help there:
 * it replays a call the model already made, and here the model made none. So
 * the save is issued by the server instead. The model is out of this path in
 * both halves — the server issues the write, and the user's "yes" replays it.
 *
 * This is the preview half. It calls the write tool with `confirm:false`,
 * which the confirm gate refuses; that refusal caches the pending op exactly
 * as a model-issued one would, so the user's next "yes" flows through the
 * SAME interceptor. What the user sees is a human preview, never the gate's
 * model-facing prose (Hard invariant #13).
 */

import { Response } from 'express';
import { randomUUID } from 'crypto';
import { executeTool } from '@/services/skills/tool-executor';
import type { SkillContext } from '@/services/skills/types';
import { ChatPersistence } from '@/services/utils/chat-persistence';
import { TESTCASE_STORE } from '@/services/utils/chat-store';
import { logger } from '@/utils/core/logger';
import { SAVE_REQUEST, toLangSet } from '@/config/testing/intent-keywords';
import { storePendingEditorConfirmation } from './editor-confirmation';

const SAVE_TOOL = 'qa_update_test_case_steps';

/** Built once. EXACT membership, not a prefix — see `isEditorSaveRequest`. */
const SAVE_REQUEST_SET = toLangSet(SAVE_REQUEST);

/**
 * Is this turn a "save"? Two signals, because neither alone is reliable: the
 * LLM's `save_test` classification is unstable (the same bare "save" landed on
 * `save_test` one day and `general_chat` the next), and a keyword list is only
 * ever an anchor set. Either is enough to TRY the save; the draft check inside
 * `handleEditorSaveRequest` decides whether anything is actually written.
 *
 * The keyword half matches the WHOLE message, not a prefix. An anchored prefix
 * regex would also claim "save this as a new separate test" — a request to
 * create a DIFFERENT test case — and preview overwriting the open one. Exact
 * membership keeps this path to unambiguous bare commands ("save", "сохрани")
 * and leaves every qualified phrasing to the model, which can reach
 * `qa_create_test_case` with `new_separate_test`.
 */
export function isEditorSaveRequest(
  message: string,
  intentFlagged: boolean,
): boolean {
  return intentFlagged || SAVE_REQUEST_SET.has(message.trim().toLowerCase().replace(/[.!]+$/, ''));
}

/** Persist the turn so a reload shows the exchange — mirrors editor-confirmation. */
async function persistTurn(
  chatSessionId: string,
  userMessage: string,
  aiReply: string,
): Promise<void> {
  try {
    await ChatPersistence.saveMessages(TESTCASE_STORE, chatSessionId, [
      { role: 'user', content: userMessage, metadata: { mode: 'editor' } },
      { role: 'ai', content: aiReply, metadata: { source: 'editor_save' } },
    ]);
  } catch (err) {
    logger.warn('[EDITOR_SAVE] Failed to persist turn', {
      chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * How many steps are waiting to be persisted, and whether a credential binding
 * rides with them. Read straight from the server-held draft — the same object
 * the write will persist — so the preview cannot describe something other than
 * what gets written.
 */
async function describeDraft(
  chatSessionId: string,
  userId: string,
): Promise<{ stepCount: number; hasCredential: boolean } | null> {
  try {
    const { DraftStepsCache } = await import('@/services/testing/ui/preview/draft-steps-cache');
    const draft = DraftStepsCache.get(chatSessionId);
    if (!draft || draft.userId !== userId || !draft.steps?.length) return null;
    return {
      stepCount: draft.steps.length,
      hasCredential: (draft.resourceBindings?.length ?? 0) > 0,
    };
  } catch {
    return null;
  }
}

/**
 * Handle a "save" in test-case scope. Returns true when the response has been
 * sent, false to fall through to the normal handler routing.
 */
export async function handleEditorSaveRequest(
  res: Response,
  message: string,
  chatSessionId: string,
  testCaseId: string,
  testCaseName: string | undefined,
  skillContext: SkillContext,
): Promise<boolean> {
  const draft = await describeDraft(chatSessionId, skillContext.userId);

  // Nothing authored this session. Fall through — general_chat can answer
  // "save what?" far better than a canned string, and there is no write to
  // preview. This is the one case where the model is still the right answer.
  if (!draft) {
    logger.info('[EDITOR_SAVE] No draft to persist — falling through to general chat', {
      chatSessionId,
      testCaseId,
    });
    return false;
  }

  const args = { test_case_id: testCaseId, confirm: false };

  try {
    // Issue the write. The gate refuses it (confirm:false) and that refusal is
    // what arms the confirmation interceptor — we are deliberately walking the
    // same two-phase path a model-issued call walks, not shortcutting it.
    const callResult = await executeTool({
      toolName: SAVE_TOOL,
      toolCallId: `editor_save_${randomUUID()}`,
      args,
      skillContext,
    });
    const result = callResult.toolResult;

    if (!result.needsConfirmation) {
      // The gate did not refuse — either it wrote (a prior preview was still
      // armed) or it failed on something real. Report the tool's own result;
      // in both cases it is about the write, not about approval.
      logger.info('[EDITOR_SAVE] Write resolved without a confirmation step', {
        chatSessionId,
        testCaseId,
        success: result.success,
      });
      await persistTurn(chatSessionId, message, result.message);
      res.json({
        success: result.success,
        reply: result.message,
        message: result.message,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return true;
    }

    await storePendingEditorConfirmation(chatSessionId, {
      toolName: SAVE_TOOL,
      args,
      skillContext,
    });

    const label = testCaseName ? `**${testCaseName}**` : 'this test case';
    const credentialNote = draft.hasCredential
      ? ' The saved login stays bound to the test, so it can replay on its own.'
      : '';
    const reply =
      `I'll save the ${draft.stepCount} step(s) just authored onto ${label}, replacing its current steps.` +
      `${credentialNote}\n\nReply **yes** to confirm.`;

    logger.info('[EDITOR_SAVE] Awaiting confirmation', {
      chatSessionId,
      testCaseId,
      stepCount: draft.stepCount,
      hasCredential: draft.hasCredential,
    });

    await persistTurn(chatSessionId, message, reply);
    res.json({
      success: true,
      reply,
      message: reply,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return true;
  } catch (err) {
    logger.error('[EDITOR_SAVE] Failed to prepare the save', {
      chatSessionId,
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fall through rather than surfacing a dead end — general_chat still gets
    // its turn, and no pending op was cached.
    return false;
  }
}
