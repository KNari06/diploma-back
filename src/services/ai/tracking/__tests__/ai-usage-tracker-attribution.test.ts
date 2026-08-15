/**
 * Regression tests for AI cost attribution.
 *
 * Context: between 2026-06-07 and 2026-08-13 NOT ONE row reached `ai_usage_log`
 * in production. Two independent defects, both covered here:
 *
 *   1. `record()` keyed synthetic sessions on `Date.now()`, so every call
 *      without a `testId` became its own single-record session that nothing
 *      ever ended — never flushed, never freed.
 *   2. `cleanup()`, the safety net that flushes orphaned sessions, had no call
 *      site anywhere in the codebase.
 *
 * A third defect (the `run_id` column missing from prod) is a migration issue,
 * not a code one — but the schema-drift detection that makes it LOUD is code,
 * and is covered below.
 */

import { insertAIUsageLog, isSchemaDriftError } from '../db/ai-usage-log.db';
import type { AITrackingContext } from '../ai-context';

jest.mock('../db/ai-usage-log.db', () => ({
  insertAIUsageLog: jest.fn().mockResolvedValue(undefined),
  isSchemaDriftError: jest.requireActual('../db/ai-usage-log.db').isSchemaDriftError,
}));

const insertMock = insertAIUsageLog as jest.MockedFunction<typeof insertAIUsageLog>;

// The tracker reads attribution from AsyncLocalStorage; drive it directly.
let currentCtx: AITrackingContext | undefined;
jest.mock('../ai-context', () => ({
  ...jest.requireActual('../ai-context'),
  getAIContext: () => currentCtx,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AIUsageTracker } = require('../ai-usage-tracker') as typeof import('../ai-usage-tracker');

function usage(costUSD = 0.001) {
  return {
    provider: 'openai' as const,
    model: 'gpt-5.4-mini',
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    costUSD,
    timestamp: Date.now(),
  };
}

/** Reach into the private session map — this is what the bugs were about. */
function sessionCount(): number {
  return (AIUsageTracker as unknown as { sessions: Map<string, unknown> }).sessions.size;
}

/** Backdate every live session so the sweep sees it as `ms` old. */
function ageAllSessions(ms: number): void {
  const sessions = (AIUsageTracker as unknown as {
    sessions: Map<string, { startedAt: number }>;
  }).sessions;
  for (const s of sessions.values()) s.startedAt = Date.now() - ms;
}

function clearSessions(): void {
  (AIUsageTracker as unknown as { sessions: Map<string, unknown> }).sessions.clear();
  (AIUsageTracker as unknown as { schemaDriftReported: boolean }).schemaDriftReported = false;
}

describe('AIUsageTracker cost attribution', () => {
  beforeEach(() => {
    insertMock.mockClear();
    insertMock.mockResolvedValue(undefined);
    clearSessions();
    currentCtx = {
      workspaceId: 'ws-1',
      userId: 'user-1',
      operationType: 'lite-test',
    };
  });

  describe('session keying', () => {
    it('groups repeated calls in one context into a SINGLE session', () => {
      for (let i = 0; i < 25; i++) AIUsageTracker.record(usage());

      expect(sessionCount()).toBe(1);
    });

    it('keeps distinct users in distinct sessions', () => {
      AIUsageTracker.record(usage());
      currentCtx = { ...currentCtx!, userId: 'user-2' };
      AIUsageTracker.record(usage());

      expect(sessionCount()).toBe(2);
    });

    it('keeps distinct workspaces in distinct sessions', () => {
      AIUsageTracker.record(usage());
      currentCtx = { ...currentCtx!, workspaceId: 'ws-2' };
      AIUsageTracker.record(usage());

      expect(sessionCount()).toBe(2);
    });

    it('honours an explicit sessionId so beginSession/endSession actually pair', async () => {
      // Four of seven beginSession call sites (chat/general, chat/mobile_agent,
      // chat/ai_test, ai-analysis) pass an id record() could not derive, so
      // calls filed under a synthetic key while endSession closed an empty
      // session and returned null. ctx.sessionId is what links the two.
      const chatSessionId = 'chat-sess-abc';
      AIUsageTracker.beginSession(chatSessionId, { ...currentCtx!, sessionId: chatSessionId });
      currentCtx = { ...currentCtx!, sessionId: chatSessionId };

      AIUsageTracker.record(usage(0.004));
      AIUsageTracker.record(usage(0.006));
      expect(sessionCount()).toBe(1);

      const summary = await AIUsageTracker.endSession(chatSessionId);
      expect(summary).not.toBeNull();
      expect(summary?.aiCallCount).toBe(2);
      expect(summary?.totalCostUSD).toBeCloseTo(0.01, 6);
      expect(sessionCount()).toBe(0);
    });

    it('takes sessionId ahead of testId, so an explicit id always wins', () => {
      currentCtx = { ...currentCtx!, testId: 'test-1', sessionId: 'analysis-42' };
      AIUsageTracker.record(usage());

      const sessions = (AIUsageTracker as unknown as { sessions: Map<string, unknown> }).sessions;
      expect([...sessions.keys()]).toEqual(['analysis-42']);
    });

    it('keeps two chat sessions from one user apart', () => {
      currentCtx = { ...currentCtx!, sessionId: 'chat-a' };
      AIUsageTracker.record(usage());
      currentCtx = { ...currentCtx!, sessionId: 'chat-b' };
      AIUsageTracker.record(usage());

      expect(sessionCount()).toBe(2);
    });

    it('prefers testId, then runId, over the synthetic key', () => {
      currentCtx = { ...currentCtx!, testId: 'test-abc' };
      AIUsageTracker.record(usage());
      AIUsageTracker.record(usage());
      expect(sessionCount()).toBe(1);

      clearSessions();
      currentCtx = { workspaceId: 'ws-1', userId: 'user-1', runId: 'run-xyz' };
      AIUsageTracker.record(usage());
      AIUsageTracker.record(usage());
      expect(sessionCount()).toBe(1);
    });

    it('does not leak a session per call — the original bug', () => {
      // Previously each of these minted `...-${Date.now()}` and stuck forever.
      for (let i = 0; i < 500; i++) AIUsageTracker.record(usage());

      expect(sessionCount()).toBe(1);
    });

    it('ignores calls made with no tracking context at all', () => {
      currentCtx = undefined;
      AIUsageTracker.record(usage());

      expect(sessionCount()).toBe(0);
    });
  });

  describe('cleanup sweep', () => {
    it('flushes an orphaned session to the database and frees it', async () => {
      AIUsageTracker.record(usage(0.004));
      AIUsageTracker.record(usage(0.006));
      expect(sessionCount()).toBe(1);

      ageAllSessions(11 * 60 * 1000);
      AIUsageTracker.cleanup();
      await Promise.resolve();

      expect(insertMock).toHaveBeenCalledTimes(1);
      const row = insertMock.mock.calls[0][0];
      expect(row.workspace_id).toBe('ws-1');
      expect(row.user_id).toBe('user-1');
      expect(row.ai_call_count).toBe(2);
      expect(row.total_cost_usd).toBeCloseTo(0.01, 6);
      expect(sessionCount()).toBe(0);
    });

    it('leaves fresh sessions alone', () => {
      AIUsageTracker.record(usage());
      AIUsageTracker.cleanup();

      expect(insertMock).not.toHaveBeenCalled();
      expect(sessionCount()).toBe(1);
    });

    it('does NOT split a long-running explicit session mid-flight', async () => {
      // A regression run routinely exceeds 10 minutes. Sweeping it early would
      // scatter one run across several ai_usage_log rows and leave endSession
      // reporting only the tail.
      AIUsageTracker.beginSession('long-run', { ...currentCtx!, testId: 'long-run' });
      currentCtx = { ...currentCtx!, testId: 'long-run' };
      AIUsageTracker.record(usage(0.01));

      ageAllSessions(30 * 60 * 1000); // 30 minutes in
      AIUsageTracker.cleanup();
      await Promise.resolve();

      expect(insertMock).not.toHaveBeenCalled();
      expect(sessionCount()).toBe(1);

      // ...and the owner still gets a complete summary when it finishes.
      const summary = await AIUsageTracker.endSession('long-run');
      expect(summary?.totalCostUSD).toBeCloseTo(0.01, 6);
    });

    it('still sweeps an explicit session that leaked past the orphan age', async () => {
      AIUsageTracker.beginSession('leaked', { ...currentCtx!, testId: 'leaked' });
      currentCtx = { ...currentCtx!, testId: 'leaked' };
      AIUsageTracker.record(usage(0.02));

      ageAllSessions(3 * 60 * 60 * 1000); // 3 hours — nobody is coming back
      AIUsageTracker.cleanup();
      await Promise.resolve();

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock.mock.calls[0][0].total_cost_usd).toBeCloseTo(0.02, 6);
      expect(sessionCount()).toBe(0);
    });

    it('sweeps an auto-created session on the SHORT age, since nothing will end it', async () => {
      AIUsageTracker.record(usage(0.003));

      ageAllSessions(11 * 60 * 1000); // 11 minutes
      AIUsageTracker.cleanup();
      await Promise.resolve();

      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(sessionCount()).toBe(0);
    });

    it('does NOT auto-start its timer under test', () => {
      // The timer is registered at import time and outlives the importing suite
      // inside a shared Jest worker, so leaving it armed lets it fire mid-way
      // through an unrelated test file and push a DB write through that file's
      // mock of `@/db/supabase`. Production arms it; tests call cleanup()
      // directly. See the guard in ai-usage-tracker.ts.
      expect(process.env.NODE_ENV).toBe('test');
      expect((AIUsageTracker as unknown as { sweepTimer: unknown }).sweepTimer).toBeNull();
    });
  });

  describe('endSession', () => {
    it('aggregates cost across every recorded call', async () => {
      AIUsageTracker.beginSession('sess-1', currentCtx!);
      currentCtx = { ...currentCtx!, testId: 'sess-1' };
      AIUsageTracker.record(usage(0.002));
      AIUsageTracker.record(usage(0.003));

      const summary = await AIUsageTracker.endSession('sess-1');

      expect(summary?.aiCallCount).toBe(2);
      expect(summary?.totalCostUSD).toBeCloseTo(0.005, 6);
    });
  });

  describe('schema-drift detection', () => {
    it('classifies a missing-column error as drift, not noise', () => {
      expect(isSchemaDriftError("column ai_usage_log.run_id does not exist")).toBe(true);
      expect(isSchemaDriftError('PGRST204: no such column')).toBe(true);
      expect(isSchemaDriftError("Could not find the table 'public.x' in the schema cache")).toBe(true);
    });

    it('does not misclassify ordinary transient failures as drift', () => {
      expect(isSchemaDriftError('connection timeout')).toBe(false);
      expect(isSchemaDriftError('duplicate key value violates unique constraint')).toBe(false);
    });

    it('does not blow up the caller when the insert rejects', async () => {
      insertMock.mockRejectedValue(new Error('column ai_usage_log.run_id does not exist'));

      AIUsageTracker.beginSession('sess-2', currentCtx!);
      currentCtx = { ...currentCtx!, testId: 'sess-2' };
      AIUsageTracker.record(usage());

      await expect(AIUsageTracker.endSession('sess-2')).resolves.toBeTruthy();
    });
  });
});
