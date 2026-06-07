/**
 * Unit tests for ArtifactRetentionJob.tick — the per-step screenshot prune.
 * Verifies it removes files older than the cutoff, keeps recent ones, recurses
 * into subfolders, and only ever touches the step-screenshots subtree.
 */

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

// Scripted storage tree keyed by list prefix. `id` present = file, absent = folder.
const TREE: Record<string, Array<{ name: string; id?: string; created_at?: string }>> = {
  '': [
    { name: 'userA', id: undefined },
    { name: 'test-uploads', id: undefined }, // unrelated top-level prefix
  ],
  'userA/step-screenshots': [{ name: 'testX', id: undefined }],
  'userA/step-screenshots/testX': [
    { name: 'old.webp', id: 'f1', created_at: iso(40 * DAY) }, // expired (>30d)
    { name: 'fresh.webp', id: 'f2', created_at: iso(1 * DAY) }, // keep
    { name: 'fail', id: undefined }, // subfolder → recurse
  ],
  'userA/step-screenshots/testX/fail': [
    { name: 'old-fail.webp', id: 'f3', created_at: iso(45 * DAY) }, // expired
  ],
  // test-uploads must NOT be walked by the job (it targets step-screenshots only)
  'test-uploads/step-screenshots': [],
};

const removeMock = jest.fn(async (_paths: string[]) => ({ error: null }));

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn(() => ({
        list: jest.fn(async (prefix: string) => ({
          data: TREE[prefix] ?? [],
          error: null,
        })),
        remove: removeMock,
      })),
    },
  },
}));

// Pin retention to 30 days regardless of env.
jest.mock('@/config/features/screenshot-capture', () => ({
  ScreenshotCaptureFeature: {
    isEnabled: () => true,
    getRetentionDays: () => 30,
    logStatus: () => {},
  },
}));

import { ArtifactRetentionJob } from '../artifact-retention.job';

describe('ArtifactRetentionJob.tick', () => {
  beforeEach(() => removeMock.mockClear());

  it('removes expired files (and recurses) while keeping recent ones', async () => {
    const result = await ArtifactRetentionJob.tick();

    expect(result.skipped).toBe(false);
    // Two expired files: testX/old.webp and testX/fail/old-fail.webp
    expect(result.removed).toBe(2);

    const removedPaths = removeMock.mock.calls.flatMap((c) => c[0] as string[]);
    expect(removedPaths).toContain('userA/step-screenshots/testX/old.webp');
    expect(removedPaths).toContain('userA/step-screenshots/testX/fail/old-fail.webp');
    // The recent file is never deleted.
    expect(removedPaths).not.toContain('userA/step-screenshots/testX/fresh.webp');
  });

  it('skips when a previous sweep is still in flight', async () => {
    // Force the in-flight guard by starting two ticks concurrently.
    const [a, b] = await Promise.all([ArtifactRetentionJob.tick(), ArtifactRetentionJob.tick()]);
    const skipped = [a, b].filter((r) => r.skipped);
    expect(skipped.length).toBe(1);
  });
});
