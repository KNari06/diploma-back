/**
 * Codec for the mobile app metadata carried inline in `intent_test_cases.goal`.
 *
 * Mobile test cases have no dedicated app_package / start_activity columns yet,
 * so the save path stashes `{ appPackage, startActivity }` as a JSON string in
 * the `goal` column (web rows keep `goal` as free text). This module is the
 * SINGLE source of that convention — the writer (RegressionSaveService) and any
 * reader (mobile-project-context.service) both go through here so the shape
 * can't drift silently.
 *
 * Web `goal` values are free text, not JSON — `decodeMobileGoal` returns an
 * empty object for anything that isn't the expected shape, never throws.
 */

export interface MobileGoalMeta {
  appPackage?: string;
  startActivity?: string;
}

/**
 * Serialise mobile app metadata for the `goal` column. Returns undefined when
 * there is nothing to store, so callers can spread it conditionally:
 *   ...(encodeMobileGoal(meta) ? { goal: encodeMobileGoal(meta) } : {})
 */
export function encodeMobileGoal(meta: MobileGoalMeta): string | undefined {
  const appPackage = meta.appPackage?.trim() || null;
  const startActivity = meta.startActivity?.trim() || null;
  if (!appPackage && !startActivity) return undefined;
  return JSON.stringify({ appPackage, startActivity });
}

/**
 * Parse a `goal` value back into mobile app metadata. Returns an empty object
 * for null, free-text (web) goals, or malformed JSON — never throws.
 */
export function decodeMobileGoal(goal: string | null | undefined): MobileGoalMeta {
  if (!goal) return {};
  try {
    const parsed = JSON.parse(goal) as { appPackage?: unknown; startActivity?: unknown };
    if (!parsed || typeof parsed !== 'object') return {};
    const out: MobileGoalMeta = {};
    if (typeof parsed.appPackage === 'string' && parsed.appPackage) {
      out.appPackage = parsed.appPackage;
    }
    if (typeof parsed.startActivity === 'string' && parsed.startActivity) {
      out.startActivity = parsed.startActivity;
    }
    return out;
  } catch {
    // Free-text `goal` (web rows) is not an error.
    return {};
  }
}
