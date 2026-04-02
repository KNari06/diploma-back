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
// V15: generateText imported lazily inside resolveInteractiveTarget() to avoid loading AI pipeline on service init
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
  /** Nearest heading/landmark text — provides container context for multi-page AI lint */
  containerText?: string;
  /** V13: CSS selector of the iframe containing this element (set when element is inside an iframe) */
  iframeSelector?: string;
  /** V14: Marker — element is inside a cross-origin iframe and cannot be probed/recorded */
  crossOriginIframe?: boolean;
  /** V15: How the interactive target was resolved from the click point */
  resolvedVia?: 'nativeTag' | 'ariaRole' | 'behavioral' | 'cssClass' | 'cursorPointer' | 'directHit' | 'llm';
  /** V15: Ancestor chain from directHit to body — transient, used for server-side LLM fallback, NOT saved to DB */
  ancestorChain?: Array<{
    tag: string;
    role?: string;
    text?: string;
    ariaLabel?: string;
    className?: string;
  }>;
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
  /** V13: CSS selector of iframe containing the focused element */
  iframeSelector?: string;
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
  /** V14: Viewport dimensions at recording time for coordinate normalization */
  viewport?: { width: number; height: number };
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

  // ── Pass 1: Collect ancestor chain (up to 12 ancestors) ──────────────
  var INTERACTIVE_TAGS = ['button', 'a', 'input', 'select', 'textarea', 'summary'];
  var WIDGET_ROLES = [
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'switch',
    'combobox', 'slider', 'spinbutton', 'treeitem', 'gridcell',
    'searchbox', 'textbox'
  ];
  var FRAMEWORK_ATTRS = ['ng-click', 'v-on:click', 'x-on:click', 'on:click'];
  var BTN_CLASS_RE = /\\b(btn|button|clickable|toggle-btn|action-btn)\\b/i;

  var chain = [];
  var walk = el;
  for (var i = 0; i < 12 && walk && walk !== document.body; i++) {
    var wtag = walk.tagName.toLowerCase();
    var wrole = walk.getAttribute('role');
    var wclass = (walk.getAttribute('class') || '').slice(0, 120);
    var hasTabindex = walk.hasAttribute('tabindex') && walk.getAttribute('tabindex') !== '-1';
    var hasOnclick = walk.hasAttribute('onclick');
    var hasDraggable = walk.getAttribute('draggable') === 'true';
    // V18: contenteditable detection
    var isContentEditable = walk.getAttribute('contenteditable') === 'true'
      || walk.getAttribute('contenteditable') === '';
    // Check (click) — Angular/Vue/Svelte/Alpine bindings
    var hasFrameworkClick = false;
    // V18: React onClick detection via __reactProps$ (React attaches props to DOM nodes)
    var hasReactClick = false;
    try {
      var attrs = walk.attributes;
      for (var ai = 0; ai < attrs.length; ai++) {
        var aname = attrs[ai].name;
        if (aname === '(click)' || aname.indexOf('@click') === 0 || FRAMEWORK_ATTRS.indexOf(aname) !== -1) {
          hasFrameworkClick = true;
          break;
        }
      }
    } catch(e) {}
    // V18: React synthetic event detection — check __reactProps$ for onClick handler.
    // React attaches __reactProps$<hash> to DOM nodes with component props including event handlers.
    if (!hasFrameworkClick && !hasOnclick) {
      try {
        var ownKeys = Object.keys(walk);
        for (var ki = 0; ki < ownKeys.length; ki++) {
          if (ownKeys[ki].indexOf('__reactProps$') === 0) {
            var rp = walk[ownKeys[ki]];
            if (rp && (typeof rp.onClick === 'function' || typeof rp.onClickCapture === 'function')) {
              hasReactClick = true;
            }
            break; // Only one __reactProps$ key per element
          }
        }
      } catch(e) {}
    }

    chain.push({
      el: walk,
      tag: wtag,
      role: wrole,
      className: wclass,
      hasTabindex: hasTabindex,
      hasOnclick: hasOnclick,
      hasFrameworkBinding: hasFrameworkClick,
      hasReactClick: hasReactClick,
      hasDraggable: hasDraggable,
      isContentEditable: isContentEditable,
      text: (walk.textContent || '').trim().slice(0, 80),
      ariaLabel: walk.getAttribute('aria-label') || ''
    });
    walk = walk.parentElement;
  }

  // ── Pass 2: Pick best interactive target from chain ──────────────────
  var target = el;
  var resolvedVia = 'directHit';
  var cssCandidateIdx = -1;

  for (var ci = 0; ci < chain.length; ci++) {
    var node = chain[ci];
    // Priority 1: Native interactive tags
    if (INTERACTIVE_TAGS.indexOf(node.tag) !== -1) {
      target = node.el;
      resolvedVia = 'nativeTag';
      break;
    }
    // Priority 2: ARIA widget roles
    if (node.role && WIDGET_ROLES.indexOf(node.role) !== -1) {
      target = node.el;
      resolvedVia = 'ariaRole';
      break;
    }
    // Priority 3: Behavioral (tabindex, onclick, framework bindings, React onClick)
    if (node.hasTabindex || node.hasOnclick || node.hasFrameworkBinding || node.hasReactClick) {
      target = node.el;
      resolvedVia = 'behavioral';
      break;
    }
    // Priority 3.5: draggable or contenteditable
    if (node.hasDraggable || node.isContentEditable) {
      target = node.el;
      resolvedVia = 'behavioral';
      break;
    }
    // Priority 4: CSS class heuristic (remember first candidate, keep looking)
    if (cssCandidateIdx === -1 && node.className && BTN_CLASS_RE.test(node.className)) {
      cssCandidateIdx = ci;
    }
  }

  // If no strong match, use CSS class candidate
  if (resolvedVia === 'directHit' && cssCandidateIdx !== -1) {
    target = chain[cssCandidateIdx].el;
    resolvedVia = 'cssClass';
  }

  // Priority 5: cursor:pointer on direct hit (single getComputedStyle call)
  if (resolvedVia === 'directHit') {
    try {
      var cursor = getComputedStyle(el).cursor;
      if (cursor === 'pointer') {
        // Walk up to find the highest ancestor with cursor:pointer
        // (the actual interactive container, not just an inherited child)
        for (var pi = 0; pi < chain.length; pi++) {
          try {
            if (getComputedStyle(chain[pi].el).cursor !== 'pointer') {
              // Previous element was the last one with cursor:pointer
              if (pi > 0) {
                target = chain[pi - 1].el;
                resolvedVia = 'cursorPointer';
              }
              break;
            }
          } catch(e) { break; }
        }
        // If ALL chain elements have cursor:pointer (e.g., global * { cursor: pointer }),
        // cursor gives no signal — leave as directHit so LLM fallback can decide
        // (target stays as el, resolvedVia stays as 'directHit')
      }
    } catch(e) {}
  }

  // ── Collect data from chosen target ──────────────────────────────────
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

  // V11: Collect nearest heading/landmark for container context
  var containerText = undefined;
  var walk2 = target.parentElement;
  for (var j = 0; j < 8 && walk2; j++) {
    var heading = walk2.querySelector('h1,h2,h3,h4,[role="heading"]');
    if (heading) {
      containerText = (heading.textContent || '').trim().slice(0, 60) || undefined;
      break;
    }
    walk2 = walk2.parentElement;
  }

  // V15: Build ancestor chain summary for server-side LLM fallback (transient, not saved to DB)
  var ancestorChain = [];
  for (var aci = 0; aci < chain.length; aci++) {
    var ac = chain[aci];
    ancestorChain.push({
      tag: ac.tag,
      role: ac.role || undefined,
      text: ac.text ? ac.text.slice(0, 50) : undefined,
      ariaLabel: ac.ariaLabel || undefined,
      className: ac.className ? ac.className.split(' ').slice(0, 3).join(' ') : undefined
    });
  }

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
    containerText: containerText,
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    resolvedVia: resolvedVia,
    ancestorChain: resolvedVia === 'directHit' || resolvedVia === 'cssClass' ? ancestorChain : undefined
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

  // V11: Collect nearest heading/landmark for container context (multi-page AI lint)
  var containerText = undefined;
  var walk2 = target.parentElement;
  for (var j = 0; j < 8 && walk2; j++) {
    var heading = walk2.querySelector('h1,h2,h3,h4,[role="heading"]');
    if (heading) {
      containerText = (heading.textContent || '').trim().slice(0, 60) || undefined;
      break;
    }
    walk2 = walk2.parentElement;
  }

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
    containerText: containerText,
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
      // V13: Get all iframe elements with bounding rects AND a CSS selector for each
      const iframeRects = await page.evaluate(`
        (() => {
          var iframes = Array.from(document.querySelectorAll('iframe'));
          return iframes.map(function(iframe, index) {
            var rect = iframe.getBoundingClientRect();
            // Build a CSS selector for this iframe (id > name > title > nth-of-type)
            var sel = '';
            if (iframe.id) {
              sel = 'iframe#' + iframe.id;
            } else if (iframe.getAttribute('name')) {
              sel = 'iframe[name="' + iframe.getAttribute('name') + '"]';
            } else if (iframe.getAttribute('title')) {
              sel = 'iframe[title="' + iframe.getAttribute('title') + '"]';
            } else if (iframe.getAttribute('src')) {
              // Use a short src substring to identify (avoid query params)
              var src = iframe.getAttribute('src') || '';
              var pathname = src.split('?')[0].split('#')[0];
              if (pathname.length > 0 && pathname.length < 200) {
                sel = 'iframe[src*="' + pathname.replace(/"/g, '') + '"]';
              }
            }
            if (!sel) {
              // Fallback: nth-of-type
              var parent = iframe.parentElement;
              var siblings = parent ? Array.from(parent.querySelectorAll(':scope > iframe')) : [];
              var nth = siblings.indexOf(iframe) + 1;
              sel = 'iframe:nth-of-type(' + nth + ')';
            }
            return { index: index, x: rect.x, y: rect.y, width: rect.width, height: rect.height, selector: sel };
          });
        })()
      `) as Array<{ index: number; x: number; y: number; width: number; height: number; selector: string }>;

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
              // V13: Store iframe CSS selector so replay can scope to the correct iframe
              probed.iframeSelector = rect.selector;
              return probed;
            }
          } catch (frameErr) {
            // V14: Log cross-origin iframe detection so the handler can warn the user
            logger.warn('[RECORDING] Cross-origin iframe detected — element inside cannot be recorded', {
              iframeSelector: rect.selector,
              error: frameErr instanceof Error ? frameErr.message : String(frameErr),
            });
            // Return a minimal marker — caller checks crossOriginIframe before using other fields
            return { tag: 'iframe', crossOriginIframe: true, iframeSelector: rect.selector };
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
   * V13: Also captures iframe CSS selector when element is found.
   */
  private static async probeFocusedInChildFrames(page: Page): Promise<ProbedElement | null> {
    // V13: Get iframe selectors from the page to attach to the result
    let iframeSelectors: string[] = [];
    try {
      iframeSelectors = await page.evaluate(`
        (() => {
          var iframes = Array.from(document.querySelectorAll('iframe'));
          return iframes.map(function(iframe) {
            if (iframe.id) return 'iframe#' + iframe.id;
            if (iframe.getAttribute('name')) return 'iframe[name="' + iframe.getAttribute('name') + '"]';
            if (iframe.getAttribute('title')) return 'iframe[title="' + iframe.getAttribute('title') + '"]';
            var src = iframe.getAttribute('src') || '';
            var pathname = src.split('?')[0].split('#')[0];
            if (pathname.length > 0 && pathname.length < 200) return 'iframe[src*="' + pathname.replace(/"/g, '') + '"]';
            var parent = iframe.parentElement;
            var siblings = parent ? Array.from(parent.querySelectorAll(':scope > iframe')) : [];
            return 'iframe:nth-of-type(' + (siblings.indexOf(iframe) + 1) + ')';
          });
        })()
      `) as string[];
    } catch { /* non-critical */ }

    const childFrames = page.mainFrame().childFrames();
    for (let i = 0; i < childFrames.length; i++) {
      const frame = childFrames[i];
      try {
        const result = await frame.evaluate(`${PROBE_FOCUSED_FN}()`) as ProbedElement | null;
        if (result) {
          result.iframeSelector = iframeSelectors[i] || undefined;
          return result;
        }
      } catch {
        // Frame may be cross-origin or detached
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LLM FALLBACK FOR INTERACTIVE ELEMENT RESOLUTION (V15)
  // ─────────────────────────────────────────────────────────────────────────

  /** In-memory cache for LLM decisions — keyed by structural pattern, value = chain index */
  private static llmResolutionCache = new Map<string, number>();

  /**
   * V15: When probe returns resolvedVia='directHit' or 'cssClass' (low confidence),
   * ask LLM to pick the correct interactive element from the ancestor chain.
   *
   * Flow:
   *   1. Check cache by structural pattern → instant if cached
   *   2. LLM call (fast model, ~100 tokens) → returns index into ancestorChain
   *   3. Re-probe the chosen ancestor for full ProbedElement data
   *   4. Cache the result for future similar patterns
   *
   * @param page - Playwright page to re-probe the chosen element
   * @param probed - Original probe result with ancestorChain
   * @param x - Click x coordinate (for re-probing the chosen ancestor)
   * @param y - Click y coordinate
   * @returns Updated ProbedElement with resolvedVia='llm', or original if LLM fails
   */
  static async resolveInteractiveTarget(
    page: Page,
    probed: ProbedElement,
    x: number,
    y: number,
  ): Promise<ProbedElement> {
    const chain = probed.ancestorChain;
    if (!chain || chain.length === 0) return probed;

    // Build cache key from structural pattern (tag.firstClass chain)
    const cacheKey = chain
      .slice(0, 4)
      .map(n => `${n.tag}${n.className ? '.' + n.className.split(' ')[0] : ''}`)
      .join('|');

    // 1. Check cache
    const cachedIndex = this.llmResolutionCache.get(cacheKey);
    if (cachedIndex !== undefined && cachedIndex < chain.length) {
      logger.debug('[RECORDING] LLM resolution cache hit', { cacheKey, index: cachedIndex });
      return await this.reprobeAtAncestorIndex(page, x, y, probed, cachedIndex);
    }

    // 2. LLM call
    try {
      const chainDescription = chain.map((n, i) =>
        `[${i}] <${n.tag}>${n.role ? ` role="${n.role}"` : ''}${n.ariaLabel ? ` aria-label="${n.ariaLabel}"` : ''}${n.className ? ` class="${n.className}"` : ''}${n.text ? ` text="${n.text.slice(0, 30)}"` : ''}`,
      ).join('\n');

      const prompt = `Given this DOM ancestor chain from a click point (index 0 = element under cursor, higher indices = parents), which element is the interactive control the user intended to click?

${chainDescription}

Return ONLY the index number (e.g., "2"). Pick the closest ancestor that is an interactive control (button, link, menu item, etc). If index 0 is already the correct interactive element, return "0".`;

      const { generateText } = await import('@/services/ai/core/ai-provider.service');
      const response = await generateText({
        prompt,
        task: 'fast',
        temperature: 0,
        maxTokens: 10,
        timeout: 2000,
      });

      const indexStr = response.content.trim().replace(/[^0-9]/g, '');
      const index = parseInt(indexStr, 10);

      if (isNaN(index) || index < 0 || index >= chain.length) {
        logger.debug('[RECORDING] LLM returned invalid index', { response: response.content, chainLength: chain.length });
        return probed;
      }

      // 3. Cache result
      this.llmResolutionCache.set(cacheKey, index);
      // Cap cache size
      if (this.llmResolutionCache.size > 200) {
        const firstKey = this.llmResolutionCache.keys().next().value;
        if (firstKey) this.llmResolutionCache.delete(firstKey);
      }

      logger.debug('[RECORDING] LLM resolved interactive target', { cacheKey, index, tag: chain[index].tag });

      // 4. Re-probe at the chosen ancestor
      if (index === 0) {
        // LLM confirmed directHit is correct
        probed.resolvedVia = 'llm';
        return probed;
      }

      return await this.reprobeAtAncestorIndex(page, x, y, probed, index);
    } catch (error) {
      logger.debug('[RECORDING] LLM resolution failed, using original probe', {
        error: error instanceof Error ? error.message : String(error),
      });
      return probed;
    }
  }

  /**
   * V15: Re-probe a specific ancestor from the chain to get full ProbedElement data.
   * Uses page.evaluate to walk from elementFromPoint up N levels and collect data.
   */
  private static async reprobeAtAncestorIndex(
    page: Page,
    x: number,
    y: number,
    original: ProbedElement,
    ancestorIndex: number,
  ): Promise<ProbedElement> {
    try {
      const result = await page.evaluate(`
        (function(px, py, idx) {
          var el = document.elementFromPoint(px, py);
          if (!el) return null;
          var walk = el;
          for (var i = 0; i < idx && walk && walk.parentElement; i++) {
            walk = walk.parentElement;
          }
          if (!walk || walk === document.body) return null;
          var tag = walk.tagName.toLowerCase();
          var labelText = undefined;
          if (walk.labels && walk.labels.length > 0) {
            labelText = (walk.labels[0].textContent || '').trim().slice(0, 100) || undefined;
          }
          if (!labelText) {
            var lby = walk.getAttribute('aria-labelledby');
            if (lby) {
              var lel = document.getElementById(lby);
              if (lel) labelText = (lel.textContent || '').trim().slice(0, 100) || undefined;
            }
          }
          var rect = walk.getBoundingClientRect();
          var ae = walk.getAttribute('aria-expanded');
          var ap = walk.getAttribute('aria-pressed');
          var isMultiline = tag === 'textarea'
            || walk.getAttribute('contenteditable') === 'true'
            || walk.getAttribute('contenteditable') === ''
            || (walk.getAttribute('role') === 'textbox' && walk.getAttribute('aria-multiline') === 'true');
          return {
            tag: tag,
            role: walk.getAttribute('role') || undefined,
            type: walk.getAttribute('type') || undefined,
            text: (walk.textContent || '').trim().slice(0, 80) || undefined,
            ariaLabel: walk.getAttribute('aria-label') || undefined,
            labelText: labelText,
            placeholder: walk.getAttribute('placeholder') || undefined,
            name: walk.getAttribute('name') || undefined,
            ref: walk.getAttribute('data-agent-ref') || undefined,
            checked: (tag === 'input' && (walk.type === 'checkbox' || walk.type === 'radio')) ? walk.checked : undefined,
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
        })(${x}, ${y}, ${ancestorIndex})
      `) as ProbedElement | null;

      if (!result) return original;

      // V15: Verify that reprobe found the expected element (DOM may have changed after click)
      const expectedTag = original.ancestorChain?.[ancestorIndex]?.tag;
      if (expectedTag && result.tag !== expectedTag) {
        logger.debug('[RECORDING] Reprobe tag mismatch (DOM changed?), using original', {
          expected: expectedTag, got: result.tag,
        });
        return original;
      }

      // Preserve iframe/container context from original probe
      result.iframeSelector = original.iframeSelector;
      result.containerText = original.containerText;
      result.resolvedVia = 'llm';
      return result;
    } catch {
      return original;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DESCRIPTION & HINTS BUILDING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Tags and roles whose textContent is a meaningful label for the element.
   * V15: Expanded from just a/button to all interactive widget roles.
   */
  private static TEXT_LABEL_TAGS = new Set(['a', 'button', 'summary', 'th', 'label', 'legend']);
  private static TEXT_LABEL_ROLES = new Set([
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'treeitem',
  ]);

  static getElementLabel(element: ProbedElement | null): string {
    if (!element) return 'element';
    return (
      element.ariaLabel
      || element.labelText
      || (this.TEXT_LABEL_TAGS.has(element.tag) || (element.role && this.TEXT_LABEL_ROLES.has(element.role))
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

    // Determine the best label for the element (V15: reuse TEXT_LABEL_TAGS/ROLES for consistency)
    const label = element.ariaLabel
      || element.labelText
      || (this.TEXT_LABEL_TAGS.has(element.tag) || (element.role && this.TEXT_LABEL_ROLES.has(element.role))
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
    // V11: Use containerText as nearText fallback for multi-page context
    if (element.containerText && !hints.nearText) hints.nearText = element.containerText;
    if (element.type) hints.type = element.type;
    if (element.name) hints.autocomplete = element.name;
    // V15: Add text content and tag for better LLM resolution at replay time
    if (element.text) hints.text = element.text;
    if (element.tag) hints.tag = element.tag;
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
    pageUrl?: string;
    name?: string;
    id?: string;
    ariaLabel?: string;
    role?: string;
  }): PreviewIntentStep {
    const { label, selectedText, selectedValue, pageUrl, name, id, ariaLabel, role } = params;

    // V13: Build bindingHints from captured select metadata
    const hints: Record<string, string> = {};
    if (label) hints.label = label;
    if (ariaLabel) hints.label = ariaLabel; // aria-label takes priority
    if (name) hints.name = name;
    if (role && role !== 'combobox') hints.role = role;

    return {
      id: recStepId(),
      type: 'select',
      description: this.buildDescription('select', { tag: 'select', labelText: label } as ProbedElement, selectedText),
      value: selectedValue,
      bindingHints: Object.keys(hints).length > 0 ? hints : undefined,
      evidence: { confidence: 1.0, pageUrl },
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
    pageUrl?: string,
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
    // V14: Store viewport dimensions for coordinate normalization during replay
    return {
      id: recStepId(),
      type: 'drag_and_drop',
      description,
      value: JSON.stringify({
        from: { x: Math.round(dragState.startX), y: Math.round(dragState.startY) },
        to: { x: Math.round(endX), y: Math.round(endY) },
        viewport: dragState.viewport,
      }),
      bindingHints: dragState.startElement
        ? this.buildBindingHints(dragState.startElement) as BindingHints | undefined
        : undefined,
      evidence: {
        ...(startRef && { lastSuccessRef: startRef }),
        confidence: 1.0,
        pageUrl,
      },
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
    pageUrl?: string,
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
      evidence: {
        ...(element?.ref && { lastSuccessRef: element.ref }),
        confidence: 1.0,
        pageUrl,
      },
    };
  }

  /**
   * V15: Minimum scroll threshold (px) — ignore trackpad noise / micro-scrolls.
   * Below this, scroll event is not recorded.
   */
  private static SCROLL_MIN_THRESHOLD_PX = 50;

  /**
   * V10 Fix #8: Capture a scroll step with actual delta value.
   * V15: Added minimum threshold, optional bindingHints for scroll-to-element replay.
   *
   * @param accumulatedDeltaY - Total pixels scrolled during the debounce window
   * @param pageUrl - Current page URL for evidence
   * @param accumulatedDeltaX - Total horizontal scroll (V14)
   * @param scrollTargetHints - Optional: bindingHints for the element that became visible after scroll (V15)
   */
  static captureScroll(
    accumulatedDeltaY: number,
    pageUrl?: string,
    accumulatedDeltaX?: number,
    scrollTargetHints?: BindingHints,
  ): PreviewIntentStep | null {
    if (accumulatedDeltaY === 0 && (!accumulatedDeltaX || accumulatedDeltaX === 0)) return null;

    // V15: Filter micro-scrolls (trackpad noise, accidental touch)
    const totalMagnitude = Math.abs(accumulatedDeltaY) + Math.abs(accumulatedDeltaX || 0);
    if (totalMagnitude < this.SCROLL_MIN_THRESHOLD_PX) return null;

    const parts: string[] = [];
    if (accumulatedDeltaY !== 0) {
      parts.push(`${accumulatedDeltaY > 0 ? 'down' : 'up'} ${Math.abs(Math.round(accumulatedDeltaY))}px`);
    }
    if (accumulatedDeltaX && accumulatedDeltaX !== 0) {
      parts.push(`${accumulatedDeltaX > 0 ? 'right' : 'left'} ${Math.abs(Math.round(accumulatedDeltaX))}px`);
    }

    // V14: Store both deltaX and deltaY as comma-separated value for replay
    const deltaXRounded = Math.round(accumulatedDeltaX || 0);
    const deltaYRounded = Math.round(accumulatedDeltaY);

    return {
      id: recStepId(),
      type: 'scroll',
      description: `Scroll ${parts.join(', ')}`,
      value: deltaXRounded !== 0 ? `${deltaYRounded},${deltaXRounded}` : String(deltaYRounded),
      // V15: If we found a target element after scroll, attach hints so replay can use scrollIntoView
      ...(scrollTargetHints && Object.keys(scrollTargetHints).length > 0 && { bindingHints: scrollTargetHints }),
      evidence: { confidence: 1.0, pageUrl },
    };
  }

  /**
   * V15: After scroll completes, find a meaningful element near viewport center
   * that can serve as a scroll-to anchor during replay.
   * Returns BindingHints for the element, or null if nothing meaningful found.
   */
  static async probeScrollTarget(page: Page): Promise<BindingHints | null> {
    try {
      const result = await page.evaluate(`
        (function() {
          var vw = window.innerWidth;
          var vh = window.innerHeight;
          // Sample a point in the upper-center area (where user likely scrolled to see)
          var cx = Math.round(vw / 2);
          var cy = Math.round(vh * 0.35);
          // Look for a meaningful element: heading, landmark, labeled section
          // Avoid [id] — too many matches on heavy pages, causes reflow storm
          var candidates = document.querySelectorAll(
            'h1,h2,h3,h4,h5,h6,[role="heading"],section[aria-label],main,article,' +
            '[data-testid],[aria-label]'
          );
          var best = null;
          var bestDist = Infinity;
          // Cap iterations to avoid perf issues on element-heavy pages
          var maxCandidates = Math.min(candidates.length, 200);
          for (var i = 0; i < maxCandidates; i++) {
            var c = candidates[i];
            var rect = c.getBoundingClientRect();
            // Element must be in viewport
            if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
            if (rect.width === 0 || rect.height === 0) continue;
            // Distance from element center to our sample point
            var ecx = rect.left + rect.width / 2;
            var ecy = rect.top + rect.height / 2;
            var dist = Math.abs(ecx - cx) + Math.abs(ecy - cy);
            if (dist < bestDist) {
              bestDist = dist;
              best = c;
            }
          }
          if (!best) return null;
          var tag = best.tagName.toLowerCase();
          return {
            tag: tag,
            text: (best.textContent || '').trim().slice(0, 80) || undefined,
            role: best.getAttribute('role') || undefined,
            ariaLabel: best.getAttribute('aria-label') || undefined,
            id: best.getAttribute('id') || undefined
          };
        })()
      `) as { tag: string; text?: string; role?: string; ariaLabel?: string; id?: string } | null;

      if (!result) return null;

      const hints: BindingHints = {};
      if (result.role) hints.role = result.role;
      if (result.ariaLabel) hints.nearText = result.ariaLabel;
      if (result.text) hints.text = result.text;
      if (result.tag) hints.tag = result.tag;
      return Object.keys(hints).length > 0 ? hints : null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HOVER CAPTURE (V11)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Capture a hover action as an IntentStep.
   * Used when a hover on a different element precedes a click (e.g., dropdown menus).
   */
  static captureHover(element: ProbedElement, pageUrl?: string): PreviewIntentStep {
    const label = this.getElementLabel(element);
    return {
      id: recStepId(),
      type: 'hover',
      description: `Hover '${label}'`,
      bindingHints: this.buildBindingHints(element) as BindingHints | undefined,
      evidence: {
        ...(element.ref && { lastSuccessRef: element.ref }),
        confidence: 1.0,
        pageUrl,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DIALOG CAPTURE (V13)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Capture a native dialog interaction (alert/confirm/prompt/beforeunload).
   * Records what the user did (accept/dismiss) so replay can reproduce it.
   */
  static captureDialog(params: {
    dialogType: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
    action: 'accept' | 'dismiss';
    message?: string;
    promptText?: string;
    pageUrl?: string;
  }): PreviewIntentStep {
    const { dialogType, action, message, promptText, pageUrl } = params;

    const actionLabel = action === 'accept' ? 'Accept' : 'Dismiss';
    const dialogLabel = dialogType === 'beforeunload' ? 'beforeunload dialog' : `${dialogType} dialog`;
    const msgPreview = message ? `: "${message.slice(0, 40)}"` : '';
    const description = `${actionLabel} ${dialogLabel}${msgPreview}`;

    return {
      id: recStepId(),
      type: 'dialog',
      description,
      options: {
        dialog: {
          dialogType,
          action,
          ...(promptText && { promptText }),
          ...(message && { message: message.slice(0, 500) }),
        },
      },
      evidence: { confidence: 1.0, pageUrl },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOWNLOAD CAPTURE (V13)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Capture a file download as an IntentStep.
   * Auto-recorded when a download event fires during recording.
   * During replay, verifies that the download actually starts.
   */
  static captureDownload(params: {
    filename: string;
    url?: string;
    pageUrl?: string;
  }): PreviewIntentStep {
    const { filename, url, pageUrl } = params;
    return {
      id: recStepId(),
      type: 'download',
      description: `Verify file download: '${filename.slice(0, 60)}'`,
      value: filename,
      options: {
        download: {
          filename,
          url,
          timeoutMs: 15000,
        },
      },
      evidence: { confidence: 1.0, pageUrl },
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

    const opts: Record<string, any> = {};
    if (triggeredByEnter) opts.pressEnter = true;
    if (buffer.iframeSelector) opts.iframe = { selector: buffer.iframeSelector };

    return {
      id: recStepId(),
      type: 'type',
      description,
      value: buffer.text,
      bindingHints: buffer.bindingHints as BindingHints | undefined,
      ...(Object.keys(opts).length > 0 && { options: opts }),
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

          // V13: Capture additional binding hints for element resolution during replay
          const name = select.getAttribute('name') || '';
          const id = select.getAttribute('id') || '';
          const ariaLabel = select.getAttribute('aria-label') || '';
          const role = select.getAttribute('role') || 'combobox';

          // @ts-ignore
          if (window[cbName]) window[cbName]({ label, text, value, name, id, ariaLabel, role });
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

  // ─────────────────────────────────────────────────────────────────────────
  // AUTOFILL DETECTION (V13)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Inject an autofill detection listener into the page.
   * Monitors 'change' events on input elements that fire without prior keyboard 'input' events.
   * Browser autofill triggers 'change' directly (no keydown/keypress/keyup/input sequence).
   * We track which inputs had recent 'input' events (from keyboard) and skip those.
   */
  static async injectAutofillListener(
    page: Page,
    callbackName: string,
  ): Promise<void> {
    try {
      // @ts-ignore - browser context code
      await page.evaluate((cbName: string) => {
        // @ts-ignore
        if (window.__qai_autofill_injected) return;
        // @ts-ignore
        window.__qai_autofill_injected = true;

        // Track which inputs had recent keyboard 'input' events
        // @ts-ignore
        const recentKeyboardInputs = new Set();
        // @ts-ignore
        let clearTimer: ReturnType<typeof setTimeout> | null = null;

        // Listen for 'input' events from keyboard (user typing)
        // @ts-ignore
        const inputHandler = (e) => {
          if (e.inputType && e.inputType.startsWith('insert') && e.target?.tagName) {
            const tag = e.target.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea') {
              const key = (e.target.getAttribute('data-agent-ref') || e.target.name || e.target.id || '');
              if (key) recentKeyboardInputs.add(key);
              // Clear after 500ms
              if (clearTimer) clearTimeout(clearTimer);
              clearTimer = setTimeout(() => recentKeyboardInputs.clear(), 500);
            }
          }
        };
        // @ts-ignore
        document.addEventListener('input', inputHandler, true);

        // Listen for 'change' events — autofill triggers these without prior 'input' events
        // @ts-ignore
        const changeHandler = (e) => {
          const el = e.target;
          if (!el || !el.tagName) return;
          const tag = el.tagName.toLowerCase();
          if (tag !== 'input' && tag !== 'textarea') return;
          // Skip select elements (handled by select listener)
          if (tag === 'select') return;

          const key = (el.getAttribute('data-agent-ref') || el.name || el.id || '');
          // If this input had recent keyboard input, skip — it's not autofill
          if (key && recentKeyboardInputs.has(key)) return;

          const value = el.value || '';
          if (!value) return;

          // Get label for the input
          let label = '';
          if (el.labels && el.labels.length > 0) {
            label = (el.labels[0].textContent || '').trim().slice(0, 100);
          }
          if (!label) {
            label = el.getAttribute('aria-label') || '';
          }

          // @ts-ignore
          if (window[cbName]) {
            // @ts-ignore
            window[cbName]({
              tag: tag,
              type: el.getAttribute('type') || '',
              name: el.getAttribute('name') || '',
              id: el.getAttribute('id') || '',
              ariaLabel: el.getAttribute('aria-label') || '',
              label: label,
              value: value,
              ref: el.getAttribute('data-agent-ref') || '',
            });
          }
        };
        // @ts-ignore
        document.addEventListener('change', changeHandler, true);

        // @ts-ignore
        window.__qai_autofill_input_handler = inputHandler;
        // @ts-ignore
        window.__qai_autofill_change_handler = changeHandler;
      }, callbackName);
    } catch (error) {
      logger.debug('[RECORDING] Failed to inject autofill listener', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove the injected autofill detection listener.
   */
  static async removeAutofillListener(page: Page): Promise<void> {
    try {
      // @ts-ignore - browser context code
      await page.evaluate(() => {
        // @ts-ignore
        if (window.__qai_autofill_input_handler) {
          // @ts-ignore
          document.removeEventListener('input', window.__qai_autofill_input_handler, true);
          // @ts-ignore
          delete window.__qai_autofill_input_handler;
        }
        // @ts-ignore
        if (window.__qai_autofill_change_handler) {
          // @ts-ignore
          document.removeEventListener('change', window.__qai_autofill_change_handler, true);
          // @ts-ignore
          delete window.__qai_autofill_change_handler;
        }
        // @ts-ignore
        delete window.__qai_autofill_injected;
      });
    } catch {
      // Page may already be closed
    }
  }
}
