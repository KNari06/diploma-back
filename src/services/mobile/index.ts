/**
 * Mobile Runner Integration
 * Barrel export for mobile testing services.
 */

export { MobileRunnerClient, getMobileRunnerClient } from './mobile-runner-client';
export type {
  MobilePlatform,
  MobileIntentActionType,
  MobileBindingHints,
  MobileIntentStepOptions,
  MobileSessionResponse,
  MobileSessionConfig,
  MobileIntentStep,
  MobileStepResult,
  MobileRunStepsRequest,
  MobileRunStepsResponse,
  MobileArtifact,
  MobileArtifactBundle,
  MobileHealthResponse,
  MobileTestJobData,
} from './mobile-runner.types';
export { MobileRunnerError } from './mobile-runner.types';
export { CiRunService } from './ci-run.service';
export type { CiRunData, CiRunStatus } from './ci-run.service';
export {
  resolveProjectPermissionPolicy,
  applyProjectPolicyToSession,
  VALID_PERMISSION_POLICIES,
} from './permission-policy.service';
export type { MobilePermissionPolicy } from './permission-policy.service';
