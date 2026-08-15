/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MOBILE SESSION DRIVE LOG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Counts successful device-driving tool calls (tap / type / scroll / swipe /
 * back / launch) per RUNNER SESSION, so the authoring grounding gate can tell
 * "this agent has walked the app" from "this agent is guessing" across more
 * than one chat turn.
 *
 * Why this exists. `isUngroundedMultiScreenDraft` originally counted drives on
 * the blackboard, which is rebuilt every turn. That is correct for a one-shot
 * "create a test case for X" — walk and draft land in the same turn. It is
 * wrong for the conversation people actually have:
 *
 *     turn 1  "create a test case for the FAQ feedback flow"
 *             → agent walks Profile → FAQ → category → question → scroll → Yes
 *     turn 2  "now emit the draft steps"
 *             → gate sees ZERO drives this turn and refuses
 *
 * Measured live on JanaPost TC-33 (2026-08-13): that refusal fired twice in a
 * single turn, the agent tried to re-walk to satisfy it, its `tap "Profile tab
 * in the bottom navigation bar"` failed because the device was parked deep
 * inside FAQ where no Profile tab exists, and the turn ended with no draft. The
 * gate was refusing a draft that was, in fact, fully grounded — the walk had
 * simply happened one message earlier.
 *
 * Keyed by mobileSessionId, NOT chatSessionId — the opposite choice from
 * `MobileDraftStepsCache`, and deliberately so. A draft survives a runner
 * restart because it is just data; GROUNDING does not. The labels an agent read
 * are only trustworthy while the app is where it left it, and a new runner
 * session means a relaunched, logged-out app. Keying on the session id makes
 * that invalidation automatic: new session → new key → zero prior drives.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';

interface SessionDrives {
  count: number;
  updatedAt: number;
}

/**
 * Shorter than the draft cache's 30 min. Grounding decays: an app left idle
 * gets backgrounded, session-expired or navigated by someone else, and labels
 * read half an hour ago stop describing the current screen. 15 minutes
 * comfortably covers walk → draft in one sitting without vouching for a walk
 * nobody remembers taking.
 */
const DRIVE_LOG_TTL_MS = 15 * 60 * 1000;

/** Lazy-cleanup threshold — mirror `MobileDraftStepsCache`. */
const CLEANUP_THRESHOLD = 50;

/** Module-scoped. Single Node process per environment — see draft cache jsdoc. */
const log = new Map<string, SessionDrives>();

export const MobileSessionDriveLog = {
  /** Record one successful device-driving call against this runner session. */
  record(mobileSessionId: string): void {
    if (!mobileSessionId) return;
    const existing = log.get(mobileSessionId);
    log.set(mobileSessionId, {
      count: (existing?.count ?? 0) + 1,
      updatedAt: Date.now(),
    });

    if (log.size > CLEANUP_THRESHOLD) {
      const now = Date.now();
      for (const [key, entry] of log) {
        if (now - entry.updatedAt > DRIVE_LOG_TTL_MS) log.delete(key);
      }
    }
  },

  /** Successful drives on this session within the TTL. 0 when unknown/stale. */
  count(mobileSessionId: string): number {
    if (!mobileSessionId) return 0;
    const entry = log.get(mobileSessionId);
    if (!entry) return 0;
    if (Date.now() - entry.updatedAt > DRIVE_LOG_TTL_MS) {
      log.delete(mobileSessionId);
      logger.info('[MOBILE_DRIVE_LOG] Expired', { mobileSessionId });
      return 0;
    }
    return entry.count;
  },

  /** Test seam. */
  clear(): void {
    log.clear();
  },
};
