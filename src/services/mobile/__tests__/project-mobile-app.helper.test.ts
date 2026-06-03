import { getProjectMobileApp } from '@/services/mobile/project-mobile-app.helper';
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
});
