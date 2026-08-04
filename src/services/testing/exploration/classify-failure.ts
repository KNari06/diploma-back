/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION FAILURE CLASSIFICATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Maps a thrown error onto the terminal status the run should carry, so
 * "the site blocked us" is a queryable fact rather than prose inside
 * `error_message` (see 20260802_exploration_runs_honest_failure_status.sql).
 *
 * Classification reads the TYPED error, never the message text: the reason is
 * already structured on `EntryUnreachableError`, and a message gets reworded
 * the first time someone improves the copy.
 *
 * Fails SAFE: anything unrecognised stays `'failed'`. A wrong specific status
 * is worse than an honest generic one — it would send a user chasing a bot wall
 * that never existed.
 */

import { EntryUnreachableError } from '@/agent/core/lite/exploration/entry-unreachable.error';
import type { ExplorationFailureStatus } from './exploration-storage.service';

export function classifyExplorationFailure(error: unknown): ExplorationFailureStatus {
  if (error instanceof EntryUnreachableError) {
    switch (error.reason) {
      // Both mean the SITE refused automation while being perfectly healthy for
      // a human — the actionable distinction for a user is "we were blocked",
      // not which throttle tripped.
      case 'rate_limited':
      case 'site_degraded':
        return 'blocked_by_bot';
      case 'navigation_failed':
        return 'unreachable';
    }
  }

  return 'failed';
}
