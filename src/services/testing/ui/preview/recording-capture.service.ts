/**
 * Recording Capture Service
 * Transforms raw browser interactions (clicks, typing, key presses)
 * into IntentStep objects for the step editor.
 *
 * Stateless utility class — recording state lives in InternalSession.
 *
 * V10 changes:
 * - Fix #1: Shift+Enter in multiline elements appends \n to buffer instead of triggering pressEnter
 * - Fix #2: Double-click records as 'dblclick' action type
 * - Fix #3: Right-click records as 'contextmenu' action type
 * - Fix #4: Drag & Drop captured from mouse:down + mouse:up sequence
 * - Fix #5: File upload captured via filechooser event
 * - Fix #6: Iframe-aware probing (tries all frames when main frame returns null)
 * - Fix #8: Scroll step stores actual accumulated deltaY (not hardcoded)
 */

import { logger } from '@/utils/core/logger';
import { randomUUID } from 'crypto';
import type { Frame, Page } from 'playwright';
import { normalizeUrlForComparison } from './auto-wait-for.utils';
import type {
  BindingHints,
  ElementBoundingBox,
  IntentActionType,
} from './preview.types';
import type { PreviewIntentStep } from '@/websocket/types/types';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Element info returned from in-page probing */
export interface ProbedElement {
  tag: string;
  role?: string;
  type?: string;
  text?: string;
  ariaLabel?: string;
  labelText?: string;
  placeholder?: string;
  name?: string;
  ref?: string;
  checked?: boolean;
  ariaExpanded?: boolean;
  ariaPressed?: boolean;
  boundingBox?: ElementBoundingBox;
  /** True if element accepts multi-line text (textarea, contenteditable) */
  isMultiline?: boolean;
}

/** Typing buffer stored on session */
export interface RecordingTypingBuffer {
  text: string;
  elementRef?: string;
  /** Best label for the target element (ariaLabel, labelText, placeholder, etc.) */
  elementLabel: string;
  lastCharAt: number;
  bindingHints?: Record<string, string>;
  /** True if the focused element is multiline (textarea, contenteditable) */
  isMultiline?: boolean;
  /** URL where typing started (guards against cross-page ref collision) */
  pageUrl?: string;
}

/** Drag state tracked between mouse:down and mouse:up events */
export interface RecordingDragState {
  /** Starting X coordinate */
  startX: number;
  /** Starting Y coordinate */
  startY: number;
  /** Element probed at the drag start point */
  startElement: ProbedElement | null;
  /** Timestamp when drag started */
  startedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Keys that produce meaningful press steps */
const MEANINGFUL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

/** Keys that should flush the typing buffer when pressed */
const FLUSH_TRIGGER_KEYS = new Set(['Enter', 'Tab', 'Escape']);

/**
 * Minimum pixel distance between mouse:down and mouse:up to be considered a drag.
 * Anything less is treated as a click (handled by the click handler).
 */
const DRAG_DISTANCE_THRESHOLD = 10;

/** Generate a recording step ID */
function recStepId(): string {
  return `rec_${randomUUID().slice(0, 8)}`;
}

/**
 * In-page probe function body.
 * Runs inside the browser via page.evaluate — all DOM APIs are available there.
 * Extracted as a string to avoid TS errors about DOM types in Node context.
 *
 * V10: Added `isMultiline` detection for textarea and contenteditable elements.
 */
const PROBE_AT_POINT_FN = `
(function(px, py) {
  var el = document.elementFromPoint(px, py);
  if (!el) return null;

  var target = el;
  var interactiveTags = ['button', 'a', 'input', 'select', 'textarea'];
  var interactiveRoles = ['button', 'link', 'checkbox', 'tab', 'menuitem', 'combobox', 'switch'];
  var walk = el;
  for (var i = 0; i < 5 && walk; i++) {
    if (interactiveTags.indexOf(walk.tagName.toLowerCase()) !== -1) { target = walk; break; }
    var r = walk.getAttribute('role');
    if (r && interactiveRoles.indexOf(r) !== -1) { target = walk; break; }
    walk = walk.parentElement;
  }

  var tag = target.tagName.toLowerCase();
  var labelText = undefined;
  if (target.labels && target.labels.length > 0) {
    labelText = (target.labels[0].textContent || '').trim().slice(0, 100) || undefined;
  }
  if (!labelText) {
    var lby = target.getAttribute('aria-labelledby');
    if (lby) {
      var lel = document.getElementById(lby);
      if (lel) labelText = (lel.textContent || '').trim().slice(0, 100) || undefined;
    }
  }

  var rect = target.getBoundingClientRect();
  var ae = target.getAttribute('aria-expanded');
  var ap = target.getAttribute('aria-pressed');

  // Detect multiline: textarea, contenteditable, or role=textbox with aria-multiline
  var isMultiline = tag === 'textarea'
    || target.getAttribute('contenteditable') === 'true'
    || target.getAttribute('contenteditable') === ''
    || (target.getAttribute('role') === 'textbox' && target.getAttribute('aria-multiline') === 'true');

  return {
    tag: tag,
    role: target.getAttribute('role') || undefined,
    type: target.getAttribute('type') || undefined,
    text: (target.textContent || '').trim().slice(0, 80) || undefined,
    ariaLabel: target.getAttribute('aria-label') || undefined,
    labelText: labelText,
    placeholder: target.getAttribute('placeholder') || undefined,
    name: target.getAttribute('name') || undefined,
    ref: target.getAttribute('data-agent-ref') || undefined,
    checked: (tag === 'input' && (target.type === 'checkbox' || target.type === 'radio')) ? target.checked : undefined,
    ariaExpanded: ae === 'true' ? true : ae === 'false' ? false : undefined,
    ariaPressed: ap === 'true' ? true : ap === 'false' ? false : undefined,
    isMultiline: isMultiline || undefined,
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
})
`;

const PROBE_FOCUSED_FN = `
(function() {
  var el = document.activeElement;
  if (!el || el === document.body) return null;

  var target = el;
  var tag = target.tagName.toLowerCase();
  var labelText = undefined;
  if (target.labels && target.labels.length > 0) {
    labelText = (target.labels[0].textContent || '').trim().slice(0, 100) || undefined;
  }
  if (!labelText) {
    var lby = target.getAttribute('aria-labelledby');
    if (lby) {
      var lel = document.getElementById(lby);
      if (lel) labelText = (lel.textContent || '').trim().slice(0, 100) || undefined;
    }
  }

  var rect = target.getBoundingClientRect();
  var ae = target.getAttribute('aria-expanded');
  var ap = target.getAttribute('aria-pressed');

  // Detect multiline: textarea, contenteditable, or role=textbox with aria-multiline
  var isMultiline = tag === 'textarea'
    || target.getAttribute('contenteditable') === 'true'
    || target.getAttribute('contenteditable') === ''
    || (target.getAttribute('role') === 'textbox' && target.getAttribute('aria-multiline') === 'true');

  return {
    tag: tag,
    role: target.getAttribute('role') || undefined,
    type: target.getAttribute('type') || undefined,
    text: (target.textContent || '').trim().slice(0, 80) || undefined,
    ariaLabel: target.getAttribute('aria-label') || undefined,
    labelText: labelText,
    placeholder: target.getAttribute('placeholder') || undefined,
    name: target.getAttribute('name') || undefined,
    ref: target.getAttribute('data-agent-ref') || undefined,
    checked: (tag === 'input' && (target.type === 'checkbox' || target.type === 'radio')) ? target.checked : undefined,
    ariaExpanded: ae === 'true' ? true : ae === 'false' ? false : undefined,
    ariaPressed: ap === 'true' ? true : ap === 'false' ? false : undefined,
    isMultiline: isMultiline || undefined,
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
})
`;

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class RecordingCaptureService {

  // ─────────────────────────────────────────────────────────────────────────
  // ELEMENT PROBING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Probe element at (x, y) coordinates via page.evaluate.
   * Returns rich element info for recording.
   *
   * V10 Fix #6: If main frame returns null (click in iframe), try all child frames.
   * Translates coordinates from viewport-relative to frame-relative using frame bounding rect.
   */
  static async probeForRecording(page: Page, x: number, y: number): Promise<ProbedElement | null> {
    try {
      // Try main frame first (fast path)
      const result = await page.evaluate(`${PROBE_AT_POINT_FN}(${x}, ${y})`) as ProbedElement | null;
      if (result) return result;

      // Main frame returned null — check if click landed on an iframe
      return await this.probeInChildFrames(page, x, y);
    } catch (error) {
      logger.debug('[RECORDING] Probe at point failed', {
        x, y,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Try probing in child frames when main frame probe returns null.
   * Walks through all iframes on the page, checks if (x, y) is within the
   * iframe's bounding rect, then probes inside the frame with adjusted coordinates.
   */
  private static async probeInChildFrames(page: Page, x: number, y: number): Promise<ProbedElement | null> {
    try {
      // Get all iframe elements with their bounding rects
      const iframeRects = await page.evaluate(`
        (() => {
          var iframes = Array.from(document.querySelectorAll('iframe'));
          return iframes.map(function(iframe, index) {
            var rect = iframe.getBoundingClientRect();
            return { index: index, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          });
        })()
      `) as Array<{ index: number; x: number; y: number; width: number; height: number }>;

      // Find which iframe contains the point
      for (const rect of iframeRects) {
        if (x >= rect.x && x <= rect.x + rect.width &&
            y >= rect.y && y <= rect.y + rect.height) {
          // Point is inside this iframe — probe only the corresponding top-level child frame.
          const frame = page.mainFrame().childFrames()[rect.index];
          if (!frame) {
            continue;
          }

          try {
            // Translate viewport coords to frame-local coords
            const localX = x - rect.x;
            const localY = y - rect.y;
            const probed = await frame.evaluate(
              `${PROBE_AT_POINT_FN}(${localX}, ${localY})`
            ) as ProbedElement | null;

            if (probed) {
              // Adjust boundingBox back to viewport coordinates for highlighting
              if (probed.boundingBox) {
                probed.boundingBox.x += Math.round(rect.x);
                probed.boundingBox.y += Math.round(rect.y);
              }
              return probed;
            }
          } catch {
            // Frame may be cross-origin or detached — skip
          }
        }
      }
    } catch (error) {
      logger.debug('[RECORDING] Iframe probe failed (non-critical)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  /**
   * Probe the currently focused element (for typing target detection).
   *
   * V10 Fix #6: Also probes focused element in child frames if main frame returns null.
   */
  static async probeFocusedElement(page: Page): Promise<ProbedElement | null> {
    try {
      const result = await page.evaluate(`${PROBE_FOCUSED_FN}()`) as ProbedElement | null;
      if (result) return result;

      // Try child frames
      return await this.probeFocusedInChildFrames(page);
    } catch (error) {
      logger.debug('[RECORDING] Probe focused element failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Probe focused element in child frames.
   */
  private static async probeFocusedInChildFrames(page: Page): Promise<ProbedElement | null> {
    const childFrames = page.frames().filter(f => f !== page.mainFrame());
    for (const frame of childFrames) {
      try {
        const result = await frame.evaluate(`${PROBE_FOCUSED_FN}()`) as ProbedElement | null;
        if (result) return result;
      } catch {
        // Frame may be cross-origin or detached
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DESCRIPTION & HINTS BUILDING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extract the best human-readable label from a probed element.
   * Used for storing in typing buffer so description can be rebuilt later.
   */
  static getElementLabel(element: ProbedElement | null): string {
    if (!element) return 'element';
    return (
      element.ariaLabel
      || element.labelText
      || (element.tag === 'a' || element.tag === 'button' || element.role === 'button' || element.role === 'link'
        ? element.text
        : undefined)
      || element.placeholder
      || element.name
      || element.role
      || element.tag
    )?.slice(0, 60) || 'element';
  }

  /**
   * Build a human-readable description for a recorded step.
   * Priority: ariaLabel > labelText > text > placeholder > role+tag
   */
  static buildDescription(actionType: IntentActionType, element: ProbedElement | null, value?: string): string {
    if (!element) {
      if (actionType === 'navigate') return `Navigate to ${value || 'page'}`;
      if (actionType === 'scroll') return value || 'Scroll down';
      if (actionType === 'press') return `Press ${value || 'key'}`;
      if (actionType === 'drag_and_drop') return 'Drag and drop';
      if (actionType === 'upload') return `Upload file '${value || 'file'}'`;
      return `${actionType} element`;
    }

    // Determine the best label for the element
    const label = element.ariaLabel
      || element.labelText
      || (element.tag === 'a' || element.tag === 'button' || element.role === 'button' || element.role === 'link'
        ? element.text
        : undefined)
      || element.placeholder
      || element.name
      || element.role
      || element.tag;

    const shortLabel = label ? label.slice(0, 60) : 'element';

    switch (actionType) {
      case 'click':
        return `Click '${shortLabel}'`;
      case 'dblclick':
        return `Double-click '${shortLabel}'`;
      case 'contextmenu':
        return `Right-click '${shortLabel}'`;
      case 'type':
        return value
          ? `Type '${value.slice(0, 40)}' in '${shortLabel}'`
          : `Type in '${shortLabel}'`;
      case 'check':
        return `Check '${shortLabel}'`;
      case 'uncheck':
        return `Uncheck '${shortLabel}'`;
      case 'open':
        return `Open '${shortLabel}'`;
      case 'close':
        return `Close '${shortLabel}'`;
      case 'toggle':
        return `Toggle '${shortLabel}'`;
      case 'select':
        return value
          ? `Select '${value.slice(0, 40)}' in '${shortLabel}'`
          : `Select in '${shortLabel}'`;
      case 'press':
        return `Press ${value || 'key'}`;
      case 'scroll':
        return value || 'Scroll down';
      case 'navigate':
        return `Navigate to ${value || 'page'}`;
      case 'drag_and_drop':
        return `Drag '${shortLabel}'`;
      case 'upload':
        return `Upload file to '${shortLabel}'`;
      default:
        return `${actionType} '${shortLabel}'`;
    }
  }

  /**
   * Build BindingHints from a probed element.
   */
  static buildBindingHints(element: ProbedElement): BindingHints {
    const hints: BindingHints = {};
    if (element.role) hints.role = element.role;
    if (element.labelText) hints.label = element.labelText;
    if (element.placeholder) hints.placeholder = element.placeholder;
    if (element.ariaLabel) hints.nearText = element.ariaLabel;
    if (element.type) hints.type = element.type;
    if (element.name) hints.autocomplete = element.name;
    return hints;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ACTION TYPE INFERENCE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Infer the IntentActionType from a raw click event + element state.
   * elementBefore = state at time of click (before the click takes effect).
   *
   * V10: Also handles dblclick and contextmenu (right-click) via optional params.
   *
   * @param elementBefore - Element state before the click
   * @param clickCount - 1 for single click, 2 for double click
   * @param button - 'left', 'right', or 'middle'
   */
  static inferClickActionType(
    elementBefore: ProbedElement,
    clickCount = 1,
    button: 'left' | 'right' | 'middle' = 'left',
  ): IntentActionType {
    // Right-click → contextmenu
    if (button === 'right') return 'contextmenu';

    // Double-click → dblclick
    if (clickCount >= 2) return 'dblclick';

    const tag = elementBefore.tag;
    const type = elementBefore.type;

    // Checkbox: check/uncheck based on current (pre-click) checked state
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      return elementBefore.checked ? 'uncheck' : 'check';
    }

    // Expandable: open/close based on aria-expanded
    if (elementBefore.ariaExpanded === false) return 'open';
    if (elementBefore.ariaExpanded === true) return 'close';

    // Toggle: aria-pressed
    if (elementBefore.ariaPressed === false || elementBefore.ariaPressed === true) return 'toggle';

    return 'click';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP CAPTURE METHODS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Capture a key press as an IntentStep.
   * Returns null for modifier-only or non-meaningful keys.
   */
  static capturePress(key: string, modifiers?: string[]): PreviewIntentStep | null {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;
    if (!MEANINGFUL_KEYS.has(key)) return null;

    const keyLabel = modifiers && modifiers.length > 0
      ? `${modifiers.join('+')}+${key}`
      : key;

    return {
      id: recStepId(),
      type: 'press',
      description: `Press ${keyLabel}`,
    };
  }

  /**
   * Check if a key should trigger flushing the typing buffer.
   *
   * V10 Fix #1: Shift+Enter in a multiline element should NOT trigger flush.
   * Instead, it should be treated as a newline character appended to the buffer.
   *
   * @param key - The key that was pressed
   * @param modifiers - Active modifier keys (Shift, Control, etc.)
   * @param isMultiline - True if the focused element is multiline (textarea/contenteditable)
   */
  static shouldFlushOnKey(
    key: string,
    modifiers?: string[],
    isMultiline?: boolean,
  ): boolean {
    if (!FLUSH_TRIGGER_KEYS.has(key)) return false;

    // Shift+Enter in a multiline element = newline, NOT flush/submit
    if (key === 'Enter' && isMultiline && modifiers?.includes('Shift')) {
      return false;
    }

    return true;
  }

  /**
   * V10 Fix #1: Check if a key press should insert a newline into the typing buffer.
   * Shift+Enter in textarea/contenteditable = newline character.
   */
  static isNewlineInsertion(
    key: string,
    modifiers?: string[],
    isMultiline?: boolean,
  ): boolean {
    return key === 'Enter' && !!isMultiline && !!modifiers?.includes('Shift');
  }

  /**
   * Capture a URL navigation as a wait_for IntentStep.
   * Returns null if URLs are effectively the same.
   */
  static captureNavigation(currentUrl: string, previousUrl: string): PreviewIntentStep | null {
    if (normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(previousUrl)) {
      return null;
    }

    return {
      id: recStepId(),
      type: 'wait_for',
      description: 'Auto: wait for URL change',
      options: {
        urlMatcher: {
          changedFrom: previousUrl,
          timeoutMs: 15000,
        },
      },
    };
  }

  /**
   * Capture a native <select> change as an IntentStep.
   */
  static captureSelectChange(params: {
    label: string;
    selectedText: string;
    selectedValue: string;
  }): PreviewIntentStep {
    const { label, selectedText, selectedValue } = params;
    return {
      id: recStepId(),
      type: 'select',
      description: this.buildDescription('select', { tag: 'select', labelText: label } as ProbedElement, selectedText),
      value: selectedValue,
    };
  }

  /**
   * V10 Fix #4: Capture a drag-and-drop operation as an IntentStep.
   * Called when mouse:up is detected after mouse:down with sufficient distance.
   *
   * @param dragState - The drag start state (from mouse:down)
   * @param endX - End X coordinate
   * @param endY - End Y coordinate
   * @param endElement - Element probed at the drop target
   */
  static captureDragAndDrop(
    dragState: RecordingDragState,
    endX: number,
    endY: number,
    endElement: ProbedElement | null,
  ): PreviewIntentStep | null {
    const distance = Math.sqrt(
      Math.pow(endX - dragState.startX, 2) + Math.pow(endY - dragState.startY, 2),
    );

    // Below threshold → not a drag (it's a click, handled by click handler)
    if (distance < DRAG_DISTANCE_THRESHOLD) return null;

    const fromLabel = this.getElementLabel(dragState.startElement);
    const toLabel = this.getElementLabel(endElement);
    const description = fromLabel !== toLabel
      ? `Drag '${fromLabel}' to '${toLabel}'`
      : `Drag '${fromLabel}'`;

    const startRef = dragState.startElement?.ref;
    return {
      id: recStepId(),
      type: 'drag_and_drop',
      description,
      value: JSON.stringify({
        from: { x: Math.round(dragState.startX), y: Math.round(dragState.startY) },
        to: { x: Math.round(endX), y: Math.round(endY) },
      }),
      bindingHints: dragState.startElement
        ? this.buildBindingHints(dragState.startElement) as BindingHints | undefined
        : undefined,
      ...(startRef && {
        evidence: { lastSuccessRef: startRef, confidence: 1.0 },
      }),
    };
  }

  /**
   * V10 Fix #5: Capture a file upload (from filechooser event) as an IntentStep.
   *
   * @param filePaths - Array of file paths that were selected
   * @param element - The input element that triggered the file chooser (if probed)
   */
  static captureFileUpload(
    filePaths: string[],
    element: ProbedElement | null,
  ): PreviewIntentStep | null {
    if (!filePaths || filePaths.length === 0) return null;

    // Extract just filenames from paths for display
    const fileNames = filePaths.map(fp => {
      const parts = fp.split(/[/\\]/);
      return parts[parts.length - 1] || fp;
    });

    const description = this.buildDescription('upload', element, fileNames.join(', '));

    return {
      id: recStepId(),
      type: 'upload',
      description,
      value: fileNames[0],
      bindingHints: element ? this.buildBindingHints(element) as BindingHints | undefined : undefined,
      ...(element?.ref && {
        evidence: { lastSuccessRef: element.ref, confidence: 1.0 },
      }),
    };
  }

  /**
   * V10 Fix #8: Capture a scroll step with actual delta value.
   *
   * @param accumulatedDeltaY - Total pixels scrolled during the debounce window
   */
  static captureScroll(accumulatedDeltaY: number): PreviewIntentStep | null {
    if (accumulatedDeltaY === 0) return null;

    const direction = accumulatedDeltaY > 0 ? 'down' : 'up';
    const absDelta = Math.abs(Math.round(accumulatedDeltaY));

    return {
      id: recStepId(),
      type: 'scroll',
      description: `Scroll ${direction} ${absDelta}px`,
      // Store the actual delta as value so replay can use it
      value: String(Math.round(accumulatedDeltaY)),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TYPING DEBOUNCE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Flush the typing buffer into an IntentStep.
   * Returns null if buffer is empty.
   * Rebuilds description with final accumulated text using stored element label.
   *
   * @param triggeredByEnter - When true, the flush was triggered by the Enter key.
   *   In that case, merge type + Enter into a single step with `pressEnter: true`
   *   instead of creating two separate steps (type + press Enter).
   *   This avoids double-Enter during replay and keeps the step list clean.
   */
  static flushTypingBuffer(
    buffer: RecordingTypingBuffer | null,
    triggeredByEnter = false,
  ): PreviewIntentStep | null {
    if (!buffer || !buffer.text) return null;

    const label = buffer.elementLabel || 'element';
    const textPreview = buffer.text.slice(0, 40);
    const description = triggeredByEnter
      ? `Type '${textPreview}' in '${label}' and press Enter`
      : `Type '${textPreview}' in '${label}'`;

    return {
      id: recStepId(),
      type: 'type',
      description,
      value: buffer.text,
      bindingHints: buffer.bindingHints as BindingHints | undefined,
      ...(triggeredByEnter && {
        options: { pressEnter: true },
      }),
      ...(buffer.elementRef && {
        evidence: { lastSuccessRef: buffer.elementRef, confidence: 1.0, pageUrl: buffer.pageUrl },
      }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SELECT CHANGE LISTENER INJECTION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Inject a <select> change listener into the page.
   * Uses event delegation on document — works for dynamically added selects.
   */
  static async injectSelectChangeListener(
    page: Page,
    callbackName: string,
  ): Promise<void> {
    try {
      // @ts-ignore - browser context code
      await page.evaluate((cbName: string) => {
        // @ts-ignore
        if (window.__qai_select_injected) return;
        // @ts-ignore
        window.__qai_select_injected = true;

        // @ts-ignore
        const handler = (e) => {
          const select = e.target;
          if (!select || select.tagName?.toLowerCase() !== 'select') return;

          let label = '';
          if (select.labels && select.labels.length > 0) {
            label = (select.labels[0].textContent || '').trim();
          }
          if (!label) {
            label = select.getAttribute('aria-label') || select.getAttribute('name') || '';
          }

          const selectedOption = select.options[select.selectedIndex];
          const text = selectedOption?.text || '';
          const value = select.value;

          // @ts-ignore
          if (window[cbName]) window[cbName]({ label, text, value });
        };

        // @ts-ignore
        document.addEventListener('change', handler, true);
        // @ts-ignore
        window.__qai_select_handler = handler;
      }, callbackName);
    } catch (error) {
      logger.debug('[RECORDING] Failed to inject select listener', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove the injected <select> change listener.
   */
  static async removeSelectChangeListener(page: Page): Promise<void> {
    try {
      // @ts-ignore - browser context code
      await page.evaluate(() => {
        // @ts-ignore
        const handler = window.__qai_select_handler;
        if (handler) {
          // @ts-ignore
          document.removeEventListener('change', handler, true);
          // @ts-ignore
          delete window.__qai_select_handler;
          // @ts-ignore
          delete window.__qai_select_injected;
        }
      });
    } catch {
      // Page may already be closed
    }
  }
}
