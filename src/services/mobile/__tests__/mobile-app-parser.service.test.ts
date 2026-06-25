// parseFromStorage orchestrates download → parse → framework-detect → cleanup,
// and must NEVER throw (returns {} on any failure). We mock every I/O boundary:
// Supabase storage, the app-info-parser CJS module, the archive detector, and
// fs/promises. Logger is globally mocked in jest.setup.ts.

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: { downloadApp: jest.fn() },
}));
jest.mock('@/services/mobile/archive-platform-detect', () => ({
  detectBuildInfoFromArchive: jest.fn(),
}));
jest.mock('fs/promises', () => ({
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));
// app-info-parser is `require`d inside the service; keep the parse mock inside
// the factory to dodge the import-hoisting TDZ, then read it back off the ctor.
jest.mock('app-info-parser', () => {
  const parseMock = jest.fn();
  const Ctor: any = jest.fn().mockImplementation(() => ({ parse: parseMock }));
  Ctor.parseMock = parseMock;
  return Ctor;
});

import { parseFromStorage } from '../mobile-app-parser.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { detectBuildInfoFromArchive } from '@/services/mobile/archive-platform-detect';
import fs from 'fs/promises';

const parseMock = (require('app-info-parser') as any).parseMock as jest.Mock;
const downloadMock = MobileAppStorageService.downloadApp as jest.Mock;
const detectMock = detectBuildInfoFromArchive as jest.Mock;
const writeMock = fs.writeFile as unknown as jest.Mock;
const unlinkMock = fs.unlink as unknown as jest.Mock;

beforeEach(() => {
  downloadMock.mockResolvedValue(Buffer.from('binary'));
  detectMock.mockResolvedValue(undefined);
  parseMock.mockResolvedValue({});
  writeMock.mockResolvedValue(undefined);
  unlinkMock.mockResolvedValue(undefined);
});

describe('parseFromStorage — guard clauses', () => {
  it('returns {} without downloading when storagePath is empty', async () => {
    await expect(parseFromStorage('', 'android')).resolves.toEqual({});
    expect(downloadMock).not.toHaveBeenCalled();
  });
});

describe('parseFromStorage — Android (apk/aab)', () => {
  it('extracts top-level versionName/versionCode/package and debuggable', async () => {
    parseMock.mockResolvedValue({
      versionName: '1.2.3',
      versionCode: 42,
      package: 'com.example.app',
      debuggable: true,
    });
    await expect(parseFromStorage('apps/app.apk', 'android')).resolves.toEqual({
      versionName: '1.2.3',
      versionCode: 42,
      packageName: 'com.example.app',
      debuggable: true,
    });
  });

  it('falls back to fields nested under `application`', async () => {
    parseMock.mockResolvedValue({
      application: { versionName: '2.0', versionCode: '7', package: 'com.nested' },
    });
    await expect(parseFromStorage('apps/app.aab', 'android')).resolves.toEqual({
      versionName: '2.0',
      versionCode: 7,
      packageName: 'com.nested',
    });
  });

  it('merges framework and flutterBuildMode from the archive detector', async () => {
    parseMock.mockResolvedValue({ versionName: '1.0', package: 'com.f' });
    detectMock.mockResolvedValue({ framework: 'flutter', flutterBuildMode: 'debug' });
    await expect(parseFromStorage('apps/app.apk', 'android')).resolves.toEqual({
      versionName: '1.0',
      packageName: 'com.f',
      framework: 'flutter',
      flutterBuildMode: 'debug',
    });
  });
});

describe('parseFromStorage — iOS (ipa)', () => {
  it('reads Info.plist keys and omits debuggable', async () => {
    parseMock.mockResolvedValue({
      CFBundleShortVersionString: '3.1',
      CFBundleVersion: '12.4',
      CFBundleIdentifier: 'com.ios.app',
    });
    await expect(parseFromStorage('apps/app.ipa', 'ios')).resolves.toEqual({
      versionName: '3.1',
      versionCode: 12, // leading integer of "12.4"
      packageName: 'com.ios.app',
    });
  });

  it('falls back to android-style keys when iOS keys are absent', async () => {
    parseMock.mockResolvedValue({ versionName: '9', package: 'com.a' });
    await expect(parseFromStorage('apps/app.ipa', 'ios')).resolves.toMatchObject({
      versionName: '9',
      packageName: 'com.a',
    });
  });
});

describe('parseFromStorage — value coercion', () => {
  it.each([
    [3.9, 3], // floored
    [-5, undefined], // negative dropped
    ['15abc', 15], // leading integer
    ['abc', undefined], // no leading integer
    ['', undefined], // empty
  ])('coerces versionCode %p → %p', async (raw, expected) => {
    parseMock.mockResolvedValue({ versionName: '1', versionCode: raw, package: 'com.c' });
    const out = await parseFromStorage('apps/app.apk', 'android');
    expect(out.versionCode).toBe(expected);
  });

  it.each([
    ['true', true],
    ['false', false],
    [true, true],
    ['maybe', undefined],
  ])('coerces debuggable %p → %p', async (raw, expected) => {
    parseMock.mockResolvedValue({ versionName: '1', package: 'com.d', debuggable: raw });
    const out = await parseFromStorage('apps/app.apk', 'android');
    expect(out.debuggable).toBe(expected);
  });

  it('drops blank/whitespace string fields', async () => {
    parseMock.mockResolvedValue({ versionName: '   ', package: '' });
    const out = await parseFromStorage('apps/app.apk', 'android');
    expect(out.versionName).toBeUndefined();
    expect(out.packageName).toBeUndefined();
  });
});

describe('parseFromStorage — resilience (never throws)', () => {
  it('returns {} when the download fails', async () => {
    downloadMock.mockRejectedValue(new Error('storage 500'));
    await expect(parseFromStorage('apps/app.apk', 'android')).resolves.toEqual({});
  });

  it('returns {} when parsing throws', async () => {
    parseMock.mockRejectedValue(new Error('corrupt archive'));
    await expect(parseFromStorage('apps/app.apk', 'android')).resolves.toEqual({});
  });

  it('returns {} when writing the temp file fails', async () => {
    writeMock.mockRejectedValue(new Error('disk full'));
    await expect(parseFromStorage('apps/app.apk', 'android')).resolves.toEqual({});
  });

  it('still returns parsed fields when the framework detector throws', async () => {
    parseMock.mockResolvedValue({ versionName: '1.0', package: 'com.keep' });
    detectMock.mockRejectedValue(new Error('detector bug'));
    await expect(parseFromStorage('apps/app.apk', 'android')).resolves.toEqual({
      versionName: '1.0',
      packageName: 'com.keep',
    });
  });

  it('returns {} for an unparseable (non-object) result', async () => {
    parseMock.mockResolvedValue(null);
    await expect(parseFromStorage('apps/app.apk', 'android')).resolves.toEqual({});
  });
});

describe('parseFromStorage — temp-file lifecycle', () => {
  it('writes a temp file with the correct extension and always cleans up', async () => {
    await parseFromStorage('apps/app.apk', 'android');
    expect(writeMock.mock.calls[0][0]).toMatch(/\.apk$/);
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('defaults the extension from the platform when the path has none', async () => {
    await parseFromStorage('apps/binary-no-ext', 'ios');
    expect(writeMock.mock.calls[0][0]).toMatch(/\.ipa$/);
  });

  it('cleans up the temp file even after a parse failure', async () => {
    parseMock.mockRejectedValue(new Error('boom'));
    await parseFromStorage('apps/app.apk', 'android');
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('swallows a cleanup (unlink) failure without throwing', async () => {
    parseMock.mockResolvedValue({ versionName: '1.0', package: 'com.x' });
    unlinkMock.mockRejectedValue(new Error('unlink failed'));
    await expect(parseFromStorage('apps/app.apk', 'android')).resolves.toMatchObject({
      versionName: '1.0',
    });
  });
});
