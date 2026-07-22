import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';

// ═══════════════════════════════════════════════════════════════════════════
// REDIS LOCK: prevents concurrent test starts for the same chat session on the
// ai_test/platform_test Lite-run path (ai_test/handler.ts). One key per chat
// session; a short TTL is the backstop if a process dies while holding it.
//
// The run-existing saved-test path does NOT use this — it prevents double-runs
// at the source by claiming its pending payload atomically (GETDEL in
// run-existing-confirmation.ts), which is race-free without a valueless lock.
// ═══════════════════════════════════════════════════════════════════════════
export const CHAT_TEST_LOCK_PREFIX = 'lock:chat_test_start:';
export const CHAT_TEST_LOCK_TTL_SECONDS = 10; // Short TTL to prevent stuck locks

/**
 * Try to acquire the per-chat-session test-start lock (atomic SET NX EX).
 * Returns true if acquired, false if already held. Fails CLOSED (returns
 * false) when Redis is unavailable — better to reject a start than to risk
 * two concurrent runs / a double credit spend.
 */
export async function acquireChatTestLock(chatSessionId: string): Promise<boolean> {
  try {
    const lockKey = `${CHAT_TEST_LOCK_PREFIX}${chatSessionId}`;
    const result = await redisConnection.set(lockKey, '1', 'EX', CHAT_TEST_LOCK_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch {
    logger.warn('[CHAT_LOCK] Redis unavailable, denying lock to prevent concurrent test execution', {
      chatSessionId,
    });
    return false;
  }
}

/** Best-effort release of the per-chat-session test-start lock. */
export async function releaseChatTestLock(chatSessionId: string): Promise<void> {
  try {
    const lockKey = `${CHAT_TEST_LOCK_PREFIX}${chatSessionId}`;
    await redisConnection.del(lockKey);
  } catch {
    // Best-effort release — the TTL is the backstop.
  }
}
