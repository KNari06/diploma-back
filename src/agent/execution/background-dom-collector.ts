/**
 * Background DOM Collector
 *
 * Lightweight utility to extract InteractiveNode[] from a Playwright Page
 * for use in background/CI test execution (without preview session dependency).
 *
 * Features:
 * - Collects interactive elements with all attributes needed for resolution
 * - Injects temporary data-agent-ref attributes for targeting
 * - No preview session or WebSocket dependency
 * - Compatible with LLM-based element resolution
 */

import type { LiteElement } from '@/agent/core/lite/lite-types';
import { SNAPSHOT_ROUTER_FLAGS } from '@/config/testing/snapshot-router.config';
import { LANDMARK_EVALUATE_BUNDLE } from '@/services/testing/ui/preview/landmark.util';
import type { InteractiveNode } from '@/services/testing/ui/preview/preview.types';
import { SnapshotRouter } from '@/services/testing/ui/preview/snapshot-router.service';
import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';

/** Maximum interactive nodes to collect (default for exploration/intelligent mode) */
const MAX_NODES_DEFAULT = 500;

/** V14: Increased from 200→400 — complex dashboards/tables need more nodes for reliable resolution */
export const MAX_NODES_REPLAY = 400;

/** Attribute name for temporary refs */
const TEMP_REF_ATTR = 'data-agent-ref';

/** Max time to wait for network idle before collecting DOM (ms) */
const NETWORK_IDLE_TIMEOUT_MS = 3000;

/** Max time to wait for DOM stability (no mutations) (ms) */
const DOM_STABILITY_TIMEOUT_MS = 1500;

/** Interval to check DOM stability (ms) */
const DOM_STABILITY_CHECK_INTERVAL_MS = 200;

/**
 * Build browser-side script to extract interactive elements
 * @param maxNodes - Maximum number of nodes to collect
 */
/**
 * Exported for the syntax-regression test only. The returned string is
 * evaluated as RAW JS in the browser (page.evaluate), so it must parse as
 * plain JavaScript — NO TypeScript syntax. The test compiles it with
 * `new vm.Script(...)` to catch any TS leak before it reaches a browser.
 */
export function __buildExtractScriptForTest(maxNodes: number): string {
  return buildExtractScript(maxNodes);
}

function buildExtractScript(maxNodes: number): string {
  return `
(function extractInteractiveNodes() {
  const MAX_NODES = ${maxNodes};
  const MAX_TEXT_LENGTH = 100;
  const MAX_PARENT_CHAIN = 6;

  // W3C implicit ARIA role mapping. MUST stay in sync with Node-side
  // src/services/testing/ui/preview/implicit-role.util.ts and the browser-
  // side COMPUTE_ROLE_SRC in recording-capture.service.ts. This inline copy
  // exists because this script runs in page.evaluate context and cannot
  // import from the backend module graph.
  //
  // Without this, native <button>/<a href>/<nav> produced node.role =
  // undefined in background/regression runs, breaking the structural
  // fingerprint score symmetry with preview (where the recorder already
  // computes implicit role) and weakening compiled-locator-plan role
  // strategies during CI replay.
  function computeRoleFor(el) {
    if (!el || !el.tagName) return undefined;
    var explicit = (el.getAttribute('role') || '').trim();
    if (explicit) return explicit;
    var t = el.tagName.toLowerCase();
    switch (t) {
      case 'button': return 'button';
      case 'a': return el.hasAttribute('href') ? 'link' : undefined;
      case 'input': {
        var it = (el.getAttribute('type') || 'text').toLowerCase();
        switch (it) {
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
      case 'select': return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
      case 'img': return el.hasAttribute('alt') ? 'img' : undefined;
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

  // Interactive element selectors (synced with snapshot-collector.ts)
  const INTERACTIVE_SELECTORS = [
    // ── Core interactive elements ──
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    // ── ARIA widget roles (covers MUI, Ant Design, Chakra, Radix, Headless UI) ──
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="listbox"]',
    '[role="combobox"]',
    '[role="menu"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="switch"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[role="treeitem"]',
    '[role="alertdialog"]',
    // ── Attribute-based interactive elements ──
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
    '[data-testid]',
    '[data-test]',
    '[data-toggle]',
    '[aria-haspopup]',
    '[draggable="true"]',
    // ── Semantic elements ──
    '[contenteditable="true"]',
    '[contenteditable=""]',
    'dialog[open]',
    'summary',
  ];

  // Collect elements from main document + shadow DOMs recursively
  function collectFromRoot(root) {
    var found = Array.from(root.querySelectorAll(INTERACTIVE_SELECTORS.join(',')));
    // Traverse shadow roots recursively
    var allEls = root.querySelectorAll('*');
    for (var i = 0; i < allEls.length; i++) {
      var sr = allEls[i].shadowRoot;
      if (sr) {
        found = found.concat(collectFromRoot(sr));
      }
    }
    return found;
  }

  var elements = collectFromRoot(document);

  // Phase 4: Second pass — find framework-clickable elements not caught by CSS selectors
  // Detect React/Vue/Angular event bindings on non-interactive elements
  function detectFrameworkClickable(el) {
    // React: __reactFiber$ or __reactInternalInstance$ or __reactEvents$
    var keys = Object.keys(el);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].startsWith('__reactFiber$') || keys[k].startsWith('__reactInternalInstance$') || keys[k].startsWith('__reactEvents$')) return 'react';
    }
    // Vue: __vue__ or __vueParentComponent
    if (el.__vue__ || el.__vueParentComponent) return 'vue';
    // Angular: __ngContext__ or _ngHost
    if (el.__ngContext__ || el._ngHost) return 'angular';
    return null;
  }

  // Collect framework-clickable divs/spans that have cursor:pointer and non-zero size
  var existingSet = new Set(elements);
  var candidates = document.querySelectorAll('div, span, li, td, th, label, p');
  for (var c = 0; c < Math.min(candidates.length, 2000); c++) {
    var el = candidates[c];
    if (existingSet.has(el)) continue; // Already collected
    if (!el.offsetWidth && !el.offsetHeight) continue; // Not visible

    var framework = detectFrameworkClickable(el);
    var computedStyle = framework ? null : window.getComputedStyle(el);
    var hasCursorPointer = computedStyle ? computedStyle.cursor === 'pointer' : false;

    // Heuristic: short actionable text on a compact element = likely a custom button/link
    // Catches <div class="btn">Submit</div> with addEventListener (no onclick attr, no framework binding)
    var isLikelyButton = false;
    if (!framework && !hasCursorPointer) {
      var tag = el.tagName;
      // Skip elements that are commonly non-interactive despite short text
      if (tag !== 'LABEL' && tag !== 'P') {
        var cls = el.className || '';
        var isBadgeOrMeta = typeof cls === 'string' && (/badge|tag|chip|breadcrumb|pagination|caption|status|label(?!.*btn)/i.test(cls));
        if (!isBadgeOrMeta) {
          var text = (el.textContent || '').trim();
          // Short text (2-25 chars), no child block elements, button-like size
          if (text.length >= 2 && text.length <= 25 && !el.querySelector('div, p, ul, ol, table, section, article, header, footer, nav')) {
            var btnRect = el.getBoundingClientRect();
            // Button-like proportions: not too tall (< 60px), not too wide (< 300px), non-trivial
            if (btnRect.width >= 24 && btnRect.height >= 24 && btnRect.height <= 60 && btnRect.width <= 300) {
              isLikelyButton = true;
            }
          }
        }
      }
    }

    if (framework || hasCursorPointer || isLikelyButton) {
      // Also require non-trivial size (at least 10x10px)
      var rect = el.getBoundingClientRect();
      if (rect.width >= 10 && rect.height >= 10) {
        elements.push(el);
        existingSet.add(el);
        if (isLikelyButton) el.__qai_heuristic_button = true;
      }
    }
  }

  // ── Active modal/popup detection (mirrors snapshot-collector.ts) ──
  // Find the topmost dialog/alertdialog/popup element to determine which elements
  // are inside the active overlay layer. This enables page-state-aware LLM resolution.
  var activeModalElement = null;
  (function detectActiveModal() {
    // 1. HTML <dialog open>
    var openDialogs = document.querySelectorAll('dialog[open]');
    if (openDialogs.length > 0) {
      activeModalElement = openDialogs[openDialogs.length - 1]; // Last = topmost
      return;
    }
    // 2. ARIA role="dialog" or role="alertdialog" that is visible
    var ariaDialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (var d = ariaDialogs.length - 1; d >= 0; d--) {
      var dlg = ariaDialogs[d];
      if (dlg.offsetWidth > 0 || dlg.offsetHeight > 0) {
        activeModalElement = dlg;
        return;
      }
    }
    // 3. High z-index positioned elements that cover significant viewport area
    // (catches custom modals without role="dialog")
    // Optimization: only scan direct children of body + up to 2 levels deep
    // to avoid getComputedStyle on every element (layout thrashing on large pages)
    var vpWidth = window.innerWidth;
    var vpHeight = window.innerHeight;
    var vpArea = vpWidth * vpHeight;
    var bestCandidate = null;
    var bestZIndex = 0;
    var modalCandidates = document.querySelectorAll(
      'body > *, body > * > *, [class*="modal"], [class*="overlay"], [class*="dialog"], [class*="popup"], [class*="drawer"]'
    );
    for (var m = 0; m < modalCandidates.length; m++) {
      var mel = modalCandidates[m];
      var mStyle = window.getComputedStyle(mel);
      if (mStyle.position !== 'fixed' && mStyle.position !== 'absolute') continue;
      var mz = parseInt(mStyle.zIndex, 10);
      if (isNaN(mz) || mz < 3) continue; // z-index >= 3: aligned with snapshot-collector
      var mRect = mel.getBoundingClientRect();
      var mArea = mRect.width * mRect.height;
      var mCoverage = vpArea > 0 ? mArea / vpArea : 0;
      // Must cover at least 3% of viewport (aligned with snapshot-collector)
      if (mCoverage < 0.03) continue;
      // Full-screen overlay (>90%) is likely a backdrop, not a popup container
      if (mCoverage > 0.9) continue;
      if (mz > bestZIndex) {
        bestCandidate = mel;
        bestZIndex = mz;
      }
    }
    if (bestCandidate) {
      activeModalElement = bestCandidate;
    }

    // 4. ARIA-EXPANDED / ARIA-CONTROLS fallback (parity with snapshot-collector.ts LAYER 3).
    //
    // Many real-world popups (Wikipedia/Codex typeahead, MUI Autocomplete,
    // Headless UI Combobox, Ant Design Select, Cmdk) do NOT use role=dialog
    // and are deep / CSS-positioned (so the positional scan above misses
    // them). What they DO have, almost universally, is a trigger with
    // aria-expanded="true" + aria-controls="<popup-id>" — the WAI-ARIA
    // standard pattern for disclosure widgets. We only run this if Layers
    // 1-3 above didn't find anything, so it cannot demote a stronger
    // signal; it only fills gaps.
    //
    // Why this is safe (zero false positives):
    //   - aria-expanded="true" is set only when popup is OPEN (otherwise
    //     "false" or removed)
    //   - aria-controls names the EXACT controlled element via IDREF
    //   - We re-verify visibility (display/visibility/opacity) and
    //     meaningful size (≥0.5% viewport — lower than Layer-2's 3%
    //     because typeahead menus are often single-column dropdowns)
    //   - Highest-z-index controlled element wins when multiple
    //     disclosures are open
    if (!activeModalElement) {
      var expanded = document.querySelectorAll('[aria-expanded="true"][aria-controls]');
      var bestL3 = null;
      var bestL3Z = -1;
      for (var ei = 0; ei < expanded.length; ei++) {
        var trig = expanded[ei];
        var controlsAttr = trig.getAttribute('aria-controls');
        if (!controlsAttr) continue;
        // aria-controls is a space-separated IDREF list; take the first.
        var firstId = controlsAttr.split(/\\s+/)[0];
        if (!firstId) continue;
        // getElementById, not querySelector — IDREF doesn't need CSS-escape
        // for ':' / '.' chars in React 18 useId() / design-system slugs.
        var controlled = document.getElementById(firstId);
        if (!controlled) continue;
        var cs = window.getComputedStyle(controlled);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (parseFloat(cs.opacity) < 0.1) continue;
        var cRect = controlled.getBoundingClientRect();
        var cArea = cRect.width * cRect.height;
        var cCov = vpArea > 0 ? cArea / vpArea : 0;
        if (cCov < 0.005) continue;
        var cz = parseInt(cs.zIndex, 10);
        // z-index may be auto/0 for elements relying on stacking context;
        // coerce NaN→0 rather than skipping, because the aria-controls
        // relationship is itself strong evidence.
        var czNum = isNaN(cz) ? 0 : cz;
        if (czNum > bestL3Z) {
          bestL3Z = czNum;
          bestL3 = controlled;
        }
      }
      if (bestL3) activeModalElement = bestL3;
    }
  })();

  const results = [];

  // Generate unique ref for each element
  let refCounter = 1;

  for (let i = 0; i < Math.min(elements.length, MAX_NODES); i++) {
    const el = elements[i];

    // Skip if not visible or disabled and not visible
    const isVisible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const isDisabled = el.hasAttribute('disabled') || (el.getAttribute('aria-disabled') || '').replace(/["']/g, '').trim() === 'true';
    if (!isVisible && isDisabled) continue;

    // Phase 4: Detect framework event bindings
    const frameworkClickable = detectFrameworkClickable(el);

    // Inject temporary ref
    const ref = 'bg-' + refCounter++;
    el.setAttribute('${TEMP_REF_ATTR}', ref);

    // Get bounding box
    const rect = el.getBoundingClientRect();
    const boundingBox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    // Check if element is topmost at center
    let isTopMostAtCenter = false;
    if (rect.width > 0 && rect.height > 0) {
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const topEl = document.elementFromPoint(centerX, centerY);
      isTopMostAtCenter = topEl === el || el.contains(topEl);
    }

    // Get label text (from <label>, aria-labelledby, or wrapping label)
    let labelText = '';
    const id = el.getAttribute('id');
    if (id) {
      const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (label) labelText = label.textContent?.trim() || '';
    }
    if (!labelText) {
      const ariaLabelledBy = el.getAttribute('aria-labelledby');
      if (ariaLabelledBy) {
        const labelEl = document.getElementById(ariaLabelledBy);
        if (labelEl) labelText = labelEl.textContent?.trim() || '';
      }
    }
    if (!labelText) {
      const parentLabel = el.closest('label');
      if (parentLabel) labelText = parentLabel.textContent?.trim() || '';
    }

    // Get container titles (form legend, fieldset legend, section heading, ARIA groups)
    // Phase 7: Expanded container detection — depth 8, semantic containers, landmarks
    //
    // LANDMARK_ROLES + LANDMARK_TAG_TO_ROLE are injected from
    // src/services/testing/ui/preview/landmark.util.ts via template
    // interpolation so this script stays byte-symmetric with the preview
    // snapshot-collector / cdp-snapshot / recorder (invariant #5). Edit
    // landmark.util.ts — never the literals here.
    const LANDMARK_ROLES = ${JSON.stringify(LANDMARK_EVALUATE_BUNDLE.ROLES)};
    const LANDMARK_TAG_TO_ROLE = ${JSON.stringify(LANDMARK_EVALUATE_BUNDLE.TAGS)};
    const SEMANTIC_TAGS = ['FIELDSET', 'FORM', 'SECTION', 'ARTICLE', 'NAV', 'ASIDE', 'DIALOG', 'HEADER', 'FOOTER', 'MAIN'];

    const containerTitles = [];
    let nearestLandmark = '';
    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < 8) {
      const parentRole = (parent.getAttribute('role') || '').toLowerCase();
      const parentAriaLabel = parent.getAttribute('aria-label');
      const parentTag = parent.tagName;

      // Track nearest landmark role
      if (!nearestLandmark) {
        // Explicit ARIA landmark role
        if (parentRole && LANDMARK_ROLES.indexOf(parentRole) !== -1) {
          nearestLandmark = parentRole;
        } else {
          // Implicit landmark from semantic HTML tags (NAV/MAIN/HEADER/…)
          const implicit = LANDMARK_TAG_TO_ROLE[parentTag];
          if (implicit) nearestLandmark = implicit;
        }
      }

      // Extract container title from semantic containers
      if (parentTag === 'FIELDSET') {
        const legend = parent.querySelector('legend');
        if (legend?.textContent?.trim()) containerTitles.push(legend.textContent.trim());
      } else if (SEMANTIC_TAGS.includes(parentTag) || (parentRole && ['group', 'region', 'form', 'navigation', 'banner', 'main', 'complementary', 'search'].includes(parentRole))) {
        // Try aria-label first (most specific for ARIA containers)
        if (parentAriaLabel?.trim()) {
          containerTitles.push(parentAriaLabel.trim());
        } else {
          // Fall back to heading text
          const heading = parent.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
          if (heading?.textContent?.trim()) containerTitles.push(heading.textContent.trim());
        }
      }
      // Skip plain <div> without role/aria-label (smart filter)
      // Only extract from divs that have semantic meaning

      parent = parent.parentElement;
      depth++;
    }

    // ── Modal layer detection ──
    const isInsideActiveModal = activeModalElement ? activeModalElement.contains(el) : false;

    // ── Icon-button detection (SVG/img child, no visible text) ──
    let isIconButton = false;
    if (el.tagName === 'BUTTON' || (el.getAttribute('role') || '') === 'button') {
      const textLen = (el.textContent || '').trim().length;
      const hasSvgOrImg = !!(el.querySelector('svg') || el.querySelector('img'));
      if (textLen <= 2 && hasSvgOrImg) {
        isIconButton = true;
      }
    }

    // ── Title attribute (tooltip text — useful for icon-only buttons) ──
    const title = el.getAttribute('title') || undefined;

    // ── Nearest semantic container (form/dialog/section) ──
    // Note: parentRefChain is NOT collected here because parent containers
    // are typically non-interactive (div, section, form) and don't get
    // data-agent-ref assigned in this same pass. containerRef uses the
    // parent's existing ref if available, otherwise skips (the container
    // context is already captured in containerTitles above).
    let containerRef = undefined;
    {
      let pEl = el.parentElement;
      let pDepth = 0;
      while (pEl && pDepth < MAX_PARENT_CHAIN) {
        const pTag = pEl.tagName;
        const pRole = (pEl.getAttribute('role') || '').toLowerCase();
        if (pTag === 'FORM' || pTag === 'DIALOG' || pTag === 'SECTION' ||
            pTag === 'FIELDSET' || pTag === 'NAV' || pTag === 'ASIDE' ||
            pRole === 'dialog' || pRole === 'form' || pRole === 'region') {
          // Use existing ref if the container was already processed, otherwise use id
          const pRef = pEl.getAttribute('${TEMP_REF_ATTR}') || pEl.getAttribute('id');
          if (pRef) {
            containerRef = pRef;
            break;
          }
        }
        pEl = pEl.parentElement;
        pDepth++;
      }
    }

    // ── Dynamic ID detection ──
    //
    // MUST MATCH src/services/testing/ui/preview/dynamic-id.util.ts
    //     DYNAMIC_ID_PATTERNS. This inline copy runs in page.evaluate context
    //     and cannot import from the backend module graph. Keep these two
    //     regex lists in sync — drift causes preview and background to
    //     disagree on "is this id stable?" for the same element, producing
    //     inconsistent locator plans on identical DOM.
    const elId = (el.getAttribute('id') || '').trim();
    const isDynamicId = elId.length > 0 && (
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(elId) || // UUID
      /^[a-f0-9]{24,}$/i.test(elId) ||                                                // Mongo ObjectId / long hex
      /^[0-9a-z]{20,}$/i.test(elId) ||                                                 // 20+ char random token
      /^\d{10,}$/.test(elId) ||                                                        // epoch-like timestamps
      /^react-select-\d+-/i.test(elId) ||                                              // React Select
      /^react-[a-z0-9]+/i.test(elId) ||                                                // other React-generated
      /^ember\d+/i.test(elId) ||                                                       // Ember auto ids
      /^ng-[a-z0-9-]+/i.test(elId) ||                                                   // AngularJS generated
      /^_[\w-]{8,}/i.test(elId) ||                                                      // underscore + random
      /:r[a-z0-9]+:?$/i.test(elId) ||                                                  // React 18 useId (:r0:)
      /:R[A-Za-z0-9]+:?$/.test(elId)                                                    // React 18 SSR form
    );

    // Build node data
    const node = {
      ref,
      tag: el.tagName.toLowerCase(),
      // Explicit OR implicit W3C role (see computeRoleFor comment above).
      // Was: getAttribute('role') only — which silently dropped the role
      // on every native <button>, <a href>, <nav>, etc., breaking locator
      // plan building downstream.
      role: computeRoleFor(el),
      type: el.getAttribute('type') || undefined,
      inputType: el.getAttribute('type') || undefined,
      text: el.textContent?.trim().substring(0, MAX_TEXT_LENGTH) || undefined,
      labelText: labelText.substring(0, MAX_TEXT_LENGTH) || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      title,
      isIconButton: isIconButton || undefined,
      name: el.getAttribute('name') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      id: el.getAttribute('id') || undefined,
      isDynamicId: isDynamicId || undefined,
      testIdAttr: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
      autocomplete: el.getAttribute('autocomplete') || undefined,
      boundingBox,
      isVisible,
      isInteractive: true,
      isDisabled,
      isTopMostAtCenter,
      isInsideActiveModal: isInsideActiveModal || undefined,

      // ARIA state
      // ✅ FIX: Use el.checked (runtime property) instead of hasAttribute('checked') (HTML default)
      // hasAttribute('checked') returns true for initially-checked boxes even after user unchecks them
      checked: el.checked === true ? true : undefined,
      ariaExpanded: (el.getAttribute('aria-expanded') || '').replace(/["']/g, '').trim() === 'true' ? true : ((el.getAttribute('aria-expanded') || '').replace(/["']/g, '').trim() === 'false' ? false : undefined),
      ariaPressed: (el.getAttribute('aria-pressed') || '').replace(/["']/g, '').trim() === 'true' ? true : ((el.getAttribute('aria-pressed') || '').replace(/["']/g, '').trim() === 'false' ? false : undefined),
      ariaSelected: (el.getAttribute('aria-selected') || '').replace(/["']/g, '').trim() === 'true' ? true : ((el.getAttribute('aria-selected') || '').replace(/["']/g, '').trim() === 'false' ? false : undefined),
      ariaChecked: (el.getAttribute('aria-checked') || '').replace(/["']/g, '').trim() === 'true' ? true : ((el.getAttribute('aria-checked') || '').replace(/["']/g, '').trim() === 'mixed' ? 'mixed' : ((el.getAttribute('aria-checked') || '').replace(/["']/g, '').trim() === 'false' ? false : undefined)),
      // Radix/shadcn/Vaul data-state. Symmetric with snapshot-collector
      // and CDP-snapshot. Length-cap < 30 chars; trim only (preserve
      // camelCase 'forceMount'). undefined when attribute absent.
      // NOTE: this template string is evaluated as RAW JS in the browser via
      // page.evaluate — it must NOT contain TypeScript syntax. A TS return-type
      // annotation on this IIFE (string-pipe-undefined arrow) made the WHOLE
      // script unparseable ("Unexpected token close-paren"), so the legacy
      // evaluate path collected 0 nodes. Keep this IIFE annotation-free.
      dataState: (() => {
        const raw = (el.getAttribute('data-state') || '').replace(/["']/g, '').trim();
        return raw.length > 0 && raw.length < 30 ? raw : undefined;
      })(),

      // Validation state
      required: el.hasAttribute('required') || (el.getAttribute('aria-required') || '').replace(/["']/g, '').trim() === 'true',
      readOnly: el.hasAttribute('readonly') || (el.getAttribute('aria-readonly') || '').replace(/["']/g, '').trim() === 'true',
      invalid: (el.getAttribute('aria-invalid') || '').replace(/["']/g, '').trim() === 'true' || el.matches(':invalid'),
      hasValue: !!(el.value && el.value.length > 0),

      // Hierarchy
      containerRef,
      // Container info (Phase 7: expanded detection)
      containerTitles: containerTitles.filter(Boolean).slice(0, 5),
      nearestLandmark: nearestLandmark || undefined,
      // Phase 4: Framework event binding detection
      frameworkClickable: frameworkClickable || undefined,
      // Phase 4: Additional interactivity signals
      isContentEditable: el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '' || undefined,
      tabIndex: el.getAttribute('tabindex') !== null ? parseInt(el.getAttribute('tabindex'), 10) : undefined,
      hasOnclick: el.hasAttribute('onclick') || undefined,
      hasAriaHaspopup: el.hasAttribute('aria-haspopup') || undefined,
      heuristicButton: el.__qai_heuristic_button || undefined,
    };

    results.push(node);
  }

  return results;
})();
`;
}

/**
 * Collect interactive nodes from current page state
 * Injects temporary data-agent-ref attributes for targeting
 *
 * @param page - Playwright Page
 * @returns Array of InteractiveNode with temporary refs
 */
export async function collectInteractiveNodes(page: Page, maxNodes?: number): Promise<InteractiveNode[]> {
  try {
    const startTime = Date.now();
    const limit = maxNodes ?? MAX_NODES_DEFAULT;

    // CRITICAL: Remove stale bg-X refs from previous resolution steps
    // Without this, multi-step tests accumulate duplicate refs causing wrong element targeting
    await cleanupTemporaryRefs(page);

    // Step 1: Wait for network idle (SPAs may still be fetching data)
    await waitForPageStability(page);

    // May 2026 — when SNAPSHOT_USE_CDP_BACKGROUND is on, route through
    // SnapshotRouter to get the CDP-collected snapshot (12× faster on
    // sparse pages, canonical AX role, includes iframe nodes the
    // legacy evaluate path silently skipped).
    //
    // NB: cleanupTemporaryRefs + waitForPageStability stay OUTSIDE the
    // flag check — both paths need them. The SnapshotRouter does NOT
    // wait for SPA idle on its own; if we skip the wait we'd snapshot
    // a half-rendered page. The legacy evaluate path has the same
    // contract (caller waits, collector reads) — keep parity.
    if (SNAPSHOT_ROUTER_FLAGS.useCdpForBackground) {
      try {
        const snapshot = await SnapshotRouter.collect(page, {
          context: 'background-regression',
          // SnapshotRouter has its own stability gate that runs before
          // CDP collection. We've already waited above; tell it to
          // skip its internal wait so we don't double-pay the cost.
          skipStabilityWait: true,
          lastDomNodeCount: undefined,
        });

        const nodes = adaptLiteElementsToInteractiveNodes(snapshot.elements);
        const elapsed = Date.now() - startTime;

        logger.info('[BACKGROUND_DOM_COLLECTOR] Collected interactive nodes (CDP path)', {
          nodeCount: nodes.length,
          source: 'cdp_via_router',
          elapsedMs: elapsed,
        });

        return nodes;
      } catch (cdpError) {
        // CDP path failed — fall through to the legacy evaluate path.
        // Keeps regression replays running even if CDP regresses on
        // some site (cross-origin iframe edge case, AX domain
        // unavailable on older Chromium, etc.). We log loud once so
        // operators see the fallback in production logs.
        logger.warn('[BACKGROUND_DOM_COLLECTOR] CDP path failed, falling back to evaluate', {
          error: cdpError instanceof Error ? cdpError.message : String(cdpError),
        });
        // Fall through.
      }
    }

    // Legacy evaluate path — used by default and as fallback when CDP
    // path errored above.
    // Step 2: Collect from main frame
    const mainNodes = await page.evaluate(buildExtractScript(limit)) as InteractiveNode[];

    // Step 3: Collect from accessible iframes
    const iframeNodes = await collectFromIframes(page, limit);

    const nodes = [...mainNodes, ...iframeNodes];
    const elapsed = Date.now() - startTime;

    logger.info('[BACKGROUND_DOM_COLLECTOR] Collected interactive nodes', {
      nodeCount: nodes.length,
      mainFrameNodes: mainNodes.length,
      iframeNodes: iframeNodes.length,
      elapsedMs: elapsed,
      source: 'evaluate_legacy',
    });

    return nodes;
  } catch (error) {
    logger.error('[BACKGROUND_DOM_COLLECTOR] Failed to collect nodes', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * May 2026 — Adapter from CDP-side `LiteElement` to legacy
 * `InteractiveNode`. The two types describe the same concept (a single
 * interactive element on a page) but settled on slightly different
 * field names through historical accident:
 *
 *   `LiteElement.bounds`   ↔  `InteractiveNode.boundingBox`
 *   `LiteElement.htmlId`   ↔  `InteractiveNode.id`
 *   `LiteElement.htmlName` ↔  `InteractiveNode.name`
 *
 * Everything else is one-to-one. We could unify the types eventually
 * but that's a large cross-cutting change; this adapter lets us flip
 * background regression to CDP without a typescript-wide rename.
 *
 * Iframe ref scheme — preserved for self-heal compatibility:
 * the legacy collector formed iframe refs as
 *   `iframe-{frameId}-bg-{N}`
 * where `frameId = frame.name() || frame.url().slice(-20)`.
 * `self-healing.service.ts:271` greps that exact pattern with
 *   `^iframe-(.+?)-bg-`
 * to extract the frameId for `page.frames().find(...)`. If we passed
 * raw CDP refs (`e1` / `e2` per-frame) the regex wouldn't match and
 * Phase 3 iframe healing would silently die. We keep the legacy shape
 * by re-prefixing iframe-side LiteElements here. Main-frame elements
 * keep their `eN` ref untouched — downstream consumers don't care
 * about the literal prefix.
 */
export function adaptLiteElementsToInteractiveNodes(elements: LiteElement[]): InteractiveNode[] {
  const out: InteractiveNode[] = [];
  // Per-iframe counter so the rewritten refs are unique within their
  // frame namespace and stable across the same snapshot. We keep
  // counters keyed by iframeSource (URL) — the same key the iframe
  // bucket uses on the recorder side.
  const iframeCounters = new Map<string, number>();

  for (const el of elements) {
    let outRef = el.ref;
    if (el.iframeSource) {
      const frameId = el.iframeSource.slice(-20);
      const next = (iframeCounters.get(el.iframeSource) ?? 0) + 1;
      iframeCounters.set(el.iframeSource, next);
      outRef = `iframe-${frameId}-bg-${next}`;
    }

    const node: InteractiveNode = {
      ref: outRef,
      tag: el.tag,
      role: el.role || undefined,
      type: el.type,
      inputType: el.type, // legacy field — same source as `type`
      // Resolver matches by raw text first (`<button>Save</button>`),
      // accessible-name cascade second (icon-only with aria-label).
      // Prefer `el.text` when CDP captured direct text; fall back to
      // AX `name` for icon-poor / aria-only widgets. Without this
      // fallback, native `<button>Save</button>` on the resolver side
      // would see `text=undefined` because AX writes "Save" into
      // `name` and the raw text into `el.text`.
      text: el.text || el.name || undefined,
      firstTextFragment: el.firstTextFragment,
      labelText: el.labelText,
      ariaLabel: el.ariaLabel,
      title: el.title,
      isIconButton: el.isIconButton,
      iconClasses: el.iconClasses,
      // Field-name renames — the only structural difference between types.
      name: el.htmlName,
      placeholder: el.placeholder,
      id: el.htmlId,
      testIdAttr: el.testIdAttr,
      autocomplete: el.autocomplete,
      // Field exists on LiteElement but legacy collector also exposed
      // it; pass through so resolver's input-type logic keeps working.
      boundingBox: el.bounds,
      // Legacy collector hard-codes isInteractive=true for everything
      // it returns — we mirror that contract.
      isVisible: el.visible,
      isInteractive: true,
      isDisabled: el.disabled,
      isTopMostAtCenter: el.isTopMostAtCenter,
      isInsideActiveModal: el.isInsideActiveModal,
      isDynamicId: el.isDynamicId,
      // ARIA state.
      checked: el.checked,
      ariaExpanded: el.ariaExpanded,
      ariaPressed: el.ariaPressed,
      ariaSelected: el.ariaSelected,
      ariaChecked: el.ariaChecked,
      dataState: el.dataState,
      ariaCurrent: el.ariaCurrent,
      ariaValueNow: el.ariaValueNow,
      ariaValueText: el.ariaValueText,
      dataValue: el.dataValue,
      childTestId: el.childTestId,
      iconLabel: el.iconLabel,
      customElementTag: el.customElementTag,
      href: el.href,
      bsToggle: el.bsToggle,
      bsTarget: el.bsTarget,
      ariaHasPopup: el.ariaHasPopup,
      ariaActiveDescendant: el.ariaActiveDescendant,
      dataRowKey: el.dataRowKey,
      rowClickable: el.rowClickable,
      nearestRowText: el.nearestRowText,
      siblingIndex: el.siblingIndex,
      disabled: el.disabled,
      arrowDir: el.arrowDir,
      // Validation.
      required: el.required,
      readOnly: el.readOnly,
      invalid: el.invalid,
      hasValue: el.hasValue,
      // Hierarchy.
      parentRefChain: el.parentRefChain,
      containerRef: el.containerRef,
      containerTitles: el.iframeSource
        // Mirror legacy iframe annotation so candidate-pruner-llm and
        // step-blocker-diagnosis still see the "this lives inside an
        // iframe" hint they rely on.
        ? [`iframe: ${el.iframeSource}`, ...(el.containerTitles ?? [])]
        : el.containerTitles,
      // Durable iframe selector → compiled plan persists frame-scoped replay.
      iframeSource: el.iframeSource,
      iframeSelector: el.iframeSelector,
      // Phase 4 interactivity.
      frameworkClickable: el.frameworkClickable,
      isContentEditable: el.isContentEditable,
      tabIndex: el.tabIndex,
      hasAriaHaspopup: el.hasAriaHaspopup,
      hasOnclick: el.hasOnclick,
      // Disambiguation hints used by candidate-pruner-llm /
      // intent-step-lint scoring on dense pages.
      nearText: el.nearText,
      // Etap 1B.2 — Angular routerLink + formControlName, now captured
      // in CDP collector's Phase 3c-DS (cdp-snapshot.service.ts) so
      // Angular reactive-forms / router-driven apps keep their
      // strongest identity fingerprints when CDP path is used.
      routerLink: el.routerLink,
      formControlName: el.formControlName,
    };
    out.push(node);
  }

  return out;
}

/**
 * Wait for page stability before DOM collection.
 * Combines network idle + DOM mutation stability.
 * Non-fatal: if timeouts expire, we proceed with current state.
 */
async function waitForPageStability(page: Page): Promise<void> {
  // 1. Wait for network idle (best-effort, don't block on long-polling/websockets)
  try {
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS });
  } catch {
    // Network idle timeout is non-fatal — SPAs with long-polling will always timeout
    logger.debug('[BACKGROUND_DOM_COLLECTOR] Network idle timeout (non-fatal), proceeding');
  }

  // 2. Wait for DOM stability: no mutations for DOM_STABILITY_CHECK_INTERVAL_MS
  // Uses string-based evaluate to avoid TS "Cannot find MutationObserver/document" errors
  // (this code runs in browser context via Playwright)
  try {
    await page.evaluate(`
      new Promise((resolve) => {
        var lastMutationTime = Date.now();
        var deadline = Date.now() + ${DOM_STABILITY_TIMEOUT_MS};
        var intervalMs = ${DOM_STABILITY_CHECK_INTERVAL_MS};
        var observer = new MutationObserver(function() { lastMutationTime = Date.now(); });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        function check() {
          var now = Date.now();
          if (now - lastMutationTime >= intervalMs || now >= deadline) {
            observer.disconnect();
            resolve();
          } else {
            setTimeout(check, 50);
          }
        }
        setTimeout(check, intervalMs);
      })
    `);
  } catch {
    logger.debug('[BACKGROUND_DOM_COLLECTOR] DOM stability wait timeout (non-fatal)');
  }
}

/**
 * Collect interactive nodes from accessible iframes.
 * Only collects from same-origin iframes (cross-origin will throw and be skipped).
 *
 * @param page - Playwright Page
 * @returns InteractiveNode[] from all accessible iframes
 */
async function collectFromIframes(page: Page, maxNodes: number = MAX_NODES_DEFAULT): Promise<InteractiveNode[]> {
  const allIframeNodes: InteractiveNode[] = [];

  try {
    const frames = page.frames();

    for (const frame of frames) {
      // Skip main frame (already collected)
      if (frame === page.mainFrame()) continue;

      // Skip detached frames
      if (frame.isDetached()) continue;

      try {
        // Try to evaluate in the frame — will fail for cross-origin
        const frameNodes = await frame.evaluate(buildExtractScript(maxNodes)) as InteractiveNode[];

        if (frameNodes.length > 0) {
          // Prefix refs with frame identifier to avoid collisions with main frame refs
          const frameId = frame.name() || frame.url().slice(-20);
          for (const node of frameNodes) {
            if (node.ref) {
              node.ref = `iframe-${frameId}-${node.ref}`;
            }
            // Mark as coming from iframe for context
            if (!node.containerTitles) node.containerTitles = [];
            node.containerTitles.push(`iframe: ${frame.name() || frame.url()}`);
          }

          allIframeNodes.push(...frameNodes);

          logger.debug('[BACKGROUND_DOM_COLLECTOR] Collected from iframe', {
            frameName: frame.name(),
            frameUrl: frame.url().slice(0, 100),
            nodeCount: frameNodes.length,
          });
        }
      } catch {
        // Cross-origin or detached iframe — skip silently
        logger.debug('[BACKGROUND_DOM_COLLECTOR] Skipped iframe (cross-origin or error)', {
          frameName: frame.name(),
          frameUrl: frame.url().slice(0, 60),
        });
      }
    }
  } catch (error) {
    logger.debug('[BACKGROUND_DOM_COLLECTOR] Iframe collection failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return allIframeNodes;
}

/**
 * Clean up temporary data-agent-ref attributes after resolution
 * Call this after test execution completes
 *
 * @param page - Playwright Page
 */
export async function cleanupTemporaryRefs(page: Page): Promise<void> {
  try {
    await page.evaluate((attrName: string) => {
      // @ts-expect-error - runs in browser context
      const elements = document.querySelectorAll(`[${attrName}^="bg-"]`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements.forEach((el: any) => el.removeAttribute(attrName));
    }, TEMP_REF_ATTR);

    logger.debug('[BACKGROUND_DOM_COLLECTOR] Cleaned up temporary refs');
  } catch (error) {
    // Cleanup failure is non-fatal
    logger.debug('[BACKGROUND_DOM_COLLECTOR] Cleanup failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get page signature for cache invalidation
 * Simple hash of form/input structure
 */
export async function getPageSignature(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      // @ts-expect-error - runs in browser context
      const inputs = document.querySelectorAll('input, select, textarea, button, [role="button"]');
      const elements: string[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputs.forEach((el: any) => {
        const tag = el.tagName?.toLowerCase() || '';
        const type = el.getAttribute?.('type') || '';
        const name = el.getAttribute?.('name') || '';
        const id = el.id || '';
        const role = el.getAttribute?.('role') || '';
        elements.push(`${tag}:${type}:${name}:${id}:${role}`);
      });

      return elements.sort().join('|').slice(0, 500);
    });
  } catch {
    return '';
  }
}
