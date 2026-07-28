/**
 * Mobile App Parser Service
 *
 * Reads version + package metadata directly from an uploaded APK / AAB / IPA
 * binary in Supabase Storage, so the user doesn't have to type values that
 * already live inside the file. Used by `finalizeMobileAppUpload` as a fill-
 * in step: client-supplied values still win, parsed values fill the gaps.
 *
 * Hard contract: NEVER throw. Corrupt / unsupported / parser bug → return {}.
 * The caller has a timestamp-based fallback for missing version fields, so
 * parser failures must degrade gracefully — they MUST NOT block uploads.
 */

import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import {
  detectBuildInfoFromArchive,
  DetectedFramework,
  FlutterBuildMode,
} from '@/services/mobile/archive-platform-detect';
import {
  detectFlutterDriverExtension,
  type DriverExtensionDetection,
} from '@/services/mobile/flutter-driver-static-detect';
import { logger } from '@/utils/core/logger';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// app-info-parser is a CommonJS module with no published types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AppInfoParser = require('app-info-parser');

export interface ParsedAppInfo {
  versionName?: string;
  versionCode?: number;
  packageName?: string;
  /**
   * Framework discriminator read from the archive itself — independent of
   * the user-selected `platform` field on the upload form, which is just
   * "android" vs "ios" based on file extension.
   *
   * It is stored as `detectedFramework` metadata and drives UI advice and the
   * CI build contract. It does NOT promote `platform`: finalize records the
   * `platform` it was given. A Flutter Android build IS a plain `.apk` and is
   * deliberately stored under `android` (`variantStoragePlatform` maps
   * `flutter → android`), because there is no separate Flutter binary — the
   * `'flutter'` platform value describes test cases and runs, not build storage.
   *
   * `undefined` means detection failed or the archive is unsupported —
   * NEVER let parser failures block the upload.
   */
  framework?: DetectedFramework;
  /**
   * Flutter build flavor (debug vs aot) inferred from the archive. Only set
   * when `framework === 'flutter'`. Used by the Settings UI to render the
   * Flutter banner with the right severity (debug → automatable; aot →
   * profile-or-release, runtime check required).
   */
  flutterBuildMode?: FlutterBuildMode;
  /**
   * `android:debuggable` flag from AndroidManifest.xml. True signals a
   * debug build on the Android side — orthogonal to `flutterBuildMode`.
   */
  debuggable?: boolean;
  /**
   * Whether the Flutter driver extension is compiled into this build — read
   * statically from the Dart kernel blob (see `flutter-driver-static-detect.ts`).
   *
   * Computed ONLY when `framework === 'flutter' && flutterBuildMode === 'debug'`;
   * `undefined` for every other archive, because the question is meaningless
   * there (an AOT build has no kernel blob at all). `'unverifiable'` means the
   * scan itself failed and is kept distinct from `'absent'` so a scanner
   * problem never reads as a customer problem.
   */
  driverExtension?: DriverExtensionDetection;
}

function coerceVersionCode(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    // iOS CFBundleVersion is commonly a dotted string ("1.2.3"); take leading
    // integer if present, otherwise drop it.
    const m = raw.trim().match(/^\d+/);
    if (m) {
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

function coerceString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Pluck fields out of whatever shape app-info-parser returned. APK/AAB and
 * IPA emit different keys; we try both and pick the first non-empty value.
 */
function coerceDebuggable(raw: unknown): boolean | undefined {
  // app-info-parser surfaces android:debuggable as either a boolean or the
  // string "true"/"false" depending on parser version. Anything else → undefined.
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return undefined;
}

function extractFields(parsed: any, platform: MobilePlatform): ParsedAppInfo {
  if (!parsed || typeof parsed !== 'object') return {};

  // Android (apk / aab): top-level versionName/versionCode/package OR nested
  // under `application`. Different versions of the parser behave differently.
  const androidVersionName = coerceString(parsed.versionName)
    ?? coerceString(parsed?.application?.versionName);
  const androidVersionCode = coerceVersionCode(parsed.versionCode)
    ?? coerceVersionCode(parsed?.application?.versionCode);
  const androidPackage = coerceString(parsed.package)
    ?? coerceString(parsed?.application?.package);
  // android:debuggable lives on the <application> element. Some parser
  // versions expose it at the top level, others only on `.application`.
  const debuggable = coerceDebuggable(parsed.debuggable)
    ?? coerceDebuggable(parsed?.application?.debuggable);

  // iOS (ipa): Info.plist keys.
  const iosVersionName = coerceString(parsed.CFBundleShortVersionString);
  const iosVersionCode = coerceVersionCode(parsed.CFBundleVersion);
  const iosPackage = coerceString(parsed.CFBundleIdentifier);

  if (platform === 'ios') {
    return {
      versionName: iosVersionName ?? androidVersionName,
      versionCode: iosVersionCode ?? androidVersionCode,
      packageName: iosPackage ?? androidPackage,
    };
  }
  // android / flutter — APK or AAB
  return {
    versionName: androidVersionName ?? iosVersionName,
    versionCode: androidVersionCode ?? iosVersionCode,
    packageName: androidPackage ?? iosPackage,
    debuggable,
  };
}

/**
 * Download the binary from Supabase Storage to a temp file, parse it, then
 * delete the temp file. Returns `{}` on ANY error path.
 */
export async function parseFromStorage(
  storagePath: string,
  platform: MobilePlatform,
): Promise<ParsedAppInfo> {
  if (!storagePath) return {};

  const ext = path.extname(storagePath).toLowerCase() || (platform === 'ios' ? '.ipa' : '.apk');
  const tempPath = path.join(
    os.tmpdir(),
    `mobile-app-parse-${crypto.randomBytes(8).toString('hex')}${ext}`,
  );

  try {
    const buffer = await MobileAppStorageService.downloadApp(storagePath);
    await fs.writeFile(tempPath, buffer);

    const parser = new AppInfoParser(tempPath);
    const result = await parser.parse();

    const fields = extractFields(result, platform);

    // Framework + build-mode detection runs against the same local temp
    // file — no extra Supabase download. Detector is hard-contract
    // non-throwing by design, but we still isolate it in a local
    // try/catch so a future regression (or a transient fs failure that
    // bubbles past the detector's own swallow) can't take down the
    // parser's version / packageName result. The caller's finalize flow
    // critically depends on those fields; framework + buildMode are hints.
    let framework: DetectedFramework | undefined;
    let flutterBuildMode: FlutterBuildMode | undefined;
    try {
      const buildInfo = await detectBuildInfoFromArchive(tempPath, storagePath);
      framework = buildInfo?.framework;
      flutterBuildMode = buildInfo?.flutterBuildMode;
    } catch (err) {
      logger.debug('[MOBILE_APP_PARSER] detector threw — swallowing', {
        storagePath,
        error: err instanceof Error ? err.message : String(err),
      });
      framework = undefined;
      flutterBuildMode = undefined;
    }

    // Driver-extension scan reuses the SAME temp file — no extra download.
    // Only meaningful for a Flutter debug build: an AOT build ships no kernel
    // blob, and a non-Flutter app needs no driver extension at all. Isolated
    // like the detector above so a regression here cannot break the version /
    // packageName result the finalize flow critically depends on.
    let driverExtension: DriverExtensionDetection | undefined;
    if (framework === 'flutter' && flutterBuildMode === 'debug') {
      try {
        driverExtension = await detectFlutterDriverExtension(tempPath);
      } catch (err) {
        logger.debug('[MOBILE_APP_PARSER] driver-extension scan threw — swallowing', {
          storagePath,
          error: err instanceof Error ? err.message : String(err),
        });
        driverExtension = 'unverifiable';
      }
    }

    logger.info('[MOBILE_APP_PARSER] Parsed binary', {
      storagePath,
      platform,
      versionName: fields.versionName,
      versionCode: fields.versionCode,
      packageName: fields.packageName,
      framework: framework ?? null,
      flutterBuildMode: flutterBuildMode ?? null,
      debuggable: fields.debuggable ?? null,
      driverExtension: driverExtension ?? null,
    });
    return { ...fields, framework, flutterBuildMode, driverExtension };
  } catch (err) {
    logger.warn('[MOBILE_APP_PARSER] Parse failed — returning empty result', {
      storagePath,
      platform,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  } finally {
    fs.unlink(tempPath).catch(() => {
      // best-effort; tmpdir is rotated by the OS anyway
    });
  }
}

export const MobileAppParserService = {
  parseFromStorage,
};
