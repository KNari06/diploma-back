/**
 * Unit tests for the two pure lane rules an upload and a probe depend on.
 *
 * `buildDriverVerdictPatch` decides WHERE a driver-extension verdict lands and
 * whether it is still valid — stamping a named lane's verdict onto the default
 * lane would tell the user a build passed the probe when a different binary did.
 *
 * `shouldPromoteToDefault` decides whether an upload also becomes the platform's
 * default. Get it wrong in one direction and a project's first build is never
 * installed by a run; in the other, an upload silently re-points a project that
 * already had a default.
 */

import { buildDriverVerdictPatch, shouldPromoteToDefault } from '@/services/mobile/project-mobile-app.helper';

const VERDICT = {
  driverExtensionDetected: 'detected',
  driverExtensionDetail: 'VM Service found',
  driverExtensionDetectedAt: '2026-08-26T11:41:00.000Z',
};

const defaultBuild = { storagePath: 'apps/p1/default.apk', packageName: 'com.example', platform: 'android' };
const stagingBuild = { storagePath: 'apps/p1/staging.apk', packageName: 'com.example', platform: 'android' };

/** Settings with a populated default lane AND a named `Staging` lane. */
function settingsWithBothLanes() {
  return {
    mobileApp: defaultBuild,
    mobileApps: { android: defaultBuild },
    mobileAppVariants: {
      android: [{ label: 'Staging', isDefault: false, latest: stagingBuild }],
    },
  };
}

describe('buildDriverVerdictPatch', () => {
  it('stamps a named lane without touching the default lane mirror', () => {
    const patch = buildDriverVerdictPatch(
      settingsWithBothLanes() as never,
      'android',
      'Staging',
      stagingBuild.storagePath,
      VERDICT,
    );

    const lanes = (patch as never as { mobileAppVariants: { android: { label: string; latest: Record<string, unknown> }[] } }).mobileAppVariants.android;
    expect(lanes.find((l) => l.label === 'Staging')?.latest).toMatchObject(VERDICT);
    // The legacy/shard mirror belongs to the default lane — a named-lane
    // probe must not rewrite it.
    expect(patch).not.toHaveProperty('mobileApp');
    expect(patch).not.toHaveProperty('mobileApps');
  });

  it('stamps the default lane and mirrors it to the legacy and shard slots', () => {
    const patch = buildDriverVerdictPatch(
      settingsWithBothLanes() as never,
      'android',
      'default',
      defaultBuild.storagePath,
      VERDICT,
    );

    expect(patch).toMatchObject({
      mobileApp: expect.objectContaining(VERDICT),
      mobileApps: { android: expect.objectContaining(VERDICT) },
    });
  });

  it('returns null when the lane got a new build during the probe', () => {
    const patch = buildDriverVerdictPatch(
      settingsWithBothLanes() as never,
      'android',
      'Staging',
      'apps/p1/an-older-build.apk',
      VERDICT,
    );

    expect(patch).toBeNull();
  });

  it('returns null when the probed lane no longer exists', () => {
    const patch = buildDriverVerdictPatch(
      settingsWithBothLanes() as never,
      'android',
      'DeletedLane',
      stagingBuild.storagePath,
      VERDICT,
    );

    expect(patch).toBeNull();
  });

  it('writes a flutter probe into the android lane, since flutter ships an apk', () => {
    const patch = buildDriverVerdictPatch(
      settingsWithBothLanes() as never,
      'flutter',
      'Staging',
      stagingBuild.storagePath,
      VERDICT,
    );

    const variants = (patch as never as { mobileAppVariants: Record<string, unknown> }).mobileAppVariants;
    expect(variants).toHaveProperty('android');
    expect(variants).not.toHaveProperty('flutter');
  });

  it('preserves the build metadata it merges onto', () => {
    const patch = buildDriverVerdictPatch(
      settingsWithBothLanes() as never,
      'android',
      'default',
      defaultBuild.storagePath,
      VERDICT,
    );

    expect((patch as never as { mobileApp: Record<string, unknown> }).mobileApp).toMatchObject({
      storagePath: defaultBuild.storagePath,
      packageName: 'com.example',
    });
  });
});

describe('shouldPromoteToDefault', () => {
  it('promotes a first named build, which nothing else would resolve to', () => {
    expect(shouldPromoteToDefault({} as never, 'android', 'Staging')).toBe(true);
  });

  it('leaves an existing default pointer alone', () => {
    const settings = { mobileDefaultVariant: { android: 'Prod' } };
    expect(shouldPromoteToDefault(settings as never, 'android', 'Staging')).toBe(false);
  });

  it('does not promote when the default lane already holds a build', () => {
    const settings = { mobileApps: { android: defaultBuild } };
    expect(shouldPromoteToDefault(settings as never, 'android', 'Staging')).toBe(false);
  });

  it('never promotes the default lane itself — it is already the fallback', () => {
    expect(shouldPromoteToDefault({} as never, 'android', 'default')).toBe(false);
  });

  it('treats a blank pointer as absent rather than as a lane name', () => {
    const settings = { mobileDefaultVariant: { android: '   ' } };
    expect(shouldPromoteToDefault(settings as never, 'android', 'Staging')).toBe(true);
  });

  it('resolves a flutter upload against the android lane it is stored under', () => {
    const settings = { mobileApps: { android: defaultBuild } };
    expect(shouldPromoteToDefault(settings as never, 'flutter', 'Staging')).toBe(false);
  });
});
