/**
 * Maps `MobileAppError` tags (returned by `mobile-app.service.ts`) to
 * HTTP responses. Kept in the api/ layer so the service stays free of
 * Express/HTTP concerns and the mapping table is in one place.
 */

import type { Response } from 'express';
import type { MobileAppError } from '@/services/mobile/mobile-app.service';
import { MAX_UPLOAD_SIZE_BYTES, ALLOWED_UPLOAD_EXTENSIONS } from '@/services/mobile/mobile-app.service';

const MB = 1024 * 1024;

/**
 * Write an HTTP error response for a mobile session/command/lint/apply handler
 * that caught a thrown error while talking to the runner.
 *
 * WHY THIS EXISTS: every such handler used to respond
 *   { success:false, error:'<X> failed' (HARDCODED), message:'<real cause>' }
 * and the editor surfaced the generic `error`, dropping `message`. So a dead
 * session, a Gemini 503, a device-init failure all read as "Apply failed" /
 * "Command failed" / "Failed to warm up emulator session". This helper makes
 * the response carry the REAL cause in `error`, forwards the runner's typed
 * `code` + HTTP status when present, and special-cases a reclaimed session as
 * a typed 410 SESSION_EXPIRED so the editor can prompt "reopen to continue".
 * `fallback` is used only when the error has no message at all.
 *
 * Keeps `message` too (same string) for any client that reads it. Callers
 * still do their own logging/tracing — this only shapes the HTTP response.
 */
export function sendMobileRunnerError(res: Response, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const runnerErr = error as { statusCode?: number; code?: string };

  // Streaming guard: runTestCaseOnSession streams NDJSON (Content-Type
  // application/x-ndjson + res.write per step), so an error AFTER the first
  // chunk reaches this catch with headers already sent — `res.status().json()`
  // would then throw ERR_HTTP_HEADERS_SENT (latent before this consolidation).
  // Emit a terminal NDJSON error line + end the stream instead, so the editor
  // gets a real failure event rather than a hung/aborted connection.
  if (res.headersSent) {
    try {
      res.write(JSON.stringify({ type: 'error', error: message || fallback, ...(runnerErr?.code ? { code: runnerErr.code } : {}) }) + '\n');
    } catch { /* socket already torn down — nothing we can do */ }
    res.end();
    return;
  }

  // A session the runner no longer has (idle TTL / pool reset / redeploy) →
  // typed 410 so the editor routes it through its session-expiry flow instead
  // of showing a dead-end error that only a reload "fixes".
  const sessionGone = runnerErr?.statusCode === 404 && /session not found/i.test(message);
  if (sessionGone) {
    res.status(410).json({
      success: false,
      code: 'SESSION_EXPIRED',
      error: 'Session expired',
      message: 'The device session is no longer available (reclaimed after inactivity or a restart). Reopen the test case to continue.',
    });
    return;
  }

  const status = runnerErr?.statusCode && runnerErr.statusCode >= 400 ? runnerErr.statusCode : 500;
  res.status(status).json({
    success: false,
    error: message || fallback,
    ...(runnerErr?.code ? { code: runnerErr.code } : {}),
    message: message || fallback,
  });
}

/** Write the appropriate HTTP response for a tagged service error. */
export function sendMobileAppError(res: Response, err: MobileAppError): void {
  switch (err.kind) {
    case 'project_not_found':
      res.status(404).json({ success: false, error: 'Project not found or access denied' });
      return;

    case 'invalid_filename':
      res.status(400).json({
        success: false,
        error: `Invalid file type: ${err.ext}. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`,
      });
      return;

    case 'file_too_large':
      // Preserve original wording — frontend / CI clients may match on these strings.
      res.status(413).json({
        success: false,
        error: err.source === 'uploaded'
          ? `Uploaded file too large (${(err.sizeBytes / MB).toFixed(1)} MB). Max: ${MAX_UPLOAD_SIZE_BYTES / MB} MB.`
          : `File too large. Maximum size is ${MAX_UPLOAD_SIZE_BYTES / MB}MB, declared ${(err.sizeBytes / MB).toFixed(1)}MB`,
      });
      return;

    case 'invalid_storage_path':
      res.status(400).json({ success: false, error: 'storagePath does not belong to this project' });
      return;

    case 'object_missing':
      res.status(404).json({
        success: false,
        error: 'Object not found at storagePath — was the PUT to the upload URL successful?',
      });
      return;

    case 'object_empty':
      res.status(400).json({ success: false, error: 'Uploaded object is empty (0 bytes)' });
      return;

    case 'package_name_required':
      res.status(400).json({
        success: false,
        error: 'packageName is required and could not be read from the binary. Pass it explicitly (Android: package id e.g. com.example.app; iOS: bundle ID).',
      });
      return;

    case 'build_record_failed': {
      // Surface the REAL database reason instead of guessing. A unique
      // violation (23505) only happens when the same commit is re-uploaded
      // into the same variant; anything else (e.g. a missing column when the
      // migration hasn't run) is reported verbatim so it's diagnosable.
      const isDup = err.code === '23505';
      res.status(isDup ? 409 : 500).json({
        success: false,
        error: isDup
          ? 'A build for this commit already exists in this variant. Re-uploading the same commit is a no-op.'
          : `Failed to record build in version history: ${err.message || 'unknown database error'}`,
      });
      return;
    }

    case 'app_not_uploaded':
      res.status(404).json({
        success: false,
        error: 'No uploaded app to update — upload an APK/IPA first',
      });
      return;

    case 'no_app_to_delete':
      // Caller treats this as a 200 (idempotent delete) — we don't write here.
      res.json({
        success: true,
        message: err.platform ? `No ${err.platform} app to delete` : 'No app to delete',
      });
      return;

    case 'variant_limit':
      res.status(409).json({
        success: false,
        error: `Variant limit reached: a ${err.platform} app can have at most ${err.max} variants. Delete one before adding another.`,
      });
      return;

    case 'invalid_variant_name':
      res.status(400).json({ success: false, error: 'Variant name is required (non-empty string)' });
      return;

    case 'cannot_modify_default_variant':
      res.status(400).json({
        success: false,
        error: 'The default variant cannot be renamed or deleted here. Use DELETE /app to clear the default slot.',
      });
      return;

    case 'variant_not_found':
      res.status(404).json({ success: false, error: `Variant "${err.label}" not found for this project+platform` });
      return;

    case 'variant_name_taken':
      res.status(409).json({ success: false, error: `A variant named "${err.label}" already exists` });
      return;
  }
}
