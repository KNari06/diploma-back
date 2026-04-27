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
  TargetFingerprint,
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
  /**
   * V22: aria-invalid — validation state at recording time. Critical for
   * negative-test recording (user records "submit form with empty email →
   * red error border"). Without it the resolver can't tell apart a clean
   * input from an invalid one with the same selector — and replay may
   * match a *valid* input where the recording targeted the *invalid* one.
   */
  ariaInvalid?: boolean;
  /**
   * V22 Pkg1: aria-current value (page|step|date|true|location). Pagination
   * shows it on the active page, Stepper on the active step, Breadcrumbs on
   * the last crumb. Without it, all pagination buttons look identical to the
   * resolver — recorded "click page 2" can match any page.
   */
  ariaCurrent?: string;
  /**
   * V22 Pkg1: aria-valuenow / aria-valuetext — current value of slider /
   * spinbutton / progressbar. Records "set slider to 50" so replay can
   * match the same target by its semantic value. valuetext takes priority
   * (it's a human-readable form) when both are present.
   */
  ariaValueNow?: number;
  ariaValueText?: string;
  /**
   * V22 Pkg1: data-value (or `<option value="...">` value). Stable
   * identifier for select options / list items / chips that have semantic
   * keys distinct from their display text — e.g. `<option value="kz">Казахстан</option>`,
   * recording "select Казахстан" stores value="kz" so localized labels still
   * resolve.
   */
  dataValue?: string;
  /**
   * V22 Pkg1: data-testid of a single direct child icon (svg/i/img) when
   * the target itself is descriptor-poor. Closes the most common gap on
   * MUI IconButton, Element Plus el-tooltip__trigger, Ant Design icon
   * buttons — the icon's data-testid carries the semantic name
   * (`VisibilityOffOutlinedIcon`) but lives on the child, not the button.
   */
  childTestId?: string;
  /**
   * V22 Pkg4: Semantic icon name extracted from svg-internal accessibility
   * (`<title>`, `<desc>`), sprite reference (`<use href="#icon-menu">`), or
   * icon-library data-attrs (`data-lucide`, `data-feather`, `data-icon`,
   * `data-iconify-name`). Closes the gap for icon-only buttons WITHOUT
   * `data-testid` (`<div role="button"><svg><title>Menu</title></svg></div>`).
   * Mirrors the snapshot-collector iconChildLabel logic so record-time and
   * apply-time agree on what the icon "means".
   */
  iconLabel?: string;
  /**
   * V22 Pkg2: Bootstrap data-bs-toggle / data-bs-target. The de-facto
   * marker for Bootstrap modals, dropdowns, tabs, accordions, collapses.
   * `bsToggle` carries the widget kind ("modal" | "dropdown" | "tab" | ...);
   * `bsTarget` the CSS selector pointing to the controlled element.
   */
  bsToggle?: string;
  bsTarget?: string;
  /**
   * V22 Pkg2: aria-haspopup — disambiguation signal for dropdown / menu /
   * combobox triggers. Even when text or icon is duplicated across the page,
   * `aria-haspopup="menu"` distinguishes a real trigger from a static button.
   */
  ariaHasPopup?: string;
  /**
   * V22 Pkg2: aria-activedescendant — id of the currently-active descendant
   * inside a Combobox / Listbox / Tree. Lets recorder capture "the option
   * that was hovered when user clicked", crucial for type-ahead flows.
   */
  ariaActiveDescendant?: string;
  /**
   * V22 Pkg2: data-row-key (AntD), data-rk (RainbowKit), key="..." prop
   * leaked to DOM by some Vue/React table libs. Stable row identity that
   * survives re-renders.
   */
  dataRowKey?: string;
  /**
   * V22 Pkg2: heuristic flag — "this <tr> looks clickable even without
   * role/onclick". Probe sets it when the row matches at least two
   * positive signals (cursor:pointer + hover class, or class*="clickable",
   * or parent table has a click handler). Recorder uses it to elevate
   * resolvedVia from `directHit` to `behavioral`.
   */
  rowClickable?: boolean;
  /**
   * V22 Pkg5: Concatenated text of sibling cells inside the nearest
   * row container (`<tr>` / `[role="row"]` / `li[role="option"]` /
   * `li.list-row`). Cells containing the target itself are excluded.
   * Format: "<cell1> | <cell2> | <cell3>" capped at 200 chars / 4 cells.
   * Critical for descriptor-poor row checkboxes & action buttons that
   * are identical-looking at the DOM level — only sibling text gives
   * uniqueness. Works on AntD/MUI/Bootstrap/plain HTML tables alike.
   */
  nearestRowText?: string;
  /**
   * V22 Pkg5: Index among same-class siblings of the same parent.
   * Only set when sibling count is 2..10 (avoid catching huge lists)
   * and target shares its first className token with siblings. Enables
   * stable `parent > .cls:nth-of-type(N)` selectors for pagination
   * arrows, tab strips, button groups where attribute identity is missing.
   */
  siblingIndex?: number;
  /**
   * V22 Pkg5: Boolean disabled state captured from `disabled` attribute,
   * `aria-disabled="true"`, or `.Mui-disabled` / `.is-disabled` class
   * tokens. Recorded fingerprint contains the *recorded* disabled state;
   * heal-time scoring boosts match when live disabled state agrees.
   * Distinguishes "prev (disabled)" from "next (enabled)" pagination twins.
   */
  disabled?: boolean;
  /**
   * V22 Pkg5: Cardinal direction inferred from svg path geometry.
   * Cheap heuristic — compares first M (move) and L (line) X/Y coords.
   * Values: "left" | "right" | "up" | "down". Only set when target is
   * an svg-only button without other identifiers. Fed to LLM resolver
   * as candidateText hint ("arrow: left") and used as iconLabel fallback.
   */
  arrowDir?: 'left' | 'right' | 'up' | 'down';
  boundingBox?: ElementBoundingBox;
  /** True if element accepts multi-line text (textarea, contenteditable) */
  isMultiline?: boolean;
  /** Nearest heading/landmark text — provides container context for multi-page AI lint */
  containerText?: string;
  /** V18: title attribute — fallback identifier for icon-only buttons */
  title?: string;
  /** alt attribute — fallback for <img> clicks (e.g. <img alt="Profile"/>) */
  alt?: string;
  /** V18: data-testid/data-test/data-cy — stable test identifier */
  testId?: string;
  /**
   * V22: DOM `id` attribute — most stable locator after testId. Critical for
   * icon-only elements (svg/img/i) where text/aria-label are absent. On Vue
   * apps from Element Plus / Ant Design icons typically lack labels but carry
   * a stable `id="layout-header-setting"` — without this field the recorder
   * falls back to "tag: svg" which collides with every other svg on the page.
   */
  elementId?: string;
  /**
   * V22: First 1-3 className tokens (filtered to drop utility classes like
   * Tailwind/UnoCSS shorthand). Useful as a secondary locator when id is
   * absent but framework-scoped CSS class is stable (e.g. el-button--primary).
   */
  cssClass?: string;
  /**
   * V22: aria-controls — semantic link to the controlled element. Frequently
   * stable on dropdowns, tabs, comboboxes. Doubles as a uniqueness signal
   * even when text is duplicated across the page.
   */
  ariaControls?: string;
  /**
   * V22: href — for <a> tags. Even when link text is duplicated ("Read more"
   * × 5), the href differentiates them. Truncated to first 200 chars to
   * keep the recording payload bounded for sites with very long URLs.
   */
  href?: string;
  /**
   * V22: Vue scoped style attribute (`data-v-XXXXXXX`). On Vue apps this is
   * a stable component-instance marker — narrows down to "this exact button
   * within this exact component" even if class names are utility-only.
   */
  vueScopeId?: string;
  /**
   * V22: Nearest ARIA landmark (banner / navigation / main / complementary /
   * search / contentinfo / form). Computed from `target.closest('[role=...]')`
   * or implicit landmarks (`<header>`, `<nav>`, `<main>`, etc.). Crucial for
   * disambiguating elements that recur across page sections — e.g. "Settings"
   * link in nav vs "Settings" link in footer.
   */
  nearestLandmark?: string;
  /**
   * V22: Up to 2 nearest container titles (first `<h1>..<h6>` or `[role="heading"]`
   * found by walking ancestors). Used for "this button inside the Login form"
   * style disambiguation when a page has multiple visually-identical sections.
   */
  containerTitles?: string[];
  /**
   * V22: Compact one-line summary of `ancestorChain` for inclusion in LLM
   * prompts. Format: `"<tag>[role|id|class] > <tag> > <tag>"` from outer
   * to inner. Saves tokens vs sending the full chain object — and survives
   * the JSON round-trip into bindingHints / DB unlike the chain itself
   * (which is documented as transient and not persisted).
   */
  ancestorSummary?: string;
  /** V13: CSS selector of the iframe containing this element (set when element is inside an iframe) */
  iframeSelector?: string;
  /** V14: Marker — element is inside a cross-origin iframe and cannot be probed/recorded */
  crossOriginIframe?: boolean;
  /** V15: How the interactive target was resolved from the click point */
  resolvedVia?: 'nativeTag' | 'ariaRole' | 'behavioral' | 'cssClass' | 'cursorPointer' | 'directHit' | 'llm';
  /**
   * Ancestor chain from target up to body, capped at 6 levels.
   *
   * V15: originally collected only for `directHit` / `cssClass` resolves and
   *      treated as transient (not persisted).
   * V22: now collected for ALL resolves — icon targets (cursorPointer) need
   *      this most, since they have no descriptors of their own. Used by
   *      `ancestorSummary` builder which IS persisted (bindingHints +
   *      fingerprint), and by the legacy LLM ancestor-walk in
   *      `resolveInteractiveTarget`.
   *
   * Each segment carries identifying signals in priority order: testId, id,
   * role, text, ariaLabel, className. The first non-generated, non-empty
   * field is what the summary builder picks.
   */
  ancestorChain?: Array<{
    tag: string;
    role?: string;
    /** V22: stable DOM id (framework-generated ids are filtered at probe time) */
    id?: string;
    /** V22: data-testid / data-test / data-cy / data-qa from this ancestor */
    testId?: string;
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
  /**
   * V22: Fingerprint of the focused input AT FOCUS TIME. Mirror of
   * `bindingHints` but in TargetFingerprint shape — used to populate the
   * eventual type-step's `recordedFingerprint` so the resolver can find
   * the right input on apply (especially when the form has 3 lookalike
   * `<input type="text">` fields).
   */
  recordedFingerprint?: TargetFingerprint;
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

/**
 * Page-context JavaScript source for computing an element's ARIA role.
 *
 * Returns the explicit `role` attribute when present, otherwise the W3C-spec
 * implicit role for the HTML tag (e.g. `<button>` → 'button', `<nav>` →
 * 'navigation', `<a href>` → 'link'). Mirrors the `getImplicitRole()` logic
 * in dom-analyzer.service.ts so recording captures and DOM snapshots agree.
 *
 * Injected verbatim into every `page.evaluate(...)` that builds a probed
 * element payload. Each probe runs in its own IIFE page-context scope, so
 * sharing the helper across probes requires inlining the source — a module-
 * level JS function is not reachable from page.evaluate callbacks.
 *
 * WHY IT MATTERS: without this, native HTML elements had `role: undefined`
 * in the captured node, which caused locator-plan-builder.service.ts to
 * skip the `role` strategy and fall through to `getByText(...)` — a weak
 * primitive that throws strict-mode-violation whenever the same text
 * recurs anywhere else on the page (e.g. "Видео" label appearing inside
 * tutor cards alongside the header button).
 */
const COMPUTE_ROLE_SRC = `
  function computeRole(element) {
    if (!element || !element.tagName) return undefined;
    if (element.hasAttribute && element.hasAttribute('role')) {
      return element.getAttribute('role') || undefined;
    }
    var t = element.tagName.toLowerCase();
    switch (t) {
      case 'button': return 'button';
      case 'a': return element.hasAttribute('href') ? 'link' : undefined;
      case 'input': {
        var inputType = (element.getAttribute('type') || 'text').toLowerCase();
        switch (inputType) {
          case 'button': case 'submit': case 'reset': case 'image': return 'button';
          case 'checkbox': return 'checkbox';
          case 'radio': return 'radio';
          case 'range': return 'slider';
          case 'text': case 'email': case 'tel': case 'url': case 'search':
          case 'password': case 'number': case 'date': case 'datetime-local':
          case 'time': case 'week': case 'month': case 'color':
            return 'textbox';
          default: return undefined;
        }
      }
      case 'textarea': return 'textbox';
      case 'select': return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
      case 'img': return element.hasAttribute('alt') ? 'img' : undefined;
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'form': return 'form';
      case 'dialog': return 'dialog';
      case 'output': return 'status';
      case 'meter': return 'meter';
      case 'progress': return 'progressbar';
      case 'fieldset': return 'group';
      case 'menu': return 'menu';
      case 'menuitem': return 'menuitem';
      case 'area': return 'link';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'article': return 'article';
      case 'section': return 'region';
      case 'search': return 'search';
      case 'figure': return 'figure';
      case 'details': return 'group';
      case 'summary': return 'button';
      default: return undefined;
    }
  }
`;

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
  // V22 Pkg7: Shadow DOM piercing entry. Recursively descend into open
  // shadow roots so the captured target is the real inner element (e.g.
  // <a> inside Documentolog Market shadow), not the host wrapper. Closed
  // shadow remains impenetrable per spec — el.shadowRoot is null for
  // outside callers, the loop simply breaks (graceful fallback to host).
  //
  // Safety guards:
  //   - depth cap 5 prevents runaway recursion in exotic web components
  //   - inner === el break protects against self-referential shadow points
  //   - try/catch (implicit via JS truthy short-circuit) — if shadowRoot
  //     access throws (very rare CSP edge), loop exits cleanly
  var el = document.elementFromPoint(px, py);
  var shadowDepth = 0;
  while (el && el.shadowRoot && shadowDepth < 5) {
    var inner = el.shadowRoot.elementFromPoint(px, py);
    if (!inner || inner === el) break;
    el = inner;
    shadowDepth++;
  }
  if (!el) return null;

  // V22 Pkg7+: in-probe text normalizer. NFC + invisible-char strip +
  // whitespace collapse. Mirrors normalizeText() in text-normalizer.util.ts
  // — symmetry contract: the same canonicalization runs at probe-time
  // (here) and heal-time / locator generation. Diverging implementations
  // would silently break fingerprint matching across BMP scripts (Cyrillic
  // NFC vs NFD, RTL with bidi marks, ZWJ in copied text).
  var INVISIBLE_CHARS_RE_PROBE = /[​-‏‪-‮⁠-⁩﻿]/g;
  function normProbeText(s) {
    if (s === undefined || s === null) return undefined;
    if (s.length === 0) return '';
    var out = s;
    try { out = out.normalize('NFC'); } catch (e) { /* ancient browsers */ }
    // \\s in this regex is intentionally double-escaped: the surrounding
    // const PROBE_AT_POINT_FN is a JS template literal, so a single \\s
    // would be interpreted by the TS compiler as escape-of-s before the
    // resulting JS code reaches page.evaluate. Without the double escape,
    // the runtime regex would not match whitespace.
    return out
      .replace(INVISIBLE_CHARS_RE_PROBE, '')
      .replace(/\\s+/g, ' ')
      .trim();
  }

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

  ${COMPUTE_ROLE_SRC}

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

    // V22: Extract id and testId from each ancestor — critical for icon
    // targets where ancestor's id is the only stable locator (e.g. svg
    // inside <header id="layout-header"> or <button data-testid="settings">).
    // Filter happens at chain-projection time (DYNAMIC_ID inline patterns).
    var wid = (walk.getAttribute('id') || '').slice(0, 80);
    // V22: same chain as the target-level testId extraction. Keep in sync.
    var wtestid = walk.getAttribute('data-testid')
      || walk.getAttribute('data-test')
      || walk.getAttribute('data-test-id')
      || walk.getAttribute('data-cy')
      || walk.getAttribute('data-qa')
      || walk.getAttribute('data-qa-test-id')
      || walk.getAttribute('data-qa-id')
      || walk.getAttribute('data-qaa')
      || walk.getAttribute('data-automation-id')
      || walk.getAttribute('data-automationid')
      || walk.getAttribute('data-pw')
      || walk.getAttribute('data-e2e')
      || walk.getAttribute('data-e2e-test')
      || walk.getAttribute('data-test-element')
      || walk.getAttribute('data-track')
      || '';
    chain.push({
      el: walk,
      tag: wtag,
      role: wrole,
      className: wclass,
      id: wid,
      testId: wtestid,
      hasTabindex: hasTabindex,
      hasOnclick: hasOnclick,
      hasFrameworkBinding: hasFrameworkClick,
      hasReactClick: hasReactClick,
      hasDraggable: hasDraggable,
      isContentEditable: isContentEditable,
      // innerText skips script/style/template and display:none children;
      // textContent would leak JSON-LD, inline CSS, offscreen microcopy.
      // Non-HTML nodes (SVG etc.) lack innerText — fall back.
      text: (normProbeText((walk.innerText != null ? walk.innerText : walk.textContent) || '') || '').slice(0, 80),
      ariaLabel: normProbeText(walk.getAttribute('aria-label')) || ''
    });
    // V22 Pkg7: Cross shadow boundary on ancestor walk. When parentElement
    // is null but the node sits inside a ShadowRoot, jump to the host
    // element so we can collect attributes / classes from ancestors above
    // the shadow (e.g. wrapper testIds set in the outer document).
    if (!walk.parentElement) {
      try {
        var rootNode = walk.getRootNode && walk.getRootNode();
        if (rootNode && rootNode !== document && rootNode.host) {
          walk = rootNode.host;
          continue;
        }
      } catch (e) { /* ignore — fall through to normal exit */ }
    }
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

  // V22 Pkg2 — Clickable row promotion.
  // MUI/AntD/Element Plus tables make <tr> kликабельным через CSS hover +
  // JS handler без role/onclick. If we landed on a <td>/<span> inside a
  // <tr> that looks clickable (cursor:pointer OR hover-class), promote
  // the target to the <tr>. Without this, recording grabs random cell text
  // and replay clicks an unrelated cell instead of the row action.
  // Constraint: only promote when target is a leaf inside the row, not
  // when target IS the row already (would dead-loop the chain).
  if (resolvedVia === 'directHit' || resolvedVia === 'cssClass' || resolvedVia === 'cursorPointer') {
    try {
      var rowAncestor = target.closest && target.closest('tr');
      if (rowAncestor && rowAncestor !== target) {
        var rowCursor = getComputedStyle(rowAncestor).cursor;
        var rowClass = rowAncestor.getAttribute('class') || '';
        var rowHoverish = /\b(hover|clickable|MuiTableRow-hover|ant-table-row|el-table__row|row-clickable)\b/i.test(rowClass);
        if (rowCursor === 'pointer' || rowHoverish) {
          target = rowAncestor;
          resolvedVia = 'behavioral';
        }
      }
    } catch (e) {}
  }

  // V22 Pkg1 — Fix 6: MUI fieldset rim to input promotion.
  // Material-UI's OutlinedInput renders an invisible fieldset (class
  // contains notchedOutline) overlay on top of the input for the border.
  // A click landing on the fieldset rim (the 1-2px border zone) lands on
  // the fieldset, not the input. Recording captures fieldset which is
  // non-interactive and useless for replay. Promote to the actual input
  // inside the surrounding MuiInputBase-root container.
  // Same pattern catches Element Plus el-input__inner / Ant Design
  // ant-input-affix-wrapper variants — any input wrapper with rim overlay.
  try {
    var ttag = (target.tagName || '').toLowerCase();
    var tcls = target.getAttribute && (target.getAttribute('class') || '');
    var looksLikeInputRim =
      (ttag === 'fieldset' && /notchedOutline|input.?border|input.?frame/i.test(tcls))
      || /MuiOutlinedInput-notchedOutline/i.test(tcls)
      || /el-input__suffix|el-input__prefix|el-input__wrapper/i.test(tcls)
      || /ant-input-affix-wrapper(?!__)/i.test(tcls);
    if (looksLikeInputRim) {
      // Walk up looking for the wrapper container with a real input/textarea/select inside.
      var rimWalk = target;
      for (var rwi = 0; rwi < 4 && rimWalk; rwi++) {
        var rwCls = rimWalk.getAttribute && (rimWalk.getAttribute('class') || '');
        if (/MuiInputBase-root|MuiInput-root|MuiTextField-root|el-input(?!_)|ant-input-affix-wrapper(?!__)/i.test(rwCls)) {
          var realInput = rimWalk.querySelector && rimWalk.querySelector('input, textarea, select, [contenteditable="true"]');
          if (realInput) {
            target = realInput;
            resolvedVia = 'nativeTag';
            break;
          }
        }
        rimWalk = rimWalk.parentElement;
      }
    }
  } catch (e) { /* best-effort, fall through to whatever target probe picked */ }

  // V22 Pkg5+: <label>-child to <input>/<select>/<textarea> elevation.
  // Mirrors browser native click-on-label semantics: clicking the visible
  // text/icon inside a <label> activates the associated control. Without
  // this promotion, clicks on Documentolog-style radio rows (where text
  // and svg circle live as <div> siblings of an invisible <input>) record
  // a useless <div data-qa-test-id="typography"> as target. After elevation
  // we capture data-value, the actual input testId, and proper labels —
  // robust across i18n re-localization.
  //
  // Safety guards:
  //   1. Skip when target IS already a form control (don't dead-loop).
  //   2. Skip when label contains MULTIPLE form controls (ambiguous —
  //      we cannot know which one user meant). Native browser behaviour
  //      also skips activation in that case.
  //   3. Prefer for=-association (explicit) before descendant search.
  try {
    var ttagForLabel = (target.tagName || '').toLowerCase();
    var alreadyFormControl = /^(input|select|textarea|button)$/.test(ttagForLabel);
    if (!alreadyFormControl) {
      var labelAnc = target.closest && target.closest('label');
      if (labelAnc && labelAnc !== target) {
        var labelInput = null;
        var forAttr = labelAnc.getAttribute && labelAnc.getAttribute('for');
        if (forAttr) {
          // Explicit for= link — trust it. CSS.escape guards against
          // React 18 useId values like :r0: that contain colons.
          var safeForId = (typeof CSS !== 'undefined' && CSS.escape)
            ? CSS.escape(forAttr)
            : forAttr.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
          try { labelInput = document.querySelector('#' + safeForId); } catch (e2) {}
        }
        if (!labelInput) {
          // Implicit association via DOM nesting. Only elevate when label
          // has EXACTLY one form control to avoid ambiguous matches.
          var labelControls = labelAnc.querySelectorAll('input, select, textarea');
          if (labelControls.length === 1) {
            labelInput = labelControls[0];
          }
        }
        if (labelInput && labelInput !== target && labelInput.tagName) {
          target = labelInput;
          // Use directHit since the label association IS the intended
          // interaction (matches native browser semantics).
          resolvedVia = 'directHit';
        }
      }
    }
  } catch (e) { /* best-effort */ }

  // ── Collect data from chosen target ──────────────────────────────────
  // V22 Audit-fix H3: guard against text/comment nodes that may slip in
  // through fieldset->input promotion when the wrapper has no real input.
  // Without this guard, a Text node leaks here and target.tagName throws,
  // killing the entire probe call. Fall back to the original element when
  // target lost its tagName (Element only has it).
  if (!target || !target.tagName) {
    target = el;
    resolvedVia = 'directHit';
  }
  var tag = target.tagName.toLowerCase();
  var labelText = undefined;
  if (target.labels && target.labels.length > 0) {
    labelText = (normProbeText(target.labels[0].textContent || '') || '').slice(0, 100) || undefined;
  }
  if (!labelText) {
    var lby = target.getAttribute('aria-labelledby');
    if (lby) {
      var lel = document.getElementById(lby);
      if (lel) labelText = (normProbeText(lel.textContent || '') || '').slice(0, 100) || undefined;
    }
  }

  var rect = target.getBoundingClientRect();
  var ae = target.getAttribute('aria-expanded');
  var ap = target.getAttribute('aria-pressed');
  // V22: aria-invalid (or :invalid native pseudo for inputs). Records the
  // validation state at the moment of capture so negative-flow tests
  // ("user clicked invalid field → red border") replay against the same
  // visual state, not a freshly-cleared field.
  var aiAttr = target.getAttribute('aria-invalid');
  var ai = aiAttr === 'true' ? true : aiAttr === 'false' ? false : undefined;
  if (ai === undefined && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
    try { if (target.matches && target.matches(':invalid')) ai = true; } catch (e) {}
  }

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

  // V22: Inline framework-id filter for page-context (cannot import the
  // shared util into page.evaluate). MUST stay in sync with
  // dynamic-id.util.ts — drift causes inconsistent locator plans between
  // recording-time and apply-time. Conservative: only the highest-confidence
  // shape patterns + the most common UI-library prefixes that are diagnostic.
  var IS_GENERATED_ID = function (idStr) {
    if (!idStr || idStr.length === 0 || idStr.length > 80) return true;
    var s = idStr;
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)) return true; // UUID
    if (/^[a-f0-9]{24,}$/i.test(s)) return true;                                                 // Mongo / hex
    if (/^[0-9a-z]{20,}$/i.test(s)) return true;                                                 // long token
    if (/^\d{10,}$/.test(s)) return true;                                                        // epoch
    if (/:r[a-z0-9]+:?$/i.test(s)) return true;                                                  // React useId
    if (/:R[A-Za-z0-9]+:?$/.test(s)) return true;
    if (/^react-select-\d+-/i.test(s)) return true;                                              // React Select
    if (/^react-(?:tabs|router|aria|focus-lock|portal|datepicker)-/i.test(s)) return true;       // narrow react-*
    if (/^el-id-[\w-]+$/i.test(s)) return true;                                                  // Element Plus
    if (/^radix-[a-z0-9-]+/i.test(s)) return true;                                               // Radix UI
    if (/^mui-[\w-]+$/i.test(s)) return true;                                                    // MUI
    if (/^headlessui-[\w-]+$/i.test(s)) return true;                                             // Headless UI
    if (/^chakra-[\w-]+$/i.test(s)) return true;                                                 // Chakra
    if (/^downshift-\d+-/i.test(s)) return true;                                                 // Downshift
    if (/^cdk-(?:overlay|describedby|focus-trap|live)-/i.test(s)) return true;                   // Angular CDK
    if (/^mat-(?:input|tab|menu|select|dialog|chip|mdc)-\d/i.test(s)) return true;               // Angular Material
    if (/^rc-[a-z]+-\d/i.test(s)) return true;                                                   // rc-* (Ant Design)
    if (/^ant-[a-z-]+-\d/i.test(s)) return true;                                                 // Ant Design
    if (/^pv_id_\d+$/.test(s)) return true;                                                      // PrimeVue
    if (/^pn_id_\d+$/.test(s)) return true;                                                      // PrimeNG
    if (/^__BVID__\d+$/.test(s)) return true;                                                    // BootstrapVue
    if (/^vs__/.test(s)) return true;                                                            // vue-select
    if (/^lit-element-\d+$/i.test(s)) return true;                                               // Lit
    if (/^sc-[a-z0-9-]+-h-/i.test(s)) return true;                                               // Stencil/Ionic
    if (/^q-[a-z]+-\d+$/i.test(s)) return true;                                                  // Quasar
    if (/^n-[a-z]+-\d+$/i.test(s)) return true;                                                  // Naive UI
    if (/^lightning-[a-z]+-\d+/i.test(s)) return true;                                           // Salesforce
    if (/^slds-[a-z-]+-\d+$/i.test(s)) return true;
    if (/^aria-id-\d+$/i.test(s)) return true;
    if (/^descid-\d+$/i.test(s)) return true;
    if (/^lit\$/.test(s)) return true;
    if (/^ember\d+/i.test(s)) return true;
    if (/^ng-[a-z0-9-]+/i.test(s)) return true;                                                  // AngularJS
    if (/^_[a-zA-Z0-9]{12,}$/.test(s)) return true;                                              // long underscore-prefixed (Emotion)
    return false;
  };

  // V22: ancestorChain — now includes id/testId for each segment, with
  // framework-generated ids filtered out. The chain is no longer a transient
  // debug artefact — it travels with the step (when persistance enabled below)
  // so the LLM resolver can reason about "this svg inside the Settings header".
  // Cap depth at 6 levels to keep payload bounded; that's enough for icon-in-
  // button-in-toolbar-in-header chains and avoids dragging the whole DOM tree.
  var ancestorChain = [];
  for (var aci = 0; aci < Math.min(chain.length, 6); aci++) {
    var ac = chain[aci];
    var acId = ac.id && !IS_GENERATED_ID(ac.id) ? ac.id : undefined;
    var acTestId = ac.testId || undefined;
    var acClassFiltered = undefined;
    if (ac.className) {
      // V22 Pkg3 — same css-in-js detection as the target-level extraction.
      var acHasCssInJs = /(?:^| )(?:css-[a-z0-9]{6,}|sc-[a-zA-Z0-9]{6,})(?: |$)/i.test(ac.className);
      var acTokens = ac.className.split(/\s+/).filter(function (t) {
        if (!t || t.length > 50) return false;
        if (/^(?:[wh]-|p[xytrbl]?-|m[xytrbl]?-|gap-|flex|grid|block|inline|hidden|absolute|relative|fixed|text-|bg-|border|rounded|shadow|opacity|cursor-|select-|items-|justify-|self-|space-|overflow-|min-|max-|top-|left-|right-|bottom-|z-|font-|leading-|tracking-|whitespace-|truncate|line-clamp|transition|duration-|ease-|animate-|hover:|focus:|active:|disabled:|group-)/.test(t)) return false;
        if (/^data-v-[a-f0-9]{8}$/.test(t)) return false;
        // V22 Pkg3: Emotion / styled-components scoped classes.
        if (/^css-[a-z0-9]{6,}$/i.test(t)) return false;
        if (/^sc-[a-zA-Z0-9]{6,}$/.test(t)) return false;
        if (acHasCssInJs && /^[a-z][a-zA-Z]{4,7}$/.test(t) && /[A-Z]/.test(t)) return false;
        return true;
      });
      if (acTokens.length > 0) acClassFiltered = acTokens.slice(0, 2).join(' ');
    }
    ancestorChain.push({
      tag: ac.tag,
      role: ac.role || undefined,
      id: acId,
      testId: acTestId,
      text: ac.text ? ac.text.slice(0, 50) : undefined,
      ariaLabel: ac.ariaLabel || undefined,
      className: acClassFiltered
    });
  }

  // V22: Persistent compact ancestor-chain summary. Used by the LLM resolver
  // at apply time as the primary "where on the page" hint when the target
  // element itself has no descriptors.
  //
  // Format example:
  //   "header#layout-header > div.icon-group > svg"
  //   "form[role=form] > [data-testid=email-input]"
  //
  // Identifier selection per segment, in priority order:
  //   1. testId  → "[data-testid=...]"            (gold-standard locator)
  //   2. id      → "#stable-id"                   (rejected if framework-generated)
  //   3. role    → "[role=...]"                   (semantic landmark)
  //   4. text    → "[text='Login']" (≤30 chars)   (label-bearing button/link parent)
  //   5. class   → ".first-class"                 (last resort)
  //
  // Built for ALL probe outcomes (cursorPointer / nativeTag / etc.), not
  // just directHit/cssClass — that was the original design flaw which left
  // icon-only targets (where summary is most useful) without it.
  var ancestorSummary = undefined;
  if (ancestorChain.length > 0) {
    var summarySegments = [];
    for (var asi = 0; asi < Math.min(ancestorChain.length, 5); asi++) {
      var seg = ancestorChain[asi];
      var segIdent = '';
      if (seg.testId) segIdent = '[data-testid=' + seg.testId + ']';
      else if (seg.id) segIdent = '#' + seg.id;
      else if (seg.role) segIdent = '[role=' + seg.role + ']';
      else if (seg.text && seg.text.length <= 30) segIdent = "[text='" + seg.text.replace(/'/g, "") + "']";
      else if (seg.className) segIdent = '.' + seg.className.split(' ')[0];
      summarySegments.push(seg.tag + segIdent);
    }
    summarySegments.reverse();          // chain is inner→outer; we want outer→inner
    summarySegments.push(tag);           // target itself at the leaf
    ancestorSummary = summarySegments.join(' > ').slice(0, 250);
  }

  // V22: Nearest ARIA landmark (banner|navigation|main|complementary|search|
  // contentinfo|form). Implicit landmarks via tagName, explicit via role attr.
  // Walk closest-first, stop at body. Mirrors how snapshot collector tags
  // InteractiveNode.nearestLandmark so apply-time and recording-time agree.
  var nearestLandmark = undefined;
  var landmarkWalk = target.parentElement;
  var LANDMARK_TAGS = { 'header': 'banner', 'nav': 'navigation', 'main': 'main',
                        'aside': 'complementary', 'footer': 'contentinfo', 'form': 'form' };
  var EXPLICIT_LANDMARKS = ['banner', 'navigation', 'main', 'complementary',
                            'search', 'contentinfo', 'form', 'region'];
  for (var lwi = 0; lwi < 12 && landmarkWalk; lwi++) {
    var lwRole = landmarkWalk.getAttribute('role');
    if (lwRole && EXPLICIT_LANDMARKS.indexOf(lwRole) !== -1) {
      nearestLandmark = lwRole;
      break;
    }
    var lwTagLower = (landmarkWalk.tagName || '').toLowerCase();
    if (LANDMARK_TAGS[lwTagLower]) {
      nearestLandmark = LANDMARK_TAGS[lwTagLower];
      break;
    }
    landmarkWalk = landmarkWalk.parentElement;
  }

  // V22: Container titles — first 1-2 enclosing headings or dialog/form titles.
  // Different from containerText (which is also a heading walk but caps at
  // first hit): we collect up to 2 distinct headings to give the resolver
  // enough context for nested forms (e.g. Settings > Profile > Save).
  var containerTitlesArr = [];
  var titleWalk = target.parentElement;
  var seenTitles = {};
  for (var twi = 0; twi < 12 && titleWalk && containerTitlesArr.length < 2; twi++) {
    var twHeading = titleWalk.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"]');
    if (twHeading) {
      var tt = (twHeading.textContent || '').trim().slice(0, 60);
      if (tt && !seenTitles[tt]) { seenTitles[tt] = 1; containerTitlesArr.push(tt); }
    }
    // Element Plus / Ant Design dialog title pattern
    var twDialogTitle = titleWalk.getAttribute('aria-labelledby');
    if (twDialogTitle) {
      var twTitleEl = document.getElementById(twDialogTitle);
      if (twTitleEl) {
        var tt2 = (twTitleEl.textContent || '').trim().slice(0, 60);
        if (tt2 && !seenTitles[tt2]) { seenTitles[tt2] = 1; containerTitlesArr.push(tt2); }
      }
    }
    titleWalk = titleWalk.parentElement;
  }
  var containerTitles = containerTitlesArr.length > 0 ? containerTitlesArr : undefined;

  // V18: Collect title and data-testid for behavioral elements with no text/label
  var titleAttr = normProbeText(target.getAttribute('title')) || undefined;
  // alt attribute — fallback for <img> targets where textContent is empty
  var altAttr = target.getAttribute('alt') || undefined;
  // V22: Test-id fallback chain. Ordered by industry adoption (data-testid is
  // the de-facto standard; the rest cover corporate naming conventions seen
  // across MUI/Element Plus/Angular/Vue stacks, Cypress/Playwright/Selenium
  // codebases, and Russian/Kazakhstan SaaS (Documentolog uses data-qa-test-id).
  // Order matters only for which value lands in testId when multiple are
  // present — adding more patterns is safe (we just look up first non-empty).
  var testId = target.getAttribute('data-testid')
    || target.getAttribute('data-test')
    || target.getAttribute('data-test-id')
    || target.getAttribute('data-cy')
    || target.getAttribute('data-qa')
    || target.getAttribute('data-qa-test-id')      // Documentolog / MUI corporate
    || target.getAttribute('data-qa-id')           // alt naming
    || target.getAttribute('data-qaa')             // Angular HostBinding convention
    || target.getAttribute('data-automation-id')   // Cypress / Selenium corp
    || target.getAttribute('data-automationid')    // Microsoft / FluentUI variant
    || target.getAttribute('data-pw')              // Playwright community
    || target.getAttribute('data-e2e')             // generic e2e
    || target.getAttribute('data-e2e-test')        // generic e2e (full)
    || target.getAttribute('data-test-element')    // long-form variant
    || target.getAttribute('data-track')           // analytics-friendly testing hook
    || undefined;

  // V22: id — most stable locator after testId. Skip framework-generated IDs
  // (Element Plus "el-id-XXXX-N" pattern, Radix UI "radix-:rXX:" pattern,
  // Vue UUID-like ids) since those rotate between sessions / SSR vs CSR.
  var rawId = target.id || target.getAttribute('id') || '';
  var elementId = undefined;
  if (rawId && rawId.length > 0 && rawId.length < 80) {
    var looksGenerated =
      /^el-id-/i.test(rawId)               // Element Plus
      || /^radix-/.test(rawId)             // Radix UI
      || /^:r[0-9a-z]+:$/i.test(rawId)     // React useId()
      || /^mui-/i.test(rawId)              // MUI auto-generated
      || /^headlessui-/i.test(rawId)       // Headless UI
      || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(rawId); // UUID
    if (!looksGenerated) elementId = rawId;
  }

  // V22: cssClass — first stable class token (drops Tailwind/UnoCSS utility
  // prefixes). For SVGElement target.className is SVGAnimatedString, not a
  // string, so always read via getAttribute for cross-tag safety.
  var rawClass = target.getAttribute('class') || '';
  var cssClass = undefined;
  // V22 Pkg3 — flag when ANY css-in-js generated class is on this element
  // (Emotion css-XXX, styled-components sc-XXX). When present, the
  // OTHER tokens on the same element are likely also generated companions
  // (kAtEng, hpEYiQ — display-name hashes that can't be regex-detected
  // without false positives on legitimate camelCase ids). In that case we
  // are extra strict on what we treat as "stable className".
  var hasCssInJs = /(?:^| )(?:css-[a-z0-9]{6,}|sc-[a-zA-Z0-9]{6,})(?: |$)/i.test(rawClass);
  if (rawClass) {
    var tokens = rawClass.split(/\s+/).filter(function (t) {
      if (!t || t.length > 50) return false;
      // Drop common utility/state classes that don't differentiate semantics.
      if (/^(?:[wh]-|p[xytrbl]?-|m[xytrbl]?-|gap-|flex|grid|block|inline|hidden|absolute|relative|fixed|text-|bg-|border|rounded|shadow|opacity|cursor-|select-|items-|justify-|self-|space-|overflow-|min-|max-|top-|left-|right-|bottom-|z-|font-|leading-|tracking-|whitespace-|truncate|line-clamp|transition|duration-|ease-|animate-|hover:|focus:|active:|disabled:|group-)/.test(t)) return false;
      // Drop dynamic Vue/CSS scoped hashes
      if (/^data-v-[a-f0-9]{8}$/.test(t)) return false;
      // V22 Pkg3: drop Emotion / styled-components scoped classes.
      if (/^css-[a-z0-9]{6,}$/i.test(t)) return false;
      if (/^sc-[a-zA-Z0-9]{6,}$/.test(t)) return false;
      // V22 Pkg3: when ANY css-in-js class is present on this element,
      // also drop bare 5-8-char mixed-case tokens — they're almost
      // certainly styled-components display-name hashes (kAtEng/hpEYiQ).
      // We do NOT drop them when there's no css-in-js sibling, to avoid
      // dropping legitimate ids like "userName" or "submitBtn".
      if (hasCssInJs && /^[a-z][a-zA-Z]{4,7}$/.test(t) && /[A-Z]/.test(t)) return false;
      return true;
    });
    if (tokens.length > 0) cssClass = tokens.slice(0, 3).join(' ');
  }

  // V22: Vue scoped marker (data-v-XXXXXXX). All children of one component
  // share it, so it narrows + survives className refactors.
  var vueScopeId = undefined;
  for (var ai = 0; ai < target.attributes.length; ai++) {
    var attr = target.attributes[ai];
    if (attr.name && attr.name.indexOf('data-v-') === 0) {
      vueScopeId = attr.name; // we want the attribute *name* (the hash itself is the value=='')
      break;
    }
  }

  // V22: aria-controls — uniqueness signal for dropdowns/tabs/menus.
  var ariaControls = target.getAttribute('aria-controls') || undefined;

  // V22: href — link target. Truncate to keep payload small.
  var hrefAttr = undefined;
  if (tag === 'a') {
    var rawHref = target.getAttribute('href') || '';
    if (rawHref && rawHref.length > 0 && rawHref.length < 500) {
      hrefAttr = rawHref.slice(0, 200);
    }
  }

  // V22 Pkg1 — Fix 5: aria-current (page|step|date|true|location|time).
  // Pagination/Stepper/Breadcrumbs disambiguation: lets resolver tell apart
  // "click current page" from neighbouring page buttons that share text/role.
  var ariaCurrentAttr = target.getAttribute('aria-current') || undefined;
  // The attribute is boolean-like but stored as string — keep raw value
  // ('page' | 'step' | 'true' | ...) so resolver can do exact compare.

  // V22 Pkg1 — Fix 2: aria-valuenow / aria-valuetext. Slider, SpinButton,
  // ProgressBar carry their current value via these ARIA attrs (or via
  // <input type="number/range">.value). Without them, "set slider to 50%"
  // recordings replay against an unrelated slider in the same shape.
  var ariaValueNowAttr = target.getAttribute('aria-valuenow');
  var ariaValueNum = undefined;
  if (ariaValueNowAttr !== null && ariaValueNowAttr !== '') {
    var parsedVN = parseFloat(ariaValueNowAttr);
    if (!isNaN(parsedVN)) ariaValueNum = parsedVN;
  } else if ((tag === 'input' && (target.type === 'range' || target.type === 'number')) || tag === 'progress' || tag === 'meter') {
    var nativeVal = parseFloat(target.value);
    if (!isNaN(nativeVal)) ariaValueNum = nativeVal;
  }
  var ariaValueTextAttr = target.getAttribute('aria-valuetext') || undefined;

  // V22 Pkg1 — Fix 3: data-value / value attribute for option-like elements.
  // <option value="kz">Казахстан</option>, <li role="option" data-value="kz">,
  // <MuiMenuItem value="kz" />. Records the semantic key alongside the
  // localized display text — so re-recording in another language still
  // resolves the same logical option.
  var dataValueAttr = undefined;
  var rawDataValue = target.getAttribute('data-value') || '';
  if (rawDataValue && rawDataValue.length > 0 && rawDataValue.length < 200) {
    dataValueAttr = rawDataValue;
  } else if (tag === 'option' || target.getAttribute('role') === 'option' || target.getAttribute('role') === 'menuitem') {
    var rawVal = target.getAttribute('value') || '';
    if (rawVal && rawVal.length > 0 && rawVal.length < 200) {
      dataValueAttr = rawVal;
    }
  }

  // V22 Pkg1 — Fix 1: child icon testid promotion.
  // When the target is descriptor-poor (no text, ariaLabel, labelText, title,
  // alt, testId, elementId) AND has a single direct icon child (svg/i/img)
  // that DOES carry a data-testid, lift the icon's testid up. This closes
  // the most common gap on MUI IconButton / Element Plus el-tooltip__trigger
  // / Ant Design icon buttons where the semantic name lives on the child.
  // Constraint: only ONE qualifying child, walked 1-2 levels deep — multiple
  // candidates make the lift ambiguous, so we abstain.
  var childTestIdAttr = undefined;
  var hasOwnDescriptor =
    (target.innerText && target.innerText.trim().length > 0)
    || (target.textContent && target.textContent.trim().length > 0 && tag !== 'svg')
    || target.getAttribute('aria-label')
    || target.getAttribute('title')
    || target.getAttribute('alt')
    || testId
    || elementId
    || (target.labels && target.labels.length > 0);
  if (!hasOwnDescriptor) {
    var childCandidates = [];
    var directChildren = target.children || [];
    for (var dci = 0; dci < directChildren.length && childCandidates.length < 3; dci++) {
      var dc = directChildren[dci];
      var dcTag = (dc.tagName || '').toLowerCase();
      if (dcTag === 'svg' || dcTag === 'i' || dcTag === 'img' || dcTag === 'span') {
        var dcTestId = dc.getAttribute('data-testid')
          || dc.getAttribute('data-test')
          || dc.getAttribute('data-cy')
          || dc.getAttribute('data-qa-test-id')
          || '';
        if (dcTestId) childCandidates.push(dcTestId);
        // One level deeper for span > svg pattern (MUI's startIcon wrapper).
        if (!dcTestId && dcTag === 'span' && dc.children && dc.children.length === 1) {
          var dcc = dc.children[0];
          var dccTag = (dcc.tagName || '').toLowerCase();
          if (dccTag === 'svg' || dccTag === 'i' || dccTag === 'img') {
            var dccTestId = dcc.getAttribute('data-testid')
              || dcc.getAttribute('data-test')
              || dcc.getAttribute('data-cy')
              || dcc.getAttribute('data-qa-test-id')
              || '';
            if (dccTestId) childCandidates.push(dccTestId);
          }
        }
      }
    }
    // Only lift when EXACTLY one candidate found — multiple icons mean we
    // can't tell which carries the semantic name without ambiguity.
    if (childCandidates.length === 1) {
      childTestIdAttr = childCandidates[0];
    }
  }

  // V22 Pkg4 — Icon-library / SVG-internal label extraction.
  // Closes the "<div role=button><svg/></div> without attributes" gap by
  // mining the svg itself for accessibility children, sprite hrefs, and
  // popular icon-library data-attributes (Lucide / Feather / Iconify / FA Pro).
  // Only runs when the target is descriptor-poor (same gate as childTestId)
  // AND childTestId did NOT already lift a name. MUST mirror the same
  // extraction order used by background-dom-collector so record-time and
  // apply-time agree on what an icon "means".
  var iconLabelAttr = undefined;
  if (!hasOwnDescriptor && !childTestIdAttr) {
    try {
      // Search inside target FIRST (icon as direct or nested child),
      // fall back to target itself if it IS the svg (clicked svg directly).
      var svgRoot = (tag === 'svg') ? target : target.querySelector('svg');
      var iconHolder = (tag === 'i' || tag === 'svg') ? target : target.querySelector('i, svg');

      // ① <svg><title>X</title></svg>  — WCAG-recommended SVG accessibility
      if (svgRoot && !iconLabelAttr) {
        var svgTitle = svgRoot.querySelector('title');
        if (svgTitle) {
          var svgText = (svgTitle.textContent || '').trim();
          if (svgText.length > 0 && svgText.length <= 100) iconLabelAttr = svgText;
        }
      }
      // ② <svg><desc>X</desc></svg>  — fallback when title absent
      if (svgRoot && !iconLabelAttr) {
        var svgDesc = svgRoot.querySelector('desc');
        if (svgDesc) {
          var descText = (svgDesc.textContent || '').trim();
          if (descText.length > 0 && descText.length <= 100) iconLabelAttr = descText;
        }
      }
      // ③ <svg><use href="#icon-menu"/></svg>  — sprite reference
      if (svgRoot && !iconLabelAttr) {
        var useEl = svgRoot.querySelector('use');
        if (useEl) {
          var href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href') || '';
          // "#icon-menu" / "/sprites.svg#icon-menu" / "#menu" — keep tail after last #
          var refTail = href.indexOf('#') >= 0 ? href.slice(href.lastIndexOf('#') + 1) : href;
          // Normalize: strip "icon-" / "icon_" prefix, replace separators with space.
          var iconRef = refTail.replace(/^icon[-_]/i, '').replace(/[-_]/g, ' ').trim();
          if (iconRef.length > 0 && iconRef.length <= 50) iconLabelAttr = iconRef;
        }
      }
      // ④ data-lucide / data-feather / data-icon / data-iconify-name
      // Check the target itself AND any inner svg/i (Lucide attaches to svg,
      // Iconify often to a wrapper div, FA Pro to <i>).
      if (!iconLabelAttr) {
        var iconAttrCands = [];
        if (target && (target.matches && target.matches('[data-lucide], [data-feather], [data-icon], [data-iconify-name]'))) {
          iconAttrCands.push(target);
        }
        if (iconHolder && iconHolder !== target) iconAttrCands.push(iconHolder);
        if (svgRoot && svgRoot !== target && svgRoot !== iconHolder) iconAttrCands.push(svgRoot);
        for (var iac = 0; iac < iconAttrCands.length && !iconLabelAttr; iac++) {
          var ih = iconAttrCands[iac];
          var raw =
            ih.getAttribute('data-lucide')
            || ih.getAttribute('data-feather')
            || ih.getAttribute('data-icon')
            || ih.getAttribute('data-iconify-name')
            || '';
          if (raw && raw.length > 0 && raw.length <= 50) {
            // Strip namespace prefix like "mdi:menu" -> "menu", "fa-bars" -> "bars".
            var cleaned = raw.replace(/^[a-z0-9]+[:-]/i, '').replace(/[-_]/g, ' ').trim();
            if (cleaned.length > 0) iconLabelAttr = cleaned;
          }
        }
      }
      // ⑤ <i class="fa-solid fa-bars">  — FontAwesome class-based icons.
      // Pull the FA name token (fa-bars, fa-trash, fa-pencil) which is the
      // closest thing to a semantic name FA exposes for old class-based usage.
      if (!iconLabelAttr) {
        var iElem = (tag === 'i') ? target : target.querySelector('i[class]');
        if (iElem) {
          var iCls = iElem.getAttribute('class') || '';
          var faMatch = iCls.match(/\bfa[-]([a-z][a-z0-9-]+)\b/i);
          if (faMatch && faMatch[1]) {
            var faName = faMatch[1].replace(/-/g, ' ').trim();
            if (faName.length > 0 && faName.length <= 30
                // Skip FA size/style modifiers ("solid", "regular", "lg", "2x")
                && !/^(solid|regular|brands|light|thin|duotone|fw|sm|lg|xl|2x|3x|4x|5x|spin|pulse|inverse|stack)$/i.test(faName)) {
              iconLabelAttr = faName;
            }
          }
        }
      }
      // ⑥ background-image: url(/icons/hamburger.svg)  — last resort.
      // Cheap heuristic: parse the URL filename. Skip data:URIs (encoded svgs
      // have no semantic name) and svg-sprite hashes (data-v-XXX pattern).
      if (!iconLabelAttr) {
        try {
          var bgImage = window.getComputedStyle(target).backgroundImage;
          if (bgImage && bgImage !== 'none' && bgImage.indexOf('url(') === 0) {
            var bgUrl = bgImage.slice(4, -1).replace(/^["']|["']$/g, '');
            if (bgUrl.indexOf('data:') !== 0) {
              var bgFile = bgUrl.split('/').pop() || '';
              var bgName = bgFile.replace(/\.(svg|png|jpe?g|webp|gif)(\?.*)?$/i, '').replace(/[-_]/g, ' ').trim();
              if (bgName.length > 1 && bgName.length <= 40 && !/^[a-f0-9]{8,}$/i.test(bgName)) {
                iconLabelAttr = bgName;
              }
            }
          }
        } catch (e) { /* CSS parsing best-effort */ }
      }
    } catch (e) { /* svg/icon mining failed — skip silently */ }
  }

  // V22 Pkg2 — Bootstrap markers (data-bs-toggle / data-bs-target).
  // Walk the target itself + up to 3 parents — Bootstrap puts these on
  // either the trigger button OR an ancestor wrapper depending on the
  // helper used (data-bs-toggle="modal" vs collapse, etc).
  var bsToggleAttr = undefined;
  var bsTargetAttr = undefined;
  var bsWalk = target;
  for (var bsi = 0; bsi < 3 && bsWalk; bsi++) {
    if (!bsToggleAttr) {
      var t = bsWalk.getAttribute('data-bs-toggle') || bsWalk.getAttribute('data-toggle') || '';
      if (t && t.length > 0 && t.length < 30) bsToggleAttr = t;
    }
    if (!bsTargetAttr) {
      var tt = bsWalk.getAttribute('data-bs-target') || bsWalk.getAttribute('data-target') || '';
      if (tt && tt.length > 0 && tt.length < 200) bsTargetAttr = tt;
    }
    if (bsToggleAttr && bsTargetAttr) break;
    bsWalk = bsWalk.parentElement;
  }

  // V22 Pkg2 — aria-haspopup. W3C spec values: menu | listbox | tree |
  // grid | dialog | true | false. We keep the raw string so the resolver
  // can match recorded "open menu" to live aria-haspopup=menu triggers.
  var ariaHasPopupAttr = target.getAttribute('aria-haspopup') || undefined;

  // V22 Pkg2 — aria-activedescendant. Combobox/Listbox/Tree typeahead
  // points to the focused descendant via this attribute; capturing it lets
  // replay distinguish "press Enter on the highlighted suggestion" from
  // "press Enter on the input itself".
  var ariaActiveDescendantAttr = target.getAttribute('aria-activedescendant') || undefined;

  // V22 Pkg2 — data-row-key (Ant Design Table) / data-rk (RainbowKit).
  // Stable identity for table rows that survives re-render and pagination.
  // Walk up to 3 parents — usually placed on <tr> while click lands on <td>.
  var dataRowKeyAttr = undefined;
  var rkWalk = target;
  for (var rki = 0; rki < 4 && rkWalk; rki++) {
    var rk = rkWalk.getAttribute('data-row-key') || rkWalk.getAttribute('data-rk') || '';
    if (rk && rk.length > 0 && rk.length < 100) {
      dataRowKeyAttr = rk;
      break;
    }
    rkWalk = rkWalk.parentElement;
  }

  // V22 Pkg2 — clickable-row heuristic. MUI / AntD / Element Plus tables
  // render rows clickable via CSS hover + JS handler without role/onclick.
  // Probe detects this via two signals: (a) tag is tr, (b) cursor:pointer
  // OR class contains hover/clickable token. Sets rowClickable flag so
  // resolver can elevate the row from a passive container to a candidate.
  var rowClickableFlag = undefined;
  if (tag === 'tr') {
    try {
      var trCursor = getComputedStyle(target).cursor;
      var trClass = target.getAttribute('class') || '';
      var hoverishClass = /\b(hover|clickable|MuiTableRow-hover|ant-table-row|el-table__row|row-clickable)\b/i.test(trClass);
      if (trCursor === 'pointer' || hoverishClass) {
        rowClickableFlag = true;
      }
    } catch (e) {}
  }

  // V22 Pkg5 — nearestRowText. Concatenates sibling-cell text inside the
  // closest row container so descriptor-poor row checkboxes/buttons get
  // unique identity from the row's payload (name / id / amount / etc).
  // Cells containing the target itself are excluded so we don't echo back
  // the empty checkbox we're trying to identify.
  var nearestRowTextAttr = undefined;
  try {
    var rowContainer = target.closest('tr, [role="row"], li[role="option"], li.list-row, li.list-item');
    if (rowContainer && rowContainer !== target) {
      var cellNodes = rowContainer.querySelectorAll('td, th, [role="cell"], [role="gridcell"]');
      // Some layouts (li-based grids) don't have td/th — fall back to direct
      // children of the row. Cap at 8 to keep extraction cheap.
      var cellList = cellNodes.length > 0
        ? Array.prototype.slice.call(cellNodes, 0, 8)
        : Array.prototype.slice.call(rowContainer.children, 0, 8);
      var cellTexts = [];
      for (var ci = 0; ci < cellList.length && cellTexts.length < 4; ci++) {
        var cellEl = cellList[ci];
        if (cellEl.contains(target)) continue; // skip the cell holding the target
        // V22 Pkg7+: normalize each cell text symmetrically with probe+heal.
        var cellText = normProbeText(cellEl.innerText != null ? cellEl.innerText : cellEl.textContent) || '';
        // Min 2 chars filters checkbox-only cells; max 80 trims long blurbs.
        if (cellText.length >= 2 && cellText.length <= 80) {
          cellTexts.push(cellText);
        }
      }
      if (cellTexts.length > 0) {
        // V22 Pkg7+: U+241F (Information Separator One) — never appears in
        // real DOM text, so cell-separator collisions are impossible even
        // when cells contain literal " | ". Symmetric with snapshot+heal.
        nearestRowTextAttr = cellTexts.join('␟').slice(0, 200);
      }
    }
  } catch (e) { /* row-text extraction best-effort */ }

  // V22 Pkg5 — siblingIndex. nth-of-type-style index among same-class
  // siblings of the same parent. Critical for pagination prev/next twins,
  // tab strips, and identical button groups where attribute identity is
  // missing. Bounded to 2..10 siblings: <2 means no ambiguity, >10 means
  // we're in a huge list where positional locators are too brittle.
  var siblingIndexAttr = undefined;
  try {
    var firstClassToken = (target.getAttribute('class') || '').trim().split(/\s+/)[0] || '';
    // Skip dynamic/utility classes — anchoring on jss123 / sc-XXX is brittle.
    var skipClassRx = /^(jss\d+|sc-[a-zA-Z0-9]{6,}|css-[a-z0-9]{6,}|makeStyles-)/;
    if (firstClassToken && firstClassToken.length >= 2 && !skipClassRx.test(firstClassToken)) {
      var sibParent = target.parentElement;
      if (sibParent) {
        // Querying with escaped class lets us include CSS Modules names
        // like dg_uikit_root_xxx — they're stable per-build and the index
        // (0..N) is what we use, the class itself isn't stored.
        var safeCls = (typeof CSS !== 'undefined' && CSS.escape)
          ? CSS.escape(firstClassToken)
          : firstClassToken.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        var sibs = sibParent.querySelectorAll(':scope > .' + safeCls);
        if (sibs.length >= 2 && sibs.length <= 10) {
          for (var sii = 0; sii < sibs.length; sii++) {
            if (sibs[sii] === target) { siblingIndexAttr = sii; break; }
          }
        }
      }
    }
  } catch (e) { /* sibling index extraction best-effort */ }

  // V22 Pkg5 — disabled boolean. Combined signal from disabled attribute,
  // aria-disabled, and well-known disabled class tokens. Recorded as the
  // captured state so heal-time can boost match when live state agrees
  // (distinguishes pagination prev/next when only one is enabled).
  var disabledAttr = undefined;
  try {
    // Audit fix: emit boolean (true OR false) for ANY form-ish element so
    // pagination prev=disabled vs next=enabled can be distinguished. The
    // earlier rawDisabled-only gate was too tight — it skipped emission
    // for enabled buttons, breaking the very twin disambiguation Pkg5
    // was meant to fix.
    var isFormish = /^(button|input|select|textarea|fieldset|optgroup|option|a)$/.test(tag)
      || target.getAttribute('role') === 'button'
      || target.getAttribute('role') === 'link';
    if (isFormish) {
      var rawDisabled = target.hasAttribute('disabled')
        || target.getAttribute('aria-disabled') === 'true';
      if (!rawDisabled) {
        var clsForDis = ' ' + (target.getAttribute('class') || '') + ' ';
        if (/\s(?:Mui-disabled|is-disabled|el-button--disabled|ant-btn-disabled|disabled)\s/.test(clsForDis)) {
          rawDisabled = true;
        }
      }
      disabledAttr = !!rawDisabled;
    }
  } catch (e) { /* disabled detection best-effort */ }

  // V22 Pkg5 — arrowDir. Cheap heuristic that infers cardinal direction
  // from the first svg <path d=...> by comparing the M (move) and L (line)
  // anchor coords. Only set for descriptor-poor svg-only buttons (no
  // testId / aria-label / text / iconLabel) — same gate as Pkg4 iconLabel.
  // Used as candidateText hint for the LLM resolver and as iconLabel
  // fallback in fingerprint scoring.
  var arrowDirAttr = undefined;
  if (!hasOwnDescriptor && !iconLabelAttr) {
    try {
      var pathSvg = (tag === 'svg') ? target : target.querySelector('svg');
      var firstPath = pathSvg ? pathSvg.querySelector('path[d]') : null;
      var d = firstPath ? (firstPath.getAttribute('d') || '') : '';
      if (d.length > 0 && d.length < 500) {
        var mMatch = d.match(/M\s*([-\d.]+)[\s,]+([-\d.]+)/);
        var lMatch = d.match(/L\s*([-\d.]+)[\s,]+([-\d.]+)/);
        if (mMatch && lMatch) {
          var mx = parseFloat(mMatch[1]), my = parseFloat(mMatch[2]);
          var lx = parseFloat(lMatch[1]), ly = parseFloat(lMatch[2]);
          var dx = lx - mx, dy = ly - my;
          // Pick the dominant axis; require ≥3 unit delta to avoid noise.
          if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= 3) {
            arrowDirAttr = dx < 0 ? 'left' : 'right';
          } else if (Math.abs(dy) >= 3) {
            arrowDirAttr = dy < 0 ? 'up' : 'down';
          }
        }
      }
    } catch (e) { /* svg path parsing best-effort */ }
  }

  return {
    tag: tag,
    // computeRole returns the explicit role attribute when present,
    // otherwise the implicit W3C role for the tag — see the COMPUTE_ROLE_SRC
    // helper at the top of the file. Previously we only read
    // getAttribute('role'), which is null for native elements and forced the
    // locator plan builder to skip role-based strategies entirely.
    role: computeRole(target),
    type: target.getAttribute('type') || undefined,
    // Use innerText so hidden/script/style children don't leak into the
    // step description or binding hints (hints.text flows to the resolver's
    // LLM prompt at replay time). Fall back to textContent for SVG and
    // other non-HTMLElement nodes where innerText is undefined.
    // V22 Pkg7+: normalize so re-renders with NFD-encoded characters or
    // copied-text zero-width contamination still produce equal fingerprints.
    text: ((normProbeText(target.innerText != null ? target.innerText : target.textContent) || '').slice(0, 80) || undefined),
    ariaLabel: normProbeText(target.getAttribute('aria-label')) || undefined,
    labelText: labelText,
    placeholder: normProbeText(target.getAttribute('placeholder')) || undefined,
    name: target.getAttribute('name') || undefined,
    ref: target.getAttribute('data-agent-ref') || undefined,
    title: titleAttr,
    alt: altAttr,
    testId: testId,
    elementId: elementId,
    cssClass: cssClass,
    ariaControls: ariaControls,
    href: hrefAttr,
    vueScopeId: vueScopeId,
    nearestLandmark: nearestLandmark,
    containerTitles: containerTitles,
    ancestorSummary: ancestorSummary,
    checked: (tag === 'input' && (target.type === 'checkbox' || target.type === 'radio')) ? target.checked : undefined,
    ariaExpanded: ae === 'true' ? true : ae === 'false' ? false : undefined,
    ariaPressed: ap === 'true' ? true : ap === 'false' ? false : undefined,
    ariaInvalid: ai,
    // V22 Pkg1 — extracted above. Each is undefined when not applicable so
    // bindingHints/fingerprint stay sparse (no zero-value noise).
    ariaCurrent: ariaCurrentAttr,
    ariaValueNow: ariaValueNum,
    ariaValueText: ariaValueTextAttr,
    dataValue: dataValueAttr,
    childTestId: childTestIdAttr,
    iconLabel: iconLabelAttr,
    // V22 Pkg2 — Bootstrap / aria-haspopup / activedescendant / row-key / clickable-row.
    bsToggle: bsToggleAttr,
    bsTarget: bsTargetAttr,
    ariaHasPopup: ariaHasPopupAttr,
    ariaActiveDescendant: ariaActiveDescendantAttr,
    dataRowKey: dataRowKeyAttr,
    rowClickable: rowClickableFlag,
    // V22 Pkg5 — row text + sibling index + disabled state + svg arrow direction.
    nearestRowText: nearestRowTextAttr,
    siblingIndex: siblingIndexAttr,
    disabled: disabledAttr,
    arrowDir: arrowDirAttr,
    isMultiline: isMultiline || undefined,
    containerText: containerText,
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    resolvedVia: resolvedVia,
    // V22: Always return chain — ancestorSummary uses it for persistence,
    // and the resolver can lean on it for any resolvedVia. Earlier gating
    // to directHit/cssClass left icon targets (cursorPointer/nativeTag)
    // without ancestor context exactly when they needed it most.
    ancestorChain: ancestorChain
  };
})
`;

const PROBE_FOCUSED_FN = `
(function() {
  var el = document.activeElement;
  if (!el || el === document.body) return null;

  ${COMPUTE_ROLE_SRC}

  // V22 Pkg7+: same in-probe text normalizer as PROBE_AT_POINT_FN.
  // NFC + invisible-char strip + whitespace collapse — symmetry contract.
  var INVISIBLE_CHARS_RE_PROBE = /[​-‏‪-‮⁠-⁩﻿]/g;
  function normProbeText(s) {
    if (s === undefined || s === null) return undefined;
    if (s.length === 0) return '';
    var out = s;
    try { out = out.normalize('NFC'); } catch (e) { /* ancient browsers */ }
    return out
      .replace(INVISIBLE_CHARS_RE_PROBE, '')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  var target = el;
  var tag = target.tagName.toLowerCase();
  var labelText = undefined;
  if (target.labels && target.labels.length > 0) {
    labelText = (normProbeText(target.labels[0].textContent || '') || '').slice(0, 100) || undefined;
  }
  if (!labelText) {
    var lby = target.getAttribute('aria-labelledby');
    if (lby) {
      var lel = document.getElementById(lby);
      if (lel) labelText = (normProbeText(lel.textContent || '') || '').slice(0, 100) || undefined;
    }
  }

  var rect = target.getBoundingClientRect();
  var ae = target.getAttribute('aria-expanded');
  var ap = target.getAttribute('aria-pressed');
  // V22: aria-invalid (or :invalid native pseudo for inputs). Records the
  // validation state at the moment of capture so negative-flow tests
  // ("user clicked invalid field → red border") replay against the same
  // visual state, not a freshly-cleared field.
  var aiAttr = target.getAttribute('aria-invalid');
  var ai = aiAttr === 'true' ? true : aiAttr === 'false' ? false : undefined;
  if (ai === undefined && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
    try { if (target.matches && target.matches(':invalid')) ai = true; } catch (e) {}
  }

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
    // See PROBE_AT_POINT_FN for rationale: computeRole returns the implicit
    // W3C role when no explicit role attribute is set, so the locator plan
    // builder can emit getByRole() strategies for native HTML elements.
    role: computeRole(target),
    type: target.getAttribute('type') || undefined,
    // innerText over textContent — hides <script>/<style>/<template> and
    // display:none children that would otherwise leak into hints.text.
    // V22 Pkg7+: normProbeText normalizes for fingerprint stability.
    text: ((normProbeText(target.innerText != null ? target.innerText : target.textContent) || '').slice(0, 80) || undefined),
    ariaLabel: normProbeText(target.getAttribute('aria-label')) || undefined,
    labelText: labelText,
    placeholder: normProbeText(target.getAttribute('placeholder')) || undefined,
    name: target.getAttribute('name') || undefined,
    ref: target.getAttribute('data-agent-ref') || undefined,
    title: normProbeText(target.getAttribute('title')) || undefined,
    alt: target.getAttribute('alt') || undefined,
    checked: (tag === 'input' && (target.type === 'checkbox' || target.type === 'radio')) ? target.checked : undefined,
    ariaExpanded: ae === 'true' ? true : ae === 'false' ? false : undefined,
    ariaPressed: ap === 'true' ? true : ap === 'false' ? false : undefined,
    ariaInvalid: ai,
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
      // V22: include id/testId so LLM can prefer ancestors with stable
      // identifiers ("button#login-submit" beats "div.flex" any day).
      const chainDescription = chain.map((n, i) =>
        `[${i}] <${n.tag}>`
        + (n.testId ? ` data-testid="${n.testId}"` : '')
        + (n.id ? ` id="${n.id}"` : '')
        + (n.role ? ` role="${n.role}"` : '')
        + (n.ariaLabel ? ` aria-label="${n.ariaLabel}"` : '')
        + (n.className ? ` class="${n.className}"` : '')
        + (n.text ? ` text="${n.text.slice(0, 30)}"` : '')
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

          ${COMPUTE_ROLE_SRC}

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
          // V22: aria-invalid for re-probe path (see PROBE_AT_POINT for rationale).
          var aiAttr = walk.getAttribute('aria-invalid');
          var ai = aiAttr === 'true' ? true : aiAttr === 'false' ? false : undefined;
          if (ai === undefined && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
            try { if (walk.matches && walk.matches(':invalid')) ai = true; } catch (e) {}
          }
          var isMultiline = tag === 'textarea'
            || walk.getAttribute('contenteditable') === 'true'
            || walk.getAttribute('contenteditable') === ''
            || (walk.getAttribute('role') === 'textbox' && walk.getAttribute('aria-multiline') === 'true');
          return {
            tag: tag,
            role: computeRole(walk),
            type: walk.getAttribute('type') || undefined,
            // innerText skips <script>/<style> and hidden children (see
            // the identical comment on PROBE_CLICK_FN above).
            text: ((walk.innerText != null ? walk.innerText : walk.textContent) || '').trim().slice(0, 80) || undefined,
            ariaLabel: walk.getAttribute('aria-label') || undefined,
            labelText: labelText,
            placeholder: walk.getAttribute('placeholder') || undefined,
            name: walk.getAttribute('name') || undefined,
            ref: walk.getAttribute('data-agent-ref') || undefined,
            checked: (tag === 'input' && (walk.type === 'checkbox' || walk.type === 'radio')) ? walk.checked : undefined,
            ariaExpanded: ae === 'true' ? true : ae === 'false' ? false : undefined,
            ariaPressed: ap === 'true' ? true : ap === 'false' ? false : undefined,
            ariaInvalid: ai,
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
   * Single source of truth for human-readable element labels.
   *
   * Matches the hover-highlight logic (preview-session.service.ts:probeInteractiveElementAt):
   * `text` is used for ALL tags, not just a/button/summary. This is what makes hover show
   * "Войти" for a <div>Войти</div> — the recorder now does the same.
   *
   * Returns `null` when the best candidate would be the literal tag name (e.g. "div", "svg").
   * Callers decide how to render that — typically as 'element' placeholder, which signals to
   * the user that the step is fragile. Background LLM refinement (preview.handler.ts:2154)
   * typically upgrades the step to a better ancestor within 1–2 seconds of the click.
   */
  static getProbedLabel(element: ProbedElement | null, maxLen = 60): string | null {
    if (!element) return null;
    // Candidates are tried in priority order. We skip values that collapse
    // to empty OR to the element's own tag name. For free-text fields
    // (`text`, `labelText`, `alt`, `title`, `placeholder`, `name`) we also
    // skip bare layout-tag-name leaf text because it's almost always noise
    // from stray `<div>div</div>` fragments or leaked `<style>` content.
    //
    // We deliberately do NOT filter `role`, `ariaLabel`, or `testId`:
    // those are intentional semantic labels where "button"/"link"/"nav"
    // are the CORRECT answer (e.g. `role="button"` on a <div> should yield
    // "button", not fall through to 'element').
    const TAG_LIKE_NOISE = new Set([
      'div', 'span', 'a', 'button', 'img', 'svg', 'i', 'p', 'li', 'ul', 'ol',
      'section', 'article', 'header', 'footer', 'nav', 'main', 'aside',
    ]);
    const elTagLc = (element.tag || '').toLowerCase();
    // Tuples of (value, isFreeText) — only free-text fields get the noise filter.
    // V22: elementId added below testId (also intentional, framework-filtered).
    // For Element Plus / Ant Design icon-only elements (svg/i with no text/aria),
    // a stable id like `layout-header-setting` is the only meaningful label —
    // without it the user sees `'element'` and can't tell what was clicked.
    // The probe already strips framework-generated ids (el-id-*, radix-*, useId,
    // UUIDs, MUI/Headless UI prefixes), so what reaches us here is human-named.
    const candidates: Array<[string | undefined, boolean]> = [
      [element.ariaLabel, false],
      [element.labelText, true],
      [element.text, true],
      [element.alt, true],         // <img alt="…">
      [element.title, true],       // icon-only buttons with tooltip
      [element.placeholder, true],
      [element.name, true],
      [element.testId, false],
      [element.elementId, false],  // V22: stable id (e.g. "layout-header-setting")
      // V22 Pkg1: child icon testid for IconButton-shaped targets where the
      // semantic name lives on the descendant svg/i/img (e.g. MUI's
      // `VisibilityOffOutlinedIcon`). Promoted only when the target itself
      // had no descriptor — see probe-side hasOwnDescriptor gate.
      [element.childTestId, false],
      // V22 Pkg4: icon-library / svg-internal label (Lucide / Feather /
      // FA / SVG <title>). Last identifier-style fallback before role —
      // for icon-only buttons WITHOUT data-testid (FA class buttons,
      // sprite-based icons, accessible <svg><title> patterns).
      [element.iconLabel, false],
      [element.role, false],
    ];
    for (const [c, isFreeText] of candidates) {
      if (!c) continue;
      const trimmed = c.trim();
      if (!trimmed) continue;
      const lc = trimmed.toLowerCase();
      if (lc === elTagLc) continue; // always skip self-referential noise
      if (isFreeText && TAG_LIKE_NOISE.has(lc)) continue;
      return trimmed.slice(0, maxLen);
    }
    return null;
  }

  static getElementLabel(element: ProbedElement | null): string {
    return this.getProbedLabel(element, 60) || 'element';
  }

  /**
   * Build a human-readable description for a recorded step.
   * Priority: ariaLabel > labelText > text > alt > title > placeholder > name > testId > role.
   * Falls back to 'element' when the probe yielded nothing more specific than the tag name.
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

    const shortLabel = this.getProbedLabel(element, 60) || 'element';

    // For label-only actions, omit the action-type prefix: the UI already renders
    // the action type in its own field, so including it in the description would
    // double up (e.g. "Click 'Foo'" shown next to an action badge that also says "Click").
    switch (actionType) {
      case 'click':
      case 'dblclick':
      case 'contextmenu':
      case 'check':
      case 'uncheck':
      case 'open':
      case 'close':
      case 'toggle':
      case 'drag_and_drop':
        return `'${shortLabel}'`;
      case 'type':
        return value
          ? `Type '${value.slice(0, 40)}' in '${shortLabel}'`
          : `Type in '${shortLabel}'`;
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
      case 'upload':
        return `Upload file to '${shortLabel}'`;
      default:
        return `'${shortLabel}'`;
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
    // V18: Use title as nearText fallback for icon-only buttons (e.g. <div title="Attach file">📎</div>)
    if (element.title && !hints.nearText) hints.nearText = element.title;
    if (element.type) hints.type = element.type;
    // V22: keep `name` separate from `autocomplete` — they had been collapsed
    // for legacy reasons but the resolver wants both (autocomplete is a
    // semantic hint, name is a stable identifier on form fields).
    if (element.name) {
      hints.name = element.name;
      if (!hints.autocomplete) hints.autocomplete = element.name;
    }
    // V15: Add text content and tag for better LLM resolution at replay time
    if (element.text) hints.text = element.text;
    if (element.tag) hints.tag = element.tag;
    // V22: alt — fallback identifier for <img> targets.
    if (element.alt) hints.alt = element.alt;
    // V18: data-testid as stable identifier — highest confidence for element matching at replay
    if (element.testId) hints.testId = element.testId;
    // V22: id / className / aria-controls / href / vueScopeId — additional
    // locator signals for icon-only elements (svg/img/i) where text-based
    // strategies fail. id alone resolves Element Plus / Ant Design icons
    // that ship without aria-label (`#layout-header-setting` etc.).
    if (element.elementId) hints.elementId = element.elementId;
    if (element.cssClass) hints.cssClass = element.cssClass;
    if (element.ariaControls) hints.ariaControls = element.ariaControls;
    if (element.href) hints.href = element.href;
    if (element.vueScopeId) hints.vueScopeId = element.vueScopeId;
    // V22: ancestorSummary, nearestLandmark, containerTitles — provide
    // disambiguation context when the same label recurs across page
    // sections. Resolver weights these as soft hints, not hard filters.
    if (element.nearestLandmark) hints.nearestLandmark = element.nearestLandmark;
    if (element.containerTitles && element.containerTitles.length > 0) {
      hints.containerTitles = element.containerTitles.slice(0, 2);
    }
    if (element.ancestorSummary) hints.ancestorSummary = element.ancestorSummary;
    // V22: ARIA state at recording time. Differentiates "click toggle when
    // expanded" from "click toggle when collapsed" — same locator but
    // different intent. Skipped when no relevant state was set on the target.
    const ariaState: BindingHints['ariaState'] = {};
    if (element.ariaExpanded !== undefined) ariaState.expanded = element.ariaExpanded;
    if (element.ariaPressed !== undefined) ariaState.pressed = element.ariaPressed;
    if (element.checked !== undefined) ariaState.checked = element.checked;
    if (element.ariaInvalid !== undefined) ariaState.invalid = element.ariaInvalid;
    // V22 Pkg1: aria-current / aria-valuenow / aria-valuetext.
    if (element.ariaCurrent) ariaState.current = element.ariaCurrent;
    if (element.ariaValueNow !== undefined) ariaState.valueNow = element.ariaValueNow;
    if (element.ariaValueText) ariaState.valueText = element.ariaValueText;
    if (Object.keys(ariaState).length > 0) hints.ariaState = ariaState;
    // V22 Pkg1: data-value / child icon testid.
    if (element.dataValue) hints.dataValue = element.dataValue;
    if (element.childTestId) hints.childTestId = element.childTestId;
    // V22 Pkg4: semantic icon name (Lucide/Feather/FA/SVG title).
    if (element.iconLabel) hints.iconLabel = element.iconLabel;
    // V22 Pkg2: Bootstrap / aria-haspopup / activedescendant / row key.
    if (element.bsToggle) hints.bsToggle = element.bsToggle;
    if (element.bsTarget) hints.bsTarget = element.bsTarget;
    if (element.ariaHasPopup) hints.ariaHasPopup = element.ariaHasPopup;
    if (element.ariaActiveDescendant) hints.ariaActiveDescendant = element.ariaActiveDescendant;
    if (element.dataRowKey) hints.dataRowKey = element.dataRowKey;
    // V22 Pkg5: row text + sibling index + disabled + arrow direction.
    if (element.nearestRowText) hints.nearestRowText = element.nearestRowText;
    if (element.siblingIndex !== undefined) hints.siblingIndex = element.siblingIndex;
    if (element.disabled !== undefined) hints.disabled = element.disabled;
    if (element.arrowDir) hints.arrowDir = element.arrowDir;
    return hints;
  }

  /**
   * V22: Build a `TargetFingerprint` snapshot from a probed element AT
   * RECORDING TIME. Distinct from `buildTargetFingerprint` in
   * locator-plan-builder.service.ts (which builds the fingerprint from a
   * resolved live DOM node at apply time).
   *
   * Why both exist:
   *   - Recorded fingerprint travels with the step from the moment of
   *     capture, so the LLM resolver has identifying data even on the
   *     FIRST apply (before any compiled plan exists).
   *   - Live-DOM fingerprint reflects what was actually executed and is
   *     used by the heal-time comparator to detect drift.
   *
   * The two should agree on shape (same TargetFingerprint type) so the
   * resolver and comparator can read either one transparently.
   */
  static buildRecordedFingerprint(element: ProbedElement): TargetFingerprint {
    const fp: TargetFingerprint = {};
    if (element.tag) fp.tag = element.tag;
    if (element.role) fp.role = element.role;
    if (element.labelText) fp.labelText = element.labelText;
    if (element.ariaLabel) fp.ariaLabel = element.ariaLabel;
    if (element.testId) fp.testIdAttr = element.testId;
    if (element.placeholder) fp.placeholder = element.placeholder;
    if (element.boundingBox) fp.boundingBox = element.boundingBox;
    if (element.containerTitles && element.containerTitles.length > 0) {
      fp.containerTitles = element.containerTitles.slice(0, 3);
    }
    if (element.nearestLandmark) fp.nearestLandmark = element.nearestLandmark;
    // V22: extra identifiers (id / classes / framework markers).
    if (element.title) fp.title = element.title;
    if (element.alt) fp.alt = element.alt;
    if (element.text) fp.text = element.text;
    if (element.elementId) fp.elementId = element.elementId;
    if (element.cssClass) fp.cssClass = element.cssClass;
    if (element.ariaControls) fp.ariaControls = element.ariaControls;
    if (element.href) fp.href = element.href;
    if (element.vueScopeId) fp.vueScopeId = element.vueScopeId;
    if (element.name) fp.name = element.name;
    if (element.type) fp.type = element.type;
    if (element.ancestorSummary) fp.ancestorSummary = element.ancestorSummary;
    const ariaState: NonNullable<TargetFingerprint['ariaState']> = {};
    if (element.ariaExpanded !== undefined) ariaState.expanded = element.ariaExpanded;
    if (element.ariaPressed !== undefined) ariaState.pressed = element.ariaPressed;
    if (element.checked !== undefined) ariaState.checked = element.checked;
    if (element.ariaInvalid !== undefined) ariaState.invalid = element.ariaInvalid;
    // V22 Pkg1: aria-current / valueNow / valueText.
    if (element.ariaCurrent) ariaState.current = element.ariaCurrent;
    if (element.ariaValueNow !== undefined) ariaState.valueNow = element.ariaValueNow;
    if (element.ariaValueText) ariaState.valueText = element.ariaValueText;
    if (Object.keys(ariaState).length > 0) fp.ariaState = ariaState;
    // V22 Pkg1: data-value / child icon testid.
    if (element.dataValue) fp.dataValue = element.dataValue;
    if (element.childTestId) fp.childTestId = element.childTestId;
    // V22 Pkg4: semantic icon name for heal-time identity match.
    if (element.iconLabel) fp.iconLabel = element.iconLabel;
    // V22 Pkg2: Bootstrap / aria-haspopup / activedescendant / row key.
    if (element.bsToggle) fp.bsToggle = element.bsToggle;
    if (element.bsTarget) fp.bsTarget = element.bsTarget;
    if (element.ariaHasPopup) fp.ariaHasPopup = element.ariaHasPopup;
    if (element.ariaActiveDescendant) fp.ariaActiveDescendant = element.ariaActiveDescendant;
    if (element.dataRowKey) fp.dataRowKey = element.dataRowKey;
    // V22 Pkg5: row text + sibling index + disabled + arrow direction.
    if (element.nearestRowText) fp.nearestRowText = element.nearestRowText;
    if (element.siblingIndex !== undefined) fp.siblingIndex = element.siblingIndex;
    if (element.disabled !== undefined) fp.disabled = element.disabled;
    if (element.arrowDir) fp.arrowDir = element.arrowDir;
    return fp;
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
      // V13: Mark as auto-injected so runtime executor can apply the
      // page-settle fallback when replay behaves differently from recording
      // (e.g. i18n toggle, feature flag, A/B bucket, cached state).
      isAutoInjected: true,
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
        // V15.7: Timestamp so evidence TTL check can reject stale refs on replay
        capturedAt: new Date().toISOString(),
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
        capturedAt: new Date().toISOString(), // V15.7: TTL support
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
    containerSelector?: string | null,
  ): PreviewIntentStep | null {
    if (accumulatedDeltaY === 0 && (!accumulatedDeltaX || accumulatedDeltaX === 0)) return null;

    // V15: Filter micro-scrolls (trackpad noise, accidental touch)
    const totalMagnitude = Math.abs(accumulatedDeltaY) + Math.abs(accumulatedDeltaX || 0);
    if (totalMagnitude < this.SCROLL_MIN_THRESHOLD_PX) return null;

    const isContainerScroll = !!containerSelector;
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
      description: isContainerScroll
        ? `Scroll container ${parts.join(', ')}`
        : `Scroll ${parts.join(', ')}`,
      value: deltaXRounded !== 0 ? `${deltaYRounded},${deltaXRounded}` : String(deltaYRounded),
      // V15: If we found a target element after scroll, attach hints so replay can use scrollIntoView
      ...(scrollTargetHints && Object.keys(scrollTargetHints).length > 0 && { bindingHints: scrollTargetHints }),
      evidence: { confidence: 1.0, pageUrl },
      // Container scroll: store selector for replay to target the right element
      ...(containerSelector && { options: { scrollContainer: containerSelector } }),
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
          ${COMPUTE_ROLE_SRC}
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
            // innerText to avoid pulling in hidden/script/style descendants
            // when LLM falls back to a nearby element.
            text: ((best.innerText != null ? best.innerText : best.textContent) || '').trim().slice(0, 80) || undefined,
            role: computeRole(best),
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

  /**
   * Detect if wheel event at (x,y) targets a scrollable container (not the page itself).
   * Returns a CSS selector for the container, or null if page-level scroll.
   *
   * Walks up from elementFromPoint(x,y) to find nearest ancestor with overflow:auto/scroll
   * and scrollHeight > clientHeight (actually scrollable, not just styled).
   */
  static async detectScrollContainer(page: Page, x: number, y: number): Promise<string | null> {
    try {
      return await page.evaluate(`
        (function() {
          var el = document.elementFromPoint(${x}, ${y});
          if (!el) return null;

          var current = el;
          while (current && current !== document.documentElement && current !== document.body) {
            var style = window.getComputedStyle(current);
            var overflowY = style.overflowY;
            var overflowX = style.overflowX;
            var isScrollable =
              ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight + 10) ||
              ((overflowX === 'auto' || overflowX === 'scroll') && current.scrollWidth > current.clientWidth + 10);

            if (isScrollable) {
              var id = current.getAttribute('id');
              if (id) return '#' + CSS.escape(id);

              var testId = current.getAttribute('data-testid');
              if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';

              var role = current.getAttribute('role');
              var ariaLabel = current.getAttribute('aria-label');
              if (role && ariaLabel) return '[role="' + role + '"][aria-label="' + CSS.escape(ariaLabel) + '"]';

              var tag = current.tagName.toLowerCase();
              var parent = current.parentElement;
              if (parent) {
                var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
                var idx = siblings.indexOf(current) + 1;
                if (siblings.length === 1) return tag;
                return tag + ':nth-of-type(' + idx + ')';
              }
              return tag;
            }
            current = current.parentElement;
          }
          return null;
        })()
      `) as string | null;
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
    // V22: Include recordedFingerprint so resolver has identifying data on
    // first apply (mirrors the click-step path in preview.handler.ts).
    const recFp = this.buildRecordedFingerprint(element);
    return {
      id: recStepId(),
      type: 'hover',
      description: `Hover '${label}'`,
      bindingHints: this.buildBindingHints(element) as BindingHints | undefined,
      recordedFingerprint: Object.keys(recFp).length > 0 ? recFp : undefined,
      evidence: {
        ...(element.ref && { lastSuccessRef: element.ref }),
        confidence: 1.0,
        pageUrl,
        capturedAt: new Date().toISOString(), // V15.7: TTL support
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
      // V22: travel the fingerprint through buffer → step. Buffer was
      // populated with the focused input's probe snapshot at focus time
      // (preview.handler.ts focus path), so on flush we hand it to the step.
      recordedFingerprint: buffer.recordedFingerprint,
      ...(Object.keys(opts).length > 0 && { options: opts }),
      evidence: {
        ...(buffer.elementRef && { lastSuccessRef: buffer.elementRef }),
        confidence: 1.0,
        pageUrl: buffer.pageUrl,
        capturedAt: new Date().toISOString(), // V15.7: TTL support
      },
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
              // Clear after 2000ms — must exceed typing debounce (1500ms) to prevent
              // browser 'change' events from being misclassified as autofill
              if (clearTimer) clearTimeout(clearTimer);
              clearTimer = setTimeout(() => recentKeyboardInputs.clear(), 2000);
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
