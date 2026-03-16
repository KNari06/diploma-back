/**
 * Preview Step Apply Service V2
 * Executes a single step in the preview session
 * Features: ownership enforcement, post-action verification, state-aware retries
 */

import { logger } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import type { FrameLocator, Locator, Page } from 'playwright';
import { sanitizeIntent } from './element-resolver.service';
import { IntentStepLintService } from './intent-step-lint.service';
import { LocatorPlanBuilder } from './locator-plan-builder.service';
import { getPreviewSessionService } from './preview-session.service';
import type {
    BindingHints,
    ConfidenceTier,
    IntentStep,
    InteractiveNode,
    LintCandidate,
    ResolutionMeta,
    UrlMatcher,
} from './preview.types';

import { STEP_APPLY_CONFIG, STEP_READINESS_CONFIG } from '@/config/testing/playwright-tuning';

const MAX_ATTEMPTS = STEP_APPLY_CONFIG.maxAttempts;

/**
 * V2: Build bindingHints from resolved InteractiveNode
 * Auto-populates hints for better runtime resolution
 */
function buildBindingHintsFromNode(node: InteractiveNode): BindingHints {
  const hints: BindingHints = {};

  if (node.role) hints.role = node.role;
  if (node.labelText) hints.label = node.labelText;
  if (node.placeholder) hints.placeholder = node.placeholder;
  if (node.autocomplete) hints.autocomplete = node.autocomplete;
  if (node.inputType || node.type) hints.type = node.inputType || node.type;

  // Add nearby text from container titles
  if (node.containerTitles && node.containerTitles.length > 0) {
    hints.nearText = node.containerTitles[0];
  }

  return hints;
}
const ACTION_TIMEOUT = STEP_APPLY_CONFIG.actionTimeoutMs;
const POST_ACTION_SETTLE_TIMEOUT = STEP_APPLY_CONFIG.postActionSettleTimeoutMs;

// V2: Action types that support state verification
const STATE_VERIFIABLE_ACTIONS = new Set(['check', 'uncheck', 'toggle', 'open', 'close', 'type', 'click', 'upload']);

// V11: Actions that don't target elements — skip modal check
const NON_TARGETING_ACTIONS = new Set(['navigate', 'wait', 'scroll', 'wait_for', 'ai_check']);

// Actions that mutate DOM and require a fresh snapshot for the next step's lint.
// After these, we invalidate the cached snapshot so hover→click sequences get fresh nodes.
const DOM_MUTATING_ACTIONS = new Set(['hover', 'click', 'open', 'close', 'toggle', 'dblclick', 'contextmenu', 'drag_and_drop']);

/**
 * V11: Detect if a modal/popup/overlay is currently blocking the page.
 * Uses cached domNodes from session (no extra snapshot collection).
 * Returns modal info if detected, null otherwise.
 */
function detectModalBlockingFromSession(
  previewSessionId: string,
  userId: string,
): { modalRef: string; modalText?: string; boundingBox?: { x: number; y: number; width: number; height: number } } | null {
  const sessionService = getPreviewSessionService();
  const session = sessionService.getSession(previewSessionId);
  if (!session) return null;

  const domNodes = session.pageState?.domNodes;
  if (!domNodes || domNodes.length === 0) return null;

  // Check if any node is flagged as inside active modal (set by snapshot collector)
  const hasModalElements = domNodes.some(n => n.isInsideActiveModal === true);
  if (!hasModalElements) return null;

  // Find the modal container node itself (dialog/alertdialog/or highest z-index positioned element)
  const modalNode = domNodes.find(n =>
    n.isVisible &&
    (n.role === 'dialog' || n.role === 'alertdialog' || n.tag === 'dialog')
  );

  // Build modal text from elements inside it
  const modalElements = domNodes.filter(n => n.isInsideActiveModal === true);
  const modalText = modalElements
    .map(n => n.text || n.ariaLabel || n.labelText || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 200);

  return {
    modalRef: modalNode?.ref || modalElements[0]?.ref || 'unknown',
    modalText: modalText || undefined,
    boundingBox: modalNode?.boundingBox || undefined,
  };
}

/**
 * Generate a random integer in range [min, max] (inclusive).
 */
function randomIntInclusive(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Best-effort: sleep for ms using Playwright timers.
 * (We use this for "human-like" micro-pauses only.)
 */
async function sleepMs(page: Page, ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return;
  await page.waitForTimeout(ms);
}

/**
 * With probability `chance` (0..1), wait a random duration within [minMs, maxMs].
 */
async function maybeRandomPause(
  page: Page,
  chance: number,
  minMs: number,
  maxMs: number
): Promise<void> {
  if (!Number.isFinite(chance) || chance <= 0) return;
  if (Math.random() > Math.min(1, chance)) return;
  const ms = randomIntInclusive(minMs, maxMs);
  await sleepMs(page, ms);
}

/**
 * Convert a wait_for glob pattern to regex string.
 * Robust parser:
 * - *  => [^/]* (single segment wildcard)
 * - ** => .*    (cross-segment wildcard)
 * - ?  => .     (single-char wildcard)
 * - \* \? \\ and any escaped char are treated as literals
 */
export function globToRegexPatternForWaitFor(glob: string): string {
  const escapeRegexChar = (char: string): string => {
    return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  };

  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const next = i + 1 < glob.length ? glob[i + 1] : '';

    // Escaped char: treat next char as literal (including *, ?, \).
    if (ch === '\\') {
      if (next) {
        pattern += escapeRegexChar(next);
        i++;
      } else {
        // Trailing backslash should be matched literally.
        pattern += '\\\\';
      }
      continue;
    }

    if (ch === '*' && next === '*') {
      pattern += '.*';
      i++;
      continue;
    }
    if (ch === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (ch === '?') {
      pattern += '.';
      continue;
    }

    pattern += escapeRegexChar(ch);
  }

  return pattern;
}

/**
 * Normalize value for "type" action without trimming user input.
 */
export function normalizeTypeActionValue(rawValue: string | undefined): string {
  return rawValue ?? '';
}

/**
 * V5: Execute wait_for using SPA-safe approach (page.waitForFunction)
 * Works for both full navigations AND SPA client-side routing (React Router, Next.js, etc.)
 *
 * Matcher precedence:
 * 1. changedFrom: wait until URL != changedFrom value (used by auto-insert)
 * 2. regex: match URL against regex pattern
 * 3. glob: match URL against glob pattern (converted to regex)
 * 4. substring: URL contains substring
 * 5. domain: URL domain equals value (strict host match)
 *
 * @param page Playwright Page
 * @param matcher UrlMatcher configuration
 * @param timeoutMs Timeout in milliseconds
 */
async function executeWaitFor(
  page: Page,
  matcher: UrlMatcher | undefined,
  timeoutMs: number
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!matcher) {
      // No matcher specified - simple wait for duration (like 'wait' action)
      logger.debug('[WAIT_FOR] No URL matcher specified, waiting for duration', { timeoutMs });
      await page.waitForTimeout(timeoutMs);
      return { success: true };
    }

    const negate = matcher.negate ?? false;
    const caseSensitive = matcher.caseSensitive ?? false;

    // Build predicate based on matcher type
    // Priority: changedFrom > regex > glob > substring > domain

    if (matcher.changedFrom) {
      // Wait until URL changes from the specified value
      const prevUrl = matcher.changedFrom;
      await page.waitForFunction(
        (prev: string) => String((globalThis as any).location?.href ?? '') !== prev,
        prevUrl,
        { timeout: timeoutMs }
      );
      logger.debug('[WAIT_FOR_URL] URL changed from previous value', {
        prevUrl,
        newUrl: page.url(),
      });
      return { success: true };
    }

    if (matcher.regex) {
      const pattern = matcher.regex;
      const flags = caseSensitive ? '' : 'i';
      await page.waitForFunction(
        ({ pattern, flags, negate }: { pattern: string; flags: string; negate: boolean }) => {
          const re = new RegExp(pattern, flags);
          const href = String((globalThis as any).location?.href ?? '');
          const matches = re.test(href);
          return negate ? !matches : matches;
        },
        { pattern, flags, negate: negate },
        { timeout: timeoutMs }
      );
      return { success: true };
    }

    if (matcher.glob) {
      const pattern = globToRegexPatternForWaitFor(matcher.glob);
      const flags = caseSensitive ? '' : 'i';
      await page.waitForFunction(
        ({ pattern, flags, negate }: { pattern: string; flags: string; negate: boolean }) => {
          const re = new RegExp(pattern, flags);
          const href = String((globalThis as any).location?.href ?? '');
          const matches = re.test(href);
          return negate ? !matches : matches;
        },
        { pattern, flags, negate: negate },
        { timeout: timeoutMs }
      );
      return { success: true };
    }

    if (matcher.substring) {
      const sub = matcher.substring;
      await page.waitForFunction(
        ({ sub, caseSensitive, negate }: { sub: string; caseSensitive: boolean; negate: boolean }) => {
          const hrefRaw = String((globalThis as any).location?.href ?? '');
          const url = caseSensitive ? hrefRaw : hrefRaw.toLowerCase();
          const search = caseSensitive ? sub : sub.toLowerCase();
          const matches = url.includes(search);
          return negate ? !matches : matches;
        },
        { sub, caseSensitive, negate: negate },
        { timeout: timeoutMs }
      );
      return { success: true };
    }

    if (matcher.domain) {
      const domain = matcher.domain;
      await page.waitForFunction(
        ({ domain, caseSensitive, negate }: { domain: string; caseSensitive: boolean; negate: boolean }) => {
          const hostRaw = String((globalThis as any).location?.hostname ?? '');
          const host = caseSensitive ? hostRaw : hostRaw.toLowerCase();
          const target = caseSensitive ? domain : domain.toLowerCase();
          const matches = host === target;
          return negate ? !matches : matches;
        },
        { domain, caseSensitive, negate: negate },
        { timeout: timeoutMs }
      );
      return { success: true };
    }

    // No specific matcher - return success
    return { success: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('[WAIT_FOR_URL] Timeout or error waiting for URL', {
      matcher,
      timeoutMs,
      error: msg,
    });
    return { success: false, error: `wait_for timed out or failed: ${msg}` };
  }
}

/**
 * Result of step application (V2: enhanced)
 */
interface ApplyResult {
  success: boolean;
  error?: string;
  appliedStep?: IntentStep;
  urlChanged?: boolean;
  url?: string;
  highlight?: Array<{
    ref?: string;
    boundingBox?: { x: number; y: number; width: number; height: number };
    type: 'success' | 'warning' | 'error';
  }>;
  attempts?: number;
  /** V2: Whether action was verified post-execution */
  verified?: boolean;
  /** V2: State change detected */
  stateChange?: {
    before?: Partial<InteractiveNode>;
    after?: Partial<InteractiveNode>;
  };
  /** V11: Modal/popup is blocking the target element */
  modalBlocking?: {
    modalRef: string;
    modalText?: string;
    boundingBox?: { x: number; y: number; width: number; height: number };
  };
}

/**
 * Get locator context - either page or iframe
 * Handles iframe configuration if specified in step options
 */
function getLocatorContext(page: Page, step: IntentStep): Page | FrameLocator {
  if (step.options?.iframe?.selector) {
    logger.debug('[PREVIEW_APPLY] Using iframe context', {
      iframeSelector: step.options.iframe.selector,
    });
    return page.frameLocator(step.options.iframe.selector);
  }
  return page;
}

/**
 * V2: Verify that an action had the expected effect
 * Respects iframe context if configured in step options
 */
async function verifyActionEffect(
  page: Page,
  step: IntentStep,
  ref: string
): Promise<boolean> {
  const selector = `[data-agent-ref="${ref}"]`;

  try {
    // Use the same context (page or iframe) as action execution
    const context = getLocatorContext(page, step);
    const locator = context.locator(selector);

    switch (step.type) {
      case 'check': {
        const checked = await locator.isChecked();
        return checked === true;
      }

      case 'uncheck': {
        const checked = await locator.isChecked();
        return checked === false;
      }

      case 'toggle': {
        // V10 Fix #9: Verify actual state change instead of just checking visibility.
        // Check multiple ARIA attributes that represent toggle state:
        // aria-pressed (toggle buttons), aria-checked (switch roles), aria-expanded (collapsibles)
        const pressed = await locator.getAttribute('aria-pressed').catch(() => null);
        if (pressed !== null) {
          // aria-pressed exists — a valid state means the toggle registered
          return pressed === 'true' || pressed === 'mixed';
        }

        const checked = await locator.getAttribute('aria-checked').catch(() => null);
        if (checked !== null) {
          return checked === 'true' || checked === 'mixed';
        }

        // Fallback: check native checked property (custom toggle wrapping a hidden checkbox)
        const nativeChecked = await locator.evaluate(
          (el: any) => el.querySelector('input[type="checkbox"]')?.checked ?? null
        ).catch(() => null);
        if (nativeChecked !== null) {
          return nativeChecked === true;
        }

        // Last resort: element is at least visible (preserves old behaviour for unknown toggles)
        return locator.isVisible();
      }

      case 'open': {
        // V10 Fix #9: Check multiple signals for "open" state, not just aria-expanded
        const expanded = await locator.getAttribute('aria-expanded').catch(() => null);
        if (expanded !== null) return expanded === 'true';

        // Some components use aria-hidden on the content panel; check sibling/child patterns
        const hasVisiblePanel = await locator.evaluate((el: any) => {
          const id = el.getAttribute('aria-controls');
          if (id) {
            const panel = el.ownerDocument.getElementById(id);
            return panel ? panel.getAttribute('aria-hidden') !== 'true' && panel.offsetHeight > 0 : null;
          }
          return null;
        }).catch(() => null);
        if (hasVisiblePanel !== null) return hasVisiblePanel;

        // Fallback: assume success if element is visible (cannot determine state)
        return locator.isVisible();
      }

      case 'close': {
        // V10 Fix #9: Mirror of 'open' — verify the target is actually collapsed
        const expanded = await locator.getAttribute('aria-expanded').catch(() => null);
        if (expanded !== null) return expanded !== 'true';

        const panelHidden = await locator.evaluate((el: any) => {
          const id = el.getAttribute('aria-controls');
          if (id) {
            const panel = el.ownerDocument.getElementById(id);
            return panel ? (panel.getAttribute('aria-hidden') === 'true' || panel.offsetHeight === 0) : null;
          }
          return null;
        }).catch(() => null);
        if (panelHidden !== null) return panelHidden;

        return locator.isVisible();
      }

      case 'type': {
        // Verify the input has a value
        const value = await locator.inputValue().catch(() => '');
        return value.length > 0 || step.value === ''; // Empty type is valid
      }

      case 'click': {
        // For click, verification is tricky - we assume success if no error
        return true;
      }

      case 'upload': {
        // Verify the file input has files set
        const files = await locator.evaluate((el: any) => el.files?.length ?? 0);
        return files > 0;
      }

      default:
        return true; // Non-verifiable actions assumed successful
    }
  } catch {
    return false;
  }
}

/**
 * Build selector from step options and candidate
 * Prioritizes manual CSS selector override if provided
 */
function buildSelector(step: IntentStep, candidate: LintCandidate): string | undefined {
  // Manual CSS selector override takes priority
  if (step.options?.cssSelector) {
    return step.options.cssSelector;
  }
  // Fall back to candidate ref
  return candidate.ref ? `[data-agent-ref="${candidate.ref}"]` : undefined;
}

/**
 * Wait for element stability before action (unless disabled)
 */
async function ensureStability(
  locator: Locator,
  step: IntentStep,
  timeout: number
): Promise<void> {
  if (step.options?.disableStabilityChecks) {
    return;
  }
  // File inputs are often hidden via CSS; check for attached instead of visible
  if (step.type === 'upload') {
    await locator.waitFor({ state: 'attached', timeout });
  } else {
    await locator.waitFor({ state: 'visible', timeout });
  }
}

/**
 * Adaptive post-hover settle: waits for DOM to stabilize after hover triggers
 * tooltips, submenus, or popovers. Instead of a fixed 150ms, we observe the DOM
 * for new elements appearing and wait until mutations stop.
 *
 * Strategy:
 * 1. Snapshot current DOM element count
 * 2. Poll for new visible elements (tooltip, menu, popover patterns)
 * 3. Once detected OR minWaitMs passed — wait for mutations to stop (stableMs gap)
 * 4. Safety cap at maxWaitMs to avoid hanging on non-reactive hovers
 *
 * @returns elapsed time in ms
 */
async function waitForHoverEffect(
  page: Page,
  maxWaitMs = 2000,
  stableMs = 150,
): Promise<number> {
  const start = Date.now();

  // Selectors for elements commonly created by hover (tooltips, menus, popovers)
  const hoverEffectSelector = [
    '[role="tooltip"]:visible',
    '[role="menu"]:visible',
    '[role="listbox"]:visible',
    '[role="dialog"]:visible',
    '[data-radix-popper-content-wrapper]:visible',
    '[class*="tooltip"]:visible',
    '[class*="popover"]:visible',
    '[class*="dropdown"]:visible',
    '.tippy-box:visible',
    '.MuiTooltip-tooltip:visible',
    '.MuiMenu-list:visible',
    '.ant-tooltip:visible',
    '.ant-dropdown:visible',
  ].join(', ');

  // Phase 1: Quick check — did hover produce any visible effect?
  // Race between effect appearing and a minimum wait (avoids 0ms exit on static hovers)
  const minWaitMs = STEP_READINESS_CONFIG.domStableThresholdMs.assertion; // 150ms
  try {
    await Promise.race([
      page.waitForSelector(hoverEffectSelector, { state: 'visible', timeout: maxWaitMs }),
      page.waitForTimeout(minWaitMs),
    ]);
  } catch {
    // No effect found within maxWaitMs — hover probably doesn't trigger visible DOM changes
    return Date.now() - start;
  }

  // Phase 2: Wait for the effect to stabilize (animation to finish).
  // Use MutationObserver-based idle detection: wait until no new DOM mutations
  // occur for stableMs. This catches CSS transitions that add/remove classes.
  const remainingMs = maxWaitMs - (Date.now() - start);
  if (remainingMs > stableMs) {
    try {
      await page.evaluate(
        ({ stableMs: stMs, timeoutMs }) => new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const reset = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              observer.disconnect();
              resolve();
            }, stMs);
          };
          const MO = (globalThis as any).MutationObserver;
          const observer = new MO(() => reset());
          observer.observe((globalThis as any).document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'aria-hidden', 'hidden', 'data-state'],
          });
          // Safety cap
          setTimeout(() => {
            observer.disconnect();
            if (timer) clearTimeout(timer);
            resolve();
          }, timeoutMs);
          // Start the idle timer immediately
          reset();
        }),
        { stableMs, timeoutMs: Math.min(remainingMs, maxWaitMs) },
      );
    } catch {
      // page.evaluate can fail if page navigated — fall through
    }
  }

  return Date.now() - start;
}

/**
 * Dispatch a synthetic file drop event onto a target element.
 * Used as a last-resort fallback for drag-and-drop-only upload zones
 * that have no hidden <input type="file"> and don't trigger a fileChooser on click.
 *
 * Reads the file from disk, passes it as base64 into the browser context,
 * and dispatches dragenter → dragover → drop events with a DataTransfer payload.
 */
async function dispatchFileDrop(
  page: Page,
  locator: Locator,
  localFilePath: string,
  filename: string,
  contentType?: string,
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  // Read file from disk and encode as base64
  const fileBuffer = await fs.readFile(localFilePath);
  const base64Data = fileBuffer.toString('base64');
  const resolvedFilename = filename || path.basename(localFilePath);
  const resolvedContentType = contentType || 'application/octet-stream';

  // Dispatch synthetic drag-and-drop events in the browser context
  await locator.evaluate(
    (el: any, { base64, fname, ctype }) => {
      const g = globalThis as any;
      // Decode base64 back to binary
      const binaryStr = g.atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const file = new g.File([bytes], fname, { type: ctype });

      // Build DataTransfer with the file
      const dt = new g.DataTransfer();
      dt.items.add(file);

      const shared = { bubbles: true, cancelable: true, dataTransfer: dt };

      // Full drag sequence: dragenter → dragover → drop
      el.dispatchEvent(new g.DragEvent('dragenter', shared));
      el.dispatchEvent(new g.DragEvent('dragover', shared));
      el.dispatchEvent(new g.DragEvent('drop', shared));
    },
    { base64: base64Data, fname: resolvedFilename, ctype: resolvedContentType },
  );
}

/**
 * Upload via fileChooser interception, with drag-drop fallback.
 *
 * Strategy:
 * 1. Try fileChooser interception (short 3s timeout) — works with programmatic input.click()
 * 2. If fileChooser times out (e.g., drag-only dropzone), fall back to synthetic drop event
 *
 * This prevents wasting the full action timeout on drag-only zones that will never
 * emit a filechooser event.
 */
async function uploadViaFileChooserOrDrop(
  page: Page,
  locator: Locator,
  localFilePath: string,
  filename: string,
  contentType?: string,
  timeout = 10_000,
): Promise<void> {
  const FILECHOOSER_QUICK_TIMEOUT = 3_000;

  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: FILECHOOSER_QUICK_TIMEOUT }),
      locator.click({ timeout: FILECHOOSER_QUICK_TIMEOUT }),
    ]);
    await fileChooser.setFiles(localFilePath);
  } catch {
    // FileChooser didn't fire — likely a drag-and-drop-only upload zone.
    // Fall back to synthetic drop event.
    logger.info('[PREVIEW_APPLY] FileChooser not triggered, falling back to synthetic drop', {
      filename,
    });
    await dispatchFileDrop(page, locator, localFilePath, filename, contentType);
  }
}

/**
 * V10 Fix #7: Detect how long a dropdown animation takes to complete.
 * Polls for new visible ARIA containers (listbox/menu) or role=option elements.
 * Returns elapsed time + a safety margin so we know how long to wait in each phase.
 *
 * Strategy: measure how long it takes for any dropdown-like container to appear
 * after the trigger click, then add a proportional buffer for animation easing.
 */
async function measureDropdownOpenLatency(
  page: Page,
  maxWaitMs = 5000,
  pollIntervalMs = 100,
): Promise<number> {
  const start = Date.now();
  const dropdownSelector = [
    '[role="listbox"]:visible',
    '[role="menu"]:visible',
    '[role="option"]:visible',
    '[role="menuitem"]:visible',
    // Common non-ARIA patterns
    'ul.dropdown-menu:visible',
    '.MuiMenu-list:visible',
    '[class*="dropdown"][class*="open"]:visible',
  ].join(', ');

  try {
    await page.waitForSelector(dropdownSelector, {
      state: 'visible',
      timeout: maxWaitMs,
    });
  } catch {
    // Nothing appeared within max wait — return the full max so callers still try
    return maxWaitMs;
  }

  const elapsed = Date.now() - start;
  // Add 30% buffer for animation easing (at least 200ms, at most 3s extra)
  const buffer = Math.min(3000, Math.max(200, Math.round(elapsed * 0.3)));
  return elapsed + buffer;
}

/**
 * Custom dropdown select: click trigger → find visible option → click option.
 *
 * V10 Fix #7: Uses adaptive timeout based on measured dropdown animation latency
 * instead of hardcoded 2s, so slow-animating dropdowns (Material UI, Ant Design)
 * are handled automatically.
 *
 * Strategy chain (most precise → broadest):
 * 1. Scoped: find ARIA listbox/menu container, search option inside it
 *    — Prevents clicking same-text elements elsewhere on the page
 * 2. Page-level getByRole('option'/'menuitem') — ARIA-compliant; auto-filters hidden
 *    — Handles portaled menus (React Portal, MUI Popper) rendered outside DOM tree
 * 3. Page-level getByText + :visible — universal fallback for non-ARIA dropdowns
 */
async function selectFromCustomDropdown(
  page: Page,
  triggerLocator: Locator,
  value: string,
  timeout: number
): Promise<void> {
  // Click the trigger to open the dropdown
  await triggerLocator.click({ timeout });

  // V10 Fix #7: Measure actual dropdown animation latency instead of hardcoding
  // This adapts to slow animations (Material UI transitions, CSS keyframes, etc.)
  const animationLatency = await measureDropdownOpenLatency(page);
  // Per-phase timeout: use animation latency as floor, step timeout as ceiling
  const phaseTimeout = Math.min(timeout, Math.max(animationLatency, 1500));

  logger.debug('[CUSTOM_DROPDOWN] Animation latency measured', {
    animationLatency,
    phaseTimeout,
    value: value.substring(0, 50),
  });

  // Phase 1: Try scoped search inside a visible ARIA container (listbox/menu)
  // This is the safest approach — avoids clicking same-text elements elsewhere
  const containers = [
    page.locator('[role="listbox"]:visible'),
    page.locator('[role="menu"]:visible'),
  ];

  for (const container of containers) {
    try {
      const isVisible = await container.first().isVisible().catch(() => false);
      if (!isVisible) continue;

      // Search for option inside this container
      const scopedOpt = container.first().getByText(value, { exact: true }).first();
      await scopedOpt.waitFor({ state: 'visible', timeout: phaseTimeout });
      await scopedOpt.click({ timeout: phaseTimeout });
      return;
    } catch {
      // Container exists but option not found inside — try next
    }
  }

  // Phase 2: Page-level ARIA role search (handles portals where container is outside DOM tree)
  const roleStrategies = [
    page.getByRole('option', { name: value, exact: true }),
    page.getByRole('menuitem', { name: value, exact: true }),
    page.getByRole('option', { name: value, exact: false }),
    page.getByRole('menuitem', { name: value, exact: false }),
  ];

  for (const strategy of roleStrategies) {
    try {
      const opt = strategy.first();
      await opt.waitFor({ state: 'visible', timeout: phaseTimeout });
      await opt.click({ timeout: phaseTimeout });
      return;
    } catch {
      // Try next
    }
  }

  // Phase 3: Universal text fallback (non-ARIA dropdowns)
  // getByText matches hidden elements too, so we filter with :visible
  const textStrategies = [
    page.getByText(value, { exact: true }).and(page.locator(':visible')),
    page.getByText(value, { exact: false }).and(page.locator(':visible')),
  ];

  for (const strategy of textStrategies) {
    try {
      const opt = strategy.first();
      await opt.waitFor({ state: 'visible', timeout: phaseTimeout });
      await opt.click({ timeout: phaseTimeout });
      return;
    } catch {
      // Try next
    }
  }

  throw new Error(`Could not find option "${value}" in dropdown`);
}

/**
 * Execute an action on the page
 * V7: Optionally accepts a pre-resolved locator (from compiled plan)
 */
async function executeAction(
  page: Page,
  step: IntentStep,
  candidate: LintCandidate,
  preResolvedLocator?: Locator
): Promise<{ success: boolean; error?: string; urlChanged: boolean }> {
  const urlBefore = page.url();

  try {
    // Build selector (unless we have a pre-resolved locator from compiled plan)
    const selector = preResolvedLocator ? '' : buildSelector(step, candidate);

    if (!selector && !preResolvedLocator && !['navigate', 'wait', 'scroll', 'press'].includes(step.type)) {
      return { success: false, error: 'No valid selector for element', urlChanged: false };
    }

    // Get context (page or iframe)
    const context = getLocatorContext(page, step);
    const timeout = step.options?.timeout || ACTION_TIMEOUT;

    // V7: Use pre-resolved locator if provided, otherwise build from selector
    const locator = preResolvedLocator || (selector ? (context as Page | FrameLocator).locator(selector) : undefined);

    // Ensure element stability before action (unless disabled)
    if (locator && step.type !== 'navigate' && step.type !== 'wait') {
      await ensureStability(locator, step, timeout);
    }

    switch (step.type) {
      case 'type': {
        if (!locator) throw new Error('No selector for type action');
        // Preserve exact user-entered text (including leading/trailing spaces and newlines).
        const value = normalizeTypeActionValue(step.value);
        const humanLike = step.options?.humanLike === true;

        // Human-like typing: gradual per-character input (instead of instant fill).
        // - If replaceContent is false: append by typing
        // - Else: clear first (fast), then type gradually
        if (humanLike) {
          // Focus the input first (real user behavior)
          await locator.click({ timeout });

          // If we want to "replace", clear existing content before typing.
          // We clear quickly, then type gradually for the human-like effect.
          if (step.options?.replaceContent !== false) {
            await locator.fill('', { timeout });
          }

          // Delay between keystrokes:
          // - If explicitly set, respect it
          // - Else choose a realistic random delay in [50..150] ms
          const delay = Number.isFinite(step.options?.keyPressDelay)
            ? Math.max(0, step.options!.keyPressDelay!)
            : randomIntInclusive(50, 150);

          await locator.pressSequentially(value, { timeout, delay });

          // Sometimes pause after typing (e.g., user thinking / UI debounce)
          await maybeRandomPause(page, 0.35, 80, 220);
        } else if (step.options?.replaceContent === false) {
          // Legacy behavior: append typing (uses keyPressDelay if provided)
          await locator.click({ timeout });
          await locator.pressSequentially(value, { timeout, delay: step.options?.keyPressDelay });
        } else {
          // Default: fast fill
          await locator.fill(value, { timeout });
        }
        if (step.options?.pressEnter) {
          await locator.press('Enter', { timeout });
        }
        break;
      }

      case 'click': {
        if (!locator) throw new Error('No selector for click action');
        const humanLike = step.options?.humanLike === true;

        if (humanLike) {
          // Human-like click: hover -> small pause -> click
          await locator.hover({ timeout });
          await sleepMs(page, randomIntInclusive(40, 160));

          // Sometimes click at a random point inside the element (reduces "robotic" center-click pattern)
          const usePosition = Math.random() < 0.3;
          if (usePosition) {
            const box = await locator.boundingBox().catch(() => null);
            if (box && box.width > 6 && box.height > 6) {
              // Position is relative to the element's top-left in Playwright
              const x = randomIntInclusive(3, Math.floor(box.width) - 3);
              const y = randomIntInclusive(3, Math.floor(box.height) - 3);
              await locator.click({ timeout, position: { x, y } });
              break;
            }
          }
        }

        await locator.click({ timeout });
        break;
      }

      case 'select': {
        if (!locator) throw new Error('No selector for select action');
        const selectValue = step.value || '';

        // Detect native <select> vs custom dropdown
        const isNativeSelect = await locator.evaluate(
          (el) => el.tagName.toLowerCase() === 'select'
        ).catch(() => false);

        if (isNativeSelect) {
          // Native <select>: use Playwright's selectOption
          await locator.selectOption(selectValue, { timeout });
        } else {
          await selectFromCustomDropdown(page, locator, selectValue, timeout);
        }
        break;
      }

      case 'hover': {
        if (!locator) throw new Error('No selector for hover action');
        // Scroll element into viewport before hovering (prevents out-of-viewport misses)
        await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
        try {
          await locator.hover({ timeout });
        } catch {
          // Retry with force:true if blocked by an overlay (another tooltip, sticky header, etc.)
          await locator.hover({ timeout, force: true });
        }
        // Adaptive post-hover settle — waits for hover-triggered DOM changes to stabilize
        // (tooltips, submenus, popovers) instead of a fixed delay
        await waitForHoverEffect(page);
        break;
      }

      case 'press': {
        const key = step.value || 'Enter';
        if (locator) {
          await locator.press(key, { timeout });
        } else {
          // Page-level press fallback (Escape, Tab, F5, shortcuts, etc.)
          await page.keyboard.press(key);
        }
        break;
      }

      case 'scroll': {
        if (locator) {
          await locator.scrollIntoViewIfNeeded({ timeout });
        } else {
          // V10 Fix #8: Use actual delta from step.value instead of hardcoded 300px
          // step.value is the accumulated deltaY from recording (positive = down, negative = up)
          const rawDelta = parseFloat(step.value || '');
          const deltaY = Number.isFinite(rawDelta) ? rawDelta : 300;
          await page.evaluate((dy: number) => {
            (globalThis as any).scrollBy(0, dy);
          }, deltaY);
        }
        // Post-scroll settle — give lazy-loaded content time to appear
        await sleepMs(page, STEP_READINESS_CONFIG.domStableThresholdMs.assertion);
        break;
      }

      case 'wait': {
        const waitTimeout = step.options?.timeout || 1000;
        await page.waitForTimeout(waitTimeout);
        break;
      }

      case 'navigate': {
        if (!step.value) throw new Error('No URL for navigate action');
        const safeUrl = sanitizeUrl(step.value);
        await page.goto(safeUrl, { waitUntil: 'load', timeout: STEP_APPLY_CONFIG.navigateTimeoutMs });
        break;
      }

      case 'assert': {
        if (!locator) throw new Error('No selector for assert action');
        // Step 1: verify element is visible
        await locator.waitFor({ state: 'visible', timeout });
        // Step 2: if value is provided, verify element contains the expected text
        if (step.value && step.value.trim().length > 0) {
          const elementText = await locator.textContent({ timeout });
          const actualText = (elementText || '').trim();
          const expectedText = step.value.trim();
          if (!actualText.toLowerCase().includes(expectedText.toLowerCase())) {
            throw new Error(
              `Element does not contain expected text.\n` +
              `Expected: "${expectedText}"\n` +
              `Actual: "${actualText.substring(0, 200)}"`
            );
          }
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V2: New state-aware action types
      // ═══════════════════════════════════════════════════════════════════════
      case 'check': {
        if (!locator) throw new Error('No selector for check action');
        await locator.check({ timeout });
        break;
      }

      case 'uncheck': {
        if (!locator) throw new Error('No selector for uncheck action');
        await locator.uncheck({ timeout });
        break;
      }

      case 'toggle': {
        if (!locator) throw new Error('No selector for toggle action');
        // Toggle: click the element (works for checkboxes, switches, toggles)
        await locator.click({ timeout });
        break;
      }

      case 'open': {
        if (!locator) throw new Error('No selector for open action');
        // Open: click to expand (dropdown, accordion, menu)
        // First check if already open
        const isExpanded = await locator.getAttribute('aria-expanded');
        if (isExpanded !== 'true') {
          await locator.click({ timeout });
        }
        break;
      }

      case 'close': {
        if (!locator) throw new Error('No selector for close action');
        // Close: click to collapse (dropdown, accordion, menu)
        const isExpanded = await locator.getAttribute('aria-expanded');
        if (isExpanded === 'true') {
          await locator.click({ timeout });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V10: New interaction types
      // ═══════════════════════════════════════════════════════════════════════
      case 'dblclick': {
        if (!locator) throw new Error('No selector for dblclick action');
        await locator.dblclick({ timeout });
        break;
      }

      case 'contextmenu': {
        if (!locator) throw new Error('No selector for contextmenu action');
        await locator.click({ button: 'right', timeout });
        break;
      }

      case 'drag_and_drop': {
        if (!locator) throw new Error('No selector for drag_and_drop source');
        // step.value is JSON: { from: {x,y}, to: {x,y} }
        const dragData = (() => {
          try { return JSON.parse(step.value || ''); } catch { return null; }
        })();

        if (dragData?.from && dragData?.to) {
          // Coordinate-based drag (recorded from mouse events)
          // Wrapped in try/catch: if drag fails mid-way, mouse.up() must still be called
          // to prevent the mouse staying "stuck" in down state and corrupting subsequent steps
          try {
            await page.mouse.move(dragData.from.x, dragData.from.y);
            await page.mouse.down();
            // Gradual move for realistic drag behaviour
            const steps = Math.max(5, Math.round(
              Math.sqrt(
                Math.pow(dragData.to.x - dragData.from.x, 2) +
                Math.pow(dragData.to.y - dragData.from.y, 2)
              ) / 10
            ));
            await page.mouse.move(dragData.to.x, dragData.to.y, { steps });
            await page.mouse.up();
          } catch (dragError) {
            await page.mouse.up().catch(() => {});
            throw dragError;
          }
        } else if (step.options?.dropTarget) {
          // Element-based drag: drag source locator to a target selector
          const targetLocator = (getLocatorContext(page, step) as Page | FrameLocator)
            .locator(step.options.dropTarget);
          await locator.dragTo(targetLocator, { timeout });
        } else {
          throw new Error('drag_and_drop requires coordinate data (value) or a dropTarget option');
        }
        break;
      }

      // V6: File upload — supports both native <input type="file"> and trigger-button patterns
      case 'upload': {
        if (!locator) throw new Error('No selector for upload action');

        const fileUrl = step.value;
        if (!fileUrl) throw new Error('File URL/path is required for upload action');

        const uploadOpts = step.options?.upload;
        let localFilePath: string;
        let downloadedFilename: string = '';
        let downloadedContentType: string | undefined;
        let needsCleanup = false;

        // Both 'url' and 'storage' source types use public URLs — download to temp dir
        {
          const { downloadFileForUpload } = await import('@/agent/execution/file-download.service');
          const result = await downloadFileForUpload(fileUrl, {
            filename: uploadOpts?.filename,
            maxSizeBytes: uploadOpts?.maxSizeBytes,
          });
          localFilePath = result.localPath;
          downloadedFilename = result.filename;
          downloadedContentType = result.contentType;
          needsCleanup = true;
        }

        try {
          // Check if the resolved element is already an <input type="file">
          const tagName = await locator.evaluate((el: any) => el.tagName?.toLowerCase()).catch(() => '');
          const inputType = await locator.evaluate((el: any) => el.type?.toLowerCase()).catch(() => '');
          const isFileInput = tagName === 'input' && inputType === 'file';

          if (isFileInput) {
            // Direct path: element is already a file input
            await locator.waitFor({ state: 'attached', timeout });
            await locator.setInputFiles(localFilePath, { timeout });
          } else {
            // Trigger-button pattern: the resolved element is a <button>/<div>/<label> that
            // opens a native file dialog. The real <input type="file"> is hidden via CSS.
            // Strategy: 1) Try to find a hidden file input nearby in DOM
            //           2) Fall back to fileChooser event interception (most universal)

            // Attempt 1: Search for a hidden file input associated with this trigger element.
            // Checks: children, shadow DOM children, parent containers (up to 3 levels),
            // shadow roots in parent trees, and label[for] association.
            const nearbyFileInput = await locator.evaluate((el: any) => {
              // Helper: check a root and its open shadow roots for input[type="file"]
              const findFileInput = (root: any): boolean => {
                if (!root) return false;
                if (root.querySelector?.('input[type="file"]')) return true;
                // Traverse open shadow roots of all child elements
                const children = root.querySelectorAll?.('*') || [];
                for (const child of children) {
                  if (child.shadowRoot?.querySelector('input[type="file"]')) return true;
                }
                return false;
              };

              // Check element itself (children + shadow)
              if (findFileInput(el)) return true;
              if (el.shadowRoot && findFileInput(el.shadowRoot)) return true;

              // Check parent containers (up to 3 levels) for a file input
              let parent = el.parentElement;
              for (let i = 0; i < 3 && parent; i++) {
                if (findFileInput(parent)) return true;
                parent = parent.parentElement;
              }

              // Check by label[for] association
              if (el.tagName === 'LABEL' && el.htmlFor) {
                const target = el.ownerDocument.getElementById(el.htmlFor);
                if (target?.type === 'file') return true;
              }

              return false;
            }).catch(() => false);

            if (nearbyFileInput) {
              // Found a nearby hidden file input — locate and use it
              const fileInputLocator = await (async () => {
                // Try child first (Playwright pierces open shadow DOM)
                const child = locator.locator('input[type="file"]');
                if (await child.count() > 0) return child.first();

                // Try parent containers (up to 3 levels)
                for (let i = 1; i <= 3; i++) {
                  const ancestor = locator.locator(`xpath=${'..'.concat('/..'.repeat(i - 1))}`);
                  const input = ancestor.locator('input[type="file"]');
                  if (await input.count() > 0) return input.first();
                }

                // No page-level fallback — too risky with multiple file inputs.
                // Fall through to fileChooser interception instead.
                return null;
              })();

              if (fileInputLocator) {
                await fileInputLocator.waitFor({ state: 'attached', timeout });
                await fileInputLocator.setInputFiles(localFilePath, { timeout });
              } else {
                // Nearby input detected in evaluate() but Playwright locator couldn't reach it
                // (e.g., closed shadow DOM). Fall back to fileChooser → drag-drop chain.
                await uploadViaFileChooserOrDrop(page, locator, localFilePath, downloadedFilename, downloadedContentType, timeout);
              }
            } else {
              // Attempt 2: No hidden file input found anywhere near the trigger.
              // Try fileChooser interception first (works with programmatic input.click()),
              // then fall back to synthetic drag-drop (for drop-only zones).
              await uploadViaFileChooserOrDrop(page, locator, localFilePath, downloadedFilename, downloadedContentType, timeout);
            }
          }
        } finally {
          if (needsCleanup) {
            const { cleanupUploadTempFile } = await import('@/agent/execution/file-download.service');
            setTimeout(() => {
              cleanupUploadTempFile(localFilePath).catch(() => {});
            }, 10_000);
          }
        }
        break;
      }

      default:
        return { success: false, error: `Unknown action type: ${step.type}`, urlChanged: false };
    }

    const urlAfter = page.url();
    return { success: true, urlChanged: urlBefore !== urlAfter };
  } catch (error) {
    logger.warn('[PREVIEW_APPLY] Action execution failed', {
      stepType: step.type,
      candidateRef: candidate.ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Action failed',
      urlChanged: page.url() !== urlBefore,
    };
  }
}

/**
 * Preview Step Apply Service
 */
export class PreviewStepApplyService {
  /**
   * Apply a step in the preview session
   * Tries top candidates with limited retries
   * V3: If selectedRef is provided (from user clarification), use it directly
   */
  static async applyStep(params: {
    previewSessionId: string;
    stepDraft: IntentStep;
    pageRef?: string;
    userId: string;
    selectedRef?: string; // V3: User-confirmed element ref from clarification
    skipPostActionWait?: boolean; // V12: Skip post-action settle when caller uses lookahead (e.g. Run mode)
  }): Promise<ApplyResult> {
    const { previewSessionId, stepDraft, userId, selectedRef, skipPostActionWait } = params;

    logger.info('[PREVIEW_APPLY] Applying step', {
      previewSessionId,
      stepType: stepDraft.type,
      descriptionPreview: sanitizeIntent(stepDraft).slice(0, 80),
      selectedRef: selectedRef || 'none (will lint)',
    });

    try {
      // Get page from session
      const sessionService = getPreviewSessionService();
      const page = sessionService.getPage(previewSessionId, userId);

      if (!page) {
        return {
          success: false,
          error: 'Preview session not found or expired',
        };
      }

      // Handle non-targeting actions (navigate, wait, scroll)
      // Scroll is page-level: uses step.value (deltaY) without targeting a DOM element
      if (['navigate', 'wait', 'scroll'].includes(stepDraft.type)) {
        // V5: Capture URL BEFORE action for accurate compiled context
        // This is important for auto-wait-for-url injection which compares adjacent pageUrls
        const urlBeforeAction = page.url();
        
        const result = await executeAction(page, stepDraft, { label: '', reason: '', confidence: 1 });

        // Generate compiled plan for non-targeting actions
        // Use urlBeforeAction to record the context where action was initiated
        let compiled;
        try {
          compiled = LocatorPlanBuilder.buildCompiledPlanForNonTargetingAction({
            step: stepDraft,
            pageUrl: urlBeforeAction,
            pageTitle: await page.title().catch(() => undefined),
          });
        } catch (compileError) {
          logger.warn('[PREVIEW_APPLY] Failed to generate compiled plan for non-targeting action', {
            error: compileError instanceof Error ? compileError.message : String(compileError),
          });
        }

        return {
          success: result.success,
          error: result.error,
          appliedStep: {
            ...stepDraft,
            compiled,
          },
          urlChanged: result.urlChanged,
          url: page.url(), // Current URL after action (may have changed)
          attempts: 1,
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V5: Handle wait_for (SPA-safe URL waiting)
      // ═══════════════════════════════════════════════════════════════════════
      if (stepDraft.type === 'wait_for') {
        const urlBefore = page.url();
        const matcher = stepDraft.options?.urlMatcher;
        // V5.1: timeout is now primary (required from frontend), urlMatcher.timeoutMs is fallback
        const timeoutMs = stepDraft.options?.timeout ?? matcher?.timeoutMs ?? 15000;

        logger.info('[PREVIEW_APPLY] Handling wait_for', {
          previewSessionId,
          matcher: matcher ? Object.keys(matcher).filter(k => (matcher as any)[k] !== undefined) : [],
          timeoutMs,
        });

        try {
          const result = await executeWaitFor(page, matcher, timeoutMs);

          // Generate compiled plan for wait_for
          let compiled;
          try {
            compiled = LocatorPlanBuilder.buildCompiledPlanForNonTargetingAction({
              step: stepDraft,
              pageUrl: page.url(),
              pageTitle: await page.title().catch(() => undefined),
            });
          } catch (compileError) {
            logger.warn('[PREVIEW_APPLY] Failed to generate compiled plan for wait_for', {
              error: compileError instanceof Error ? compileError.message : String(compileError),
            });
          }

          return {
            success: result.success,
            error: result.error,
            appliedStep: {
              ...stepDraft,
              compiled,
            },
            urlChanged: urlBefore !== page.url(),
            url: page.url(),
            attempts: 1,
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'wait_for failed',
            urlChanged: urlBefore !== page.url(),
            url: page.url(),
            attempts: 1,
          };
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V3: Handle ai_check assertions
      // ═══════════════════════════════════════════════════════════════════════
      if (stepDraft.type === 'ai_check') {
        logger.info('[PREVIEW_APPLY] Handling ai_check assertion', {
          previewSessionId,
          assertion: stepDraft.assertionText,
          contextMode: stepDraft.options?.aiContextMode || 'html+a11y+screenshot',
        });

        // Validate assertionText
        if (!stepDraft.assertionText || stepDraft.assertionText.trim().length === 0) {
          return {
            success: false,
            error: 'assertionText is required for ai_check',
            attempts: 0,
          };
        }

        try {
          // Import devtools collector, AI check service, and HTML context service
          const { fetchAccessibility } = await import('./preview-devtools-collector.service');
          const { evaluateAiCheck } = await import('./ai-check.service');
          const { buildSemanticHtmlFromPage } = await import('./html-context.service');

          // Determine context mode (default: html+a11y+screenshot)
          const contextMode = stepDraft.options?.aiContextMode || 'html+a11y+screenshot';

          // Gather context based on mode
          let html: string | undefined;
          let a11yTree: any[] | undefined;
          let screenshotBase64: string | undefined;

          const sessionService = getPreviewSessionService();

          // Feature flag: use semantic HTML builder (default: ON)
          const useSemanticHtml = process.env.AI_CHECK_SEMANTIC_HTML !== '0';

          if (contextMode.includes('html')) {
            if (useSemanticHtml) {
              try {
                // Use semantic HTML builder with token budgeting
                const semanticResult = await buildSemanticHtmlFromPage(page, {
                  assertionText: stepDraft.assertionText,
                  tokenBudget: 8000,
                  expandForNegative: true,
                });
                html = semanticResult.html;
                
                logger.debug('[PREVIEW_APPLY] Using semantic HTML for ai_check', {
                  previewSessionId,
                  originalLength: semanticResult.originalLength,
                  semanticLength: semanticResult.semanticLength,
                  tokens: semanticResult.tokens,
                  reduction: `${Math.round((1 - semanticResult.semanticLength / semanticResult.originalLength) * 100)}%`,
                });
              } catch (semanticError) {
                // Fallback to raw HTML if semantic builder fails
                logger.warn('[PREVIEW_APPLY] Semantic HTML builder failed, falling back to raw HTML', {
                  previewSessionId,
                  error: semanticError instanceof Error ? semanticError.message : String(semanticError),
                });
                const rawHtml = await page.content();
                html = rawHtml.substring(0, 100 * 1024); // Fallback: 100KB truncation
              }
            } else {
              // Legacy path: use raw HTML
              const { fetchHtml } = await import('./preview-devtools-collector.service');
              const htmlPayload = await fetchHtml(page, previewSessionId, 0);
              html = htmlPayload.html;
            }
          }

          if (contextMode.includes('a11y')) {
            const a11yPayload = await fetchAccessibility(page, previewSessionId, 0);
            a11yTree = a11yPayload.tree;
          }

          if (contextMode.includes('screenshot')) {
            const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
              force: true,
              includeScreenshot: true,
              includeDomNodes: false,
            });
            screenshotBase64 = snapshot?.screenshot;
            if (!screenshotBase64) {
              logger.warn('[PREVIEW_APPLY] ai_check screenshot not available from snapshot', {
                previewSessionId,
              });
            }
          }

          // Evaluate AI check
          const aiCheckResult = await evaluateAiCheck({
            assertionText: stepDraft.assertionText,
            url: page.url(),
            html,
            a11yTree,
            screenshotBase64,
          });

          logger.info('[PREVIEW_APPLY] ai_check evaluation completed', {
            previewSessionId,
            pass: aiCheckResult.pass,
            confidence: aiCheckResult.confidence,
            explanation: aiCheckResult.explanation,
            highlightRefsCount: aiCheckResult.highlightRefs?.length || 0,
          });

          /**
           * V4: Best-effort highlight mapping for ai_check.
           *
           * We can only reliably highlight DOM elements when the model returns `data-agent-ref` values
           * (highlightRefs). Those refs are mapped to `InteractiveNode.boundingBox` when available.
           *
           * Limitations:
           * - If HTML lacks `data-agent-ref` attributes, `highlightRefs` will likely be empty.
           * - If domNodes are not available (ownership / snapshot missing), highlights may miss boundingBox.
           */
          let highlight: ApplyResult['highlight'] = [];
          if (aiCheckResult.highlightRefs && aiCheckResult.highlightRefs.length > 0) {
            const isOwned = sessionService.isSessionOwned(previewSessionId, userId);
            if (!isOwned) {
              logger.warn('[PREVIEW_APPLY] Skip ai_check highlight mapping: session is not owned by user', {
                previewSessionId,
                userId,
              });
            } else {
              // Force-including domNodes is cheap when throttled (reuses session.pageState.domNodes).
              // When not throttled, it collects a fresh snapshot and updates session.pageState.
              const snapshotWithDom = await sessionService.getSnapshot(previewSessionId, userId, {
                force: true,
                includeDomNodes: true,
                includeScreenshot: false,
              });
              const domNodes = snapshotWithDom?.domNodes ?? sessionService.getSession(previewSessionId)?.pageState?.domNodes ?? [];

              highlight = aiCheckResult.highlightRefs.map((ref) => {
                const node = domNodes.find((n) => n.ref === ref);
                return {
                  ref,
                  boundingBox: node?.boundingBox,
                  type: aiCheckResult.pass ? 'success' : 'error',
                };
              });
            }
          }

          // Build appliedStep with evidence
          const updatedStep: IntentStep = {
            ...stepDraft,
            evidence: {
              ...stepDraft.evidence,
              confidence: aiCheckResult.confidence,
              resolutionMeta: {
                allowedCount: 1,
                usedRules: ['ai_check'],
                usedLLM: false,
                confidenceTier: (aiCheckResult.confidence || 0) >= 0.85 ? 'high' :
                                (aiCheckResult.confidence || 0) >= 0.6 ? 'medium' : 'low',
              },
            },
            // No compiled plan for ai_check (it's evaluated by LLM, not by locators)
          };

          return {
            success: aiCheckResult.pass,
            error: aiCheckResult.pass ? undefined : aiCheckResult.explanation,
            appliedStep: updatedStep,
            urlChanged: false,
            url: page.url(),
            highlight,
            attempts: 1,
          };
        } catch (error) {
          logger.error('[PREVIEW_APPLY] ai_check evaluation failed', {
            previewSessionId,
            error: error instanceof Error ? error.message : String(error),
          });

          return {
            success: false,
            error: `AI check failed: ${error instanceof Error ? error.message : String(error)}`,
            attempts: 0,
          };
        }
      }

      // V3: If user confirmed a selection, use it directly without re-linting
      if (selectedRef) {
        logger.info('[PREVIEW_APPLY] Using user-confirmed selectedRef', {
          previewSessionId,
          selectedRef,
        });

        const confirmedCandidate: LintCandidate = {
          ref: selectedRef,
          label: 'User confirmed',
          reason: 'User selected from clarification options',
          confidence: 1.0,
        };

        // V5: Capture URL BEFORE action for accurate compiled context
        const urlBeforeAction = page.url();
        
        const result = await executeAction(page, stepDraft, confirmedCandidate);

        if (result.success) {
          // V12: Post-action settle — skip in Run mode (lookahead handles it), keep for single-step
          if (!skipPostActionWait) {
            await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { });
          }

          // Invalidate snapshot cache for DOM-mutating actions so next step's lint gets fresh nodes
          if (DOM_MUTATING_ACTIONS.has(stepDraft.type)) {
            const sess = sessionService.getSession(previewSessionId);
            if (sess) sess.lastSnapshotEmit = 0;
          }

          // Try to get the node from current session for compiled plan
          const isOwned = sessionService.isSessionOwned(previewSessionId, userId);
          const session = isOwned ? sessionService.getSession(previewSessionId) : undefined;
          const resolvedNode = session?.pageState?.domNodes?.find(n => n.ref === selectedRef);

          // Generate compiled plan if node is available
          // Use urlBeforeAction to record the context where element was found
          let compiled;
          if (resolvedNode) {
            try {
              compiled = LocatorPlanBuilder.buildCompiledPlan({
                step: stepDraft,
                resolvedNode,
                pageUrl: urlBeforeAction,
                pageTitle: await page.title().catch(() => undefined),
              });
            } catch (compileError) {
              logger.warn('[PREVIEW_APPLY] Failed to generate compiled plan for user-confirmed selection', {
                error: compileError instanceof Error ? compileError.message : String(compileError),
              });
            }
          } else if (!isOwned) {
            logger.warn('[PREVIEW_APPLY] Skip compiled plan: session is not owned by user', {
              previewSessionId,
              userId,
            });
          }

          // Build resolution meta for user-confirmed selection
          const resolutionMeta: ResolutionMeta = {
            allowedCount: 1,
            usedRules: ['user_confirmed'],
            usedLLM: false,
            confidenceTier: 'high' as ConfidenceTier,
          };

          // V2: Auto-populate bindingHints from resolved node
          const enrichedBindingHints = resolvedNode
            ? { ...stepDraft.bindingHints, ...buildBindingHintsFromNode(resolvedNode) }
            : stepDraft.bindingHints;

          // Update step evidence with resolutionMeta and enriched bindingHints
          const updatedStep: IntentStep = {
            ...stepDraft,
            bindingHints: enrichedBindingHints,
            evidence: {
              ...stepDraft.evidence,
              lastSuccessRef: selectedRef,
              confidence: 1.0,
              resolutionMeta,
            },
            compiled, // NEW: compiled execution plan
          };

          return {
            success: true,
            appliedStep: updatedStep,
            urlChanged: result.urlChanged,
            url: page.url(),
            highlight: [{
              ref: selectedRef,
              type: 'success',
            }],
            attempts: 1,
          };
        }

        // If confirmed selection failed, return error (don't fallback to lint)
        return {
          success: false,
          error: result.error || 'Failed to apply user-confirmed element',
          highlight: [{
            ref: selectedRef,
            type: 'error',
          }],
          attempts: 1,
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V7: Try compiled locator plan first (if available) before lint
      // This is a fast path that avoids expensive AI/LLM resolution when we have
      // a cached, validated locator from a previous successful resolution
      // ═══════════════════════════════════════════════════════════════════════
      if (stepDraft.compiled && stepDraft.compiled.locatorPlan && stepDraft.compiled.locatorPlan.length > 0) {
        logger.debug('[PREVIEW_APPLY] Trying compiled locator plan before lint', {
          previewSessionId,
          stepId: stepDraft.id,
          locatorCount: stepDraft.compiled.locatorPlan.length,
          pageUrl: stepDraft.compiled.context?.pageUrl,
        });

        try {
          // Import and execute compiled plan
          const { executeCompiledLocatorPlan } = await import('@/agent/execution/compiled-locator-executor');
          
          const compiledResult = await executeCompiledLocatorPlan(
            page,
            stepDraft.compiled,
            stepDraft.type,
            5000 // 5s timeout
          );

          if (compiledResult.success && compiledResult.locator) {
            logger.info('[PREVIEW_APPLY] Compiled locator succeeded, skipping lint', {
              previewSessionId,
              stepId: stepDraft.id,
              strategy: compiledResult.usedStrategy,
            });

            // Build candidate from compiled result
            const compiledCandidate: LintCandidate = {
              ref: '', // Not needed for execution
              reason: `Compiled locator: ${compiledResult.usedStrategy}`,
              confidence: compiledResult.confidence || 0.9,
              label: '',
            };

            // Execute action with compiled locator
            const result = await executeAction(page, stepDraft, compiledCandidate, compiledResult.locator);

            if (result.success) {
              // V12: Post-action settle — skip in Run mode (lookahead handles it), keep for single-step
              if (!skipPostActionWait) {
                await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { });
              }

              // Invalidate snapshot cache for DOM-mutating actions so next step's lint gets fresh nodes
              if (DOM_MUTATING_ACTIONS.has(stepDraft.type)) {
                const sess = sessionService.getSession(previewSessionId);
                if (sess) sess.lastSnapshotEmit = 0;
              }

              // Build resolution meta for compiled success
              const resolutionMeta: ResolutionMeta = {
                allowedCount: 1,
                usedRules: ['compiled_plan'],
                usedLLM: false,
                confidenceTier: 'high' as ConfidenceTier,
              };

              // Update step with success evidence
              const updatedStep: IntentStep = {
                ...stepDraft,
                evidence: {
                  ...stepDraft.evidence,
                  lastSuccessRef: '', // Compiled doesn't use refs
                  confidence: compiledResult.confidence || 0.9,
                  resolutionMeta,
                },
              };

              return {
                success: true,
                appliedStep: updatedStep,
                urlChanged: result.urlChanged,
                url: page.url(),
                attempts: 1,
              };
            }
          }

          // Compiled failed or element not found - fallthrough to lint
          logger.debug('[PREVIEW_APPLY] Compiled locator failed, falling back to lint', {
            previewSessionId,
            stepId: stepDraft.id,
            reason: compiledResult.skipReason,
          });
        } catch (compiledError) {
          // Compiled execution threw - fallthrough to lint
          logger.debug('[PREVIEW_APPLY] Compiled execution error, falling back to lint', {
            previewSessionId,
            stepId: stepDraft.id,
            error: compiledError instanceof Error ? compiledError.message : String(compiledError),
          });
        }
      }

      // Normal flow: Lint the step to get candidates
      const lintResult = await IntentStepLintService.lintStepWithAI({
        previewSessionId,
        stepDraft,
        pageRef: params.pageRef,
        userId,
      });

      if (lintResult.status === 'needs_clarification') {
        return {
          success: false,
          error: lintResult.message || 'Please clarify which element to use',
          highlight: lintResult.highlight,
          attempts: 0,
        };
      }

      if (lintResult.status === 'error') {
        return {
          success: false,
          error: lintResult.message || 'Linting failed',
          highlight: [],
          attempts: 0,
        };
      }

      if (lintResult.status === 'not_found' || lintResult.candidates.length === 0) {
        // ═══════════════════════════════════════════════════════════════════
        // V11: Modal-aware "not found" — if a modal is open, the target may
        // be behind it. Inform the user so they can dismiss the modal first.
        // ═══════════════════════════════════════════════════════════════════
        const modalInfo = detectModalBlockingFromSession(previewSessionId, userId);
        if (modalInfo) {
          logger.info('[PREVIEW_APPLY] Element not found — modal/popup may be blocking', {
            previewSessionId,
            modalRef: modalInfo.modalRef,
            modalText: modalInfo.modalText?.slice(0, 80),
          });
          return {
            success: false,
            error: 'A popup/modal is currently open and may be blocking the target element. Dismiss it or interact with it first.',
            highlight: modalInfo.boundingBox ? [{
              boundingBox: modalInfo.boundingBox,
              type: 'warning' as const,
            }] : [],
            modalBlocking: modalInfo,
          };
        }

        return {
          success: false,
          error: lintResult.message || 'No matching elements found',
          highlight: [],
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // V11: Layer-aware execution — check if modal blocks the target element.
      // Like a real user: if a popup is open, you interact with its elements.
      // If your target is behind the popup, you must dismiss it first.
      // ═══════════════════════════════════════════════════════════════════════
      const resolvedCandidates = lintResult.candidates.slice(0, MAX_ATTEMPTS);
      const anyInsideModal = resolvedCandidates.some(c => c.node?.isInsideActiveModal === true);
      const modalDetected = detectModalBlockingFromSession(previewSessionId, userId);

      if (modalDetected && !anyInsideModal) {
        // Target element is NOT inside the modal — modal is blocking it.
        // Don't execute: inform the user.
        logger.info('[PREVIEW_APPLY] Modal blocking target — candidates are behind popup', {
          previewSessionId,
          modalRef: modalDetected.modalRef,
          candidateRefs: resolvedCandidates.map(c => c.ref).join(', '),
        });
        return {
          success: false,
          error: 'A popup/modal is blocking the target element. Dismiss it or interact with elements inside the popup first.',
          highlight: [
            // Highlight the modal itself as warning
            ...(modalDetected.boundingBox ? [{
              boundingBox: modalDetected.boundingBox,
              type: 'warning' as const,
            }] : []),
            // Highlight candidates as error (behind modal)
            ...resolvedCandidates.map(c => ({
              ref: c.ref,
              boundingBox: c.boundingBox,
              type: 'error' as const,
            })),
          ],
          modalBlocking: modalDetected,
          attempts: 0,
        };
      }
      // If target IS inside the modal (anyInsideModal=true) or no modal detected,
      // proceed normally — the user is working with the popup layer.

      // Try candidates in order (reuse resolvedCandidates from modal check above)
      let lastError: string | undefined;
      let attempts = 0;

      // V5: Capture URL BEFORE trying candidates for accurate compiled context
      // This URL represents the page state when elements were found by lint
      const urlBeforeAction = page.url();

      for (const candidate of resolvedCandidates) {
        attempts++;
        logger.debug('[PREVIEW_APPLY] Trying candidate', {
          attempt: attempts,
          ref: candidate.ref,
          confidence: candidate.confidence,
        });

        const result = await executeAction(page, stepDraft, candidate);

        if (result.success) {
          // V12: Post-action settle — skip in Run mode (lookahead handles it), keep for single-step
          if (!skipPostActionWait) {
            await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => { });
          }

          // Invalidate snapshot cache for DOM-mutating actions so next step's lint gets fresh nodes
          if (DOM_MUTATING_ACTIONS.has(stepDraft.type)) {
            const sess = sessionService.getSession(previewSessionId);
            if (sess) sess.lastSnapshotEmit = 0;
          }

          // V2: Post-action verification for state-aware actions
          let verified = false;
          const stateChange: ApplyResult['stateChange'] = undefined;

          if (STATE_VERIFIABLE_ACTIONS.has(stepDraft.type) && candidate.ref) {
            try {
              verified = await verifyActionEffect(page, stepDraft, candidate.ref);
              if (verified) {
                logger.debug('[PREVIEW_APPLY] Action verified', {
                  stepType: stepDraft.type,
                  candidateRef: candidate.ref,
                });
              }
            } catch (verifyError) {
              logger.warn('[PREVIEW_APPLY] Verification failed', {
                error: verifyError instanceof Error ? verifyError.message : String(verifyError),
              });
            }
          }

          // V3: Generate compiled plan from resolved node
          // Include pageSignature from session for staleness detection
          // Use urlBeforeAction to record the context where element was found
          let compiled;
          let pageSignature: string | undefined;
          if (candidate.node) {
            try {
              // Get pageSignature from session if available
              const session = sessionService.getSession(previewSessionId);
              pageSignature = session?.lastPageSignature;

              compiled = LocatorPlanBuilder.buildCompiledPlan({
                step: stepDraft,
                resolvedNode: candidate.node,
                pageUrl: urlBeforeAction,
                pageTitle: await page.title().catch(() => undefined),
                pageSignature,
              });
              logger.debug('[PREVIEW_APPLY] Compiled plan generated', {
                stepId: stepDraft.id,
                locatorCount: compiled.locatorPlan.length,
                hasPageSignature: !!pageSignature,
              });
            } catch (compileError) {
              logger.warn('[PREVIEW_APPLY] Failed to generate compiled plan', {
                error: compileError instanceof Error ? compileError.message : String(compileError),
              });
            }
          }

          // Build resolution meta from lint result
          // Determine confidence tier based on candidate confidence
          const confidenceTier: ConfidenceTier =
            candidate.confidence >= 0.85 ? 'high' :
            candidate.confidence >= 0.6 ? 'medium' : 'low';

          const resolutionMeta: ResolutionMeta = {
            allowedCount: lintResult.candidates.length,
            usedRules: [],
            usedLLM: !lintResult.degradedMode,
            confidenceTier,
            topSimilarity: lintResult.topSimilarity,
          };

          // V2: Auto-populate bindingHints from resolved node
          const enrichedBindingHints = candidate.node
            ? { ...stepDraft.bindingHints, ...buildBindingHintsFromNode(candidate.node) }
            : stepDraft.bindingHints;

          // Update step evidence with resolutionMeta and enriched bindingHints
          const updatedStep: IntentStep = {
            ...stepDraft,
            bindingHints: enrichedBindingHints,
            evidence: {
              ...stepDraft.evidence,
              lastSuccessRef: candidate.ref,
              confidence: candidate.confidence,
              resolutionMeta,
            },
            compiled, // NEW: compiled execution plan
          };

          return {
            success: true,
            appliedStep: updatedStep,
            urlChanged: result.urlChanged,
            url: page.url(),
            highlight: [{
              ref: candidate.ref,
              boundingBox: candidate.boundingBox,
              type: 'success',
            }],
            attempts,
            verified,
            stateChange,
          };
        }

        lastError = result.error;
      }

      // All attempts failed
      return {
        success: false,
        error: lastError || 'All candidates failed',
        highlight: resolvedCandidates.map(c => ({
          ref: c.ref,
          boundingBox: c.boundingBox,
          type: 'error' as const,
        })),
        attempts,
      };
    } catch (error) {
      logger.error('[PREVIEW_APPLY] Apply failed', {
        error: error instanceof Error ? error.message : String(error),
        previewSessionId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Apply failed',
      };
    }
  }
}
