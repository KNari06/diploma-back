/**
 * Detect which mobile framework an APK / AAB / IPA was built with by
 * inspecting the ZIP Central Directory — no decompression, no external
 * dependencies. Mirror of the runner-side detector
 * (`qait-mobile-runner/src/api/routes/archive-platform-detect.ts`) so the
 * backend can stamp a trustworthy `framework` on uploads without
 * relying on the user-selected platform field, which is almost always
 * "android" because the frontend's heuristic is just the file extension.
 *
 * The detector is HARD-CONTRACT non-throwing: any I/O, parse, or
 * timeout error returns `undefined`. The caller treats the field as
 * optional metadata and falls back to existing behaviour.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '@/utils/core/logger';

/**
 * Framework discriminator stamped on each upload. Wider than the backend's
 * `MobilePlatform` enum (`'android' | 'ios' | 'flutter'`) because we also
 * want to recognise React Native bundles — both ride on `MobilePlatform`'s
 * underlying host ('android' or 'ios') so we keep `MobilePlatform` as the
 * primary routing field and add this one as an additional hint.
 */
export type DetectedFramework = 'android' | 'ios' | 'flutter' | 'react-native';

/**
 * Flutter build flavor inferred from archive contents.
 *
 *   - `'debug'`  — Dart kernel + JIT VM (debug builds ship `kernel_blob.bin`).
 *                  Driver extension is wireable; automation supported.
 *   - `'aot'`    — Profile or release. AOT-compiled snapshot, no JIT.
 *                  Profile is automatable, release is not — we can't tell
 *                  them apart from the archive alone (the difference is
 *                  whether the VM Service is enabled, which is a runtime
 *                  signal).
 *   - `undefined` for non-Flutter archives.
 */
export type FlutterBuildMode = 'debug' | 'aot';

export interface DetectedBuildInfo {
  framework: DetectedFramework;
  flutterBuildMode?: FlutterBuildMode;
}

/** Hard cap on detection time. Bounded fs.read calls anyway, but on slow
 * disk we don't want to stall finalize. */
const DETECT_TIMEOUT_MS = 2000;

/**
 * Inspect a local APK/AAB/IPA file. The caller is responsible for downloading
 * the binary to a temp path — we re-use whatever temp file the existing
 * `MobileAppParserService` already produces so we do not double-download
 * a 100+ MB binary from Supabase.
 *
 * Strategy: scan the ZIP Central Directory for filename signatures.
 *
 *   APK (base + plain):
 *     - lib/<abi>/libflutter.so           → flutter
 *     - lib/<abi>/libreactnativejni.so    → react-native
 *     - assets/flutter_assets/...         → flutter   (split-APK base fallback)
 *     - assets/index.android.bundle       → react-native (split-APK base fallback)
 *     - otherwise                         → android
 *
 *   AAB (bundletool output):
 *     - base/lib/<abi>/libflutter.so      → flutter
 *     - base/lib/<abi>/libreactnativejni.so → react-native
 *     - base/assets/flutter_assets/...    → flutter
 *     - base/assets/index.android.bundle  → react-native
 *     - otherwise                         → android
 *
 *   IPA:
 *     - Payload/*.app/Frameworks/Flutter.framework/        → flutter
 *     - Payload/*.app/Frameworks/(React|hermes).framework/ → react-native
 *     - otherwise                                          → ios
 */
export async function detectFrameworkFromArchive(
  filePath: string,
  originalName: string,
): Promise<DetectedFramework | undefined> {
  const info = await detectBuildInfoFromArchive(filePath, originalName);
  return info?.framework;
}

/**
 * Like `detectFrameworkFromArchive`, but also returns the Flutter build
 * flavor (debug vs aot) when the archive is a Flutter app. Single ZIP
 * Central Directory scan — same I/O budget as the framework-only variant.
 *
 * Hard-contract non-throwing — any failure returns `undefined`.
 */
export async function detectBuildInfoFromArchive(
  filePath: string,
  originalName: string,
): Promise<DetectedBuildInfo | undefined> {
  // path.extname handles trailing-junk / unicode quirks better than .endsWith().
  const ext = path.extname(originalName).toLowerCase();
  const isIpa = ext === '.ipa';
  const isApk = ext === '.apk' || ext === '.aab';
  if (!isIpa && !isApk) {
    logger.debug(`[archive-detect] skip: unsupported extension "${ext}"`);
    return undefined;
  }

  // Defensive try around Promise.race: `inspect` already has its own
  // try/catch returning undefined, but if any future refactor breaks that
  // contract, an uncaught reject would propagate to the caller. We treat
  // detector failures as "framework unknown" — never a hard error.
  try {
    return await Promise.race([
      inspect(filePath, originalName, isIpa),
      new Promise<undefined>((resolve) =>
        setTimeout(() => {
          logger.debug(`[archive-detect] timeout (>${DETECT_TIMEOUT_MS}ms) for ${originalName}`);
          resolve(undefined);
        }, DETECT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    logger.debug(`[archive-detect] race rejected for ${originalName}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Buffer-input wrapper around `detectFrameworkFromArchive`. Writes the buffer
 * to a temp file in a private subdir (created via mkdtemp so concurrent
 * callers can't collide on filename), runs detection, deletes the temp file
 * regardless of outcome. Designed for the CI upload path
 * (`MobileAppStorageService.uploadApp`) where we have the APK in memory and
 * don't want to re-download from Supabase just to detect.
 *
 * Hard-contract non-throwing — any I/O / temp-fs failure returns undefined.
 */
export async function detectFrameworkFromBuffer(
  buffer: Buffer,
  originalName: string,
): Promise<DetectedFramework | undefined> {
  const info = await detectBuildInfoFromBuffer(buffer, originalName);
  return info?.framework;
}

/**
 * Buffer-input wrapper around `detectBuildInfoFromArchive`. Same temp-file
 * dance as `detectFrameworkFromBuffer`, but exposes the Flutter build flavor.
 */
export async function detectBuildInfoFromBuffer(
  buffer: Buffer,
  originalName: string,
): Promise<DetectedBuildInfo | undefined> {
  if (!buffer || buffer.length === 0) return undefined;
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.apk' && ext !== '.aab' && ext !== '.ipa') return undefined;

  let tmpDir: string | undefined;
  try {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'archive-detect-'));
    const tmpPath = path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}${ext}`);
    await fs.promises.writeFile(tmpPath, buffer);
    return await detectBuildInfoFromArchive(tmpPath, originalName);
  } catch (err) {
    logger.debug(`[archive-detect] buffer wrapper failed for ${originalName}: ${(err as Error).message}`);
    return undefined;
  } finally {
    if (tmpDir) {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* swallow */ });
    }
  }
}

async function inspect(
  filePath: string,
  originalName: string,
  isIpa: boolean,
): Promise<DetectedBuildInfo | undefined> {
  try {
    const names = await readZipEntryNames(filePath);
    if (!names) {
      logger.debug(`[archive-detect] could not read CD for ${originalName}`);
      return undefined;
    }

    if (isIpa) {
      if (names.some((n) => /^Payload\/[^/]+\.app\/Frameworks\/Flutter\.framework\//i.test(n))) {
        return { framework: 'flutter', flutterBuildMode: ipaFlutterBuildMode(names) };
      }
      if (names.some((n) => /^Payload\/[^/]+\.app\/Frameworks\/(React|hermes)\.framework\//i.test(n))) {
        return { framework: 'react-native' };
      }
      return { framework: 'ios' };
    }

    // APK / AAB — same matchers, but AAB nests under `base/` (and `splits/<config>/`).
    const flutterLibRe = /(^|^base\/|^splits\/[^/]+\/)lib\/[^/]+\/libflutter\.so$/i;
    const rnLibRe = /(^|^base\/|^splits\/[^/]+\/)lib\/[^/]+\/libreactnativejni\.so$/i;
    const flutterAssetRe = /(^|^base\/)assets\/flutter_assets\//i;
    const rnAssetRe = /(^|^base\/)assets\/index\.android\.bundle$/i;

    if (names.some((n) => flutterLibRe.test(n) || flutterAssetRe.test(n))) {
      return { framework: 'flutter', flutterBuildMode: apkFlutterBuildMode(names) };
    }
    if (names.some((n) => rnLibRe.test(n) || rnAssetRe.test(n))) return { framework: 'react-native' };
    return { framework: 'android' };
  } catch (err) {
    logger.debug(`[archive-detect] inspection failed for ${originalName}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Distinguish a Flutter APK's build flavor from its archive contents.
 *
 *   - **Debug**: ships `flutter_assets/kernel_blob.bin` (the Dart kernel for
 *     the JIT VM). Releases / profiles never ship it.
 *   - **AOT** (profile or release): no `kernel_blob.bin`, just the
 *     AOT-compiled `lib/<abi>/libapp.so`. We cannot tell profile from
 *     release without runtime VM Service probing.
 */
function apkFlutterBuildMode(names: string[]): FlutterBuildMode {
  const kernelRe = /(^|^base\/|^splits\/[^/]+\/)assets\/flutter_assets\/kernel_blob\.bin$/i;
  if (names.some((n) => kernelRe.test(n))) return 'debug';
  return 'aot';
}

/**
 * iOS counterpart: debug builds embed `flutter_assets/kernel_blob.bin` under
 * `App.framework/`. Release / profile ship the AOT snapshot inside the
 * `App.framework/App` binary, which is always present, so its absence alone
 * is not a reliable signal — the kernel blob is.
 */
function ipaFlutterBuildMode(names: string[]): FlutterBuildMode {
  const kernelRe = /^Payload\/[^/]+\.app\/Frameworks\/App\.framework\/flutter_assets\/kernel_blob\.bin$/i;
  if (names.some((n) => kernelRe.test(n))) return 'debug';
  return 'aot';
}

/**
 * Read filenames from a ZIP archive's Central Directory without decompressing.
 *
 * Parses the End-of-Central-Directory record and walks the Central Directory
 * headers. ZIP64-aware (large APKs occasionally trip 4 GB / 65535-entry limits).
 */
async function readZipEntryNames(filePath: string): Promise<string[] | undefined> {
  const stat = await fs.promises.stat(filePath);
  const size = stat.size;
  if (size < 22) return undefined; // smaller than the smallest possible EOCD

  const fh = await fs.promises.open(filePath, 'r');
  try {
    // EOCD is at most 22 + 65535 bytes from the end (comment field length).
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    const eocdOffsetInTail = findEocd(tail);
    if (eocdOffsetInTail < 0) return undefined;

    let cdOffset: number;
    let cdSize: number;
    let entryCount: number;

    const zip64 = await tryReadZip64Eocd(fh, tail, eocdOffsetInTail, size, tailLen);
    if (zip64) {
      cdOffset = zip64.cdOffset;
      cdSize = zip64.cdSize;
      entryCount = zip64.entryCount;
    } else {
      entryCount = tail.readUInt16LE(eocdOffsetInTail + 10);
      cdSize = tail.readUInt32LE(eocdOffsetInTail + 12);
      cdOffset = tail.readUInt32LE(eocdOffsetInTail + 16);
      // ZIP64 sentinels — if 32-bit fields are saturated and no ZIP64 EOCD was
      // found, the archive is malformed (or we couldn't locate the ZIP64 record).
      if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
        return undefined;
      }
    }

    if (cdSize <= 0 || cdOffset < 0 || cdOffset + cdSize > size) return undefined;
    // Hard cap to avoid pathological archives — 64 MB of CD is far more than any real APK.
    if (cdSize > 64 * 1024 * 1024) return undefined;

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const names: string[] = [];
    let p = 0;
    const SIG = 0x02014b50; // Central directory file header
    // Each CD record is ≥46 bytes; cd.length/46 is the natural upper bound on iterations.
    const maxEntries = Math.ceil(cd.length / 46) + 1;
    void entryCount; // kept for the validation above; loop bound comes from buffer length
    for (let i = 0; i < maxEntries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== SIG) break;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const nameStart = p + 46;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > cd.length) break;
      const name = cd.toString('utf8', nameStart, nameEnd);
      names.push(name);
      p = nameEnd + extraLen + commentLen;
    }
    return names;
  } finally {
    await fh.close();
  }
}

/**
 * Locate the EOCD record from the tail buffer.
 *
 * We scan backward from the *first* position where a 22-byte EOCD could
 * start, and for each candidate signature verify the `commentLen` field
 * agrees with how far the signature sits from the end. That validation
 * defeats fake EOCD signatures planted inside the archive comment.
 */
function findEocd(buf: Buffer): number {
  const SIG = 0x06054b50;
  const lastStart = buf.length - 22;
  for (let i = lastStart; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
    // signature collision — keep searching
  }
  return -1;
}

async function tryReadZip64Eocd(
  fh: fs.promises.FileHandle,
  tail: Buffer,
  eocdOffsetInTail: number,
  fileSize: number,
  tailLen: number,
): Promise<{ cdOffset: number; cdSize: number; entryCount: number } | undefined> {
  // ZIP64 EOCD Locator sits immediately before the EOCD.
  const locatorOffset = eocdOffsetInTail - 20;
  if (locatorOffset < 0) return undefined;
  const LOCATOR_SIG = 0x07064b50;
  if (tail.readUInt32LE(locatorOffset) !== LOCATOR_SIG) return undefined;

  const zip64EocdAbsOffset = Number(tail.readBigUInt64LE(locatorOffset + 8));
  if (zip64EocdAbsOffset < 0 || zip64EocdAbsOffset + 56 > fileSize) return undefined;

  const ZIP64_EOCD_SIG = 0x06064b50;
  const tailStartAbs = fileSize - tailLen;

  let rec: Buffer;
  if (zip64EocdAbsOffset >= tailStartAbs) {
    const off = zip64EocdAbsOffset - tailStartAbs;
    if (off + 56 > tail.length) return undefined;
    rec = tail.subarray(off, off + 56);
  } else {
    // Second fs.read — common for large APKs (>65k entries or >4 GB).
    rec = Buffer.alloc(56);
    await fh.read(rec, 0, 56, zip64EocdAbsOffset);
  }

  if (rec.readUInt32LE(0) !== ZIP64_EOCD_SIG) return undefined;

  const entryCount = Number(rec.readBigUInt64LE(32));
  const cdSize = Number(rec.readBigUInt64LE(40));
  const cdOffset = Number(rec.readBigUInt64LE(48));
  return { cdOffset, cdSize, entryCount };
}
