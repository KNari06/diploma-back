/**
 * Trigger validation — enforces the CANONICAL cross-repo `Trigger` contract.
 *
 * Mirrors qait-mobile-runner src/api/schemas/run.schema.ts `triggerSchema`
 * exactly. The backend must persist + forward triggers in this shape and no
 * other; the runner re-validates with the same rules and rejects anything else.
 *
 * Two entry points:
 *   - `validateTriggers` — THROWS on the first malformed entry. Used on the
 *     write path (PATCH) so a bad payload is a 400, not silent data loss.
 *   - `sanitizeTriggers` — drops malformed entries and returns the valid ones.
 *     Used on the dispatch path as defense-in-depth (DB rows are already
 *     validated on write, but a legacy/manually-edited row shouldn't crash a
 *     run — we forward only the well-formed triggers).
 */

import type { Trigger, TriggerCondition, TriggerAction } from './mobile-runner.types';
import { ValidationError } from '@/types';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Returns an error string when `condition` is invalid, else null. */
function conditionError(condition: unknown): string | null {
  if (!condition || typeof condition !== 'object') {
    return 'condition is required (object)';
  }
  const kind = (condition as { kind?: unknown }).kind;
  switch (kind) {
    case 'permission_dialog':
    case 'any_dialog':
      return null;
    case 'dialog_text':
      return isNonEmptyString((condition as { contains?: unknown }).contains)
        ? null
        : "condition.contains is required (non-empty string) when kind='dialog_text'";
    default:
      return `condition.kind must be one of permission_dialog|any_dialog|dialog_text (got ${String(kind)})`;
  }
}

/** Returns an error string when `action` is invalid, else null. */
function actionError(action: unknown): string | null {
  if (!action || typeof action !== 'object') {
    return 'action is required (object)';
  }
  const kind = (action as { kind?: unknown }).kind;
  switch (kind) {
    case 'permission': {
      const decision = (action as { decision?: unknown }).decision;
      return decision === 'allow' || decision === 'deny'
        ? null
        : "action.decision must be 'allow' or 'deny' when kind='permission'";
    }
    case 'tap':
      return isNonEmptyString((action as { text?: unknown }).text)
        ? null
        : "action.text is required (non-empty string) when kind='tap'";
    case 'back':
      return null;
    default:
      return `action.kind must be one of permission|tap|back (got ${String(kind)})`;
  }
}

/** Returns an error string when `trigger` is invalid, else null. */
function triggerError(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== 'object') {
    return 'expected an object { id, condition, action }';
  }
  if (!isNonEmptyString((trigger as { id?: unknown }).id)) {
    return 'id is required (non-empty string)';
  }
  return (
    conditionError((trigger as { condition?: unknown }).condition) ??
    actionError((trigger as { action?: unknown }).action)
  );
}

/** Narrowed object after validation — keeps only the contract fields. */
function normalizeTrigger(t: Trigger): Trigger {
  const condition = t.condition as TriggerCondition;
  const action = t.action as TriggerAction;
  return { id: t.id, condition, action };
}

/**
 * Validate triggers on the WRITE path. Throws `ValidationError` (HTTP 400) on
 * the first malformed entry — the preview controller's catch already maps
 * `ValidationError` to a 400. Returns the normalized array (contract fields
 * only). `undefined` in → `undefined` out (field untouched).
 */
export function validateTriggers(triggers: unknown): Trigger[] | undefined {
  if (triggers === undefined) return undefined;
  if (!Array.isArray(triggers)) {
    throw new ValidationError('triggers must be an array');
  }
  return triggers.map((t, i) => {
    const err = triggerError(t);
    if (err) {
      throw new ValidationError(`triggers[${i}]: ${err}`);
    }
    return normalizeTrigger(t as Trigger);
  });
}

/**
 * Sanitize triggers on the DISPATCH/READ path. Drops malformed entries instead
 * of throwing — a run should never crash because one stored trigger is stale.
 * Non-array input yields an empty array.
 */
export function sanitizeTriggers(triggers: unknown): Trigger[] {
  if (!Array.isArray(triggers)) return [];
  return triggers
    .filter((t) => triggerError(t) === null)
    .map((t) => normalizeTrigger(t as Trigger));
}
