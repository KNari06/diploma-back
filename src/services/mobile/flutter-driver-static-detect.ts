/**
 * Static detection of the Flutter driver extension inside a debug APK/AAB.
 *
 * WHY STATIC. The runtime probe (`mobile-driver-probe.service.ts`) boots an
 * emulator and takes 2–6 minutes — unusable at upload time, and hopeless in a
 * CI pipeline. This reads the archive instead, in about 150 ms.
 *
 * HOW. A Flutter debug build ships `flutter_assets/kernel_blob.bin` — the Dart
 * kernel for the JIT VM — which embeds a URI table of every library compiled
 * in. If the app actually depends on `flutter_driver`, that table contains the
 * package's INTERNAL sub-libraries: `package:flutter_driver/src/...`.
 *
 * The `/src/` qualifier is the whole trick. Matching a bare
 * `package:flutter_driver` false-positives on EVERY Flutter app, because the
 * framework's own sources carry a doc-import of it:
 *
 *     /// @docImport 'package:flutter_driver/driver_extension.dart';
 *
 * Internal sub-libraries only enter the table when the package is genuinely
 * compiled in. Measured on three real APKs (Flutter 3.41.2): 24 occurrences
 * with the extension wired up, 0 without — and the negative case still had
 * `flutter_driver` in `dev_dependencies`, so declaring the dependency is not
 * enough to trip it. The threshold is 2, far below the observed signal and far
 * above the observed noise.
 *
 * ACCEPTED LIMITATION. This proves the package is COMPILED IN, not that
 * `enableFlutterDriverExtension()` is actually CALLED — debug builds do not
 * tree-shake. So it can false-ACCEPT, never false-REJECT, which is the safe
 * direction for a blocking gate: it never turns away a build that would work.
 */

import AdmZip from 'adm-zip';
import { logger } from '@/utils/core/logger';

export type DriverExtensionDetection = 'present' | 'absent' | 'unverifiable';

/**
 * Internal sub-library marker. See the file docstring for why the `/src/`
 * qualifier is load-bearing.
 */
const MARKER = 'package:flutter_driver/src/';

/** Observed 24 (present) vs 0 (absent); 2 is comfortably between. */
const MIN_OCCURRENCES = 2;

/**
 * Kernel blob location across archive layouts: plain APK (`assets/...`), AAB
 * (`base/assets/...`), split APK (`splits/<name>/assets/...`), and iOS
 * (`Payload/<app>.app/Frameworks/App.framework/...`). Mirrors the regex family
 * in `archive-platform-detect.ts`, which is what decided this build was
 * `debug` in the first place — the two must agree on every layout, or a build
 * it calls `debug` reports here as unverifiable and gets rejected for the
 * wrong reason.
 */
const KERNEL_BLOB_RE =
  /(?:(?:^|^base\/|^splits\/[^/]+\/)assets|^Payload\/[^/]+\.app\/Frameworks\/App\.framework)\/flutter_assets\/kernel_blob\.bin$/i;

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Inspect a local APK/AAB for the compiled-in driver extension.
 *
 * Call ONLY for an archive already known to be Flutter + debug — an AOT build
 * has no kernel blob at all, so this would report `unverifiable` and mask the
 * real reason the build is unusable.
 *
 * Never throws. Any failure — missing entry, corrupt zip, unreadable blob —
 * degrades to `'unverifiable'`, which the build-contract table treats as its
 * own distinct rejection so it stays diagnosable rather than masquerading as
 * "extension missing".
 *
 * @param archivePath local path to the already-downloaded binary
 */
export async function detectFlutterDriverExtension(
  archivePath: string,
): Promise<DriverExtensionDetection> {
  try {
    const zip = new AdmZip(archivePath);
    const entry = zip.getEntries().find((e) => KERNEL_BLOB_RE.test(e.entryName));

    if (!entry) {
      logger.warn('[FLUTTER_DRIVER_DETECT] No kernel_blob.bin in a build reported as debug', {
        archivePath,
      });
      return 'unverifiable';
    }

    // Inflates the whole blob (~46 MB on the measured builds) into memory,
    // briefly, on a file the caller has already downloaded. Hand-rolling a
    // streaming inflate would buy little: `readZipEntryNames` discards local
    // header offsets, so we would be re-parsing the archive from scratch.
    const blob = entry.getData();
    if (!blob || blob.length === 0) return 'unverifiable';

    const hits = countOccurrences(blob, Buffer.from(MARKER, 'utf8'));

    logger.info('[FLUTTER_DRIVER_DETECT] Scanned kernel blob', {
      archivePath,
      entryName: entry.entryName,
      blobBytes: blob.length,
      hits,
      threshold: MIN_OCCURRENCES,
    });

    return hits >= MIN_OCCURRENCES ? 'present' : 'absent';
  } catch (err) {
    logger.warn('[FLUTTER_DRIVER_DETECT] Scan failed — treating as unverifiable', {
      archivePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unverifiable';
  }
}
