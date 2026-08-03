/**
 * The iOS host lane is only writable when the project actually has an iOS
 * build. Without this gate the pair persists silently and every run — editor,
 * regression, scheduled, CI — fails ~2 minutes later on
 * `WDA on port 8115 did not become ready within 120000ms`, which reads as a
 * runner fault rather than a project setting (incident 2026-08-02).
 *
 * Collaborators are mocked at the ProjectService boundary; the settings
 * predicate itself is real (it IS the behaviour under test).
 */

// Mocked at the same boundaries as the sibling mobile-app.service tests: the
// storage service pulls in the Supabase client, which throws at module load
// without env (see .claude/deferred/20260726-jest-suites-fail-without-env.md).
jest.mock('@/services/core/project.service', () => ({
  ProjectService: { getProject: jest.fn(), updateProject: jest.fn() },
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    statObject: jest.fn(),
    finaliseDirectUpload: jest.fn(),
    recordBuild: jest.fn(),
    listVariantLabels: jest.fn().mockResolvedValue([]),
  },
  trimMobileBuildField: (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined),
}));

jest.mock('@/services/mobile/mobile-app-parser.service', () => ({
  MobileAppParserService: { parseFromStorage: jest.fn() },
}));

import {
  projectSupportsFlutterHost,
  assertProjectSupportsFlutterHost,
} from '@/services/mobile/flutter-host-guard.service';
import { setFlutterDefaultHost } from '@/services/mobile/mobile-app.service';
import { ProjectService } from '@/services/core/project.service';

const mockedProject = ProjectService as jest.Mocked<typeof ProjectService>;

const IOS_APP = { storagePath: 'app.ipa', platform: 'ios', originalName: 'Runner.app.zip' };
const ANDROID_APP = { storagePath: 'app.apk', platform: 'android', originalName: 'app.apk' };

const withSettings = (settings: Record<string, unknown>) =>
  mockedProject.getProject.mockResolvedValue({ id: 'p1', workspace_id: 'w1', settings } as any);

beforeEach(() => {
  jest.clearAllMocks();
  mockedProject.updateProject.mockResolvedValue({} as any);
});

describe('projectSupportsFlutterHost', () => {
  it('refuses the iOS lane when the project has no iOS build', async () => {
    withSettings({ mobileApps: { android: ANDROID_APP } });
    expect(await projectSupportsFlutterHost('p1', 'u1', 'ios')).toBe(false);
  });

  it('allows the iOS lane once an iOS build exists', async () => {
    withSettings({ mobileApps: { android: ANDROID_APP, ios: IOS_APP } });
    expect(await projectSupportsFlutterHost('p1', 'u1', 'ios')).toBe(true);
  });

  it('allows the iOS lane when the only iOS build is a named variant', async () => {
    withSettings({
      mobileAppVariants: { ios: [{ label: 'Staging', isDefault: false, latest: IOS_APP }] },
    });
    expect(await projectSupportsFlutterHost('p1', 'u1', 'ios')).toBe(true);
  });

  it('never gates android — it is the implicit fallback lane, so gating it would strand a project already on iOS', async () => {
    withSettings({});
    expect(await projectSupportsFlutterHost('p1', 'u1', 'android')).toBe(true);
    expect(mockedProject.getProject).not.toHaveBeenCalled();
  });

  it('allows the write when the project is unreadable, leaving authz to the caller', async () => {
    mockedProject.getProject.mockResolvedValue(null as any);
    expect(await projectSupportsFlutterHost('p1', 'u1', 'ios')).toBe(true);
  });
});

describe('assertProjectSupportsFlutterHost', () => {
  it('throws a ValidationError naming the missing build', async () => {
    withSettings({ mobileApps: { android: ANDROID_APP } });
    await expect(assertProjectSupportsFlutterHost('p1', 'u1', 'ios')).rejects.toThrow(
      /no iOS build uploaded/i,
    );
  });

  it('resolves silently for a supported lane', async () => {
    withSettings({ mobileApps: { ios: IOS_APP } });
    await expect(assertProjectSupportsFlutterHost('p1', 'u1', 'ios')).resolves.toBeUndefined();
  });
});

describe('setFlutterDefaultHost', () => {
  it('rejects ios on a project with no iOS build and writes nothing', async () => {
    withSettings({ mobileApps: { android: ANDROID_APP } });
    const res = await setFlutterDefaultHost('p1', 'u1', 'ios');
    expect(res).toEqual({ kind: 'host_build_missing', host: 'ios' });
    expect(mockedProject.updateProject).not.toHaveBeenCalled();
  });

  it('persists ios once an iOS build exists', async () => {
    withSettings({ mobileApps: { ios: IOS_APP } });
    const res = await setFlutterDefaultHost('p1', 'u1', 'ios');
    expect(res).toEqual({ flutterDefaultHost: 'ios' });
    expect(mockedProject.updateProject).toHaveBeenCalledWith('p1', 'u1', {
      settings: { flutterDefaultHost: 'ios' },
    });
  });

  it('still lets a project stuck on ios switch BACK to android with no android build', async () => {
    withSettings({ flutterDefaultHost: 'ios' });
    const res = await setFlutterDefaultHost('p1', 'u1', 'android');
    expect(res).toEqual({ flutterDefaultHost: 'android' });
    expect(mockedProject.updateProject).toHaveBeenCalled();
  });

  it('keeps rejecting a malformed host before the build check', async () => {
    const res = await setFlutterDefaultHost('p1', 'u1', 'windows');
    expect(res).toEqual({ kind: 'invalid_host' });
    expect(mockedProject.getProject).not.toHaveBeenCalled();
  });
});
