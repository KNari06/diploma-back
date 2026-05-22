/**
 * Shared in-page resolver helpers for preview overlays.
 *
 * This module returns a JavaScript string that, when injected into the
 * page via `page.evaluate()`, defines a uniform set of helper functions:
 *
 *   safeAttr(el, name)                — defensive attribute read
 *   looksDynamicId(id)                — cheap dynamic-id check (cosmetic)
 *   describeElement(el)               — "tag#id" / "tag[data-testid=…]" label
 *   hasClickHandler(el)               — onclick / tabindex / React onClick / framework attrs
 *   isInteractive(el)                 — native tag / role / handler / contenteditable / draggable
 *   promoteToClickableRow(target)     — <td>/<span> → <tr> when row looks clickable
 *   elevateLabelToControl(target)     — <label> → associated <input> via for= or single nested control
 *   findInteractive(el)               — full ancestor-walk resolver returning the best interactive
 *                                       target with all post-promotions applied
 *
 * Both `preview-element-pick.service.ts` and the future hover-overlay
 * service inject these helpers so the **hover outline matches the click
 * target** byte-for-byte. Without this shared module the two services
 * would drift — exactly the kind of bug the recording invariants in
 * `src/services/testing/ui/preview/CLAUDE.md` (Invariant #5) warn about.
 *
 * Why a string template instead of a real JS file?
 *   The helpers run in the LIVE PAGE's JavaScript context, not Node's.
 *   `page.evaluate()` takes a function or a string and serialises it
 *   into the page. We choose strings because we want to compose them
 *   into larger overlay scripts that reference the helpers by name.
 *
 * Pure / read-only contract:
 *   None of these helpers mutate the DOM, attach listeners, or store
 *   global state. Safe to call at mousemove frequency.
 *
 * Symmetry with PROBE_AT_POINT_FN:
 *   This is the *lightweight* subset of the recording probe rules
 *   (~250 lines vs ~1800). The rules we replicate are the high-value,
 *   low-cost ones: native tags, ARIA roles, behavioural signals,
 *   cursor:pointer walk, row/label promotion. The heavy rules (shadow
 *   DOM piercing, MUI fieldset rim, wrapper→icon descent, dynamic-id
 *   filter for ancestor chain) live ONLY in the server-side
 *   PROBE_AT_POINT_FN — which still runs on click via finishPick() in
 *   the pick service, so the **persisted identity is always
 *   canonical** even when the hover outline is approximate.
 */
export function buildOverlayResolverHelpers(): string {
  return `
    function safeAttr(el, name) {
      try { const v = el.getAttribute(name); return v ? String(v) : ''; } catch (e) { return ''; }
    }

    // Lightweight dynamic-id check for the TOOLTIP only. The full
    // catalogue lives in dynamic-id.util.ts (TS, ~50 patterns); we
    // can't import it into a page-evaluated string, so we keep the
    // hot subset that covers React useId, UUID, MUI/Radix/etc. The
    // server-side PROBE at click time uses the canonical list — this
    // copy is purely cosmetic to avoid showing "button#:r3:" in the
    // hover badge.
    function looksDynamicId(id) {
      if (!id) return false;
      return /^:[rR][a-zA-Z0-9]+:?$/.test(id)
        || /^[a-f0-9]{8}-[a-f0-9-]{20,}$/i.test(id)
        || /^(?:mui|radix|headlessui|chakra|cdk|mat|rc|ant|el-id|pn_id|pv_id|downshift|ember|jss|lit|sc|css|q|n|slds|lightning|aria-id|descid)-/i.test(id)
        || /^_[a-zA-Z0-9]{12,}$/.test(id)
        || /^[0-9a-z]{20,}$/i.test(id);
    }

    function describeElement(el) {
      const tag = (el.tagName || '').toLowerCase();
      const id = safeAttr(el, 'id');
      const tid = safeAttr(el, 'data-testid') || safeAttr(el, 'data-test') || safeAttr(el, 'data-qa');
      const name = safeAttr(el, 'name');
      let body = tag;
      // Prefer the most stable identifier: testId > non-dynamic id > name.
      // Dynamic ids (React useId :r3:, MUI mui-7, UUIDs, etc.) regenerate
      // on every render and are useless to show — fall through to testId
      // / name / bare tag instead.
      if (tid) body += '[data-testid="' + tid + '"]';
      else if (id && !looksDynamicId(id)) body += '#' + id;
      else if (name) body += '[name="' + name + '"]';
      return body.slice(0, 120);
    }

    // ── Interactive-element resolution ─────────────────────────────────
    // Mirrors the logic of recording-capture.service.ts PROBE_AT_POINT_FN
    // but kept tiny (<60 lines vs ~1800) because the OVERLAY only paints
    // a visual hint — the canonical identity is resolved by the full
    // PROBE on click via finishPick() in the server. We replicate ONLY
    // the cheap, high-value rules:
    //   1. Native interactive tags  → button/input/a/select/textarea/summary
    //   2. ARIA widget roles        → button/link/checkbox/radio/tab/...
    //   3. Behavioral signals       → onclick / tabindex / framework click
    //                                  attrs / React __reactProps$.onClick
    //   4. contenteditable, draggable
    //   5. cursor:pointer ancestor  → highest pointer in chain
    //   6. Post-promote a TR        → if target sits in cursor:pointer <tr>
    //                                  or table-row hover class
    //   7. Post-elevate a label     → to associated input via for= or
    //                                  single nested control
    const FRAMEWORK_CLICK_ATTRS = ['ng-click', 'v-on:click', 'x-on:click', 'on:click', '(click)'];
    const INTERACTIVE_TAGS = ['a', 'button', 'input', 'select', 'textarea', 'summary'];
    const INTERACTIVE_ROLES = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'combobox', 'textbox', 'switch', 'treeitem'];
    const ROW_HOVER_CLASS_RE = /\\b(hover|clickable|MuiTableRow-hover|ant-table-row|el-table__row|row-clickable)\\b/i;

    function hasClickHandler(el) {
      try {
        if (el.hasAttribute('onclick')) return true;
        if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
        const attrs = el.attributes;
        for (let ai = 0; ai < attrs.length; ai++) {
          const aname = attrs[ai].name;
          if (aname.indexOf('@click') === 0) return true;
          if (FRAMEWORK_CLICK_ATTRS.indexOf(aname) !== -1) return true;
        }
        // React: __reactProps$<hash>.onClick / onClickCapture
        const ownKeys = Object.keys(el);
        for (let ki = 0; ki < ownKeys.length; ki++) {
          if (ownKeys[ki].indexOf('__reactProps$') === 0) {
            const rp = el[ownKeys[ki]];
            if (rp && (typeof rp.onClick === 'function' || typeof rp.onClickCapture === 'function')) {
              return true;
            }
            break; // only one __reactProps$ key per element
          }
        }
      } catch (e) {}
      return false;
    }

    function isInteractive(el) {
      if (!(el instanceof Element)) return false;
      const tag = (el.tagName || '').toLowerCase();
      if (INTERACTIVE_TAGS.indexOf(tag) !== -1) return true;
      const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
      if (INTERACTIVE_ROLES.indexOf(role) !== -1) return true;
      if (hasClickHandler(el)) return true;
      // Editable surfaces (Notion / Slack composer / Lexical / TipTap).
      // contenteditable="" (empty string) is truthy per HTML spec.
      const ce = el.getAttribute && el.getAttribute('contenteditable');
      if (ce === 'true' || ce === '') return true;
      // Drag handles (kanban cards, sortable lists).
      if (el.getAttribute && el.getAttribute('draggable') === 'true') return true;
      return false;
    }

    function promoteToClickableRow(target) {
      try {
        const row = target.closest && target.closest('tr');
        if (!row || row === target) return target;
        const rowCursor = window.getComputedStyle(row).cursor;
        const rowClass = row.getAttribute('class') || '';
        if (rowCursor === 'pointer' || ROW_HOVER_CLASS_RE.test(rowClass)) {
          return row;
        }
      } catch (e) {}
      return target;
    }

    function elevateLabelToControl(target) {
      try {
        const tag = (target.tagName || '').toLowerCase();
        if (/^(input|select|textarea|button)$/.test(tag)) return target;
        const label = target.closest && target.closest('label');
        if (!label || label === target) return target;
        let control = null;
        const forAttr = label.getAttribute && label.getAttribute('for');
        if (forAttr) {
          try {
            const safeId = (typeof CSS !== 'undefined' && CSS.escape)
              ? CSS.escape(forAttr)
              : forAttr.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
            control = document.querySelector('#' + safeId);
          } catch (e2) {}
        }
        if (!control) {
          const nested = label.querySelectorAll('input, select, textarea');
          if (nested.length === 1) control = nested[0];
        }
        if (control && control !== target) return control;
      } catch (e) {}
      return target;
    }

    function findInteractive(el) {
      if (!(el instanceof Element)) return null;
      let interactive = null;
      const cursorChain = [];
      let cur = el;
      let chainLen = 0;
      for (let i = 0; cur && i < 10 && cur !== document.body && cur !== document.documentElement; i++) {
        if (!(cur instanceof Element)) { cur = cur.parentElement; continue; }
        chainLen++;
        if (isInteractive(cur)) {
          interactive = cur; // last-write wins ⇒ highest in chain
        }
        try {
          if (window.getComputedStyle(cur).cursor === 'pointer') {
            cursorChain.push(cur);
          }
        } catch (e) {}
        cur = cur.parentElement;
      }
      if (interactive) {
        let promoted = promoteToClickableRow(interactive);
        promoted = elevateLabelToControl(promoted);
        return promoted;
      }
      // Fallback: highest cursor:pointer ancestor, but bail when ALL nodes
      // are pointer (global * { cursor: pointer } gives no signal).
      if (cursorChain.length > 0 && cursorChain.length < chainLen) {
        const highest = cursorChain[cursorChain.length - 1];
        return promoteToClickableRow(highest);
      }
      return el;
    }
  `;
}
