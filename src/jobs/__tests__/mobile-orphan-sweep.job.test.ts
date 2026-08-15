/**
 * The only interesting property of this job is what it does NOT delete.
 *
 * Deleting a live build breaks every test on that project with an install
 * failure, and the blob is unrecoverable. So the tests below are mostly
 * negative: each one asserts that a particular kind of still-referenced object
 * survives. The reference check is deliberately over-broad — `mobile_app_builds`
 * is not the only thing that points at a blob, and the legacy `settings`
 * slots in particular can outlive the build row they were written from.
 */

jest.mock('@/config/environment/env', () => ({
  env: { MOBILE_ORPHAN_SWEEP_DELETE: false },
}));

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock('@/services/storage/blob', () => ({
  getBlobStoreForWrite: jest.fn(),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { getBlobStoreForWrite } from '@/services/storage/blob';
import { MobileOrphanSweepJob } from '../mobile-orphan-sweep.job';

const storeMock = getBlobStoreForWrite as jest.Mock;
const fromMock = supabaseAdmin.from as jest.Mock;

const OLD = new Date(Date.now() - 48 * 3600_000);
const FRESH = new Date(Date.now() - 60_000);
const P = 'mobile-apps/ws-1/proj-1/android';

const remove = jest.fn();

/** Blob store yielding a fixed listing. */
function storeWith(blobs: { storagePath: string; sizeBytes?: number; createdAt: Date | null }[]) {
  return {
    provider: 'azure' as const,
    remove,
    list: async function* () {
      for (const b of blobs) yield { sizeBytes: 1024, ...b };
    },
  };
}

/**
 * `projects` returns `settingsRows`; `mobile_app_builds` returns `buildPaths`.
 * Mirrors the two query shapes the job issues, nothing more.
 */
function db(settingsRows: unknown[], buildPaths: string[]) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'projects') {
      return { select: () => ({ not: () => Promise.resolve({ data: settingsRows, error: null }) }) };
    }
    return {
      select: () => ({
        in: (_col: string, paths: string[]) =>
          Promise.resolve({
            data: paths.filter((p) => buildPaths.includes(p)).map((storage_path) => ({ storage_path })),
            error: null,
          }),
      }),
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (env as { MOBILE_ORPHAN_SWEEP_DELETE: boolean }).MOBILE_ORPHAN_SWEEP_DELETE = false;
  remove.mockResolvedValue(undefined);
});

describe('what the sweep must never delete', () => {
  it('spares a blob that has a mobile_app_builds row', async () => {
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/app_1.apk`, createdAt: OLD }]));
    db([], [`${P}/app_1.apk`]);

    const result = await MobileOrphanSweepJob.tick();

    expect(result.orphaned).toBe(0);
  });

  it('spares a blob referenced only by the LEGACY settings.mobileApp slot', async () => {
    // pruneOldBuilds can delete the row while the legacy pointer still resolves
    // to this object for editor warm-up.
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/legacy.apk`, createdAt: OLD }]));
    db([{ settings: { mobileApp: { storagePath: `${P}/legacy.apk` } } }], []);

    const result = await MobileOrphanSweepJob.tick();

    expect(result.orphaned).toBe(0);
  });

  it('spares a blob referenced only by a per-platform mobileApps slot', async () => {
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/perplat.apk`, createdAt: OLD }]));
    db([{ settings: { mobileApps: { android: { storagePath: `${P}/perplat.apk` } } } }], []);

    expect((await MobileOrphanSweepJob.tick()).orphaned).toBe(0);
  });

  it('spares a blob referenced only by a named variant lane', async () => {
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/prod.apk`, createdAt: OLD }]));
    db(
      [{ settings: { mobileAppVariants: { android: [{ latest: { storagePath: `${P}/prod.apk` } }] } } }],
      [],
    );

    expect((await MobileOrphanSweepJob.tick()).orphaned).toBe(0);
  });

  it('spares a young blob — it may be an upload still on its way to finalize', async () => {
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/inflight.apk`, createdAt: FRESH }]));
    db([], []);

    expect((await MobileOrphanSweepJob.tick()).orphaned).toBe(0);
  });

  it('spares a blob whose age is unknown rather than guessing', async () => {
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/nodate.apk`, createdAt: null }]));
    db([], []);

    expect((await MobileOrphanSweepJob.tick()).orphaned).toBe(0);
  });

  it('deletes nothing when the settings query fails — it cannot tell live from orphan', async () => {
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/app.apk`, createdAt: OLD }]));
    fromMock.mockImplementation(() => ({
      select: () => ({ not: () => Promise.resolve({ data: null, error: { message: 'db down' } }) }),
    }));

    const result = await MobileOrphanSweepJob.tick();

    expect(result.orphaned).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes nothing when the builds lookup fails', async () => {
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/app.apk`, createdAt: OLD }]));
    fromMock.mockImplementation((table: string) =>
      table === 'projects'
        ? { select: () => ({ not: () => Promise.resolve({ data: [], error: null }) }) }
        : { select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) },
    );

    const result = await MobileOrphanSweepJob.tick();

    expect(result.orphaned).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('what it does reclaim', () => {
  it('identifies an old, unreferenced blob as an orphan', async () => {
    storeMock.mockReturnValue(
      storeWith([{ storagePath: `${P}/orphan.apk`, sizeBytes: 5_000_000, createdAt: OLD }]),
    );
    db([], []);

    const result = await MobileOrphanSweepJob.tick();

    expect(result.orphaned).toBe(1);
    expect(result.orphanedBytes).toBe(5_000_000);
  });

  it('REPORTS but does not delete while the flag is off', async () => {
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/orphan.apk`, createdAt: OLD }]));
    db([], []);

    const result = await MobileOrphanSweepJob.tick();

    expect(result.orphaned).toBe(1);
    expect(result.deleted).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes once the flag is on', async () => {
    (env as { MOBILE_ORPHAN_SWEEP_DELETE: boolean }).MOBILE_ORPHAN_SWEEP_DELETE = true;
    storeMock.mockReturnValue(storeWith([{ storagePath: `${P}/orphan.apk`, createdAt: OLD }]));
    db([], []);

    const result = await MobileOrphanSweepJob.tick();

    expect(result.deleted).toBe(1);
    expect(remove).toHaveBeenCalledWith([`${P}/orphan.apk`]);
  });

  it('separates orphans from live builds in one mixed listing', async () => {
    (env as { MOBILE_ORPHAN_SWEEP_DELETE: boolean }).MOBILE_ORPHAN_SWEEP_DELETE = true;
    storeMock.mockReturnValue(
      storeWith([
        { storagePath: `${P}/live.apk`, createdAt: OLD },
        { storagePath: `${P}/orphan.apk`, createdAt: OLD },
        { storagePath: `${P}/legacy.apk`, createdAt: OLD },
        { storagePath: `${P}/young.apk`, createdAt: FRESH },
      ]),
    );
    db([{ settings: { mobileApp: { storagePath: `${P}/legacy.apk` } } }], [`${P}/live.apk`]);

    const result = await MobileOrphanSweepJob.tick();

    expect(result.scanned).toBe(4);
    expect(remove).toHaveBeenCalledWith([`${P}/orphan.apk`]);
  });
});

describe('environments it must not run in', () => {
  it('skips when the storage provider cannot list objects', async () => {
    storeMock.mockReturnValue({ provider: 'supabase', remove });

    const result = await MobileOrphanSweepJob.tick();

    expect(result.skipped).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
});
