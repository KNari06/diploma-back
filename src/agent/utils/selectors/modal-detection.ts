/**
 * Shared modal/overlay detection constants.
 *
 * All consumers run detection inside page.evaluate() (browser context),
 * so we export selector *strings* that get interpolated into evaluate calls
 * rather than Node-side functions.
 *
 * Framework coverage (verified against source code / DOM output):
 *   - Material UI (MUI)        : MuiModal-*, MuiDialog-*, MuiDrawer-*, MuiMenu-*, MuiPopover-*, MuiBackdrop-*, MuiTooltip-popper
 *   - Ant Design               : ant-modal-*, ant-drawer-*, ant-tooltip, ant-popover, ant-dropdown
 *   - Headless UI / Tailwind UI: [data-headlessui-state*="open"], [data-open]
 *   - Bootstrap 5              : .modal, .modal-backdrop, .modal-dialog
 *   - Radix UI / ShadCN        : [data-radix-popper-content-wrapper], [data-state="open"]
 *   - Vuetify 3                : v-overlay-*, v-dialog, v-menu, v-tooltip, v-navigation-drawer, v-bottom-sheet
 *   - Angular CDK              : cdk-overlay-pane, cdk-overlay-backdrop, cdk-overlay-container
 *   - Angular Material (MDC)   : mat-mdc-dialog-*, mdc-dialog--open, mat-mdc-snack-bar-container
 *   - Chakra UI v2             : chakra-modal__*, chakra-drawer__*, chakra-popover__*, chakra-tooltip
 *   - PrimeNG / PrimeVue       : p-dialog-*, p-sidebar, p-overlaypanel, p-tooltip
 *   - Semantic UI / Fomantic   : .ui.modal, .ui.dimmer, .dimmable
 *   - Mantine UI               : mantine-Modal-*, mantine-Drawer-*, mantine-Popover-*
 *   - Reach UI                 : [data-reach-dialog-overlay], [data-reach-dialog-content]
 *   - SweetAlert2              : swal2-container, swal2-popup, swal2-backdrop
 *   - react-toastify           : Toastify__toast-container, Toastify__toast
 *   - Sonner                   : [data-sonner-toaster], [data-sonner-toast]
 *   - Tippy.js                 : .tippy-box, [data-tippy-root]
 *   - react-hot-toast          : [data-rht-toaster]
 *   - Native HTML              : dialog[open]
 *   - Hand-rolled custom       : [data-modal], [data-overlay], [data-dialog], [data-portal]
 */

/** @legacy Targeted CSS selectors for elements likely to be modals/overlays.
 * Used as fallback when Layer 2 LLM classification is disabled.
 * Prefer IRON_CLAD_MODAL_SELECTORS + LLM classification for new code. */
export const MODAL_OVERLAY_SELECTORS = [
  // ── ARIA roles (universal, framework-agnostic) ──────────────────────────────
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',

  // ── Native HTML dialog element ───────────────────────────────────────────────
  // The <dialog> element with the open attribute is a visible, open dialog.
  // Widely supported in all modern browsers as of 2022+.
  'dialog[open]',

  // ── Generic utility classes (Bootstrap, hand-rolled, legacy) ────────────────
  '.modal',
  '.overlay',
  '.popup',
  '.drawer',

  // ── Broad class substring patterns (covers most frameworks) ──────────────────
  // modal / dialog / overlay / backdrop — already present, kept
  '[class*="modal"]',
  '[class*="overlay"]',
  '[class*="popup"]',
  '[class*="dialog"]',
  '[class*="backdrop"]',
  '[class*="popover"]',
  '[class*="sheet"]',
  '[class*="lightbox"]',
  '[class*="flyout"]',

  // dropdown — covers ant-dropdown, MuiPopover wrapper for MuiMenu, v-menu content wrappers
  '[class*="dropdown"]',

  // tooltip — NEW: covers MuiTooltip-popper, ant-tooltip, chakra-tooltip,
  //   v-tooltip, p-tooltip, tippy-box / tippy-content, MantineTooltip
  '[class*="tooltip"]',

  // dimmer — NEW: Semantic UI / Fomantic UI backdrop (.ui.dimmer)
  '[class*="dimmer"]',

  // sidebar — NEW: PrimeNG/PrimeVue p-sidebar, common hand-rolled patterns
  '[class*="sidebar"]',

  // Angular CDK — cdk-overlay-pane wraps every mat-dialog, mat-menu, mat-tooltip.
  // Using exact cdk-overlay prefix instead of [class*="-pane"] which matches
  // Bootstrap tab-pane, split-pane, reading-pane, and other unrelated layout elements.
  '[class*="cdk-overlay"]',

  // swal2 — NEW: SweetAlert2 (swal2-container, swal2-popup, swal2-backdrop)
  '[class*="swal2"]',

  // Toastify — NEW: react-toastify (Toastify__toast-container, Toastify__toast)
  '[class*="Toastify"]',

  // Mantine — NEW: mantine-Modal-*, mantine-Drawer-*, mantine-Popover-*, mantine-Tooltip-*
  '[class*="mantine-Modal"]',
  '[class*="mantine-Drawer"]',
  '[class*="mantine-Popover"]',
  '[class*="mantine-Tooltip"]',
  '[class*="mantine-Overlay"]',

  // ── Radix UI / ShadCN ────────────────────────────────────────────────────────
  // data-radix-popper-content-wrapper is applied by Radix Popper to every floating
  // element: Popover.Content, Tooltip.Content, DropdownMenu.Content, Select.Content.
  '[data-radix-popper-content-wrapper]',

  // data-state="open" narrowed to elements that also carry a dialog/modal ARIA role.
  // Plain [data-state="open"] is too broad — Radix also sets it on Accordion, Tabs,
  // Collapsible, Select.Trigger, etc. which are not overlays.
  '[data-state="open"][role="dialog"]',
  '[data-state="open"][aria-modal="true"]',

  // ── Headless UI (Tailwind UI) ────────────────────────────────────────────────
  // data-headlessui-state contains "open" for Dialog, Popover, Disclosure, Menu.
  // Narrowed with role to avoid false-positives on Disclosure / generic open panels.
  '[data-headlessui-state*="open"][role="dialog"]',
  '[data-headlessui-state*="open"][aria-modal="true"]',
  // data-open (Headless UI v2) — narrowed to actual dialog roles only.
  '[data-open][role="dialog"]',
  '[data-open][aria-modal="true"]',

  // ── Reach UI ────────────────────────────────────────────────────────────────
  '[data-reach-dialog-overlay]',
  '[data-reach-dialog-content]',

  // ── Sonner toast library ─────────────────────────────────────────────────────
  '[data-sonner-toaster]',
  '[data-sonner-toast]',

  // ── Tippy.js ─────────────────────────────────────────────────────────────────
  // data-tippy-root is applied to the outermost Tippy container div.
  '[data-tippy-root]',

  // ── react-hot-toast ──────────────────────────────────────────────────────────
  '[data-rht-toaster]',

  // ── Common hand-rolled / custom framework data attributes ────────────────────
  '[data-modal]',
  '[data-modal="true"]',
  '[data-overlay]',
  '[data-overlay="true"]',
  '[data-dialog]',
  '[data-portal]',
].join(', ');

/**
 * @legacy Selector for el.closest() ancestry checks (e.g. "is this input inside a modal?").
 * Covers ARIA roles, common CSS classes, and attribute patterns.
 * Intentionally broader than MODAL_OVERLAY_SELECTORS to catch any containing layer.
 * Used as fallback when Layer 2 LLM classification is disabled.
 */
export const MODAL_ANCESTOR_SELECTORS = [
  // ARIA
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',

  // Native dialog
  'dialog[open]',

  // Generic classes
  '.modal',
  '.dialog',
  '.popup',
  '.overlay',
  '.drawer',

  // Broad substring patterns
  '[class*="modal"]',
  '[class*="dialog"]',
  '[class*="popup"]',
  '[class*="overlay"]',
  '[class*="drawer"]',
  '[class*="tooltip"]',
  '[class*="dimmer"]',
  '[class*="sidebar"]',
  '[class*="swal2"]',

  // Mantine
  '[class*="mantine-Modal"]',
  '[class*="mantine-Drawer"]',
  '[class*="mantine-Popover"]',

  // Data attributes
  '[data-modal]',
  '[data-modal="true"]',
  '[data-overlay]',
  '[data-dialog]',
  '[data-portal]',

  // Radix / ShadCN / Headless UI — narrowed to dialog roles to avoid matching
  // Accordion, Tabs, Collapsible which also use data-state="open" / data-open.
  '[data-radix-popper-content-wrapper]',
  '[data-state="open"][role="dialog"]',
  '[data-state="open"][aria-modal="true"]',
  '[data-headlessui-state*="open"][role="dialog"]',
  '[data-headlessui-state*="open"][aria-modal="true"]',
  '[data-open][role="dialog"]',
  '[data-open][aria-modal="true"]',

  // Reach UI
  '[data-reach-dialog-overlay]',
  '[data-reach-dialog-content]',

  // Angular CDK — cdk-overlay-pane wraps every mat-dialog, mat-menu, mat-tooltip.
  // Using exact class prefix instead of [class*="-pane"] which matches tab-pane, split-pane, etc.
  '[class*="cdk-overlay"]',
].join(', ');

/**
 * Positional candidates selector (second pass).
 * Catches fixed/absolute elements that may not match class-based selectors,
 * including CSS-in-JS (Emotion/styled-components) modals with hashed class names.
 */
export const POSITIONAL_CANDIDATES_SELECTOR = [
  'body > *',
  'body > * > *',
  '[style*="position: fixed"]',
  '[style*="position:fixed"]',
  '[style*="position: absolute"]',
  '[style*="position:absolute"]',
].join(', ');

/** Selector for interactive child elements (buttons, inputs, links, etc.). */
export const INTERACTIVE_CHILDREN_SELECTOR = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * @legacy Regex to detect modal/popup-related class names.
 * Used for hasPopupClass scoring — NOT for initial candidate selection.
 *
 * Intentionally excludes overly generic terms:
 *   ✗ panel  — matches nav-panel, control-panel, side-panel, panel-body (layout elements)
 *   ✗ tray   — matches entry-tray, input-tray (unrelated)
 *   ✗ pane   — matches Bootstrap tab-pane, split-pane, reading-pane
 *   ✗ notification — matches any notification badge/counter
 *   ✗ menu   — matches nav-menu, top-menu, side-menu-item (navigation)
 *
 * Specific enough terms kept:
 *   tooltip   — MuiTooltip-popper, ant-tooltip, chakra-tooltip, v-tooltip, tippy-box
 *   dimmer    — Semantic UI / Fomantic UI .ui.dimmer
 *   sidebar   — PrimeNG p-sidebar (full-screen overlay panel)
 *   snackbar  — Angular Material mat-mdc-snack-bar-container
 *   toastify  — react-toastify (capital T, unique enough)
 *   swal2     — SweetAlert2 (unique prefix)
 *   tippy     — Tippy.js (unique prefix)
 *   mantine   — Mantine UI (unique prefix)
 *   cdk-overlay — Angular CDK overlay pane/container/backdrop
 *   toast     — generic toast (acceptable: toast elements are always overlays)
 */
export const MODAL_CLASS_REGEX =
  /modal|overlay|popup|popover|dialog|drawer|sheet|lightbox|flyout|backdrop|tooltip|dimmer|sidebar|snackbar|toastify|swal2|tippy|mantine|cdk-overlay|toast/i;

// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL OBSTACLE INTELLIGENCE — Iron-Clad & Dismissible Selectors
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Iron-clad modal selectors — ZERO false positive risk.
 * Only includes W3C ARIA spec signals and native HTML dialog.
 * Used by Layer 1 (deterministic detection).
 *
 * All framework-specific selectors (Radix, Headless UI, Reach UI, SweetAlert2)
 * are removed — they all set [role="dialog"] or [aria-modal="true"] which
 * these selectors already catch. Classification is now 100% LLM (Layer 2).
 */
export const IRON_CLAD_MODAL_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  'dialog[open]',
].join(', ');

// ═══════════════════════════════════════════════════════════════════════════
// KNOWN_DISMISSIBLE_SELECTORS and ALL_KNOWN_DISMISSIBLE_SELECTORS — REMOVED
// Classification of cookie banners, chat widgets, toasts, onboarding is now
// 100% LLM (Observer Agent Layer 2). See observer-agent.ts classification guide.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Close/dismiss button selectors — used to find the dismiss action
 * within an obstacle element.
 *
 * Universal-first: structural close affordances (ARIA labels in several
 * languages, `data-dismiss`/`data-close`, `btn-close` class) are the reliable,
 * language-agnostic signal. Word lists are unavoidably partial — keep them as a
 * weak tiebreaker, never the sole basis to click. See `EXPLICIT_CLOSE_AFFORDANCE`.
 */
export const CLOSE_BUTTON_SELECTOR = [
  // ARIA labels (case-insensitive). English + a spread of common non-English
  // close/dismiss terms so consent/promo modals on non-English sites still
  // expose a structural dismiss affordance.
  'button[aria-label*="close" i]',
  'button[aria-label*="dismiss" i]',
  'button[aria-label*="закрыть" i]', // ru
  'button[aria-label*="отклонить" i]', // ru
  'button[aria-label*="cerrar" i]', // es
  'button[aria-label*="fermer" i]', // fr
  'button[aria-label*="schließen" i]', // de
  'button[aria-label*="schliessen" i]', // de (no umlaut)
  'button[aria-label*="chiudi" i]', // it
  'button[aria-label*="fechar" i]', // pt
  'button[aria-label*="sluiten" i]', // nl
  'button[aria-label*="關閉" i]', // zh-Hant
  'button[aria-label*="关闭" i]', // zh-Hans
  'button[aria-label*="閉じる" i]', // ja
  'button[aria-label*="닫기" i]', // ko
  'button[aria-label*="إغلاق" i]', // ar

  // Class patterns
  '[class*="close"]',
  '[class*="dismiss"]',
  '[class*="btn-close"]',

  // Data attributes
  '[data-dismiss]',
  '[data-close]',

  // Common text-based close buttons
  'button[title*="close" i]',
  'button[title*="dismiss" i]',
].join(', ');

/**
 * Explicit close-affordance probe (run INSIDE page.evaluate on a candidate).
 *
 * Language-agnostic test for "this element is unambiguously a close control":
 * a structural close attribute/class/role, OR an `aria-label`/`title` matching a
 * close word in any supported language, OR a recognisable × glyph as its only
 * text. This is the signal the dismisser requires before clicking a button —
 * far safer on non-English sites than matching a visible text word list.
 *
 * Returns a JS expression string body? No — exported as a string of source that
 * defines `hasExplicitCloseAffordance(el, win)` inside the evaluate sandbox,
 * keeping a single source of truth without serialising a Node closure.
 */
export const CLOSE_AFFORDANCE_FN_SOURCE = `
  function hasExplicitCloseAffordance(el) {
    if (!el) return false;
    var aria = (el.getAttribute('aria-label') || '').toLowerCase();
    var title = (el.getAttribute('title') || '').toLowerCase();
    var meta = aria + ' ' + title;
    // Structural attributes / classes / role — fully language-agnostic.
    if (el.hasAttribute('data-dismiss') || el.hasAttribute('data-close')) return true;
    var cls = (el.getAttribute('class') || '').toLowerCase();
    if (/(^|[^a-z])(close|dismiss|btn-close)([^a-z]|$)/.test(cls)) return true;
    // Multi-language close words in aria-label / title (not visible text — these
    // attributes are authored explicitly, so a match is high-confidence).
    var CLOSE_WORDS = ['close','dismiss','закрыть','отклонить','cerrar','fermer','schließen','schliessen','chiudi','fechar','sluiten','关闭','關閉','閉じる','닫기','إغلاق'];
    for (var i = 0; i < CLOSE_WORDS.length; i++) {
      if (meta.indexOf(CLOSE_WORDS[i]) !== -1) return true;
    }
    // × glyph as the element's ENTIRE text — the universal close icon.
    var txt = (el.textContent || '').trim();
    if (txt.length <= 2 && /^[×✕✖xX✗╳]$/.test(txt.replace(/\\s/g, ''))) return true;
    return false;
  }
`;

/**
 * Destructive-action text patterns — buttons whose text matches these must
 * NEVER be auto-clicked (delete / logout / unsubscribe / reset …).
 *
 * Universality contract: uses a Unicode-aware boundary `(?![\p{L}\p{N}])` (NOT
 * `\b`, which is ASCII-only and never matches Cyrillic/CJK), and includes common
 * non-English destructive terms. A miss here can cause real data loss (clicking
 * "Удалить"/"删除" while auto-dismissing an overlay), so this is intentionally
 * broad and the dismisser ALSO refuses to click any button lacking an explicit
 * close affordance — the word list is a backstop, not the only guard.
 *
 * Two exported forms because consumers run in two contexts:
 *   - DESTRUCTIVE_TEXT_REGEX — Node-side (`u` flag, lookahead boundary).
 *   - DESTRUCTIVE_WORDS — plain word list for in-page substring checks where a
 *     pre-built `u`-flag literal can't be re-derived cheaply.
 */
export const DESTRUCTIVE_WORDS: readonly string[] = [
  // English
  'delete', 'remove', 'unsubscribe', 'deactivate', 'disable', 'logout',
  'log out', 'sign out', 'erase', 'reset', 'terminate', 'revoke', 'destroy',
  'cancel subscription', 'clear all',
  // Russian
  'удалить', 'удали', 'выйти', 'выход', 'отписаться', 'деактивировать', 'сбросить', 'стереть',
  // Spanish
  'eliminar', 'borrar', 'cerrar sesión', 'cerrar sesion', 'desactivar',
  // French
  'supprimer', 'déconnexion', 'deconnexion', 'se déconnecter', 'désactiver',
  // German
  'löschen', 'loschen', 'abmelden', 'entfernen', 'deaktivieren',
  // Portuguese / Italian
  'excluir', 'apagar', 'sair', 'eliminare', 'disconnetti',
  // CJK
  '删除', '刪除', '注销', '登出', '退出', '削除', 'ログアウト', '삭제', '로그아웃',
];

/**
 * Unicode-aware destructive-text matcher. `(?![\p{L}\p{N}])` is the boundary —
 * matches a destructive term not immediately followed by another letter/number,
 * so it works for Cyrillic/CJK where `\b` is silently inert.
 */
export const DESTRUCTIVE_TEXT_REGEX = new RegExp(
  '(' +
    DESTRUCTIVE_WORDS
      // Words contain only letters and spaces — escape regex metachars, then
      // collapse spaces to `\s*` so "log out" / "log  out" / "logout" all match.
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'))
      .join('|') +
  ')(?![\\p{L}\\p{N}])',
  'iu',
);

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3: MINIMAL REACTIVE FALLBACK PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Minimal blocker classification for Layer 3 reactive fallback ONLY.
 * Used inside identifyBlocker() where there is NO time for an LLM call.
 *
 * Only covers patterns where the recovery action differs from the default
 * (dismiss_escape). All other classification is done by LLM (Layer 2).
 *
 * cookie_consent → dismiss_button (not escape)
 * toast → wait (transient, auto-dismisses)
 * loading_overlay → wait (transient, must not interact)
 */
export const LAYER3_FALLBACK_PATTERNS: Record<string, RegExp> = {
  cookie_consent: /cookie[-_]?consent|cookie[-_]?banner|gdpr|ccpa|onetrust|cookiebot/i,
  toast: /toastify|sonner|snack[-_]?bar|notistack/i,
  loading_overlay: /loading|spinner|loader/i,
};

/**
 * Obstacle type → suggested recovery action mapping.
 * Used by Layer 3 (identifyBlocker) to suggest how to recover from a blocked click.
 */
export const OBSTACLE_RECOVERY_MAP: Record<string, 'dismiss_escape' | 'dismiss_button' | 'scroll_around' | 'wait' | 'click_away' | 'navigate_back'> = {
  modal: 'dismiss_escape',
  cookie_consent: 'dismiss_button',
  chat_widget: 'dismiss_button',
  toast: 'wait',
  sticky_header: 'scroll_around',
  sticky_footer: 'scroll_around',
  loading_overlay: 'wait',
  dropdown: 'click_away',
  tooltip: 'click_away',
  drawer: 'dismiss_escape',
  onboarding: 'dismiss_button',
  paywall: 'navigate_back',
  unknown: 'dismiss_escape',
};
