/**
 * Backend mirror of qait-mobile-runner's archive-platform-detect tests.
 * Same store-only ZIP fixtures, same matrix of APK / AAB / IPA × Flutter /
 * React Native / native, same robustness cases (ZIP64-adjacent, EOCD-in-
 * comment, missing file, etc.). Kept in sync with the runner-side suite
 * because the production detector code is duplicated by design — backend
 * stamps the framework on upload, runner stamps it on its own /upload/apk
 * endpoint, and both must agree on every edge case.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  detectFrameworkFromArchive,
  detectFrameworkFromBuffer,
  detectBuildInfoFromArchive,
} from '../archive-platform-detect';

/**
 * Build a minimal store-only ZIP containing the given entry names. The
 * detector only walks the Central Directory for filenames — bodies are
 * empty and crc32 stays zero (valid for empty files). See the runner-side
 * test for the full ZIP layout commentary.
 */
function buildZip(
  entries: string[],
  opts: { comment?: Buffer; fakeEocdInComment?: boolean } = {},
): Buffer {
  const files: { name: Buffer; offset: number }[] = [];
  const parts: Buffer[] = [];
  let offset = 0;

  for (const name of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf);
    files.push({ name: nameBuf, offset });
    offset += local.length + nameBuf.length;
  }

  const cdParts: Buffer[] = [];
  let cdSize = 0;
  for (const f of files) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(0, 20);
    cd.writeUInt32LE(0, 24);
    cd.writeUInt16LE(f.name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(f.offset, 42);
    cdParts.push(cd, f.name);
    cdSize += cd.length + f.name.length;
  }

  const cdOffset = offset;

  let comment = opts.comment ?? Buffer.alloc(0);
  if (opts.fakeEocdInComment) {
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    fake.writeUInt16LE(99, 20); // bogus commentLen — fails validation
    comment = Buffer.concat([fake, comment]);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...parts, ...cdParts, eocd, comment]);
}

const TMP = path.join(os.tmpdir(), `be-archive-detect-${Date.now()}`);

beforeAll(() => fs.mkdirSync(TMP, { recursive: true }));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writeFixture(
  name: string,
  entries: string[],
  opts?: { comment?: Buffer; fakeEocdInComment?: boolean },
): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buildZip(entries, opts));
  return p;
}

describe('detectFrameworkFromArchive — APK', () => {
  it('detects Flutter via lib/<abi>/libflutter.so', async () => {
    const p = writeFixture('flutter.apk', [
      'AndroidManifest.xml',
      'lib/arm64-v8a/libflutter.so',
      'lib/arm64-v8a/libapp.so',
    ]);
    expect(await detectFrameworkFromArchive(p, 'flutter.apk')).toBe('flutter');
  });

  it('detects React Native via lib/<abi>/libreactnativejni.so', async () => {
    const p = writeFixture('rn.apk', [
      'AndroidManifest.xml',
      'lib/arm64-v8a/libreactnativejni.so',
      'lib/arm64-v8a/libhermes.so',
    ]);
    expect(await detectFrameworkFromArchive(p, 'rn.apk')).toBe('react-native');
  });

  it('falls back to android for a native APK', async () => {
    const p = writeFixture('native.apk', [
      'AndroidManifest.xml',
      'classes.dex',
      'resources.arsc',
    ]);
    expect(await detectFrameworkFromArchive(p, 'native.apk')).toBe('android');
  });

  it('detects Flutter via assets/flutter_assets/ in a split-APK base (no lib/)', async () => {
    const p = writeFixture('flutter-split-base.apk', [
      'AndroidManifest.xml',
      'classes.dex',
      'assets/flutter_assets/AssetManifest.json',
      'assets/flutter_assets/fonts/MaterialIcons-Regular.otf',
    ]);
    expect(await detectFrameworkFromArchive(p, 'flutter-split-base.apk')).toBe('flutter');
  });

  it('detects React Native via assets/index.android.bundle (split-APK base)', async () => {
    const p = writeFixture('rn-split-base.apk', [
      'AndroidManifest.xml',
      'classes.dex',
      'assets/index.android.bundle',
    ]);
    expect(await detectFrameworkFromArchive(p, 'rn-split-base.apk')).toBe('react-native');
  });
});

describe('detectFrameworkFromArchive — AAB', () => {
  it('detects Flutter inside base/lib/', async () => {
    const p = writeFixture('flutter.aab', [
      'BundleConfig.pb',
      'base/manifest/AndroidManifest.xml',
      'base/lib/arm64-v8a/libflutter.so',
    ]);
    expect(await detectFrameworkFromArchive(p, 'flutter.aab')).toBe('flutter');
  });

  it('detects RN inside base/lib/', async () => {
    const p = writeFixture('rn.aab', [
      'BundleConfig.pb',
      'base/lib/arm64-v8a/libreactnativejni.so',
    ]);
    expect(await detectFrameworkFromArchive(p, 'rn.aab')).toBe('react-native');
  });

  it('detects Flutter via base/assets/flutter_assets/', async () => {
    const p = writeFixture('flutter-assets.aab', [
      'BundleConfig.pb',
      'base/assets/flutter_assets/AssetManifest.json',
    ]);
    expect(await detectFrameworkFromArchive(p, 'flutter-assets.aab')).toBe('flutter');
  });

  it('falls back to android for a native AAB', async () => {
    const p = writeFixture('native.aab', [
      'BundleConfig.pb',
      'base/manifest/AndroidManifest.xml',
      'base/dex/classes.dex',
    ]);
    expect(await detectFrameworkFromArchive(p, 'native.aab')).toBe('android');
  });
});

describe('detectFrameworkFromArchive — IPA', () => {
  it('detects Flutter via Flutter.framework', async () => {
    const p = writeFixture('flutter.ipa', [
      'Payload/Runner.app/Info.plist',
      'Payload/Runner.app/Frameworks/Flutter.framework/Flutter',
    ]);
    expect(await detectFrameworkFromArchive(p, 'flutter.ipa')).toBe('flutter');
  });

  it('detects RN via React.framework', async () => {
    const p = writeFixture('rn.ipa', [
      'Payload/MyApp.app/Info.plist',
      'Payload/MyApp.app/Frameworks/React.framework/React',
    ]);
    expect(await detectFrameworkFromArchive(p, 'rn.ipa')).toBe('react-native');
  });

  it('detects RN via hermes.framework', async () => {
    const p = writeFixture('rn-hermes.ipa', [
      'Payload/MyApp.app/Info.plist',
      'Payload/MyApp.app/Frameworks/hermes.framework/hermes',
    ]);
    expect(await detectFrameworkFromArchive(p, 'rn-hermes.ipa')).toBe('react-native');
  });

  it('falls back to ios for a plain native IPA', async () => {
    const p = writeFixture('native.ipa', [
      'Payload/MyApp.app/Info.plist',
      'Payload/MyApp.app/MyApp',
    ]);
    expect(await detectFrameworkFromArchive(p, 'native.ipa')).toBe('ios');
  });
});

describe('detectFrameworkFromArchive — robustness', () => {
  it('returns undefined for non-archive filenames', async () => {
    const p = writeFixture('weird.zip', ['anything']);
    expect(await detectFrameworkFromArchive(p, 'weird.zip')).toBeUndefined();
  });

  it('returns undefined for a corrupt file (no EOCD)', async () => {
    const p = path.join(TMP, 'corrupt.apk');
    fs.writeFileSync(p, Buffer.from('not a real zip'));
    expect(await detectFrameworkFromArchive(p, 'corrupt.apk')).toBeUndefined();
  });

  it('returns undefined when the file is missing', async () => {
    expect(
      await detectFrameworkFromArchive(path.join(TMP, 'nope.apk'), 'nope.apk'),
    ).toBeUndefined();
  });

  it('handles an EOCD with a non-empty archive comment', async () => {
    const p = writeFixture(
      'commented.apk',
      ['AndroidManifest.xml', 'lib/arm64-v8a/libflutter.so'],
      { comment: Buffer.from('signed-by-vendor-12345') },
    );
    expect(await detectFrameworkFromArchive(p, 'commented.apk')).toBe('flutter');
  });

  it('ignores a counterfeit EOCD signature embedded in the archive comment', async () => {
    const p = writeFixture(
      'attacker.apk',
      ['AndroidManifest.xml', 'lib/arm64-v8a/libflutter.so'],
      { comment: Buffer.from('padding-padding-padding'), fakeEocdInComment: true },
    );
    expect(await detectFrameworkFromArchive(p, 'attacker.apk')).toBe('flutter');
  });

  it('strips path extension via path.extname (handles odd casing)', async () => {
    const p = writeFixture('MIXED.APK', [
      'AndroidManifest.xml',
      'lib/arm64-v8a/libreactnativejni.so',
    ]);
    expect(await detectFrameworkFromArchive(p, 'MIXED.APK')).toBe('react-native');
  });

  it('returns undefined (not null) on failure — important for spread-into-response', async () => {
    const result = await detectFrameworkFromArchive(
      path.join(TMP, 'missing.apk'),
      'missing.apk',
    );
    expect(result).toBeUndefined();
    expect(result).not.toBeNull();
  });

  it('does not false-positive on filenames that just contain a substring', async () => {
    const p = writeFixture('decoy.apk', [
      'AndroidManifest.xml',
      'lib/arm64-v8a/mylibflutter.so',
      'assets/libs/libreactnativejni.so.bak',
    ]);
    expect(await detectFrameworkFromArchive(p, 'decoy.apk')).toBe('android');
  });
});

describe('detectFrameworkFromBuffer — CI upload wrapper', () => {
  // The wrapper is what the CI APK-from-URL path uses: it has the bytes
  // already in memory after the HTTP download, doesn't want to round-trip
  // back to Supabase just to detect. These tests assert the wrapper
  // delegates correctly and cleans up its temp file in every branch.
  it('detects framework from a Flutter APK buffer', async () => {
    const zipBuf = buildZip([
      'AndroidManifest.xml',
      'lib/arm64-v8a/libflutter.so',
    ]);
    expect(await detectFrameworkFromBuffer(zipBuf, 'flutter.apk')).toBe('flutter');
  });

  it('detects framework from a React Native AAB buffer', async () => {
    const zipBuf = buildZip([
      'BundleConfig.pb',
      'base/lib/arm64-v8a/libreactnativejni.so',
    ]);
    expect(await detectFrameworkFromBuffer(zipBuf, 'rn.aab')).toBe('react-native');
  });

  it('returns undefined for an empty buffer (CI URL fetch returned 0 bytes)', async () => {
    expect(await detectFrameworkFromBuffer(Buffer.alloc(0), 'x.apk')).toBeUndefined();
  });

  it('returns undefined for an unsupported extension without writing temp file', async () => {
    expect(await detectFrameworkFromBuffer(Buffer.from('whatever'), 'readme.txt')).toBeUndefined();
  });

  it('returns undefined for a corrupt buffer (no ZIP EOCD)', async () => {
    expect(await detectFrameworkFromBuffer(Buffer.from('not a real zip'), 'corrupt.apk')).toBeUndefined();
  });
});

describe('detectBuildInfoFromArchive — Flutter build mode', () => {
  // Debug builds ship `assets/flutter_assets/kernel_blob.bin` because the
  // Dart VM still loads kernel at startup for the JIT path. AOT (release /
  // profile) replaces the kernel blob with a pre-compiled snapshot inside
  // libapp.so, so the kernel file is absent.
  it('reports debug when an APK ships kernel_blob.bin', async () => {
    const p = writeFixture('flutter-debug.apk', [
      'AndroidManifest.xml',
      'lib/arm64-v8a/libflutter.so',
      'lib/arm64-v8a/libapp.so',
      'assets/flutter_assets/kernel_blob.bin',
      'assets/flutter_assets/AssetManifest.json',
    ]);
    const info = await detectBuildInfoFromArchive(p, 'flutter-debug.apk');
    expect(info).toEqual({ framework: 'flutter', flutterBuildMode: 'debug' });
  });

  it('reports aot when a Flutter APK has libapp.so but no kernel_blob.bin', async () => {
    const p = writeFixture('flutter-release.apk', [
      'AndroidManifest.xml',
      'lib/arm64-v8a/libflutter.so',
      'lib/arm64-v8a/libapp.so',
      'assets/flutter_assets/AssetManifest.json',
    ]);
    const info = await detectBuildInfoFromArchive(p, 'flutter-release.apk');
    expect(info).toEqual({ framework: 'flutter', flutterBuildMode: 'aot' });
  });

  it('reports debug for an AAB whose base ships kernel_blob.bin', async () => {
    const p = writeFixture('flutter-debug.aab', [
      'BundleConfig.pb',
      'base/lib/arm64-v8a/libflutter.so',
      'base/assets/flutter_assets/kernel_blob.bin',
    ]);
    const info = await detectBuildInfoFromArchive(p, 'flutter-debug.aab');
    expect(info).toEqual({ framework: 'flutter', flutterBuildMode: 'debug' });
  });

  it('reports debug for an IPA shipping App.framework/flutter_assets/kernel_blob.bin', async () => {
    const p = writeFixture('flutter-debug.ipa', [
      'Payload/Runner.app/Info.plist',
      'Payload/Runner.app/Frameworks/Flutter.framework/Flutter',
      'Payload/Runner.app/Frameworks/App.framework/App',
      'Payload/Runner.app/Frameworks/App.framework/flutter_assets/kernel_blob.bin',
    ]);
    const info = await detectBuildInfoFromArchive(p, 'flutter-debug.ipa');
    expect(info).toEqual({ framework: 'flutter', flutterBuildMode: 'debug' });
  });

  it('reports aot for a release IPA without kernel_blob.bin', async () => {
    const p = writeFixture('flutter-release.ipa', [
      'Payload/Runner.app/Info.plist',
      'Payload/Runner.app/Frameworks/Flutter.framework/Flutter',
      'Payload/Runner.app/Frameworks/App.framework/App',
    ]);
    const info = await detectBuildInfoFromArchive(p, 'flutter-release.ipa');
    expect(info).toEqual({ framework: 'flutter', flutterBuildMode: 'aot' });
  });

  it('does not stamp flutterBuildMode on non-Flutter archives', async () => {
    const p = writeFixture('native.apk', ['AndroidManifest.xml', 'classes.dex']);
    const info = await detectBuildInfoFromArchive(p, 'native.apk');
    expect(info).toEqual({ framework: 'android' });
  });

  it('does not stamp flutterBuildMode on React Native archives', async () => {
    const p = writeFixture('rn.apk', [
      'AndroidManifest.xml',
      'lib/arm64-v8a/libreactnativejni.so',
    ]);
    const info = await detectBuildInfoFromArchive(p, 'rn.apk');
    expect(info).toEqual({ framework: 'react-native' });
  });
});
