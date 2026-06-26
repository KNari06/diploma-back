import {
  getProjectMobileApp,
  getProjectMobileVariants,
  buildMobileAppSettingsPatch,
  DEFAULT_VARIANT_LABEL,
} from '@/services/mobile/project-mobile-app.helper';
import type { MobileAppMetadata } from '@/services/storage/mobile-app-storage.service';

const app = (platform: MobileAppMetadata['platform'], storagePath: string): MobileAppMetadata =>
  ({ platform, storagePath } as MobileAppMetadata);

describe('getProjectMobileApp', () => {
  describe('exact-platform resolution', () => {
    it('returns the sharded slot for the requested platform', () => {
      const settings = { mobileApps: { android: app('android', 'a.apk'), ios: app('ios', 'a.ipa') } };
      expect(getProjectMobileApp(settings, 'android')?.storagePath).toBe('a.apk');
      expect(getProjectMobileApp(settings, 'ios')?.storagePath).toBe('a.ipa');
    });

    it('falls back to legacy slot when its platform matches', () => {
      const settings = { mobileApp: app('android', 'legacy.apk') };
      expect(getProjectMobileApp(settings, 'android')?.storagePath).toBe('legacy.apk');
    });

    it('treats legacy slot with missing platform as android', () => {
      const settings = { mobileApp: { storagePath: 'old.apk' } as MobileAppMetadata };
      expect(getProjectMobileApp(settings, 'android')?.storagePath).toBe('old.apk');
    });
  });

  describe('flutter → android binary fallback', () => {
    it('uses the android shard when no flutter shard exists', () => {
      // A Flutter app is uploaded as an android .apk; flutter sessions reuse it.
      const settings = { mobileApps: { android: app('android', 'flutter-built.apk') } };
      expect(getProjectMobileApp(settings, 'flutter')?.storagePath).toBe('flutter-built.apk');
    });

    it('uses the legacy android slot when no flutter shard exists', () => {
      const settings = { mobileApp: app('android', 'legacy-flutter.apk') };
      expect(getProjectMobileApp(settings, 'flutter')?.storagePath).toBe('legacy-flutter.apk');
    });

    it('prefers an explicit flutter shard over the android fallback', () => {
      const settings = {
        mobileApps: { flutter: app('flutter', 'explicit.apk'), android: app('android', 'other.apk') },
      };
      expect(getProjectMobileApp(settings, 'flutter')?.storagePath).toBe('explicit.apk');
    });

    it('returns undefined for flutter when only an iOS app exists', () => {
      const settings = { mobileApps: { ios: app('ios', 'only.ipa') } };
      expect(getProjectMobileApp(settings, 'flutter')).toBeUndefined();
    });
  });

  describe('iOS never cross-falls-back (the original bug guard)', () => {
    it('returns undefined for ios when only an android app exists', () => {
      const settings = { mobileApps: { android: app('android', 'a.apk') } };
      expect(getProjectMobileApp(settings, 'ios')).toBeUndefined();
    });

    it('returns undefined for ios when only a legacy android app exists', () => {
      const settings = { mobileApp: app('android', 'a.apk') };
      expect(getProjectMobileApp(settings, 'ios')).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('returns undefined for null/empty settings', () => {
      expect(getProjectMobileApp(null, 'flutter')).toBeUndefined();
      expect(getProjectMobileApp(undefined, 'android')).toBeUndefined();
      expect(getProjectMobileApp({}, 'flutter')).toBeUndefined();
    });
  });

  describe('named-variant read', () => {
    it('returns the named lane latest when requested', () => {
      const settings = {
        mobileAppVariants: { android: [{ label: 'Staging', isDefault: false, latest: app('android', 's.apk') }] },
      };
      expect(getProjectMobileApp(settings, 'android', 'Staging')?.storagePath).toBe('s.apk');
    });

    it('returns undefined for a named lane with no builds (no silent default substitution)', () => {
      const settings = { mobileApps: { android: app('android', 'd.apk') } };
      expect(getProjectMobileApp(settings, 'android', 'Staging')).toBeUndefined();
    });

    it('default request still resolves the legacy/shard slot', () => {
      const settings = { mobileApps: { android: app('android', 'd.apk') } };
      expect(getProjectMobileApp(settings, 'android', DEFAULT_VARIANT_LABEL)?.storagePath).toBe('d.apk');
    });
  });
});

describe('buildMobileAppSettingsPatch', () => {
  const m = (storagePath: string): MobileAppMetadata =>
    ({ platform: 'android', storagePath } as MobileAppMetadata);

  it('default lane writes legacy + shard + registry', () => {
    const patch = buildMobileAppSettingsPatch(undefined, 'android', m('d.apk'), DEFAULT_VARIANT_LABEL) as Record<string, any>;
    expect(patch.mobileApp.storagePath).toBe('d.apk');
    expect(patch.mobileApps.android.storagePath).toBe('d.apk');
    expect(patch.mobileAppVariants.android).toEqual([
      { label: DEFAULT_VARIANT_LABEL, isDefault: true, latest: m('d.apk') },
    ]);
  });

  it('named lane leaves legacy/shard untouched and only upserts the registry', () => {
    const base = buildMobileAppSettingsPatch(undefined, 'android', m('d.apk'), DEFAULT_VARIANT_LABEL);
    const patch = buildMobileAppSettingsPatch(base, 'android', m('s.apk'), 'Staging') as Record<string, any>;
    expect(patch.mobileApp).toBeUndefined();
    expect(patch.mobileApps).toBeUndefined();
    const labels = (patch.mobileAppVariants.android as Array<{ label: string }>).map((l) => l.label).sort();
    expect(labels).toEqual([DEFAULT_VARIANT_LABEL, 'Staging'].sort());
  });

  it('re-upload to a lane replaces (does not duplicate) its entry', () => {
    const first = buildMobileAppSettingsPatch(undefined, 'android', m('s1.apk'), 'Staging');
    const patch = buildMobileAppSettingsPatch(first, 'android', m('s2.apk'), 'Staging') as Record<string, any>;
    const lanes = patch.mobileAppVariants.android as Array<{ latest: MobileAppMetadata }>;
    expect(lanes).toHaveLength(1);
    expect(lanes[0].latest.storagePath).toBe('s2.apk');
  });
});

describe('getProjectMobileVariants', () => {
  it('virtual-fills a default lane from the legacy slot when no registry exists', () => {
    const lanes = getProjectMobileVariants({ mobileApp: app('android', 'd.apk') }, 'android');
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ label: DEFAULT_VARIANT_LABEL, isDefault: true });
    expect(lanes[0].latest.storagePath).toBe('d.apk');
  });

  it('returns [] when nothing is uploaded', () => {
    expect(getProjectMobileVariants({}, 'android')).toEqual([]);
    expect(getProjectMobileVariants(undefined, 'android')).toEqual([]);
  });

  it('flutter reads the android lanes (flutter ships the android .apk)', () => {
    const settings = {
      mobileAppVariants: { android: [{ label: 'Staging', isDefault: false, latest: app('android', 's.apk') }] },
    };
    // flutter has no lanes of its own, but must see android's.
    const lanes = getProjectMobileVariants(settings, 'flutter');
    expect(lanes.map((l) => l.label)).toEqual(['Staging']);
    // and a named flutter variant read resolves to the android build.
    expect(getProjectMobileApp(settings, 'flutter', 'Staging')?.storagePath).toBe('s.apk');
  });

  it('surfaces the base default lane alongside named lanes (so pickers can offer the base build)', () => {
    const settings = {
      mobileApp: app('android', 'base.apk'),
      mobileAppVariants: { android: [{ label: 'Staging', isDefault: false, latest: app('android', 's.apk') }] },
    };
    const lanes = getProjectMobileVariants(settings, 'android');
    expect(lanes.map((l) => l.label)).toEqual([DEFAULT_VARIANT_LABEL, 'Staging']);
    expect(lanes[0].latest.storagePath).toBe('base.apk');
  });

  it('does not duplicate an explicit default entry already in the registry', () => {
    const settings = {
      mobileApp: app('android', 'base.apk'),
      mobileAppVariants: { android: [
        { label: DEFAULT_VARIANT_LABEL, isDefault: true, latest: app('android', 'reg.apk') },
        { label: 'Staging', isDefault: false, latest: app('android', 's.apk') },
      ] },
    };
    const lanes = getProjectMobileVariants(settings, 'android');
    expect(lanes.map((l) => l.label)).toEqual([DEFAULT_VARIANT_LABEL, 'Staging']);
    expect(lanes[0].latest.storagePath).toBe('reg.apk'); // registry's own, not synthesized
  });
});
