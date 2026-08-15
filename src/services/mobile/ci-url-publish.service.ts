/**
 * Publish a build that the pipeline hands us as a URL (`POST /ci/run` with
 * `appUrl`), rather than uploading directly.
 *
 * Extracted from `ci.controller.ts`, where it was ~180 lines of business logic
 * inside a route handler — over the file-size limit and directly against the
 * layering rule. The extraction is also what makes the branch testable: it had
 * no tests at all, which is how three lock leaks survived in it.
 *
 * DIFFERENT FROM `ci-app-publish.service.ts`. There the binary never transits
 * the backend — the client PUTs it to storage against a signed URL. Here the
 * API process DOWNLOADS the whole build into memory (up to 500 MB) and
 * re-uploads it. That is why the caller holds a per-project mutex around this:
 * concurrent copies would race the same `project.settings` read-modify-write
 * AND stack hundreds of megabytes of heap in one replica. The body is read
 * incrementally against the cap for the same reason.
 */

import { PERMISSIONS, WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { ProjectService } from '@/services/core/project.service';
import { ALLOWED_UPLOAD_EXTENSIONS } from '@/services/mobile/mobile-app.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { checkSsrfHost } from '@/utils/validation/ssrf-host-guard';
import { logger } from '@/utils/core/logger';
import path from 'path';

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 min
const MAX_APP_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Parse and scheme-check only — no DNS, so it is free to call up front. */
function parseHttpUrl(raw: string): URL | CiUrlPublishError {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid_url' };
  }
  return parsed;
}

/**
 * Parse + resolve + SSRF-check. Every hop we are about to REQUEST goes through
 * this exactly once, so the DNS lookup is not repeated.
 */
async function checkedUrl(raw: string): Promise<URL | CiUrlPublishError> {
  const parsed = parseHttpUrl(raw);
  if ('kind' in parsed) return parsed;

  const ssrf = await checkSsrfHost(parsed.hostname, 'CI_URL_PUBLISH');
  if (ssrf.verdict !== 'allowed') {
    return { kind: 'blocked_host', message: ssrf.message ?? 'This host is not allowed.' };
  }
  return parsed;
}

/**
 * Fetch, re-running the SSRF guard on EVERY redirect hop.
 *
 * `fetch` defaults to `redirect: 'follow'`, so checking only the URL the
 * customer supplied is not a guard at all: a public host they control can 302
 * straight to link-local metadata, and the body of that response would be
 * stored as a "build". Each hop is therefore validated with `redirect:
 * 'manual'` before we follow it.
 *
 * KNOWN RESIDUAL RISK, shared with every other `checkSsrfHost` caller: the
 * guard resolves the name and `fetch` resolves it again, so a host that answers
 * differently between the two lookups (DNS rebinding) still gets connected to.
 * Closing that needs the connection pinned to the address we validated, via a
 * custom lookup/agent. Do not read this guard as making `appUrl` safe against a
 * determined attacker — it makes the redirect vector, which was trivially
 * exploitable, no longer so.
 */
async function fetchFollowingCheckedRedirects(
  startUrl: string,
  signal: AbortSignal,
): Promise<Response | CiUrlPublishError> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await checkedUrl(current);
    if ('kind' in checked) return checked;

    // ONE signal for the whole operation, created by the caller. A fresh
    // `AbortSignal.timeout` per hop would restart the clock on every redirect,
    // so five slow hops could run for 6 x DOWNLOAD_TIMEOUT_MS = 12 minutes —
    // longer than CI_PUBLISH_LOCK's 600s TTL. The per-project mutex is held for
    // this entire call, so it would EXPIRE mid-download and let a second
    // publish start concurrently, reviving the settings lost-update the mutex
    // exists to prevent.
    const response = await fetch(checked.toString(), {
      redirect: 'manual',
      signal,
    });

    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get('location');
    if (!location) return response; // a 3xx with no target — let the caller report it
    // Resolve relative redirects against the hop we are on.
    current = new URL(location, checked).toString();
  }

  return { kind: 'download_error', message: `Too many redirects (max ${MAX_REDIRECTS})` };
}

export interface CiUrlPublishInput {
  projectId: string;
  workspaceId: string;
  userId: string;
  platform: MobilePlatform;
  appUrl: string;
  versionName?: string;
  versionCode?: number;
  branch?: string;
  commitSha?: string;
  buildNumber?: string;
  ciRunId?: string;
}

export interface CiUrlPublishOutput {
  storagePath: string;
  originalName: string;
  packageName?: string;
  variantLabel: string;
  buildId: string;
  sizeBytes: number;
}

export type CiUrlPublishError =
  | { kind: 'write_denied' }
  | { kind: 'invalid_url' }
  | { kind: 'blocked_host'; message: string }
  | { kind: 'download_failed'; status: number }
  | { kind: 'download_timeout' }
  | { kind: 'download_error'; message: string }
  | { kind: 'file_too_large'; sizeBytes: number; maxBytes: number }
  | { kind: 'invalid_filename'; ext: string }
  | { kind: 'duplicate_commit' }
  | { kind: 'build_record_failed'; message: string };

export function isCiUrlPublishError(v: unknown): v is CiUrlPublishError {
  return typeof v === 'object' && v !== null && 'kind' in v;
}

/**
 * Download `appUrl`, store it in the project's default lane, and record a build
 * row. Returns a tagged error rather than writing a response — the HTTP mapping
 * belongs to the controller.
 *
 * The caller MUST hold the per-project publish mutex; see the module docblock.
 */
export async function publishFromUrl(
  input: CiUrlPublishInput,
): Promise<CiUrlPublishOutput | CiUrlPublishError> {
  const { projectId, workspaceId, userId, platform, appUrl } = input;

  // The key's owner may have been demoted since the key was issued.
  // `ProjectService.updateProject` THROWS on a denied write and runs AFTER the
  // build row is inserted, so without this check a demoted owner gets a 500
  // and a half-applied publish — the same reason the `/ci/app/*` path checks
  // up front.
  if (!(await WorkspaceAccessService.hasPermission(userId, workspaceId, PERMISSIONS.PROJECT_WRITE))) {
    logger.warn('[CI_URL_PUBLISH] publish denied — owner lacks PROJECT_WRITE', {
      projectId,
      userId,
    });
    return { kind: 'write_denied' };
  }

  // Scheme/shape only here. The SSRF resolve happens once per hop inside
  // `fetchFollowingCheckedRedirects`, so doing it again here would just be a
  // second DNS lookup for the same host.
  const parsedUrl = parseHttpUrl(appUrl);
  if ('kind' in parsedUrl) return parsedUrl;

  // Extension is checked BEFORE the download — no point pulling 500 MB to
  // reject it on the filename. Single source shared with the editor upload,
  // so `.zip` (iOS simulator build) support cannot diverge.
  const originalName = path.basename(parsedUrl.pathname) || 'app.apk';
  const ext = path.extname(originalName).toLowerCase();
  if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return { kind: 'invalid_filename', ext: ext || '(none)' };
  }

  // ── Download ────────────────────────────────────────────────────
  logger.info('[CI_URL_PUBLISH] Downloading build from URL', { projectId, appUrl });

  let buffer: Buffer;
  try {
    // Covers redirects AND the body read, so the 2-minute budget bounds the
    // whole download rather than each leg of it.
    const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const response = await fetchFollowingCheckedRedirects(appUrl, deadline);
    if ('kind' in response) return response;

    if (!response.ok) return { kind: 'download_failed', status: response.status };

    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > MAX_APP_BYTES) {
      return { kind: 'file_too_large', sizeBytes: Number(declared), maxBytes: MAX_APP_BYTES };
    }

    // Read INCREMENTALLY and stop at the cap. `arrayBuffer()` would buffer the
    // whole body first, so a response with no Content-Length (a chunked
    // transfer) could exhaust the heap before any size check could reject it —
    // the declared-size check above is a courtesy, not a bound.
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) return { kind: 'download_error', message: 'Response had no body' };

    let complete = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        total += value.byteLength;
        if (total > MAX_APP_BYTES) {
          return { kind: 'file_too_large', sizeBytes: total, maxBytes: MAX_APP_BYTES };
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      // Unconditional, for the same reason withRedisMutex releases in a
      // `finally`: an early return or a throw mid-stream would otherwise leave
      // the socket held until GC.
      if (!complete) await reader.cancel().catch(() => undefined);
    }
    buffer = Buffer.concat(chunks, total);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { kind: 'download_timeout' };
    return {
      kind: 'download_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Store + record ──────────────────────────────────────────────
  // Resolve the lane ONCE and use it for the storage path, the build row and
  // the prune. This branch used to hardcode the literal 'default' lane while
  // the RESOLVE branch honours `getProjectDefaultVariant` — so a project that
  // promoted a named variant wrote every CI upload into `default` and then
  // resolved from the named lane, never seeing its own CI builds.
  const variantLabel = await MobileAppStorageService.getProjectDefaultVariant(projectId, platform);

  const metadata = await MobileAppStorageService.uploadApp(
    { buffer, originalname: originalName, size: buffer.length } as Express.Multer.File,
    { workspaceId, projectId, platform, variantLabel },
  );
  // `uploadApp`'s signature is intentionally narrow and knows nothing about
  // version fields, so attach them here for `recordBuild` and the legacy slot.
  if (input.versionName) metadata.versionName = input.versionName;
  if (typeof input.versionCode === 'number') metadata.versionCode = input.versionCode;

  // Record BEFORE updating the legacy slot — a legacy pointer to a build that
  // is not audit-traceable is worse than no pointer.
  const recorded = await MobileAppStorageService.recordBuild(
    metadata,
    {
      branch: input.branch,
      commitSha: input.commitSha,
      buildNumber: input.buildNumber,
      ciRunId: input.ciRunId,
      source: 'ci',
    },
    { projectId, workspaceId, uploadedBy: userId, variantLabel },
  );
  if ('error' in recorded) {
    if (recorded.error.code === '23505') return { kind: 'duplicate_commit' };
    return {
      kind: 'build_record_failed',
      message: recorded.error.message || 'unknown database error',
    };
  }

  // Legacy slot — points at the newest upload so the editor warm-up resolves
  // to the right binary.
  await ProjectService.updateProject(projectId, userId, {
    settings: { mobileApp: metadata as unknown as Record<string, unknown> },
  });

  logger.info('[CI_URL_PUBLISH] Build published from URL', {
    projectId,
    appUrl,
    storagePath: metadata.storagePath,
    sizeBytes: buffer.length,
    buildId: recorded.id,
    variant: variantLabel,
    branch: input.branch,
    commitSha: input.commitSha,
  });

  // Fire-and-forget prune — must not block the CI response and must not throw.
  // MUST use the same lane the build landed in, or it prunes a lane this
  // upload never wrote to.
  MobileAppStorageService.pruneOldBuilds(projectId, platform, variantLabel).catch((err) => {
    logger.warn('[CI_URL_PUBLISH] pruneOldBuilds failed (non-fatal)', {
      projectId,
      platform,
      variant: variantLabel,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    storagePath: metadata.storagePath,
    originalName: metadata.originalName,
    packageName: metadata.packageName,
    variantLabel,
    buildId: recorded.id,
    sizeBytes: buffer.length,
  };
}
