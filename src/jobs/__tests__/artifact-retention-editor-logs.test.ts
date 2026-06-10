/**
 * Unit tests for ArtifactRetentionJob's LOCAL editor/forensic-log prune.
 * Storage side is stubbed to a no-op tree; `fs/promises` is mocked so the test
 * never touches the real test_logs/editor dir. Verifies the local sweep removes
 * files older than EDITOR_LOG_RETENTION_DAYS, keeps recent ones, ignores
 * sub-directories, and treats a missing dir (ENOENT) as a clean no-op.
 */

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// Storage tree: empty so the storage prune removes nothing — we only assert the
// local sweep here. `''` returns no user folders.
jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    storage: {
      from: jest.fn(() => ({
        list: jest.fn(async () => ({ data: [], error: null })),
        remove: jest.fn(async () => ({ error: null })),
      })),
    },
  },
}));

jest.mock('@/config/features/screenshot-capture', () => ({
  ScreenshotCaptureFeature: {
    isEnabled: () => true,
    getRetentionDays: () => 30,
    logStatus: () => {},
  },
}));

// Pin the editor-log TTL to 3 days regardless of the real env.
jest.mock('@/config/environment/env', () => ({
  env: { SUPABASE_BUCKET_NAME: 'artifacts', EDITOR_LOG_RETENTION_DAYS: 3 },
}));

// Scripted flat directory: filename → { mtimeMs, isFile }.
const FILES: Record<string, { mtimeMs: number; isFile: boolean }> = {
  'old_editor.jsonl': { mtimeMs: now - 5 * DAY, isFile: true }, // expired
  'old_forensic_ds.json': { mtimeMs: now - 4 * DAY, isFile: true }, // expired
  'fresh_editor.jsonl': { mtimeMs: now - 1 * DAY, isFile: true }, // keep
  'today.jsonl': { mtimeMs: now - 60 * 1000, isFile: true }, // keep
  'a-subdir': { mtimeMs: now - 99 * DAY, isFile: false }, // not a file → ignore
};

const unlinked: string[] = [];

jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn(async () => Object.keys(FILES)),
    stat: jest.fn(async (p: string) => {
      const name = p.split('/').pop() as string;
      const f = FILES[name];
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => f.isFile, mtimeMs: f.mtimeMs };
    }),
    unlink: jest.fn(async (p: string) => { unlinked.push(p.split('/').pop() as string); }),
  },
}));

import { ArtifactRetentionJob } from '../artifact-retention.job';

describe('ArtifactRetentionJob — local editor/forensic log prune', () => {
  beforeEach(() => { unlinked.length = 0; });

  it('removes only files older than the 3-day TTL, keeps recent ones, ignores subdirs', async () => {
    const result = await ArtifactRetentionJob.tick();

    expect(result.skipped).toBe(false);
    // Storage prune removed 0; the 2 expired local files make up the total.
    expect(result.removed).toBe(2);
    expect(unlinked.sort()).toEqual(['old_editor.jsonl', 'old_forensic_ds.json']);
    expect(unlinked).not.toContain('fresh_editor.jsonl');
    expect(unlinked).not.toContain('today.jsonl');
    expect(unlinked).not.toContain('a-subdir'); // directory entry never unlinked
  });

  it('treats a missing editor-log dir (ENOENT) as a clean no-op', async () => {
    const fsMock = jest.requireMock('fs') as { promises: { readdir: jest.Mock } };
    fsMock.promises.readdir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await ArtifactRetentionJob.tick();
    expect(result.skipped).toBe(false);
    expect(result.removed).toBe(0);
    expect(unlinked).toHaveLength(0);
  });
});
