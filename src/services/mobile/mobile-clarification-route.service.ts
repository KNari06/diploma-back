import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';

/**
 * Routing registry for MOBILE exploration clarifications (human-in-the-loop
 * `ask_user` pauses — confirmation of a destructive action, a choice, etc.).
 *
 * The web clarification path (captcha/2FA) resolves an answer through the
 * in-process ClarificationService (Redis poll on the worker). Mobile is
 * different: the run lives on the RUNNER, and the answer must be POSTed back to
 * the runner's `submitAnswer`. But the browser only sends `{questionId, answer}`
 * on `exploration:clarification:response` — it has no idea which runner runId a
 * questionId belongs to (and must not: the runner URL/key stay server-side).
 *
 * So when the mobile relay forwards an `awaiting_user` question to the browser,
 * it also records here: questionId → the runner runId + owning userId. The
 * response handler looks the questionId up; a hit means "this is a mobile
 * question — route the answer to the runner" (a miss means it's a web
 * captcha/2FA question, handled the old way).
 *
 * Best-effort + short-lived: the key TTL tracks the run's own answer timeout, so
 * a stale mapping can never outlive the paused run. A Redis failure degrades to
 * "no mapping" — the same safe fail-closed outcome as before this feature (the
 * run times out on the runner and cancels).
 */

export interface MobileClarificationRoute {
  /** The RUNNER's run id — what submitExplorationAnswer POSTs to. */
  runId: string;
  /** Owner, for the runner's user-scoped auth + the answer POST. */
  userId?: string;
}

const KEY_PREFIX = 'mobile:clarification:route:';
/** TTL floor; overridden per-call by the run's answer-timeout when known. */
const DEFAULT_TTL_SECONDS = 5 * 60;

function keyFor(questionId: string): string {
  return `${KEY_PREFIX}${questionId}`;
}

/** Record the runner route for a pending mobile question. Best-effort. */
export async function storeMobileClarificationRoute(
  questionId: string,
  route: MobileClarificationRoute,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  try {
    await redisConnection.set(
      keyFor(questionId),
      JSON.stringify(route),
      'EX',
      Math.max(1, Math.round(ttlSeconds)),
    );
  } catch (err) {
    logger.warn('[MOBILE_CLARIFY_ROUTE] failed to store route', {
      questionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Look up and CONSUME the runner route for a question — but only for the user
 * who owns the paused run.
 *
 * OWNERSHIP (security): the answer resumes a real exploration on the runner (a
 * side-effecting external call), so a questionId alone must NOT be enough to
 * answer it — otherwise any authenticated user who learns a questionId UUID
 * could unpause/steer another tenant's run. `requestUserId` is the answering
 * socket's own id; it must equal the stored owner. On mismatch we return null
 * and DO NOT delete the entry, so a probe by a non-owner can't DoS the real
 * owner's pending answer. The route is deleted (one-shot) only on a match, so a
 * duplicate/replayed answer can't double-route.
 */
export async function takeMobileClarificationRoute(
  questionId: string,
  requestUserId: string | undefined,
): Promise<MobileClarificationRoute | null> {
  try {
    const raw = await redisConnection.get(keyFor(questionId));
    if (!raw) return null;
    const route = JSON.parse(raw) as MobileClarificationRoute;

    // Owner check. A route with no stored userId is only answerable by an
    // equally-anonymous socket (both undefined) — never by an identified user
    // claiming someone else's anonymous run, and never the reverse.
    if (route.userId !== requestUserId) {
      logger.warn('[MOBILE_CLARIFY_ROUTE] ownership mismatch — refusing to route answer', {
        questionId,
        // Do not log the real owner id; just that it differed.
        hadOwner: route.userId !== undefined,
        requesterPresent: requestUserId !== undefined,
      });
      return null; // entry left intact for the legitimate owner
    }

    await redisConnection.del(keyFor(questionId)).catch(() => {});
    return route;
  } catch (err) {
    logger.warn('[MOBILE_CLARIFY_ROUTE] failed to read route', {
      questionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
