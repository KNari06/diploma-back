/**
 * Unit tests for MobileAppStorageService.resolveAppForRun — the resolver that
 * decides WHICH build a mobile run installs. This is the runtime heart of the
 * APK-variant feature, so the behaviours that bit us in review are locked in
 * here: pin-wins, named-lane-returns-null (no default substitution), the
 * flutter-named-lane → android storage mapping, and the default-lane legacy
 * fallback.
 *
 * This module IS the storage data-access layer, so we mock `@/db/supabase`
 * directly (the correct boundary per testing.md). The mock is a chainable
 * query builder that records each query's table + `.eq()` filters and defers
 * the terminal `.maybeSingle()/.single()` to a per-test resolver, so a test
 * controls exactly which lane/platform/commit yields a row.
 */

let mockResolveQuery: (q: { table: string; filters: Record<string, unknown>; ordered: boolean }) => { data: unknown; error: unknown };
const mockQueries: Array<{ table: string; filters: Record<string, unknown>; ordered: boolean }> = [];

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const q = { table, filters: {} as Record<string, unknown>, ordered: false };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => { q.filters[col] = val; return builder; },
        order: () => { q.ordered = true; return builder; },
        limit: () => builder,
        maybeSingle: () => { mockQueries.push(q); return Promise.resolve(mockResolveQuery(q)); },
        single: () => { mockQueries.push(q); return Promise.resolve(mockResolveQuery(q)); },
      };
      return builder;
    },
  },
}));

// resolveAppForRun never touches the blob store; stub the import so loading the
// module under test can't reach real storage credentials.
jest.mock('@/services/storage/blob', () => ({ getBlobStore: () => ({}) }));

import { MobileAppStorageService } from '../mobile-app-storage.service';

/** A `mobile_app_builds` row (snake_case, as the table returns it). */
function buildRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b1',
    platform: 'android',
    package_name: 'com.example.app',
    storage_path: 'mobile-apps/w1/p1/android/app.apk',
    public_url: 'https://cdn/app.apk',
    original_name: 'app.apk',
    file_size: 1234,
    uploaded_at: '2026-06-01T00:00:00.000Z',
    version_name: '1.0.0',
    version_code: 10,
    branch: null,
    commit_sha: null,
    build_number: null,
    ci_run_id: null,
    source: 'manual',
    variant_label: 'default',
    ...overrides,
  };
}

beforeEach(() => {
  mockQueries.length = 0;
  mockResolveQuery = () => ({ data: null, error: null });
});

describe('resolveAppForRun — buildId pin', () => {
  it('returns the pinned build and skips every other stage when the platform matches', async () => {
    const pinned = buildRow({ id: 'pinned1', platform: 'android' });
    mockResolveQuery = (q) => (q.filters.id === 'pinned1' ? { data: pinned, error: null } : { data: null, error: null });

    const res = await MobileAppStorageService.resolveAppForRun({
      projectId: 'p1', platform: 'android', buildId: 'pinned1', commitSha: 'deadbeef',
    });

    expect(res?.id).toBe('pinned1');
    // Only the getBuildById lookup ran — no commit/branch/latest fan-out.
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0].filters).toMatchObject({ id: 'pinned1', project_id: 'p1' });
  });

  it('falls through to the latest-in-lane build when the pin resolves to a different platform', async () => {
    const wrongPlatform = buildRow({ id: 'ios-pin', platform: 'ios' });
    const latest = buildRow({ id: 'latest1', platform: 'android' });
    mockResolveQuery = (q) => {
      if (q.filters.id === 'ios-pin') return { data: wrongPlatform, error: null };
      if (q.table === 'mobile_app_builds' && q.filters.platform === 'android' && q.filters.variant_label === 'default') {
        return { data: latest, error: null };
      }
      return { data: null, error: null };
    };

    const res = await MobileAppStorageService.resolveAppForRun({
      projectId: 'p1', platform: 'android', buildId: 'ios-pin',
    });

    // The cross-platform pin is rejected; resolution continues to the lane.
    expect(res?.id).toBe('latest1');
  });
});

describe('resolveAppForRun — named variant lane', () => {
  it('returns the latest build in the named lane', async () => {
    const staging = buildRow({ id: 'staging1', variant_label: 'Staging' });
    mockResolveQuery = (q) =>
      q.filters.platform === 'android' && q.filters.variant_label === 'Staging'
        ? { data: staging, error: null }
        : { data: null, error: null };

    const res = await MobileAppStorageService.resolveAppForRun({
      projectId: 'p1', platform: 'android', variantLabel: 'Staging',
    });

    expect(res?.id).toBe('staging1');
    expect(res?.variantLabel).toBe('Staging');
  });

  it('returns null (NOT the default flavor) when the named lane has no build', async () => {
    // Every build query misses; the named lane must stop here and never reach
    // the legacy/shard fallback — installing the default APK in a Staging run
    // would ship the wrong flavor.
    mockResolveQuery = () => ({ data: null, error: null });

    const res = await MobileAppStorageService.resolveAppForRun({
      projectId: 'p1', platform: 'android', variantLabel: 'Staging',
    });

    expect(res).toBeNull();
    // The legacy fallback reads the `projects` table — it must never run.
    expect(mockQueries.some((q) => q.table === 'projects')).toBe(false);
  });

  it('resolves a flutter named lane from the ANDROID storage lane (flutter ships the .apk)', async () => {
    // The build was recorded under platform=android; a flutter run targeting it
    // must query the android lane, not "flutter".
    const staging = buildRow({ id: 'flutter-staging', platform: 'android', variant_label: 'Staging' });
    mockResolveQuery = (q) =>
      q.filters.platform === 'android' && q.filters.variant_label === 'Staging'
        ? { data: staging, error: null }
        : { data: null, error: null };

    const res = await MobileAppStorageService.resolveAppForRun({
      projectId: 'p1', platform: 'flutter', variantLabel: 'Staging',
    });

    expect(res?.id).toBe('flutter-staging');
    // It must have queried the android lane (never variant_label under "flutter").
    expect(mockQueries.some((q) => q.table === 'mobile_app_builds' && q.filters.platform === 'flutter')).toBe(false);
    expect(mockQueries.some((q) => q.filters.platform === 'android' && q.filters.variant_label === 'Staging')).toBe(true);
  });
});

describe('resolveAppForRun — default lane fallbacks', () => {
  it('matches the commit pin within the default lane', async () => {
    const byCommit = buildRow({ id: 'commit1', commit_sha: 'abc123' });
    mockResolveQuery = (q) =>
      q.filters.commit_sha === 'abc123' && q.filters.variant_label === 'default'
        ? { data: byCommit, error: null }
        : { data: null, error: null };

    const res = await MobileAppStorageService.resolveAppForRun({
      projectId: 'p1', platform: 'android', commitSha: 'abc123',
    });

    expect(res?.id).toBe('commit1');
  });

  it('falls back to the legacy settings slot when no build rows exist (default lane only)', async () => {
    mockResolveQuery = (q) => {
      if (q.table === 'projects') {
        return {
          data: {
            workspace_id: 'w1',
            settings: { mobileApp: { storagePath: 'legacy/app.apk', platform: 'android', publicUrl: 'u', originalName: 'app.apk' } },
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };

    const res = await MobileAppStorageService.resolveAppForRun({ projectId: 'p1', platform: 'android' });

    expect(res?.id).toBe('legacy-settings');
    expect(res?.storagePath).toBe('legacy/app.apk');
  });

  it('does NOT use the legacy slot when its platform differs from the run platform', async () => {
    mockResolveQuery = (q) => {
      if (q.table === 'projects') {
        return {
          data: { workspace_id: 'w1', settings: { mobileApp: { storagePath: 'legacy/app.ipa', platform: 'ios' } } },
          error: null,
        };
      }
      return { data: null, error: null };
    };

    const res = await MobileAppStorageService.resolveAppForRun({ projectId: 'p1', platform: 'android' });

    expect(res).toBeNull();
  });
});
