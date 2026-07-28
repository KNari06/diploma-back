/**
 * The build contract — what a build must be for QAIT to automate it.
 *
 * A pure decision over what the parser read from the archive. Enforced at
 * UPLOAD time for CI publishes so a pipeline learns immediately, in its own
 * log, instead of every subsequent test run failing for a reason nobody
 * connects back to how the APK was built.
 *
 * CI-ONLY, deliberately. The editor upload keeps its advisory banner: a native
 * Android test needs no driver extension, and a user may legitimately upload an
 * AOT build just to inspect it. What changes for the editor is only that the
 * parse now also stamps `driverExtension` — never whether the upload is blocked.
 */

import type { ParsedAppInfo } from '@/services/mobile/mobile-app-parser.service';

export type BuildContractCode =
  | 'BUILD_UNVERIFIABLE'
  | 'BUILD_NOT_DEBUG'
  | 'DRIVER_EXTENSION_MISSING'
  | 'DRIVER_EXTENSION_UNVERIFIABLE';

export interface BuildContractRejection {
  ok: false;
  code: BuildContractCode;
  /** One-line reason. */
  error: string;
  /** What to change, phrased so it reads as an instruction in a CI log. */
  remediation: string;
}

export type BuildContractVerdict = { ok: true } | BuildContractRejection;

/** The exact recipe §2.7 documents, repeated wherever a build is rejected. */
const DRIVER_EXTENSION_RECIPE = [
  'Add a driver entrypoint that leaves your production main.dart untouched:',
  '',
  '  // lib/main_qait.dart',
  "  import 'package:flutter_driver/driver_extension.dart';",
  "  import 'main.dart' as app;",
  '',
  '  void main() {',
  '    enableFlutterDriverExtension();',
  '    app.main();',
  '  }',
  '',
  'then build with it:',
  '',
  '  flutter pub add "dev:flutter_driver:{sdk: flutter}"',
  '  flutter build apk --debug --target=lib/main_qait.dart',
].join('\n');

const DEBUG_BUILD_RECIPE = [
  'QAIT drives Flutter through the Dart VM Service, which a release build does',
  'not expose. Build in debug mode:',
  '',
  '  flutter build apk --debug --target=lib/main_qait.dart',
].join('\n');

/**
 * Apply the contract to a parsed archive.
 *
 * | parsed state                            | verdict                          |
 * | --------------------------------------- | -------------------------------- |
 * | framework unknown (parse failed)        | BUILD_UNVERIFIABLE               |
 * | not Flutter                             | accept — no driver extension needed |
 * | Flutter, build mode unknown             | BUILD_UNVERIFIABLE               |
 * | Flutter + aot                           | BUILD_NOT_DEBUG                  |
 * | Flutter + debug + extension present     | accept                           |
 * | Flutter + debug + extension absent      | DRIVER_EXTENSION_MISSING         |
 * | Flutter + debug + scan failed           | DRIVER_EXTENSION_UNVERIFIABLE    |
 *
 * The first row is why this cannot be written as "if flutter then check":
 * `parseFromStorage` is hard-contract non-throwing and returns `{}` on ANY
 * failure, so the most likely unverifiable case would otherwise fall into
 * "not Flutter → accept" and sail through as if it were a native Android app —
 * inverting the gate exactly when it matters most.
 */
export function evaluateBuildContract(parsed: ParsedAppInfo): BuildContractVerdict {
  if (!parsed.framework) {
    return {
      ok: false,
      code: 'BUILD_UNVERIFIABLE',
      error: 'Could not read this build, so it cannot be accepted for automated testing.',
      remediation:
        'The uploaded file could not be parsed as an APK, AAB or IPA. Check that the pipeline uploaded the built artifact itself and that the upload completed.',
    };
  }

  if (parsed.framework !== 'flutter') {
    // A native Android / iOS / React Native app is driven through the
    // accessibility layer and needs no driver extension.
    return { ok: true };
  }

  if (!parsed.flutterBuildMode) {
    return {
      ok: false,
      code: 'BUILD_UNVERIFIABLE',
      error: 'This is a Flutter build, but its build mode could not be determined.',
      remediation: DEBUG_BUILD_RECIPE,
    };
  }

  if (parsed.flutterBuildMode === 'aot') {
    return {
      ok: false,
      code: 'BUILD_NOT_DEBUG',
      error: 'This is a release or profile Flutter build. QAIT can only automate debug builds.',
      remediation: DEBUG_BUILD_RECIPE,
    };
  }

  switch (parsed.driverExtension) {
    case 'present':
      return { ok: true };

    case 'absent':
      return {
        ok: false,
        code: 'DRIVER_EXTENSION_MISSING',
        error:
          'This Flutter debug build does not have the Flutter driver extension compiled in, so QAIT cannot drive it.',
        remediation: DRIVER_EXTENSION_RECIPE,
      };

    default:
      return {
        ok: false,
        code: 'DRIVER_EXTENSION_UNVERIFIABLE',
        error:
          'Could not verify whether the Flutter driver extension is compiled into this build.',
        remediation: DRIVER_EXTENSION_RECIPE,
      };
  }
}
