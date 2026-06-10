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
});
