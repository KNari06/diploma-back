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
import type { FlutterHostPlatform, MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { env } from '@/config/environment/env';

/**
 * Canonical label for the default variant lane. A project's first upload
 * (and every upload that doesn't name a variant) lands here. The label is
 * deliberately version-independent — a variant accumulates many builds over
 * time, so encoding app name / version / mode would mint a new variant per
 * upload and blow the cap.
 */
export const DEFAULT_VARIANT_LABEL = 'default';

/**
 * Normalise a variant OVERRIDE field (a flow / test-case / plan's
 * `mobile_variant_label`), where the absence of a value means "inherit".
 * Blank/non-string → `null`. This is distinct from the upload/resolve-side
 * `normaliseVariantLabel` (which folds blank → the literal `'default'` lane).
 * Use this anywhere null means inherit so the five call sites can't drift.
 */
export function normaliseVariantOverride(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/**
 * Max named variants per (project, platform). Sourced from the
 * MAX_MOBILE_VARIANTS env var (default 3). Read ONLY through this accessor
 * so the source can later become a per-project / admin setting by changing
 * this body — never reference the env value at call sites.
 */
export function getMaxMobileVariants(): number {
  const n = env.MAX_MOBILE_VARIANTS;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/**
 * One named variant lane as mirrored into `project.settings` for fast UI
 * reads. `latest` is the newest build's metadata in that lane; the durable
 * source of truth is the `mobile_app_builds` table (`variant_label`).
 */
export interface MobileAppVariantEntry {
  label: string;
  isDefault: boolean;
  latest: MobileAppMetadata;
}

/** Per-platform variant registry: `settings.mobileAppVariants[platform]`. */
export interface MobileAppVariantsByPlatform {
  android?: MobileAppVariantEntry[];
  ios?: MobileAppVariantEntry[];
  flutter?: MobileAppVariantEntry[];
}

/**
 * Per-platform "which variant is the default" pointer:
 * `settings.mobileDefaultVariant[platform]`. The default variant is the one a
 * run uses when nothing (test case / plan) specifies a variant. Absent = the
 * literal `'default'` lane (the main upload).
 */
export interface MobileDefaultVariantByPlatform {
  android?: string;
  ios?: string;
  flutter?: string;
}

/**
 * The variant a run resolves to when no test/plan variant is set. Reads the
 * per-platform pointer, falling back to the `'default'` lane.
 */
export function getDefaultVariantLabel(
  settings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ptr = (settings as any)?.mobileDefaultVariant as MobileDefaultVariantByPlatform | undefined;
  const label = ptr?.[variantStoragePlatform(platform)];
  return typeof label === 'string' && label.trim() ? label : DEFAULT_VARIANT_LABEL;
}

/**
 * Which platform a variant's builds physically live under. Flutter apps are
 * uploaded as a native Android `.apk` (there is no separate flutter binary),
 * so their variant lanes are stored under `android`. Every variant read /
 * default / resolution for flutter must therefore look at the android lane.
 */
export function variantStoragePlatform(platform: MobilePlatform): MobilePlatform {
  return platform === 'flutter' ? 'android' : platform;
}

/** Build the settings patch that sets the default variant for a platform. */
export function buildSetDefaultVariantPatch(
  currentSettings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
  label: string,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (currentSettings ?? {}) as any;
  const ptr = (existing.mobileDefaultVariant as MobileDefaultVariantByPlatform | undefined) ?? {};
  return { mobileDefaultVariant: { ...ptr, [platform]: label } };
}

/**
 * Normalise a Flutter host value (`android`|`ios`) where absence means
 * "inherit". Anything that isn't exactly one of the two hosts → `null`.
 * Use this for the per-test-case `host_platform` override and any
 * caller-supplied host so the call sites can't drift (mirrors
 * `normaliseVariantOverride`).
 */
export function normaliseHostOverride(raw: unknown): FlutterHostPlatform | null {
  return raw === 'android' || raw === 'ios' ? raw : null;
}

/**
 * The host a Flutter run resolves to when the test case has no override.
 * Reads the scalar `settings.flutterDefaultHost` pointer (written by the
 * editor's Android/iOS toggle). Absent/invalid = `'android'` (back-compat:
 * every Flutter run was implicitly Android-hosted before this existed).
 *
 * Scalar, not a per-platform map like `mobileDefaultVariant`: only
 * `mobile_flutter` tests have a host choice — native platforms already
 * encode their OS in the platform key (ADR-0019: host lane, not a key).
 */
export function getFlutterDefaultHost(
  settings: ProjectSettings | undefined | null,
): FlutterHostPlatform {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return normaliseHostOverride((settings as any)?.flutterDefaultHost) ?? 'android';
}

/** Build the settings patch that sets the project's Flutter default host. */
export function buildSetFlutterDefaultHostPatch(
  host: FlutterHostPlatform,
): Record<string, unknown> {
  return { flutterDefaultHost: host };
}

/**
 * Resolve the effective host for one Flutter run:
 * test-case override > project default > 'android'. Callers pass the raw
 * `intent_test_cases.host_platform` value and the project settings.
 */
export function resolveFlutterHost(
  caseHostPlatform: unknown,
  settings: ProjectSettings | undefined | null,
): FlutterHostPlatform {
  return normaliseHostOverride(caseHostPlatform) ?? getFlutterDefaultHost(settings);
}

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
  variantLabel?: string,
): MobileAppMetadata | undefined {
  if (!settings) return undefined;

  // Which lane to read: an explicit variant wins; otherwise the project's
  // configured default-variant pointer (which may itself be a named lane). An
  // explicit 'default' means the literal default lane, not the pointer.
  const effectiveLabel = (variantLabel && variantLabel.trim())
    ? variantLabel
    : getDefaultVariantLabel(settings, platform);

  // Named lane → read its latest from the registry. No silent substitution —
  // an absent lane returns undefined so callers don't install the wrong flavor.
  if (effectiveLabel !== DEFAULT_VARIANT_LABEL) {
    const entry = getProjectMobileVariants(settings, platform)
      .find((v) => v.label === effectiveLabel);
    return entry?.latest;
  }

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
 * Read the variant registry for a platform: `settings.mobileAppVariants[platform]`.
 *
 * This is the per-platform list of named lanes mirrored for fast UI reads.
 * The durable source of truth is `mobile_app_builds.variant_label`; the
 * registry is rebuilt on every upload / rename / delete. When the registry
 * is absent (projects that pre-date variants) we synthesise a single
 * `'default'` entry from the legacy/shard slot so the Settings UI shows one
 * lane without a data migration.
 */
export function getProjectMobileVariants(
  settings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
): MobileAppVariantEntry[] {
  if (!settings) return [];

  // `isDefault` follows the project's default-variant pointer (set-default),
  // NOT a stored flag — so promoting a lane updates every badge consistently.
  const defaultLabel = getDefaultVariantLabel(settings, platform);
  // Flutter variants live under the android lane (shared .apk).
  const lanePlatform = variantStoragePlatform(platform);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (settings as any).mobileAppVariants as MobileAppVariantsByPlatform | undefined;
  const fromRegistry = registry?.[lanePlatform];
  if (fromRegistry && fromRegistry.length > 0) {
    const mapped = fromRegistry.map((v) => ({ ...v, isDefault: v.label === defaultLabel }));
    // The registry stores only NAMED lanes; the base/default build lives in the
    // legacy/shard slot. Surface it as a `default` lane too so build-variant
    // pickers can offer the base build (otherwise a project with named variants
    // hides its base app from the picker entirely). The Settings UI renders the
    // default lane from the slot and filters `default` out of its named list, so
    // this adds no double-listing there.
    if (!mapped.some((v) => v.label === DEFAULT_VARIANT_LABEL)) {
      const slot = getProjectMobileApp(settings, platform, DEFAULT_VARIANT_LABEL);
      if (slot) {
        mapped.unshift({ label: DEFAULT_VARIANT_LABEL, isDefault: DEFAULT_VARIANT_LABEL === defaultLabel, latest: slot });
      }
    }
    return mapped;
  }

  // Virtual-fill: synthesise a default lane from the legacy/shard slot.
  const slot = getProjectMobileApp(settings, platform, DEFAULT_VARIANT_LABEL);
  return slot ? [{ label: DEFAULT_VARIANT_LABEL, isDefault: DEFAULT_VARIANT_LABEL === defaultLabel, latest: slot }] : [];
}

/**
 * True when the project has ANY installable build for `platform` — the base
 * slot, the legacy singular slot, or a named variant lane. Pure (settings-only),
 * so it can gate a write without a second DB round-trip.
 *
 * Deliberately reuses `getProjectMobileVariants`: that function already folds
 * every source a run can resolve (registry lanes + virtual-filled default slot)
 * into one list, so this predicate can never disagree with what prep would
 * actually find. A hand-rolled `!!settings.mobileApps[platform]` check would
 * miss a project whose only iOS build lives in a named lane.
 *
 * Used to reject `flutterDefaultHost: 'ios'` / `host_platform: 'ios'` on a
 * project with no iOS build — a combination that cannot succeed and whose
 * failure surfaces 2 minutes later as an opaque WebDriverAgent timeout.
 */
export function hasProjectMobileBuild(
  settings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
): boolean {
  return getProjectMobileVariants(settings, platform).length > 0;
}

/**
 * Build a settings patch that REMOVES a variant lane from the registry.
 * Only touches `mobileAppVariants[platform]` — the legacy/shard slot is left
 * alone (callers must not delete the default lane, which mirrors it).
 */
export function buildRemoveMobileVariantPatch(
  currentSettings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
  variantLabel: string,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (currentSettings ?? {}) as any;
  const registry = (existing.mobileAppVariants as MobileAppVariantsByPlatform | undefined) ?? {};
  const laneList = (registry[platform] ?? []).filter((v) => v.label !== variantLabel);
  return { mobileAppVariants: { ...registry, [platform]: laneList } };
}

/**
 * Build a settings patch that RELABELS a variant lane (`from` → `to`) in the
 * registry, preserving its `latest`/`isDefault`. No-op fields for other lanes.
 */
export function buildRenameMobileVariantPatch(
  currentSettings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
  from: string,
  to: string,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (currentSettings ?? {}) as any;
  const registry = (existing.mobileAppVariants as MobileAppVariantsByPlatform | undefined) ?? {};
  const laneList = (registry[platform] ?? []).map((v) =>
    v.label === from ? { ...v, label: to } : v,
  );
  return { mobileAppVariants: { ...registry, [platform]: laneList } };
}

/**
 * Build the settings patch for a new upload into `variantLabel`.
 *
 * - DEFAULT lane: writes the legacy singular slot AND the platform shard (so
 *   every existing reader keeps seeing the project's active app), plus the
 *   registry entry.
 * - NAMED lane: leaves the legacy/shard slot untouched (those mirror the
 *   default lane) and only upserts this variant's registry entry, so a
 *   Staging upload never changes what a default-lane resolve returns.
 *
 * The registry (`mobileAppVariants[platform]`) is a derived mirror — the
 * durable source of truth is the `mobile_app_builds` table.
 */
export function buildMobileAppSettingsPatch(
  currentSettings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
  metadata: MobileAppMetadata,
  variantLabel: string = DEFAULT_VARIANT_LABEL,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (currentSettings ?? {}) as any;
  const isDefaultLane = variantLabel === DEFAULT_VARIANT_LABEL;

  // Upsert this lane into the per-platform registry.
  const registry = (existing.mobileAppVariants as MobileAppVariantsByPlatform | undefined) ?? {};
  const laneList = [...(registry[platform] ?? [])];
  const idx = laneList.findIndex((v) => v.label === variantLabel);
  const entry: MobileAppVariantEntry = { label: variantLabel, isDefault: isDefaultLane, latest: metadata };
  if (idx >= 0) laneList[idx] = { ...laneList[idx], ...entry };
  else laneList.push(entry);
  const mobileAppVariants: MobileAppVariantsByPlatform = { ...registry, [platform]: laneList };

  const patch: Record<string, unknown> = { mobileAppVariants };

  if (isDefaultLane) {
    patch.mobileApp = metadata; // legacy mirror (TODO: remove after readers migrate)
    patch.mobileApps = {
      ...(existing.mobileApps as MobileAppsByPlatform | undefined),
      [platform]: metadata,
    } satisfies MobileAppsByPlatform;
  }

  return patch;
}

/**
 * Should this upload also become the platform's default build?
 *
 * A run with no explicit variant resolves through `getDefaultVariantLabel` →
 * the `mobileDefaultVariant` pointer, falling back to the literal `default`
 * lane. Nothing sets that pointer except the explicit "make default" action,
 * so a project whose FIRST build is a named one would resolve to the empty
 * default lane: the settings page shows a build, and every run reports no
 * installable binary.
 *
 * True only when the platform has nothing to resolve to yet — no pointer AND
 * an empty default lane. It therefore promotes a first build and never
 * silently re-points a project that already has a default.
 */
export function shouldPromoteToDefault(
  settings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
  variantLabel: string,
): boolean {
  if (variantLabel === DEFAULT_VARIANT_LABEL) return false;
  const lanePlatform = variantStoragePlatform(platform);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ptr = (settings as any)?.mobileDefaultVariant as MobileDefaultVariantByPlatform | undefined;
  if (typeof ptr?.[lanePlatform] === 'string' && ptr[lanePlatform]?.trim()) return false;
  return !getProjectMobileApp(settings, lanePlatform, DEFAULT_VARIANT_LABEL);
}

/** The driver-extension verdict fields stamped onto a build by the probe. */
export interface DriverVerdictFields {
  driverExtensionDetected: string;
  driverExtensionDetail: string;
  driverExtensionDetectedAt: string;
}

/**
 * Build the settings patch that stamps a driver-extension verdict onto ONE
 * lane's latest build. Mirrors `buildMobileAppSettingsPatch`'s lane rules:
 * the default lane also updates the legacy/shard mirror, a named lane only
 * its registry entry.
 *
 * Returns `null` when the lane's current build is no longer the one that was
 * probed — a re-upload mid-probe makes the verdict stale, and stamping it
 * would label a new binary with an old build's result. The caller skips the
 * write. `probedStoragePath` is therefore the identity of the probed build,
 * NOT just a sanity check.
 */
export function buildDriverVerdictPatch(
  currentSettings: ProjectSettings | undefined | null,
  platform: MobilePlatform,
  variantLabel: string,
  probedStoragePath: string,
  verdict: DriverVerdictFields,
): Record<string, unknown> | null {
  const lanePlatform = variantStoragePlatform(platform);
  const current = getProjectMobileApp(currentSettings, lanePlatform, variantLabel);
  if (!current || current.storagePath !== probedStoragePath) return null;

  const updated = { ...current, ...verdict } as MobileAppMetadata;
  return buildMobileAppSettingsPatch(currentSettings, lanePlatform, updated, variantLabel);
}
