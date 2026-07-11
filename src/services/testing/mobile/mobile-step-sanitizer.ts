/**
 * Mobile-step sanitizer — thin wrapper over the shared step sanitizer.
 *
 * The credential-replacement logic now lives in
 * `src/services/testing/shared/step-sanitizer.ts` and is shared with the web
 * chat-agent save path (both `IntentStep` and `MobileIntentStep` are
 * structurally compatible). This file preserves the mobile-typed public API so
 * existing callers + tests are unchanged.
 */

import type { MobileIntentStep } from '@/services/mobile/mobile-runner.types';
import {
  sanitizeSteps,
  type SanitizableStep,
  type SanitizedStepsResult,
} from '@/services/testing/shared/step-sanitizer';

export { SECRET_OPTION_FIELDS, slugify } from '@/services/testing/shared/step-sanitizer';

export type SanitizedMobileResult<T extends SanitizableStep = MobileIntentStep> =
  SanitizedStepsResult<T>;

/**
 * Returns a copy of `steps` with sensitive `value` strings replaced by
 * `{{param_<name>}}` placeholders, plus the `parametersSchema` to persist to
 * `intent_test_cases.parameters_schema`. See the shared sanitizer for details.
 *
 * Generic in the step type so BOTH callers keep their own type: the mobile
 * agent (`MobileIntentStep`) and the save service (web `IntentStep`). Web
 * `IntentStep` and `MobileIntentStep` are structurally compatible for the
 * fields the sanitizer reads.
 */
export function sanitizeMobileSteps<T extends SanitizableStep = MobileIntentStep>(
  steps: T[],
): SanitizedMobileResult<T> {
  return sanitizeSteps<T>(steps);
}
