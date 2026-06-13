/**
 * Human-facing catalog for runner device / attach failure codes.
 *
 * The codes mirror `DeviceErrorCode` in qait-mobile-runner
 * (src/device/device-error.ts) — the runner returns them as `{ code, error }`
 * on attach / session failures, and the mobile job persists the code onto
 * `mobile_test_results.metadata.errorCode` (and, for environment failures,
 * onto `test_executions.result.failureCategory`).
 *
 * This catalog turns that code into a short label + remediation hint for the
 * run-report failure banner, and a coarse `category` that drives flaky / fail-
 * rate exclusion: an `environment` failure means the test never actually ran
 * (emulator stuck, agent didn't attach), so it is infrastructure noise, not a
 * test outcome, and must not inflate a test case's flaky rate.
 *
 * Keep the code list in sync with the runner. An unknown / missing code falls
 * back to a generic "couldn't start" entry so a job-level failure always has
 * something useful to show.
 */

export type DeviceFailureCategory = 'environment' | 'configuration' | 'unknown';

export interface DeviceErrorInfo {
  /** Short human label, e.g. "Couldn't start test". */
  label: string;
  /** One-line "what to do next" hint. */
  remediation: string;
  /** Coarse bucket. 'environment' is excluded from flaky / fail-rate math. */
  category: DeviceFailureCategory;
}

const CATALOG: Record<string, DeviceErrorInfo> = {
  FLUTTER_NOT_DETECTED: {
    label: "Couldn't start test",
    remediation:
      'On-device accessibility agent failed to attach to the Flutter app. Cold-boot the emulator and retry; ensure the app is a debug/profile build.',
    category: 'environment',
  },
  A11Y_AGENT_UNAVAILABLE: {
    label: "Couldn't start test",
    remediation:
      'On-device accessibility agent failed to bind, so the native a11y tree (needed for Flutter element resolution) was unavailable. Usually transient under emulator/host resource pressure — let the device settle (or cold-boot it) and retry.',
    // Infrastructure noise: the agent never bound, so the test never ran.
    // MUST be 'environment' so it is excluded from flaky / fail-rate math
    // (same as FLUTTER_NOT_DETECTED, which this code split off from on the
    // agent-bind path in qait-mobile-runner).
    category: 'environment',
  },
  DEVICE_UNAUTHORIZED: {
    label: 'Device not authorized',
    remediation: 'Approve the USB-debugging prompt on the device, then retry.',
    category: 'environment',
  },
  DEVICE_OFFLINE: {
    label: 'Device offline',
    remediation: 'The device went offline. Reconnect it or cold-boot the emulator, then retry.',
    category: 'environment',
  },
  DEVICE_NOT_FOUND: {
    label: 'Device unavailable',
    remediation: 'No matching device was ready. Start the emulator / connect the device, then retry.',
    category: 'environment',
  },
  DEVICE_BUSY: {
    label: 'Device busy',
    remediation: 'Another session is using this device. Retry in a moment.',
    category: 'environment',
  },
  DEVICE_INIT_FAILED: {
    label: "Device couldn't start",
    remediation: 'The device never reached a usable state. Power-cycle it (or cold-boot the emulator), then retry.',
    category: 'environment',
  },
  PHYSICAL_NO_DEVICES: {
    label: 'No device connected',
    remediation: 'No physical device is plugged in. Connect one, then retry.',
    category: 'environment',
  },
  MULTIUSER_NOT_SUPPORTED: {
    label: 'Configuration not supported',
    remediation: 'Multi-user is not supported for a local physical device. Adjust the run configuration.',
    category: 'configuration',
  },
  IOS_PHYSICAL_NOT_SUPPORTED: {
    label: 'Not supported yet',
    remediation: 'iOS physical devices are not supported yet. Use a simulator.',
    category: 'configuration',
  },
  NETWORK_SIM_NOT_SUPPORTED: {
    label: 'Not supported on device',
    remediation: 'Network-condition simulation needs an emulator. Run this on an emulator.',
    category: 'configuration',
  },
  BIOMETRIC_NOT_SUPPORTED: {
    label: 'Not supported on device',
    remediation: 'Biometric simulation needs an emulator. Run this on an emulator.',
    category: 'configuration',
  },
  INVALID_INPUT: {
    label: 'Invalid run input',
    remediation: 'The run was dispatched with a malformed device / platform input. Re-create the run.',
    category: 'configuration',
  },

  // MobileRunnerError codes (mobile-runner-client.ts) — the runner host itself
  // was unreachable / erroring, so the test never ran. Infrastructure, not a
  // test outcome.
  NETWORK_ERROR: {
    label: "Couldn't reach the mobile runner",
    remediation: 'The mobile runner host was unreachable. Check the runner is up, then retry.',
    category: 'environment',
  },
  SERVER_ERROR: {
    label: 'Mobile runner error',
    remediation: 'The mobile runner returned a server error. Check the runner logs and retry.',
    category: 'environment',
  },
  TIMEOUT: {
    label: 'Mobile runner timed out',
    remediation: 'The mobile runner did not respond in time. Retry; if it persists, check runner load.',
    category: 'environment',
  },
  UPLOAD_ERROR: {
    label: 'App upload failed',
    remediation: 'Uploading the app build to the runner failed. Re-upload the build and retry.',
    category: 'environment',
  },
  DISABLED: {
    label: 'Mobile testing disabled',
    remediation: 'Mobile testing is turned off for this environment. Enable it, then retry.',
    category: 'configuration',
  },
};

const UNKNOWN: DeviceErrorInfo = {
  label: "Couldn't start test",
  remediation: 'The test failed before any step ran. Check the runner logs and retry.',
  category: 'unknown',
};

/**
 * Map a device / job error code to its human-facing descriptor. Always returns
 * an entry (falls back to a generic "couldn't start" for unknown / missing
 * codes) so a job-level failure always has something to show.
 */
export function describeDeviceError(code: string | null | undefined): DeviceErrorInfo {
  if (!code) return UNKNOWN;
  return CATALOG[code] ?? UNKNOWN;
}
