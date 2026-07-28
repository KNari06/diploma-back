/**
 * Error → `device-error-catalog` code for JOB-LEVEL mobile failures.
 *
 * Deliberately separate from [device-error-catalog.ts](device-error-catalog.ts):
 * that module is pure data with zero imports, so anything that only needs to
 * RENDER a failure label (the run-report assembler, a script, a unit test) can
 * import it freely. Recognising the error CLASSES needs the runner + blob
 * modules, and `@/services/storage/blob` transitively loads `@/db/supabase`,
 * which throws at module scope when Supabase env vars are absent. Keeping the
 * two apart means only the mobile job — which already requires that env —
 * pays for it.
 */

import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import { BlobNotFoundError } from '@/services/storage/blob';

/**
 * `MobileRunnerError` carries the runner's own code. `BlobNotFoundError` is a
 * BACKEND-side storage failure: the app binary the run resolved to is gone, so
 * `MobileAppPrepService` threw before the runner was ever asked to install
 * anything. Without that branch it falls through to `UNKNOWN`, whose
 * remediation sends the user to the runner logs — which hold nothing about a
 * failure the runner never saw.
 *
 * Returns `undefined` for a `MobileRunnerError` that carries no code — `code`
 * is optional on that class and the callers (and `describeDeviceError`)
 * already treat absent the same as unrecognised. Don't coerce it to
 * `'UNKNOWN'`: that string is also persisted verbatim onto
 * `mobile_test_results.metadata.errorCode`, where "no code was reported" and
 * "a code we don't recognise" are worth telling apart.
 */
export function classifyJobErrorCode(error: unknown): string | undefined {
  if (error instanceof MobileRunnerError) return error.code;
  if (error instanceof BlobNotFoundError) return 'APP_BINARY_MISSING';
  return 'UNKNOWN';
}
