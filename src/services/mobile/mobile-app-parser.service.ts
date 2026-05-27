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
import { detectFrameworkFromArchive, DetectedFramework } from '@/services/mobile/archive-platform-detect';
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
   * "android" vs "ios" based on file extension. Lets the finalize handler
   * promote `platform='android'` uploads to `platform='flutter'` when the
   * binary clearly contains a Flutter engine.
   *
   * `undefined` means detection failed or the archive is unsupported —
   * NEVER let parser failures block the upload.
   */
  framework?: DetectedFramework;
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

    // Framework detection runs against the same local temp file — no
    // extra Supabase download. Detector is hard-contract non-throwing by
    // design, but we still isolate it in a local try/catch so a future
    // regression (or a transient fs failure that bubbles past the
    // detector's own swallow) can't take down the parser's version /
    // packageName result. The caller's finalize flow critically depends
    // on those fields; framework is just a hint.
    let framework: DetectedFramework | undefined;
    try {
      framework = await detectFrameworkFromArchive(tempPath, storagePath);
    } catch (err) {
      logger.debug('[MOBILE_APP_PARSER] detector threw — swallowing', {
        storagePath,
        error: err instanceof Error ? err.message : String(err),
      });
      framework = undefined;
    }

    logger.info('[MOBILE_APP_PARSER] Parsed binary', {
      storagePath,
      platform,
      versionName: fields.versionName,
      versionCode: fields.versionCode,
      packageName: fields.packageName,
      framework: framework ?? null,
    });
    return { ...fields, framework };
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
