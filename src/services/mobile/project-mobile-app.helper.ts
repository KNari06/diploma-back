/**
 * Multi-platform mobile-app slot resolver.
 *
 * Background
 * ──────────
 * The original schema stored ONE mobile app per project at
 * `project.settings.mobileApp` (singular). Every new upload overwrote
 * it, regardless of platform — uploading an .ipa wiped the previously
 * uploaded .apk metadata and vice versa.
 *
 * To support dual-platform projects (most real teams ship the same
 * product on both Android and iOS), the metadata is now sharded by
 * platform:
 *
 *   project.settings.mobileApps = {
 *     android?: MobileAppMetadata,
 *     ios?: MobileAppMetadata,
 *     flutter?: MobileAppMetadata,
 *   }
 *
 * The legacy singular field stays in place. Its semantics:
 *   - Old projects: it's the ONLY slot — usually Android, occasionally iOS.
 *   - New projects: writers mirror the Android slot here for back-compat
 *     with any code path that hasn't been migrated yet (and there are
 *     several — see the grep in the PR description). Once everything
 *     reads via this helper, the mirror can be retired.
 *
 * This helper is the SINGLE READ PATH callers should use. It encapsulates
 * the precedence rules so we never end up with two readers disagreeing.
 */

import type { MobileAppMetadata } from '@/services/storage/mobile-app-storage.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';

/**
 * Loosely typed shape of `project.settings`. ProjectService doesn't
 * export a strict type because the JSONB column accumulates ad-hoc keys
 * over time; we accept `Record<string, unknown>` so this helper works
 * across all call sites without coupling them to a particular Project
 * model version.
 */
export type ProjectSettings = Record<string, unknown>;

/**
 * Shape of the new platform-sharded slot. Optional per platform — a
 * project may have only one uploaded.
 */
export interface MobileAppsByPlatform {
  android?: MobileAppMetadata;
  ios?: MobileAppMetadata;
  flutter?: MobileAppMetadata;
}

/**
 * Read the mobile-app metadata for the requested platform.
 *
 * Precedence:
 *   1. `settings.mobileApps[platform]` (new, authoritative)
 *   2. `settings.mobileApp` (legacy singular) — ONLY when its own
 *      `platform` field matches the requested one. This keeps old
 *      projects working: an Android-only project never had its
 *      mobileApps slot populated, but its legacy `mobileApp` is the
 *      Android app, so the request for android still resolves.
 *
 * Returns `undefined` when no upload exists for the requested platform.
 * Callers that need to fall back to a different platform must do so
 * explicitly — this helper never silently substitutes (otherwise we'd
 * reintroduce the bug we're fixing: install Android APK on an iOS
 * session because that's what happened to be uploaded).
 *
 * Flutter exception: a Flutter app's installable artifact on an emulator
 * IS an Android `.apk` (Flutter compiles to a native APK; the runner hosts
 * Flutter sessions on top of an Android device). Projects upload that APK
 * as `android` — there is no separate "flutter" binary. So when `flutter`
 * is requested and no flutter-specific slot exists, we DO fall back to the
 * android slot/legacy. This is safe (same .apk, same `pm install`) and is
 * NOT the cross-platform bug — that bug is about iOS, where an .ipa and an
 * .apk are genuinely different binaries. Android↔Flutter share the binary.
 */
export function getProjectMobileApp(
  settings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
): MobileAppMetadata | undefined {
  if (!settings) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps = (settings as any).mobileApps as MobileAppsByPlatform | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = (settings as any).mobileApp as MobileAppMetadata | undefined;

  // 1. New sharded slot for the exact platform.
  const fromShard = apps?.[platform];
  if (fromShard) return fromShard;

  // 2. Legacy singular slot — only when its own `platform` matches.
  // Missing `platform` on very old records is treated as "android".
  if (legacy && (legacy.platform ?? 'android') === platform) return legacy;

  // 3. Flutter → Android binary fallback. A Flutter Android build is a
  //    plain .apk stored under the `android` slot/legacy; there is no
  //    distinct flutter artifact. Reuse it so Flutter warmups install the
  //    same APK an android session would. (iOS never falls back here.)
  if (platform === 'flutter') {
    const androidShard = apps?.android;
    if (androidShard) return androidShard;
    if (legacy && (legacy.platform ?? 'android') === 'android') return legacy;
  }

  return undefined;
}

/**
 * Read ALL platform slots at once. Used by:
 *   - GET endpoint that returns the full dict
 *   - Frontend MobileSettings panel showing both upload widgets
 *
 * The legacy slot, when present, lands under its own platform if that
 * platform's shard is empty (read-time virtual fill — we don't write
 * back). This means a fresh `MobileSettings` page on an old project
 * naturally shows the Android slot populated without a data migration.
 */
export function getAllProjectMobileApps(
  settings: ProjectSettings | undefined | null,
): MobileAppsByPlatform {
  const out: MobileAppsByPlatform = {};
  if (!settings) return out;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps = (settings as any).mobileApps as MobileAppsByPlatform | undefined;
  if (apps?.android) out.android = apps.android;
  if (apps?.ios) out.ios = apps.ios;
  if (apps?.flutter) out.flutter = apps.flutter;

  // Virtual-fill from legacy if the matching shard is empty.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = (settings as any).mobileApp as MobileAppMetadata | undefined;
  if (legacy) {
    const p = (legacy.platform ?? 'android') as MobilePlatform;
    if (p === 'android' && !out.android) out.android = legacy;
    else if (p === 'ios' && !out.ios) out.ios = legacy;
    else if (p === 'flutter' && !out.flutter) out.flutter = legacy;
  }
  return out;
}

/**
 * Build the settings patch for a new upload.
 *
 * Always writes the platform-sharded slot. ALSO mirrors into the legacy
 * singular slot during the transition period — callers that still read
 * `settings.mobileApp` directly continue to see the latest upload (with
 * the same "last write wins across platforms" behaviour they had
 * before, which is a graceful degradation rather than a new bug).
 *
 * The mirror can be removed once a grep confirms every read goes
 * through `getProjectMobileApp` / `getAllProjectMobileApps`.
 */
export function buildMobileAppSettingsPatch(
  currentSettings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
  metadata: MobileAppMetadata,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (currentSettings ?? {}) as any;
  const mobileApps: MobileAppsByPlatform = {
    ...(existing.mobileApps as MobileAppsByPlatform | undefined),
    [platform]: metadata,
  };
  return {
    mobileApp: metadata,    // legacy mirror (TODO: remove after readers migrate)
    mobileApps,             // new authoritative
  };
}
