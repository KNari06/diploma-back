/**
 * Flutter host-lane write guard.
 *
 * A project can only run Flutter tests on a host it actually has a build for.
 * Setting the iOS lane on a project with no uploaded iOS build produces a
 * combination that cannot succeed, and it fails LATE and in the wrong place:
 * every session warmup boots a simulator, retries WebDriverAgent on incrementing
 * ports, and ~2 minutes later surfaces
 *
 *   WDA on port 8115 did not become ready within 120000ms
 *
 * which reads as a runner/environment fault. The real cause is a project
 * setting. It silently affects regression / scheduled / CI runs too, not just
 * the editor (incident 2026-08-02, project 008e4c1a "Default Project").
 *
 * This module is the SINGLE place that decides whether a host lane may be
 * written, so the project default (`settings.flutterDefaultHost`), the per-test
 * override (`intent_test_cases.host_platform`) and the per-flow bulk write can
 * never drift apart.
 *
 * ── Why only iOS ──────────────────────────────────────────────────────────
 * `getFlutterDefaultHost` falls back to `'android'` whenever the setting is
 * absent or invalid, so android is the implicit default lane. Blocking an
 * android write on a project with no APK would strand a project that is
 * already on `'ios'` — it could never switch back. Android also fails
 * honestly: the emulator boots, the app just isn't there, and the first step
 * fails visibly. Only the iOS lane turns a configuration mistake into an
 * opaque 120s timeout, so only the iOS lane is gated.
 */

import { ProjectService } from '@/services/core/project.service';
import { hasProjectMobileBuild } from '@/services/mobile/project-mobile-app.helper';
import type { FlutterHostPlatform } from '@/services/mobile/mobile-runner.types';
import { ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';

/** Typed code echoed to clients so the editor can special-case the copy. */
export const HOST_BUILD_MISSING_CODE = 'HOST_BUILD_MISSING';

/**
 * User-facing reason a host lane was refused. Names the project setting AND the
 * missing artifact, because the whole point of this guard is that the previous
 * failure blamed the wrong subsystem.
 */
export const HOST_BUILD_MISSING_MESSAGE =
  'This project has no iOS build uploaded, so Flutter tests cannot run on the iOS simulator. '
  + 'Upload an .ipa / .app under Settings → Mobile apps first, then switch the host to iOS.';

/**
 * Whether `host` is a legal lane for this project right now.
 *
 * Returns `true` for every non-iOS host (see the module docstring) and for a
 * project the caller cannot read — an inaccessible project is an authorization
 * concern the CALLER already owns, and answering `false` here would turn a
 * 403/404 into a misleading "no iOS build" message.
 */
export async function projectSupportsFlutterHost(
  projectId: string,
  userId: string,
  host: FlutterHostPlatform,
): Promise<boolean> {
  if (host !== 'ios') return true;

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return true;

  return hasProjectMobileBuild(project.settings, 'ios');
}

/**
 * Throwing form for the test-case / flow write paths, which surface a
 * `ValidationError` as a 400 (see `preview.controller.ts`). `mobile-app.service`
 * uses the predicate above instead, because it reports failures as tagged
 * `MobileAppError` values rather than exceptions.
 */
export async function assertProjectSupportsFlutterHost(
  projectId: string,
  userId: string,
  host: FlutterHostPlatform,
): Promise<void> {
  if (await projectSupportsFlutterHost(projectId, userId, host)) return;

  logger.info('[FLUTTER_HOST_GUARD] Rejected iOS host write — no iOS build uploaded', {
    projectId,
    userId,
    host,
  });
  throw new ValidationError(HOST_BUILD_MISSING_MESSAGE);
}
