/**
 * Unit tests for reduceRuntimeMeta — the pure transform that whitelists the
 * runtimeMeta fields persisted to the Redis step buffer. A silent drop/rename
 * of stepScreenshotUrl here would break the whole per-step screenshot pipeline
 * with no other failing test, so it is guarded directly.
 */

// Module imports redisConnection + supabaseAdmin at load — stub both so the
// import has no side effects (no real Redis/Supabase connection).
jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {} }));
jest.mock('@/db/supabase', () => ({ supabaseAdmin: {} }));

import { reduceRuntimeMeta } from '../test-executed-steps-redis.service';

describe('reduceRuntimeMeta', () => {
  it('preserves stepScreenshotUrl up to 2000 chars', () => {
    const url = 'https://cdn/step-' + 'a'.repeat(100) + '.webp';
    expect(reduceRuntimeMeta({ stepScreenshotUrl: url }).stepScreenshotUrl).toBe(url);
  });

  it('truncates stepScreenshotUrl longer than 2000 chars', () => {
    const url = 'h'.repeat(2500);
    const out = reduceRuntimeMeta({ stepScreenshotUrl: url }).stepScreenshotUrl;
    expect(out.length).toBeLessThan(url.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('keeps bugScreenshotUrl alongside stepScreenshotUrl (failure-only vs every-step)', () => {
    const out = reduceRuntimeMeta({ bugScreenshotUrl: 'https://cdn/bug.png', stepScreenshotUrl: 'https://cdn/step.webp' });
    expect(out.bugScreenshotUrl).toBe('https://cdn/bug.png');
    expect(out.stepScreenshotUrl).toBe('https://cdn/step.webp');
  });

  it('returns undefined stepScreenshotUrl when absent', () => {
    expect(reduceRuntimeMeta({ runtimeStatus: 'executed' }).stepScreenshotUrl).toBeUndefined();
  });

  it('returns undefined for null / non-object meta', () => {
    expect(reduceRuntimeMeta(null)).toBeUndefined();
    expect(reduceRuntimeMeta('nope' as any)).toBeUndefined();
  });

  // Regression: these three fields used to be silently dropped by this
  // function's allowlist, so a link_test_case run's captured variables never
  // reached `tests.executed_steps` and readFinalVariables always saw them as
  // undefined — the redacted-key ValidationError check could never fire.
  describe('link_test_case output-capture fields', () => {
    it('preserves scratchpadSnapshot (mobile shape)', () => {
      const snapshot = { otp: '123456', userName: 'alice' };
      expect(reduceRuntimeMeta({ scratchpadSnapshot: snapshot }).scratchpadSnapshot).toEqual(snapshot);
    });

    it('preserves extractedDataSnapshot (web shape)', () => {
      const snapshot = { orderId: 'ord_123' };
      expect(reduceRuntimeMeta({ extractedDataSnapshot: snapshot }).extractedDataSnapshot).toEqual(snapshot);
    });

    it('preserves redactedSnapshotKeys', () => {
      const keys = ['apiToken', 'password'];
      expect(reduceRuntimeMeta({ redactedSnapshotKeys: keys }).redactedSnapshotKeys).toEqual(keys);
    });

    it('returns undefined for all three when absent', () => {
      const out = reduceRuntimeMeta({ runtimeStatus: 'executed' });
      expect(out.scratchpadSnapshot).toBeUndefined();
      expect(out.extractedDataSnapshot).toBeUndefined();
      expect(out.redactedSnapshotKeys).toBeUndefined();
    });

    it('ignores a non-array redactedSnapshotKeys instead of persisting garbage', () => {
      expect(reduceRuntimeMeta({ redactedSnapshotKeys: 'not-an-array' as any }).redactedSnapshotKeys).toBeUndefined();
    });

    it('ignores a non-object scratchpadSnapshot instead of persisting garbage', () => {
      expect(reduceRuntimeMeta({ scratchpadSnapshot: 'not-an-object' as any }).scratchpadSnapshot).toBeUndefined();
    });
  });

  describe('triggerFired (mobile fired-trigger indicator)', () => {
    const payload = {
      triggerId: 'editor-trigger-7',
      conditionKind: 'any_dialog' as const,
      actionKind: 'tap' as const,
      actionText: 'Allow',
      matchedText: 'Allow access to your location?',
      timestamp: '2026-07-13T00:00:00.000Z',
    };

    it('preserves triggerFired through the Redis → Postgres reduction', () => {
      expect(reduceRuntimeMeta({ triggerFired: payload }).triggerFired).toEqual(payload);
    });

    it('returns undefined triggerFired when absent (so it never persists an empty badge)', () => {
      expect(reduceRuntimeMeta({ runtimeStatus: 'executed' }).triggerFired).toBeUndefined();
    });

    it('ignores a non-object triggerFired instead of persisting garbage', () => {
      expect(reduceRuntimeMeta({ triggerFired: 'nope' as any }).triggerFired).toBeUndefined();
    });
  });
});
