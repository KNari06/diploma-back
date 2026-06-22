/**
 * Parser-service unit tests. The third-party `app-info-parser` package is
 * mocked at the require-cache boundary — we don't want to ship fixture APKs
 * into the repo, and the parser's binary-decoding logic isn't what we own.
 *
 * The contract under test is:
 *   1. APK shape (versionName/versionCode/package) maps correctly.
 *   2. IPA shape (CFBundle*) maps correctly.
 *   3. Parser throw → returns `{}`, never re-throws.
 *   4. Storage download failure → returns `{}`.
 */

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: {
    downloadApp: jest.fn(),
  },
}));

const mockParse = jest.fn();
jest.mock('app-info-parser', () => {
  return jest.fn().mockImplementation(() => ({ parse: mockParse }));
});

import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { parseFromStorage } from '../mobile-app-parser.service';

const downloadAppMock = MobileAppStorageService.downloadApp as jest.Mock;

describe('mobile-app-parser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    downloadAppMock.mockResolvedValue(Buffer.from('binary-bytes'));
  });

  it('extracts versionName / versionCode / package from APK parse result', async () => {
    mockParse.mockResolvedValueOnce({
      versionName: '1.2.3',
      versionCode: 42,
      package: 'com.example.app',
    });

    const out = await parseFromStorage('mobile-apps/w/p/android/x.apk', 'android');

    expect(out).toEqual({
      versionName: '1.2.3',
      versionCode: 42,
      packageName: 'com.example.app',
    });
  });

  it('handles APK fields nested under `application`', async () => {
    mockParse.mockResolvedValueOnce({
      application: {
        versionName: '9.9.9',
        versionCode: 99,
        package: 'com.nested.app',
      },
    });

    const out = await parseFromStorage('mobile-apps/w/p/android/x.apk', 'android');

    expect(out).toEqual({
      versionName: '9.9.9',
      versionCode: 99,
      packageName: 'com.nested.app',
    });
  });

  it('extracts CFBundle keys for iOS', async () => {
    mockParse.mockResolvedValueOnce({
      CFBundleShortVersionString: '2.0.1',
      CFBundleVersion: '2010',
      CFBundleIdentifier: 'com.example.ios',
    });

    const out = await parseFromStorage('mobile-apps/w/p/ios/x.ipa', 'ios');

    expect(out).toEqual({
      versionName: '2.0.1',
      versionCode: 2010,
      packageName: 'com.example.ios',
    });
  });

  it('coerces dotted CFBundleVersion (e.g. "1.2.3") to leading integer', async () => {
    mockParse.mockResolvedValueOnce({
      CFBundleShortVersionString: '1.2.3',
      CFBundleVersion: '1.2.3',
      CFBundleIdentifier: 'com.example.ios',
    });

    const out = await parseFromStorage('mobile-apps/w/p/ios/x.ipa', 'ios');

    expect(out.versionCode).toBe(1);
  });

  it('returns {} when the parser throws (corrupt file)', async () => {
    mockParse.mockRejectedValueOnce(new Error('not a zip'));

    const out = await parseFromStorage('mobile-apps/w/p/android/corrupt.apk', 'android');

    expect(out).toEqual({});
  });

  it('returns {} when storage download fails', async () => {
    downloadAppMock.mockRejectedValueOnce(new Error('object missing'));

    const out = await parseFromStorage('mobile-apps/w/p/android/missing.apk', 'android');

    expect(out).toEqual({});
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('returns {} for empty storagePath without touching storage', async () => {
    const out = await parseFromStorage('', 'android');
    expect(out).toEqual({});
    expect(downloadAppMock).not.toHaveBeenCalled();
  });

  it('drops empty / non-numeric values rather than passing junk through', async () => {
    mockParse.mockResolvedValueOnce({
      versionName: '   ',
      versionCode: 'not-a-number',
      package: '',
    });

    const out = await parseFromStorage('mobile-apps/w/p/android/x.apk', 'android');

    expect(out.versionName).toBeUndefined();
    expect(out.versionCode).toBeUndefined();
    expect(out.packageName).toBeUndefined();
  });
});
