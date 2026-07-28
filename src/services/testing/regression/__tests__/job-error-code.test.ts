import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import { BlobNotFoundError } from '@/services/storage/blob';
import { describeDeviceError } from '../device-error-catalog';
import { classifyJobErrorCode } from '../job-error-code';

describe('classifyJobErrorCode', () => {
  it('maps a missing app binary to APP_BINARY_MISSING', () => {
    const err = new BlobNotFoundError('mobile-apps/ws/proj/android/app.apk', 'supabase');
    expect(classifyJobErrorCode(err)).toBe('APP_BINARY_MISSING');
  });

  it('maps the dual-read fallback miss too, not just the primary store', () => {
    // Under provider=azure the fallback is what throws last, so the error
    // reports provider 'supabase' even in an Azure-primary environment.
    expect(classifyJobErrorCode(new BlobNotFoundError('p', 'azure'))).toBe('APP_BINARY_MISSING');
  });

  it('passes a runner error through with its own code', () => {
    expect(classifyJobErrorCode(new MobileRunnerError('boom', 500, 'SERVER_ERROR'))).toBe('SERVER_ERROR');
  });

  it('preserves an absent runner code rather than coercing it to UNKNOWN', () => {
    // The code is persisted verbatim onto mobile_test_results.metadata.errorCode,
    // where "no code reported" and "unrecognised code" are worth distinguishing.
    expect(classifyJobErrorCode(new MobileRunnerError('boom', 500))).toBeUndefined();
  });

  it('returns UNKNOWN for an unrelated throw', () => {
    expect(classifyJobErrorCode(new Error('something else'))).toBe('UNKNOWN');
    expect(classifyJobErrorCode('not an error at all')).toBe('UNKNOWN');
  });

  it('resolves a missing app binary to an actionable descriptor end-to-end', () => {
    const info = describeDeviceError(classifyJobErrorCode(new BlobNotFoundError('p', 'azure')));
    expect(info.label).toBe('App build is missing');
    expect(info.category).toBe('environment');
  });
});
