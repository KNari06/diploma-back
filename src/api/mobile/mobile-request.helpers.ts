/**
 * Shared request-parsing helpers for the mobile HTTP controllers.
 *
 * Extracted from `mobile.controller.ts` so handlers stay thin and the
 * same validation/coercion logic is reused across upload-url, finalize,
 * get, patch, delete, and the per-platform variants of each. Pure
 * functions — no I/O, no Express coupling beyond the `Request` type.
 */

import type { Request, Response } from 'express';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';

const VALID_PLATFORMS: Record<string, MobilePlatform> = {
  android: 'android',
  ios: 'ios',
  flutter: 'flutter',
};

/** Coerce `req.body.platform` / `req.query.platform` to a valid `MobilePlatform`, defaulting to `'android'`. */
export function pickPlatform(raw: unknown, fallback: MobilePlatform = 'android'): MobilePlatform {
  if (typeof raw === 'string' && VALID_PLATFORMS[raw]) return VALID_PLATFORMS[raw];
  return fallback;
}

/** Coerce to a valid `MobilePlatform` or `undefined` if not one of the known kinds. */
export function pickPlatformOrUndefined(raw: unknown): MobilePlatform | undefined {
  return typeof raw === 'string' ? VALID_PLATFORMS[raw] : undefined;
}

/** Trim a body field, return `undefined` if empty or non-string. */
export function trimmedString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Coerce `versionCode`-style input (number OR digit string) to a non-negative
 * integer, or `undefined` if the value is missing / malformed.
 */
export function parseVersionCode(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return undefined;
}

/** Coerce `contentLength` (number OR digit string) to bytes, or `null` when absent/invalid. */
export function parseContentLength(raw: unknown): number | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

/**
 * Resolve and validate the authenticated `userId`. Writes a 401 and
 * returns `null` if the request is unauthenticated — callers then bail
 * out without re-emitting a response.
 */
export function requireUserId(req: Request, res: Response): string | null {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }
  return userId;
}
