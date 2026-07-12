/**
 * Web trigger engine — user-authored `when <condition> -> <action>` rules
 * for the live-editor Run path (`PreviewRunService.runSavedSteps`).
 *
 * Ports the mobile runner's user-trigger concept (ADR-0007) onto Playwright:
 * - `permission_dialog` + `permission(allow|deny)` matches a NATIVE browser
 *   dialog (alert/confirm/prompt/beforeunload) — handled in
 *   `preview-session.service.ts`'s `attachDialogHandler` (event-driven,
 *   can't be polled — Playwright pauses the page until the dialog is
 *   accepted/dismissed).
 * - `any_dialog` / `dialog_text{contains}` + `tap(text)`/`back` matches a
 *   DOM overlay (sales/survey popup, cookie banner, onboarding, paywall) —
 *   handled here, polled pre-step by `PreviewRunService`.
 *
 * See claude-plans/trigger-feature-web-port-20260712.md for the full design
 * and the two ordering bugs a plan-review pass caught before this shipped.
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { SnapshotRouter } from './snapshot-router.service';
import { normalizeText } from './text-normalizer.util';
import { OverlayDismisser, ESCAPE_KEY } from '@/agent/core/lite/exploration/overlay-dismisser';
import type { Trigger, TriggerCondition, TriggerAction } from '@/services/mobile/mobile-runner.types';

export type { Trigger, TriggerCondition, TriggerAction } from '@/services/mobile/mobile-runner.types';

export interface DetectedWebDialog {
  /** Concatenated text preview of every detected, non-permanent overlay — used for `dialog_text` matching. */
  text: string;
}

export interface WebTriggerFireResult {
  fired: boolean;
  trigger?: Trigger;
  matchedText?: string;
}

/**
 * The `triggerFired` shape sent on `preview:run:step` so the UI can name the
 * EXACT trigger that activated (its id, condition, and action target) — not
 * just that "a trigger fired". `triggerId` lets the editor point back at the
 * specific authored trigger; the flattened condition/action fields let the
 * step tooltip render "Any dialog → Tap 'Астана'" without importing the
 * canonical Trigger type into the WS layer.
 */
export interface TriggerFiredPayload {
  triggerId: string;
  conditionKind: TriggerCondition['kind'];
  /** condition.contains, only for `dialog_text`. */
  conditionContains?: string;
  actionKind: TriggerAction['kind'];
  /** action.text (button label), only for `tap`. */
  actionText?: string;
  /** action.decision, only for `permission`. */
  actionDecision?: 'allow' | 'deny';
  /** The overlay text that matched (DOM-overlay conditions only). */
  matchedText?: string;
  timestamp: string;
}

/**
 * Build the `triggerFired` WS payload from the trigger that activated. Shared
 * by both emit sites (pre-step overlay check in `preview-run.service`, native
 * dialog handler in `preview-session.service`) so they stay in lockstep.
 */
export function buildTriggerFiredPayload(trigger: Trigger, matchedText?: string): TriggerFiredPayload {
  const { condition, action } = trigger;
  return {
    triggerId: trigger.id,
    conditionKind: condition.kind,
    ...(condition.kind === 'dialog_text' ? { conditionContains: condition.contains } : {}),
    actionKind: action.kind,
    ...(action.kind === 'tap' ? { actionText: action.text } : {}),
    ...(action.kind === 'permission' ? { actionDecision: action.decision } : {}),
    ...(matchedText ? { matchedText } : {}),
    timestamp: new Date().toISOString(),
  };
}

/** Mirrors the runner's `MAX_ACTIVATIONS_PER_STEP` — stops a trigger whose own action reopens its target from looping forever. */
const MAX_ACTIVATIONS_PER_STEP = 3;

/** Case-insensitive, Unicode-safe compare — reuses this repo's existing NFC/invisible-char normalizer, lowercased locally for matching. */
function normalizeForCompare(s: string | undefined | null): string {
  return (normalizeText(s) ?? '').toLowerCase();
}

/**
 * Detect a currently-showing DOM overlay via the same `SnapshotRouter` +
 * `OverlayDismisser` classification `OverlayDismisser.dismissOverlays` uses
 * internally — reused here (not re-derived) so "is a dialog-like overlay
 * present" agrees with the classifier that already knows a sticky navbar
 * or framework container is NOT a real overlay (`filterDismissible`'s
 * `unknown`/permanent exclusions).
 */
export async function detectOverlay(page: Page): Promise<DetectedWebDialog | null> {
  try {
    const snapshot = await SnapshotRouter.collect(page, { context: 'preview-apply', skipStabilityWait: true });
    const obstacles = snapshot.obstacleFacts ?? [];
    if (obstacles.length === 0) return null;

    const classified = OverlayDismisser.classifyObstacles(obstacles, snapshot.viewport);
    const dismissible = OverlayDismisser.filterDismissible(classified, 'flow');
    if (dismissible.length === 0) return null;

    const text = dismissible
      .map(({ fact }) => fact.textPreview)
      .filter(Boolean)
      .join(' ');
    return { text };
  } catch (error) {
    logger.debug('[WebTriggerEngine] Overlay detection failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Does a single condition match a detected DOM overlay? `permission_dialog` never matches here — native dialogs only, handled elsewhere. */
export function conditionMatchesOverlay(condition: TriggerCondition, detected: DetectedWebDialog): boolean {
  switch (condition.kind) {
    case 'any_dialog':
      return true;
    case 'permission_dialog':
      return false;
    case 'dialog_text': {
      const needle = normalizeForCompare(condition.contains);
      if (!needle) return false;
      return normalizeForCompare(detected.text).includes(needle);
    }
    default: {
      // Exhaustiveness is enforced at compile time; fail SAFE at runtime
      // (an unknown kind must not read as "matched").
      const _exhaustive: never = condition;
      void _exhaustive;
      return false;
    }
  }
}

/** First trigger (in the given order) whose condition matches. User triggers take precedence — same "first match wins" contract as the mobile matcher. */
export function matchOverlayTrigger(triggers: readonly Trigger[], detected: DetectedWebDialog): Trigger | null {
  for (const trigger of triggers) {
    if (conditionMatchesOverlay(trigger.condition, detected)) return trigger;
  }
  return null;
}

/**
 * ALL triggers (in authored order) whose condition matches the detected
 * overlay. The handler tries each in turn until one's action actually acts, so
 * a matching trigger with an inapplicable action — a `tap` whose label isn't on
 * this overlay, or a `permission` action (native-only, a no-op on a DOM
 * overlay) — can't abandon the overlay and shadow a later working trigger.
 */
export function matchOverlayTriggers(triggers: readonly Trigger[], detected: DetectedWebDialog): Trigger[] {
  return triggers.filter((trigger) => conditionMatchesOverlay(trigger.condition, detected));
}

/**
 * Run a matched trigger's action against a detected DOM overlay.
 * `permission` never applies to a DOM overlay (no native accept/dismiss) —
 * the editor UI already restricts `permission` to the `permission_dialog`
 * condition, which never reaches this function (see `conditionMatchesOverlay`).
 */
export async function runWebTriggerAction(page: Page, trigger: Trigger): Promise<boolean> {
  const { action } = trigger;
  try {
    switch (action.kind) {
      case 'tap': {
        const needle = action.text?.trim();
        if (!needle) return false;
        // Scope to the topmost OPEN dialog first. bi.group (and most modal
        // component libraries) render the same city/label text both inside
        // the modal AND in background content — a filter dropdown, project
        // cards, etc. An unscoped `getByText(needle).first()` grabbed a
        // background copy sitting BEHIND the modal, so the click was
        // intercepted by the modal's backdrop and did nothing while
        // reporting success (bi.group 2026-07-12: manual click on the
        // modal's own "Астана" closed it, but the trigger's did not).
        // Targeting the dialog's own subtree clicks the button the user
        // actually sees. Falls back to page scope when the overlay isn't a
        // role=dialog/aria-modal (e.g. a plain promo div or cookie bar).
        const dialogScope = page.locator('[role="dialog"], [aria-modal="true"]').last();
        const inDialog = dialogScope.getByText(needle, { exact: false }).first();
        const locator = (await inDialog.count()) > 0
          ? inDialog
          : page.getByText(needle, { exact: false }).first();
        try {
          await locator.click({ timeout: 3000 });
        } catch {
          // A real coordinate click was intercepted (portal backdrop,
          // animation layer). Dispatch the click event DIRECTLY on the
          // resolved element — no coordinate hit-testing, so an overlay
          // can't swallow it, and it still fires the element's own onClick
          // (React/Vue listen for bubbling click events). This replaces an
          // earlier `force: true` retry, which was wrong: force skips
          // Playwright's actionability CHECK but STILL clicks at the
          // element's coordinates, landing on whatever overlay sits on top
          // — so it silently no-op'd instead of activating the target.
          await locator.dispatchEvent('click');
        }
        return true;
      }
      case 'back': {
        await page.keyboard.press(ESCAPE_KEY);
        return true;
      }
      case 'permission':
        return false;
      default: {
        // Exhaustiveness is enforced at compile time; fail SAFE at runtime
        // (an unknown kind must not read as "acted").
        const _exhaustive: never = action;
        void _exhaustive;
        return false;
      }
    }
  } catch (error) {
    logger.warn('[WebTriggerEngine] Trigger action failed', {
      triggerId: trigger.id,
      actionKind: action.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Detect -> match -> act for the DOM-overlay conditions, called pre-step by
 * `PreviewRunService`. Loops (bounded by `MAX_ACTIVATIONS_PER_STEP`) so a
 * stacked overlay (e.g. cookie banner behind a sales popup) can be cleared
 * in one pre-step check rather than only ever handling the topmost.
 */
export async function checkAndHandleWebOverlayTrigger(
  page: Page,
  triggers: readonly Trigger[],
): Promise<WebTriggerFireResult> {
  if (triggers.length === 0) return { fired: false };

  let activations = 0;
  let lastFired: WebTriggerFireResult = { fired: false };

  while (activations < MAX_ACTIVATIONS_PER_STEP) {
    const detected = await detectOverlay(page);
    if (!detected) break;

    const candidates = matchOverlayTriggers(triggers, detected);
    if (candidates.length === 0) break;

    // Try each condition-matching trigger until one's action actually acts.
    // A candidate whose action can't fire on this overlay (wrong `tap` label,
    // or a native-only `permission` action) returns false and we advance to
    // the next — rather than abandoning the overlay, which would both leave the
    // popup up and shadow every later trigger for this step.
    let fired: Trigger | null = null;
    for (const candidate of candidates) {
      if (await runWebTriggerAction(page, candidate)) {
        fired = candidate;
        break;
      }
    }
    // No condition-matching candidate could act — stop, else we'd re-detect the
    // same overlay and re-try the same failing candidates until the cap.
    if (!fired) break;

    activations++;
    lastFired = { fired: true, trigger: fired, matchedText: detected.text.slice(0, 200) };
    logger.info('[WebTriggerEngine] Trigger fired', {
      triggerId: fired.id,
      conditionKind: fired.condition.kind,
      actionKind: fired.action.kind,
    });

    // Let the dismiss animation settle before re-checking for a stacked overlay.
    await page.waitForTimeout(300);
  }

  return lastFired;
}
