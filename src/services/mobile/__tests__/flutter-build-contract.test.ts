/**
 * The build-contract decision table — all rows.
 *
 * This is the gate that turns "your tests mysteriously fail" into "your build
 * is missing the driver extension, here is the snippet". Every row matters;
 * the first one especially, because `parseFromStorage` returns `{}` on ANY
 * failure and an unverifiable archive must NOT fall through the
 * "not Flutter → accept" branch and pass as a native Android app.
 */

import { evaluateBuildContract } from '../flutter-build-contract';
import type { ParsedAppInfo } from '../mobile-app-parser.service';

const parsed = (over: Partial<ParsedAppInfo> = {}): ParsedAppInfo => ({
  packageName: 'com.example.app',
  ...over,
});

describe('evaluateBuildContract', () => {
  it('rejects BUILD_UNVERIFIABLE when the archive could not be parsed at all', () => {
    // The inverted-gate case: {} must not read as "not Flutter, therefore fine".
    expect(evaluateBuildContract({})).toEqual(
      expect.objectContaining({ ok: false, code: 'BUILD_UNVERIFIABLE' }),
    );
  });

  it.each([['android'], ['ios'], ['react-native']] as const)(
    'accepts a %s build — it needs no Flutter driver extension',
    (framework) => {
      expect(evaluateBuildContract(parsed({ framework }))).toEqual({ ok: true });
    },
  );

  it('rejects BUILD_NOT_DEBUG for a release/profile Flutter build', () => {
    const verdict = evaluateBuildContract(parsed({ framework: 'flutter', flutterBuildMode: 'aot' }));
    expect(verdict).toEqual(expect.objectContaining({ ok: false, code: 'BUILD_NOT_DEBUG' }));
  });

  it('rejects BUILD_UNVERIFIABLE for a Flutter build whose mode is unknown', () => {
    const verdict = evaluateBuildContract(parsed({ framework: 'flutter' }));
    expect(verdict).toEqual(expect.objectContaining({ ok: false, code: 'BUILD_UNVERIFIABLE' }));
  });

  it('accepts a Flutter debug build with the driver extension compiled in', () => {
    expect(
      evaluateBuildContract(
        parsed({ framework: 'flutter', flutterBuildMode: 'debug', driverExtension: 'present' }),
      ),
    ).toEqual({ ok: true });
  });

  it('rejects DRIVER_EXTENSION_MISSING when the extension is absent', () => {
    const verdict = evaluateBuildContract(
      parsed({ framework: 'flutter', flutterBuildMode: 'debug', driverExtension: 'absent' }),
    );
    expect(verdict).toEqual(
      expect.objectContaining({ ok: false, code: 'DRIVER_EXTENSION_MISSING' }),
    );
  });

  it('rejects DRIVER_EXTENSION_UNVERIFIABLE — kept distinct so OUR failure stays diagnosable', () => {
    const verdict = evaluateBuildContract(
      parsed({ framework: 'flutter', flutterBuildMode: 'debug', driverExtension: 'unverifiable' }),
    );
    expect(verdict).toEqual(
      expect.objectContaining({ ok: false, code: 'DRIVER_EXTENSION_UNVERIFIABLE' }),
    );
  });

  it('treats a missing driverExtension on a Flutter debug build as unverifiable, never as present', () => {
    const verdict = evaluateBuildContract(
      parsed({ framework: 'flutter', flutterBuildMode: 'debug' }),
    );
    expect(verdict).toEqual(
      expect.objectContaining({ ok: false, code: 'DRIVER_EXTENSION_UNVERIFIABLE' }),
    );
  });
});

describe('rejection payloads', () => {
  it('carries the driver-extension recipe on both extension rejections', () => {
    for (const detection of ['absent', 'unverifiable'] as const) {
      const verdict = evaluateBuildContract(
        parsed({ framework: 'flutter', flutterBuildMode: 'debug', driverExtension: detection }),
      );
      if (verdict.ok) throw new Error('expected rejection');
      // The body has to read as an instruction in a CI log, not just an error.
      expect(verdict.remediation).toContain('enableFlutterDriverExtension()');
      expect(verdict.remediation).toContain('--target=lib/main_qait.dart');
      expect(verdict.remediation).toContain('flutter pub add "dev:flutter_driver:{sdk: flutter}"');
    }
  });

  it('tells an AOT build how to produce a debug build instead', () => {
    const verdict = evaluateBuildContract(parsed({ framework: 'flutter', flutterBuildMode: 'aot' }));
    if (verdict.ok) throw new Error('expected rejection');
    expect(verdict.remediation).toContain('flutter build apk --debug');
  });

  it('gives every rejection a non-empty one-line reason', () => {
    const rejections = [
      evaluateBuildContract({}),
      evaluateBuildContract(parsed({ framework: 'flutter', flutterBuildMode: 'aot' })),
      evaluateBuildContract(
        parsed({ framework: 'flutter', flutterBuildMode: 'debug', driverExtension: 'absent' }),
      ),
    ];
    for (const verdict of rejections) {
      if (verdict.ok) throw new Error('expected rejection');
      expect(verdict.error.length).toBeGreaterThan(0);
      expect(verdict.error).not.toContain('undefined');
    }
  });
});
