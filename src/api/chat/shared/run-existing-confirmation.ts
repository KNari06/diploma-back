/**
 * Run-Existing-Test Confirmation Handler
 *
 * When a user asks the global chat to "run a test" and we find matching saved
 * test cases, we DON'T immediately Lite-run. We persist the candidate list in
 * Redis and ask the user to confirm (single match → yes/no; multiple → pick a
 * number / name). The next turn lands here, where a confirmation runs the saved
 * test case via the regression runner (web vs mobile is auto-dispatched on
 * `intent_test_cases.platform`).
 *
 * Mirrors exploration-confirmation.ts / manage-confirmation.ts:
 *  - Redis keyed by chatSessionId ONLY (Hard invariant #14 — no userId fallback)
 *  - Always emits a response + clears the key on confirm / decline / other / error
 *  - Returns boolean: true = handled (response sent), false = pass through
 */

import { Request, Response } from 'express';
import { redisConnection } from '@/config/infrastructure/queues';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { ChatService } from '@/services/utils/chat.service';
import { NotFoundError, InsufficientCreditsError } from '@/types';
import { logger } from '@/utils/core/logger';
import { classifyConfirmation } from './confirmation-classifier';
import { QuickAction } from './quick-action.types';

const PENDING_RUN_EXISTING_PREFIX = 'pending_run_existing:';
const PENDING_TTL_SECONDS = 300; // 5 min, matches manage-confirmation

export interface PendingRunExistingCandidate {
  id: string;
  name: string;
  /** 'web' | 'mobile_android' | 'mobile_ios' — for display + (auto) dispatch. */
  platform: string;
}

interface PendingRunExistingData {
  candidates: PendingRunExistingCandidate[];
}

function keyFor(chatSessionId: string): string {
  return `${PENDING_RUN_EXISTING_PREFIX}${chatSessionId}`;
}

/** Human-friendly platform label for chat copy. */
function platformLabel(platform: string): string {
  if (platform.startsWith('mobile_')) {
    return platform === 'mobile_ios' ? 'mobile (iOS)' : 'mobile (Android)';
  }
  return 'web';
}

/**
 * Build clickable confirmation chips for the pending candidates. Each chip is a
 * `kind:'chat'` quick action whose `prompt` is re-sent as a chat message on the
 * user's behalf — landing back in `handlePendingRunExistingConfirmation` on the
 * next turn exactly as if the user typed it. So the copy still tells the user
 * they can type; the chips are a shortcut, not a replacement.
 */
function buildConfirmationChips(candidates: PendingRunExistingCandidate[]): QuickAction[] {
  if (candidates.length === 1) {
    return [
      { id: 'run-existing-yes', label: 'Yes, run it', kind: 'chat', prompt: 'yes', variant: 'primary', icon: 'play', oneShot: true },
      { id: 'run-existing-no', label: 'No', kind: 'chat', prompt: 'no', variant: 'ghost', icon: 'x', oneShot: true },
    ];
  }
  const pickChips: QuickAction[] = candidates.map((_, i) => ({
    id: `run-existing-pick-${i + 1}`,
    label: `${i + 1}`,
    kind: 'chat',
    prompt: `${i + 1}`,
    variant: 'secondary',
    oneShot: true,
  }));
  return [
    ...pickChips,
    { id: 'run-existing-no', label: 'No', kind: 'chat', prompt: 'no', variant: 'ghost', icon: 'x', oneShot: true },
  ];
}

/**
 * Persist the pending candidate list and return the confirmation message + the
 * clickable chips the caller should attach. The caller (chat.controller) sends
 * the response.
 */
export async function storePendingRunExisting(
  chatSessionId: string,
  candidates: PendingRunExistingCandidate[],
): Promise<{ reply: string; actions: QuickAction[] }> {
  const payload: PendingRunExistingData = { candidates };
  try {
    await redisConnection.set(
      keyFor(chatSessionId),
      JSON.stringify(payload),
      'EX',
      PENDING_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn('[RUN_EXISTING_CONFIRM] Failed to store pending op', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const actions = buildConfirmationChips(candidates);

  if (candidates.length === 1) {
    const c = candidates[0];
    return {
      reply:
        `I found a saved test that matches: **${c.name}** (${platformLabel(c.platform)}).\n\n` +
        `Want me to run it?`,
      actions,
    };
  }

  const list = candidates
    .map((c, i) => `${i + 1}. **${c.name}** (${platformLabel(c.platform)})`)
    .join('\n');
  return {
    reply:
      `I found ${candidates.length} saved tests that match your request:\n\n${list}\n\n` +
      `Reply with the **number** (e.g. "1") of the test to run, or **no** to skip.`,
    actions,
  };
}

/**
 * Parse a "pick by number / name" reply against the candidate list.
 * Returns the chosen candidate, or null if no clear pick.
 */
function parsePick(
  message: string,
  candidates: PendingRunExistingCandidate[],
): PendingRunExistingCandidate | null {
  const trimmed = message.trim().toLowerCase();

  // 1) Numeric pick: a standalone number ("2", "#2", "run 2", "вариант 2").
  //    Word-boundary so "test2b" / "v10.2" don't match a stray digit; require
  //    EXACTLY one in-range number so "run 10" with 5 candidates is a no-pick
  //    (re-ask) rather than a silent off-by-one onto candidate 1.
  const numbers = (trimmed.match(/(?<![\p{L}\p{N}])\d+(?![\p{L}\p{N}])/gu) || [])
    .map((n) => parseInt(n, 10))
    .filter((n) => n >= 1 && n <= candidates.length);
  if (numbers.length === 1) {
    return candidates[numbers[0] - 1];
  }

  // 2) Exact name match (case-insensitive) wins over any partial.
  const exact = candidates.find((c) => c.name.trim().toLowerCase() === trimmed);
  if (exact) return exact;

  // 3) Partial name: pick the LONGEST candidate name contained in the reply
  //    (so "Login Test" beats "Login"), or the reply contained in a name when
  //    the reply itself is the longer/more specific token. Only accept a pick
  //    when it's unambiguous — ties → no pick (re-ask).
  const partials = candidates
    .map((c) => ({ c, name: c.name.trim().toLowerCase() }))
    .filter(({ name }) => name.length > 2 && (trimmed.includes(name) || name.includes(trimmed)))
    .sort((a, b) => b.name.length - a.name.length);

  if (partials.length === 1) return partials[0].c;
  if (partials.length > 1 && partials[0].name.length !== partials[1].name.length) {
    return partials[0].c;
  }

  return null;
}

async function runCandidate(
  res: Response,
  message: string,
  chatSessionId: string,
  userId: string,
  candidate: PendingRunExistingCandidate,
): Promise<void> {
  // Double-run protection lives at the caller: the pending payload is claimed
  // atomically (GETDEL), so two near-simultaneous confirms can't both reach
  // here for the same chat. No per-run Redis lock is needed (a valueless
  // SET NX/DEL lock had a wrong-owner-delete footgun and only masked the race).
  try {
    const result = await RegressionRunService.runSavedTestCase({
      savedTestCaseId: candidate.id,
      userId,
      trigger: 'chat',
      // Stream the run's progress + result into this chat panel (same surface
      // as a Lite run) — the web/mobile job emits to room chat:<sessionId>.
      chatSessionId,
    });

    const replyMessage =
      `🚀 Running **${candidate.name}** (${platformLabel(candidate.platform)}).\n\n` +
      `Watch the progress below — I'll report the result when it finishes.\n\n` +
      `📊 Run ID: \`${result.runId}\``;

    ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      {
        role: 'ai',
        content: replyMessage,
        metadata: {
          runId: result.runId,
          testId: result.testId,
          savedTestCaseId: candidate.id,
          platform: candidate.platform,
          mode: 'run_existing',
        },
      },
    ]).catch(() => {});

    res.json({
      success: true,
      reply: replyMessage,
      mode: 'run_existing',
      runId: result.runId,
      testId: result.testId,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  } catch (error) {
    // A deleted/unpublished test between ask and confirm → NotFound. Surface a
    // clean message rather than a 500.
    const isNotFound = error instanceof NotFoundError;
    // Out of credits: the pre-flight check throws InsufficientCreditsError,
    // which carries a stable `code`/`details`. Pass the code through in the
    // body so apiClient flips the global credits banner (it keys off
    // `data.code === 'INSUFFICIENT_CREDITS'`, HTTP-status-independent), and
    // show the human-readable reason instead of the generic retry copy.
    const isInsufficientCredits = error instanceof InsufficientCreditsError;
    logger.error('[RUN_EXISTING_CONFIRM] Failed to run saved test case', {
      error: error instanceof Error ? error.message : String(error),
      savedTestCaseId: candidate.id,
    });

    let errorReply: string;
    if (isInsufficientCredits) {
      errorReply = `⚠️ ${error.message}`;
    } else if (isNotFound) {
      errorReply = `⚠️ That saved test is no longer available. Try again or open the **Explore** section to create new tests.`;
    } else {
      errorReply = `⚠️ Failed to start the test. Please try again.`;
    }

    ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      { role: 'ai', content: errorReply, metadata: { error: true } },
    ]).catch(() => {});

    res.json({
      success: false,
      reply: errorReply,
      // Machine-readable credit sentinel so the frontend can trigger the
      // global banner; other errors carry only the ⚠️-prefixed reply.
      ...(isInsufficientCredits && {
        code: (error as InsufficientCreditsError & { code?: string }).code,
        message: error.message,
        details: (error as InsufficientCreditsError & { details?: unknown }).details,
      }),
      metadata: { error: true },
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  }
}

/**
 * Intercept a reply to a pending "run existing test" confirmation.
 * @returns true if handled (response sent), false to fall through to normal flow.
 */
export async function handlePendingRunExistingConfirmation(
  _req: Request,
  res: Response,
  message: string,
  chatSessionId: string,
  userId: string,
): Promise<boolean> {
  const key = keyFor(chatSessionId);

  // Atomically CLAIM the pending payload: GETDEL reads-and-deletes in one op so
  // two near-simultaneous confirms (double-click / network retry) can't both
  // pass — only the first sees the payload; the second gets null and falls
  // through. This closes the get→del race at the root (a plain get let both
  // requests through, and the downstream run lock only masked it). The one case
  // that must KEEP the pending list — a bare "yes" on a multi-match, where we
  // re-ask for the number — writes it back below.
  let pendingRaw: string | null;
  try {
    // getdel needs Redis 6.2+. Fall back to get+del if the command is refused
    // on an older server (still non-atomic there, but correct behaviour).
    if (typeof (redisConnection as { getdel?: unknown }).getdel === 'function') {
      pendingRaw = await (redisConnection as unknown as { getdel(k: string): Promise<string | null> }).getdel(key);
    } else {
      pendingRaw = await redisConnection.get(key);
      if (pendingRaw) await redisConnection.del(key).catch(() => {});
    }
  } catch {
    return false;
  }
  if (!pendingRaw) return false;

  let pending: PendingRunExistingData;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    return false; // already deleted by the claim above
  }

  const candidates = pending.candidates || [];
  if (candidates.length === 0) {
    return false; // already deleted by the claim above
  }

  // For a multi-match list, a direct numeric/name pick wins over yes/no.
  if (candidates.length > 1) {
    const picked = parsePick(message, candidates);
    if (picked) {
      await runCandidate(res, message, chatSessionId, userId, picked);
      return true;
    }
  }

  const intent = await classifyConfirmation(message, 'run the saved test case you just described');

  // Confirm — single match runs directly; a bare "yes" on a multi list is
  // ambiguous, so re-ask for the number rather than guessing.
  if (intent === 'confirm') {
    if (candidates.length === 1) {
      await runCandidate(res, message, chatSessionId, userId, candidates[0]);
      return true;
    }
    // Bare "yes" on a multi list is ambiguous — re-ask for the number. The
    // atomic claim already consumed the key, so write the pending list BACK
    // (same TTL) so the user's next numeric reply still finds it.
    try {
      await redisConnection.set(key, pendingRaw, 'EX', PENDING_TTL_SECONDS);
    } catch { /* best-effort — a lost list just falls through to a re-ask */ }
    const list = candidates
      .map((c, i) => `${i + 1}. **${c.name}** (${platformLabel(c.platform)})`)
      .join('\n');
    const reply = `Which one? Reply with the number:\n\n${list}`;
    ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      { role: 'ai', content: reply },
    ]).catch(() => {});
    res.json({
      success: true,
      reply,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return true;
  }

  // Decline — steer toward exploration (consistent with the "no saved match"
  // path). The pending key was already consumed by the atomic claim above.
  if (intent === 'decline') {
    const reply =
      `Okay, I won't run a saved test. To create new tests, open the **Explore** ` +
      `section (Execution menu) and add your URL or mobile app build.`;
    ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      { role: 'ai', content: reply },
    ]).catch(() => {});
    res.json({
      success: true,
      reply,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return true;
  }

  // Ambiguous → let the normal flow handle this message. The pending key was
  // already consumed by the atomic claim above, so nothing to clear.
  return false;
}
