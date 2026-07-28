import { describeDeviceError } from '../device-error-catalog';

describe('describeDeviceError', () => {
  it('falls back to the generic entry for an unrecognised code', () => {
    const info = describeDeviceError('NOT_A_REAL_CODE');
    expect(info.label).toBe("Couldn't start test");
    expect(info.category).toBe('unknown');
  });

  it('falls back to the generic entry when no code is reported', () => {
    expect(describeDeviceError(undefined).category).toBe('unknown');
    expect(describeDeviceError(null).category).toBe('unknown');
    expect(describeDeviceError('').category).toBe('unknown');
  });

  it('classifies a missing app binary as an environment failure', () => {
    // 'environment' is what excludes the failure from flaky / fail-rate math.
    // A run that never installed the app is infrastructure noise, not a test
    // outcome, so this must not be 'unknown'.
    expect(describeDeviceError('APP_BINARY_MISSING').category).toBe('environment');
  });

  it('points a missing app binary at re-uploading the app, not at the runner logs', () => {
    const info = describeDeviceError('APP_BINARY_MISSING');
    expect(info.remediation).toMatch(/re-upload/i);
    expect(info.remediation).not.toMatch(/runner logs/i);
  });
});
