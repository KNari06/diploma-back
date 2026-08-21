/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOCTOR ACCESS — "may this user act on this Doctor row?", in one place.
 *
 * Every Doctor endpoint originally authorized on bare `row.user_id === userId`.
 * On a shared test suite — the normal case for a QA team — that made the
 * feature single-player: a nightly regression triggered by one member (or by
 * the scheduler under that member's id) produced findings nobody else could
 * read, let alone apply. The panel simply 403'd for them.
 *
 * The rule here is the one the repo already settled on for the negative-test
 * routes (see .claude/rules/architecture.md § Negative-test domain): owner OR
 * workspace member, via `hasProjectAccess`. It is also the rule the EDITOR
 * already applies to the very same write — `canWriteTestCase` lets a workspace
 * member edit `steps_json` by hand, which is exactly what an apply does — so
 * bare ownership here was not a stricter policy, just an inconsistent one.
 *
 * Shape: owner short-circuits FIRST, so this can only ever widen who is
 * allowed. A row with no `project_id` (older findings pre-date the column
 * being populated) falls back to owner-only rather than opening up — fail
 * closed on the unknown.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { hasProjectAccess } from '@/services/core/project-access.service';

export interface DoctorOwnedRow {
  user_id: string;
  project_id?: string | null;
}

/**
 * True when `userId` owns the row, or is a member of the workspace owning the
 * row's project. Never throws — `hasProjectAccess` is itself fail-closed.
 */
export async function canActOnDoctorRow(row: DoctorOwnedRow, userId: string): Promise<boolean> {
  if (row.user_id === userId) return true;
  if (!row.project_id) return false;
  return hasProjectAccess(row.project_id, userId);
}
