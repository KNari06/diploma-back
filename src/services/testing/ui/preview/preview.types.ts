/**
 * Preview Session Types
 * Types for realtime step editor and preview functionality
 */

// Canonical cross-repo Trigger contract lives in the mobile runner types
// (single source of truth, mirrored by qait-mobile-runner's zod schema).
import type { Trigger } from '@/services/mobile/mobile-runner.types';

// ═══════════════════════════════════════════════════════════════════════════
// INTERACTIVE NODE (for dom_analysis storage)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bounding box for element (used for highlighting)
 */
export interface ElementBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Interactive node stored in dom_analysis
 * Structure for linting/resolving without live browser
 * V2: Includes ARIA state, validation, labels, hierarchy
 */
export interface InteractiveNode {
  /** Stable reference (data-agent-ref if available) */
  ref?: string;
  /** HTML tag */
  tag: string;
  /** ARIA role or computed role */
  role?: string;
  /** Input type (for input elements) */
  type?: string;
  inputType?: string;
  /** Text content (truncated) */
  text?: string;
  /**
   * V26: First non-empty text fragment as it actually appears in the DOM —
   * not the concatenated full innerText. Used to handle Angular Material /
   * Vue scoped / Web Component patterns where a card's title and
   * description live in DIFFERENT child elements:
   *
   *   <a><app-title>МАТ-SMART</app-title><span>Бекнұр • Курс аяқталды</span></a>
   *
   * `text` would be the joined "МАТ-SMART Бекнұр • Курс аяқталды" — which
   * `getByText(...)` cannot match because the DOM has no single text node
   * with that string. `firstTextFragment` is "МАТ-SMART" alone, which IS a
   * single-text-node match.
   *
   * Set ONLY when it differs from `text` (otherwise the locator builder
   * would generate a redundant strategy). Symmetric: recorder and
   * collector use the same extraction logic, so recorded fingerprints and
   * live snapshots agree byte-for-byte.
   */
  firstTextFragment?: string;
  /** Associated label text (from <label for=>, wrapping <label>, aria-labelledby) */
  labelText?: string;
  /** ARIA label */
  ariaLabel?: string;
  /** HTML title attribute (tooltip text — useful for icon-only buttons) */
  title?: string;
  /** True if element is an icon-only button (SVG/img child, no visible text) */
  isIconButton?: boolean;
  /** HTML name attribute */
  name?: string;
  /** Placeholder text */
  placeholder?: string;
  /** HTML id attribute */
  id?: string;
  /** Test ID attribute (data-testid, data-test, etc.) */
  testIdAttr?: string;
  /** Autocomplete hint (email, username, current-password, etc.) */
  autocomplete?: string;
  /** Bounding box (for highlighting) */
  boundingBox?: ElementBoundingBox;
  /** Visibility flag */
  isVisible?: boolean;
  /** Interactive flag */
  isInteractive?: boolean;
  /** Disabled flag */
  isDisabled?: boolean;
  /** Container hints for context (legacy) */
  containerHints?: {
    formGroupTitle?: string;
    parentClassTokens?: string[];
  };
  /** True if element is topmost at its center (not covered by overlay) */
  isTopMostAtCenter?: boolean;
  /** True if element is inside the active modal/popup/overlay layer */
  isInsideActiveModal?: boolean;
  /**
   * True if element lies in a small fixed corner widget layer (geometry-derived,
   * e.g. a chat/assistant bubble). Mirrors LiteElement.floatingWidget; computed
   * in-page (viewport-relative) and symmetric across both collectors. The
   * resolver deprioritizes such nodes so a corner widget's buttons don't pollute
   * the candidate set (escape-hatch when the step actually targets the widget).
   */
  floatingWidget?: boolean;
  /** True if id looks like a dynamic GUID/random string */
  isDynamicId?: boolean;

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: ARIA state
  // ═══════════════════════════════════════════════════════════════════════════
  /** Native checked state (for checkboxes/radios) */
  checked?: boolean;
  /** aria-expanded state (for dropdowns, accordions, menus) */
  ariaExpanded?: boolean;
  /** aria-pressed state (for toggle buttons) */
  ariaPressed?: boolean;
  /** aria-selected state (for tabs, listbox options) */
  ariaSelected?: boolean;
  /** aria-checked for custom checkboxes/switches */
  ariaChecked?: boolean | 'mixed';
  /**
   * Radix UI / shadcn / Vaul / many headless React libs encode toggle state
   * via `data-state="open|closed|active|inactive|on|off|checked|unchecked"`.
   * Some Radix primitives (Dialog, Popover, DropdownMenu) do NOT mirror it
   * to `aria-expanded` — without this signal verifier reports the click
   * had no effect even when the menu actually opened (canonical fake-success
   * symptom). Length-capped at 30 chars to stay defensive against
   * pathological values; raw casing preserved (Radix uses camelCase like
   * 'forceMount'). Mirror of LiteElement.dataState.
   */
  dataState?: string;
  /**
   * V22 Pkg1: aria-current — for Pagination current page, Stepper active
   * step, Breadcrumbs last crumb. Raw value: 'page' | 'step' | 'true' | etc.
   */
  ariaCurrent?: string;
  /**
   * V22 Pkg1: aria-valuenow / aria-valuetext — slider/spinbutton/progressbar
   * current value. Mirrors recording-time extraction so heal-time fingerprint
   * can match by semantic value.
   */
  ariaValueNow?: number;
  ariaValueText?: string;
  /**
   * V22 Pkg1: data-value or `<option value="...">` — semantic key for select
   * options / list items / chips, distinct from display text.
   */
  dataValue?: string;
  /**
   * V22 Pkg1: data-testid of single direct icon child (svg/i/img) when the
   * node itself is descriptor-poor (no text/aria/testid). Lets the resolver
   * surface a meaningful name in candidateText for IconButton-shaped targets.
   */
  childTestId?: string;
  /**
   * V22 Pkg4: Semantic icon name from svg-internal accessibility (`<title>`,
   * `<desc>`), sprite reference (`<use href="#icon-X">`), icon-library
   * data-attrs (`data-lucide`, `data-feather`, `data-icon`, `data-iconify-name`),
   * FontAwesome class tokens, or background-image URL filename. Used for
   * `<div role="button"><svg/></div>` patterns where neither testId nor
   * childTestId is available — closes the "fully bare icon button" gap.
   */
  iconLabel?: string;
  /**
   * Angular Material icon registry name. Read from `svgicon` attribute on
   * `<mat-icon>` (or `data-mat-icon-name` mirror). Survives across builds
   * and re-renders — Material registers each icon once globally and the
   * attribute is the lookup key. Strong identity signal for Material apps
   * where the SVG itself has no `<title>`/aria-label/text.
   *
   *   <mat-icon svgicon="chevron-left-outline"><svg>...</svg></mat-icon>
   *
   * Distinct from `iconLabel` (which sources from svg <title>, data-lucide,
   * FA classes). When both are present we prefer svgIcon as the identity —
   * iconLabel can be derived from generic CSS class tokens that overlap
   * across icons; svgIcon comes from the explicit registration name.
   */
  svgIcon?: string;
  /**
   * Closest semantic custom-element ancestor (`<app-foo-bar>` /
   * `<my-button>` / etc.). See TargetFingerprint.customElementTag for
   * the rationale and filter rules. Used by the resolver's identity
   * fast-path so an Angular icon-only button wrapped in a meaningful
   * `<app-X>` tag still gets a deterministic match.
   */
  customElementTag?: string;
  /**
   * V23: `<img alt="...">` — WCAG-recommended accessible name for image
   * targets. Promoted from "checked but not stored" status so the resolver,
   * builder, and getEffectiveLabel() can use it as a first-class identity
   * source instead of reading via `(node as any).alt`.
   */
  alt?: string;
  /**
   * V23: `<a href="...">` — link destination. Used by builder for
   * hash-anchor (`#section-id`) and pathname-suffix locator strategies,
   * and by candidateText to disambiguate duplicate visible text by destination.
   */
  href?: string;
  /**
   * V23: First 1-3 stable className tokens (utility-class noise stripped at
   * probe time). Used by builder's scoped-text fallback strategies.
   */
  cssClass?: string;
  /**
   * V23: Vue scoped-style attribute (`data-v-XXXXXX`). Stable per-component
   * instance marker; narrows cross-redesign matches in Vue apps.
   */
  vueScopeId?: string;
  /** Etap 1B.2 — Angular `routerLink` directive value. */
  routerLink?: string;
  /** Etap 1B.2 — Angular reactive-forms `formControlName`. */
  formControlName?: string;
  /**
   * V23: Compact ancestor chain summary like `header > div.icon-group > svg`
   * — see TargetFingerprint.ancestorSummary for rationale.
   */
  ancestorSummary?: string;
  /** V22 Pkg2: Bootstrap data-bs-toggle marker. */
  bsToggle?: string;
  /** V22 Pkg2: Bootstrap data-bs-target selector. */
  bsTarget?: string;
  /** V22 Pkg2: aria-haspopup popup-trigger marker. */
  ariaHasPopup?: string;
  /** V22 Pkg2: aria-activedescendant — id of currently-active descendant. */
  ariaActiveDescendant?: string;
  /** V22 Pkg2: data-row-key / data-rk — stable row identity for tables. */
  dataRowKey?: string;
  /**
   * V22 Pkg2: heuristic flag — row that LOOKS clickable even without
   * role/onclick (cursor:pointer + hover-style class). Resolver weighs
   * this when ranking candidates inside a table context.
   */
  rowClickable?: boolean;
  /**
   * V22 Pkg5: Concatenated text of sibling cells inside the nearest
   * row container — uniqueness signal for descriptor-poor row checkboxes
   * and action buttons. Format: "<cell1> | <cell2> | <cell3>".
   */
  nearestRowText?: string;
  /**
   * V22 Pkg5: nth-of-type index among same-class siblings. Bounded to
   * 2..10 siblings. Anchors pagination prev/next, tabs, button groups
   * where attribute identity is missing.
   */
  siblingIndex?: number;
  /**
   * V22 Pkg5: Recorded disabled state (combines `disabled` attr,
   * `aria-disabled`, and disabled CSS class tokens). Distinguishes
   * pagination prev (disabled at start) from next (enabled).
   */
  disabled?: boolean;
  /**
   * V22 Pkg5: Cardinal direction inferred from svg path geometry.
   * Last-resort hint for svg-only buttons (prev/next, expand/collapse).
   */
  arrowDir?: 'left' | 'right' | 'up' | 'down';

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Validation state
  // ═══════════════════════════════════════════════════════════════════════════
  /** HTML required attribute */
  required?: boolean;
  /** HTML readonly attribute or aria-readonly */
  readOnly?: boolean;
  /** aria-invalid or :invalid pseudo-class */
  invalid?: boolean;
  /** True if input has a non-empty value (privacy-safe) */
  hasValue?: boolean;

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Hierarchy (parent chain for disambiguation)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Refs of key ancestor containers (closest-first, max depth 6) */
  parentRefChain?: string[];
  /** Ref of nearest form/dialog/section container */
  containerRef?: string;
  /** Titles of key containers (form legend, fieldset legend, section heading, ARIA groups) */
  containerTitles?: string[];
  /** Nearest ARIA landmark role (banner, navigation, main, complementary, search, etc.) */
  nearestLandmark?: string;
  /** Phase 4: Framework event binding detected (React/Vue/Angular/Alpine/HTMX/Stimulus/Knockout/Qwik/jQuery/Svelte) */
  frameworkClickable?: 'react' | 'vue' | 'angular' | 'alpine' | 'htmx' | 'stimulus' | 'knockout' | 'qwik' | 'jquery' | 'svelte';
  /** Phase 4: Element has contenteditable="true" (rich text editor, inline text field) */
  isContentEditable?: boolean;
  /** Phase 4: Element has tabindex >= 0 (explicitly keyboard-focusable) */
  tabIndex?: number;
  /** Phase 4: Element has onclick attribute or inline click handler */
  hasOnclick?: boolean;
  /** Phase 4: Element has aria-haspopup attribute (popup trigger) */
  hasAriaHaspopup?: boolean;
  /** Nearby sibling/row text for disambiguation of duplicate elements (e.g. row context in tables) */
  nearText?: string;

  // ═══════════════════════════════════════════════════════════════════════════
  // V8: Visual properties for LLM element matching
  // ═══════════════════════════════════════════════════════════════════════════
  /** Named background color (e.g. "red", "grey", "blue", "white", "transparent") */
  backgroundColor?: string;
  /** Named text/foreground color (e.g. "black", "white", "red") */
  textColor?: string;
  /** Shape hint based on border-radius ("rounded" | "pill" | "circle" | "square") */
  shapeHint?: string;
  /** CSS class names related to icons (e.g. "fa-gear material-icons") */
  iconClasses?: string;
  /** Semantic size category based on pixel dimensions */
  sizeHint?: 'small' | 'medium' | 'large';
  /** Source iframe name/id if element is inside a same-origin iframe */
  iframeSource?: string;
  /**
   * Durable CSS selector for the owning <iframe> in the parent document.
   * Threaded from `LiteElement.iframeSelector` so the compiled-plan builder
   * can persist a frame-scoped replay locator (`action.options.iframe`).
   */
  iframeSelector?: string;
}

/**
 * V15: Tab info for multi-tab preview support
 */
export interface PreviewTabInfo {
  /** Tab index (0 = initial page, 1+ = popups) */
  tabIndex: number;
  /** Current URL of the tab */
  url: string;
  /** Page title */
  title?: string;
  /** Whether this tab is currently active */
  isActive: boolean;
}

/**
 * DOM analysis structure stored in intelligent_page_visits.dom_analysis
 */
export interface DomAnalysisData {
  /** Interactive elements on the page */
  interactiveNodes: InteractiveNode[];
  /** Page URL at time of capture */
  url?: string;
  /** Page title */
  title?: string;
  /** Timestamp of capture */
  capturedAt: number;
  /** Version for future migrations */
  version: string;
  /** V26: Real browser viewport at capture time. Used for modal-coverage
   *  ratio in `buildAllowedSets` — without this, long scrollable pages
   *  underestimate modal coverage and the blocking-modal hard-exclude rule
   *  never fires. Optional for backwards compatibility. */
  viewport?: { width: number; height: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTENT STEP (for user-authored test cases)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Action type for intent steps (V2: added state-aware actions, V3: added ai_check, V4: replaced fill with type, V5: added wait_for)
 */
export type IntentActionType =
  | 'type'
  | 'click'
  | 'wait'
  // Real sleep/pause: wait N milliseconds, no element, no URL matcher
  | 'timeout'
  | 'assert'
  | 'navigate'
  | 'select'
  | 'hover'
  | 'scroll'
  | 'press'
  // V2: State-aware action types
  | 'check'
  | 'uncheck'
  | 'toggle'
  | 'open'
  | 'close'
  // V3: AI-powered assertion
  | 'ai_check'
  // V5: URL wait (Momentic-like matchers + auto-insert support)
  | 'wait_for'
  // V6: File upload
  | 'upload'
  // V10: Advanced interaction types (recording)
  | 'dblclick'
  | 'contextmenu'
  | 'drag_and_drop'
  // V12: Email inbox (wait for email, extract OTP/link via AI)
  | 'wait_for_email'
  // V13: Native browser dialog (alert/confirm/prompt/beforeunload)
  | 'dialog'
  // V13: File download verification (auto-recorded when download triggers)
  | 'download'
  // V15: Multi-tab support — explicit tab switch
  | 'switch_tab'
  // Multi-tab — close a tab by index. Recorded when the user clicks × on
  // a pill in the preview tab bar during a recording session. Replay closes
  // the same tabIndex; if it's already gone the step soft-succeeds (the
  // intent — "this tab should not exist anymore" — is already true).
  | 'close_tab'
  // Multi-tab — open a new tab and navigate it to a URL. The new tab becomes
  // active (matches popup adoption). Requires a URL: a tab left at about:blank
  // is auto-closed by `attachPopupHandler`. URL travels in `step.value`.
  | 'open_tab'
  // V16: Gesture and coordinate actions (carousels, canvas, maps)
  | 'swipe'
  | 'click_at'
  // V17: Meta / Scratchpad — store a key-value pair for cross-step memory
  | 'store'
  // V-cross-app: run another saved test case at this point in the sequence,
  // possibly on a different platform. See StepOptions.linkTestCase.
  | 'link_test_case';

/**
 * Binding hints for element resolution
 * Helps the linting engine find the right element
 */
export interface BindingHints {
  /** ARIA role or tag-based role */
  role?: string;
  /** Label text to match */
  label?: string;
  /** Placeholder text to match */
  placeholder?: string;
  /** Nearby text for context */
  nearText?: string;
  /** URL pattern where this step applies */
  urlPattern?: string;
  /** Page type (login, checkout, etc.) */
  pageType?: string;
  /** Autocomplete hint (email, password, etc.) */
  autocomplete?: string;
  /** Input type (text, email, password, etc.) */
  type?: string;
  /** V15: Element text content — helps LLM resolver find element after redesign */
  text?: string;
  /** V15: HTML tag of the interactive element — structural hint for replay */
  tag?: string;
  /** V18: data-testid/data-test/data-cy — stable test identifier for reliable element matching */
  testId?: string;
  /**
   * V22: DOM `id` attribute (filtered to skip framework-generated UIDs).
   * Highest-confidence locator after testId — `#layout-header-setting`
   * pinpoints icon-only svg/div elements where text/aria-label are empty.
   */
  elementId?: string;
  /**
   * V22: First 1-3 stable className tokens (utility-class noise stripped).
   * Secondary locator — useful when id is missing but framework-scoped
   * class is unique (e.g. `el-button--primary`).
   */
  cssClass?: string;
  /**
   * V22: aria-controls — semantic uniqueness signal for dropdowns/tabs/menus.
   */
  ariaControls?: string;
  /**
   * V22: href — for <a> tags, differentiates duplicate link text by destination.
   */
  href?: string;
  /**
   * `<a target="...">` attribute, captured at record time when non-empty.
   * Drives the new-tab path in the replay layer — anchors with `_blank` (or
   * any named target) are opened via `context.newPage() + goto(href)` so the
   * preview session gains a real second tab in `session.pages[]` instead of
   * collapsing the navigation into the active tab.
   */
  linkTarget?: string;
  /**
   * V22: Vue scoped style attribute name (`data-v-XXXXXXX`). Stable per-component
   * marker that narrows down element identity within a Vue app.
   */
  vueScopeId?: string;
  /** Etap 1B.2 — Angular `routerLink` directive value. */
  routerLink?: string;
  /** Etap 1B.2 — Angular reactive-forms `formControlName`. */
  formControlName?: string;
  /** V22: <img alt="…"> — fallback identifier for image targets. */
  alt?: string;
  /** V22: HTML name attribute (form fields). */
  name?: string;
  /**
   * V22: ARIA state at recording time. Distinguishes "click toggle when
   * expanded" from "click toggle when collapsed" — the resolver picks the
   * right candidate when the page has multiple toggles in different states.
   * `invalid` covers negative-test scenarios (records "click on invalid
   * email field with red border" so replay can match the same visual state).
   * `current` (V22 Pkg1) covers Pagination/Stepper/Breadcrumbs disambiguation —
   * "click current page" stays meaningful even when all page buttons share
   * identical text/role.
   * `valueNow`/`valueText` (V22 Pkg1) record the live numeric / textual value
   * of slider/spinbutton/progressbar so replay can either match the exact
   * value or skip the step if the value already matches.
   */
  ariaState?: {
    expanded?: boolean;
    pressed?: boolean;
    checked?: boolean;
    invalid?: boolean;
    current?: string;
    valueNow?: number;
    valueText?: string;
  };
  /**
   * Radix/shadcn/Vaul `data-state` at recording time. Captured separately
   * from `ariaState` because (a) it doesn't fit the boolean schema (raw
   * string keyword), and (b) it can be set INDEPENDENTLY of aria-* — many
   * Radix primitives don't mirror to aria. Used by the click-effect
   * verifier (post-action-verify state-reflected phase) to recognise
   * Radix open/close transitions; used by `inferClickActionType` to
   * record the right step type ('open' vs 'click') when aria-expanded
   * is missing. Read by element-resolver candidateText / scene summary
   * for LLM disambiguation between already-open and closed triggers.
   */
  dataState?: string;
  /**
   * V22 Pkg1: data-value / `<option value>` — semantic key for select
   * options / list items / chips, distinct from their display label.
   */
  dataValue?: string;
  /**
   * V22 Pkg1: data-testid of the SINGLE direct icon child (svg/i/img),
   * promoted to the parent button's hints when the button itself has no
   * descriptor. Closes the IconButton-with-icon-testid gap on MUI / AntD /
   * Element Plus.
   */
  childTestId?: string;
  /**
   * V22 Pkg4: Semantic icon name extracted from svg-internal accessibility
   * (`<title>`, `<desc>`, `<use href="#icon-X">`), icon-library data-attrs
   * (`data-lucide`, `data-feather`, `data-icon`, `data-iconify-name`),
   * FontAwesome class tokens, or background-image URL filename. Last-line
   * defense for fully-bare icon buttons (`<div role="button"><svg/></div>`
   * with no testId / aria-label / title).
   */
  iconLabel?: string;
  /**
   * Angular Material icon registry name (`svgicon` attribute on `<mat-icon>`).
   * Mirror of `TargetFingerprint.svgIcon` — see that field for rationale.
   */
  svgIcon?: string;
  /**
   * Closest semantic custom-element ancestor's tag name. Mirror of
   * `TargetFingerprint.customElementTag` — see that field for rationale.
   */
  customElementTag?: string;
  /**
   * V22 Pkg2: Bootstrap toggle marker (data-bs-toggle). Distinguishes
   * "real Bootstrap dropdown trigger" from a static button with similar
   * styling. Values: 'modal' | 'dropdown' | 'tab' | 'collapse' | 'tooltip' | etc.
   */
  bsToggle?: string;
  /**
   * V22 Pkg2: Bootstrap target selector (data-bs-target). Stable pointer
   * to the controlled element — useful when same toggle text appears
   * multiple times (e.g. all rows have a "Delete" dropdown).
   */
  bsTarget?: string;
  /**
   * V22 Pkg2: aria-haspopup — popup-trigger marker. Values per W3C: 'menu' |
   * 'listbox' | 'tree' | 'grid' | 'dialog' | 'true' | 'false'.
   */
  ariaHasPopup?: string;
  /**
   * V22 Pkg2: aria-activedescendant — id of currently-active descendant.
   * Combobox/Listbox/Tree typeahead state at recording time.
   */
  ariaActiveDescendant?: string;
  /**
   * V22 Pkg2: data-row-key / data-rk — stable row identity that survives
   * table re-renders (Ant Design Table, RainbowKit).
   */
  dataRowKey?: string;
  /**
   * V22 Pkg5: Concatenated text of sibling cells in nearest row container.
   * Identity for descriptor-poor row checkboxes / action buttons.
   */
  nearestRowText?: string;
  /**
   * V22 Pkg5: nth-of-type index among same-class siblings (2..10).
   * Anchors pagination prev/next, tab strips, button groups.
   */
  siblingIndex?: number;
  /**
   * V22 Pkg5: Recorded disabled state (boolean). Distinguishes pagination
   * prev (disabled) from next (enabled) when both share class & geometry.
   */
  disabled?: boolean;
  /**
   * V22 Pkg5: Cardinal direction inferred from svg path geometry.
   * Last-resort hint for svg-only pagination/expand buttons.
   */
  arrowDir?: 'left' | 'right' | 'up' | 'down';
  /**
   * V22: Nearest ARIA landmark (banner / navigation / main / footer / etc.).
   * Disambiguates "Settings" in nav from "Settings" in footer.
   */
  nearestLandmark?: string;
  /**
   * V22: Up to 2 enclosing container titles (form legend, dialog title,
   * section heading). Helps the resolver when same label recurs across
   * forms or sections.
   */
  containerTitles?: string[];
  /**
   * V22: Compact one-line ancestor chain summary. Format:
   * `"header[role=banner] > div.icon-group > svg"`. Replaces the transient
   * `ProbedElement.ancestorChain` for persistence — chain itself is too
   * heavy for the JSON payload and explicitly marked non-persistent.
   */
  ancestorSummary?: string;
}

/**
 * Confidence tier for resolution/execution quality
 */
export type ConfidenceTier = 'high' | 'medium' | 'low';

/**
 * Resolution metadata from linting/execution
 */
export interface ResolutionMeta {
  /** Count of elements in allowed set */
  allowedCount: number;
  /** Rule IDs that were applied */
  usedRules?: string[];
  /** Whether LLM was used for element resolution */
  usedLLM: boolean;
  /** Confidence tier based on resolution quality */
  confidenceTier: ConfidenceTier;
  /** Top similarity score from LLM resolution */
  topSimilarity?: number;
}

/**
 * Evidence cache from last successful execution
 * Used as optimization hint, not as truth
 */
export interface StepEvidence {
  /** Last successful element ref */
  lastSuccessRef?: string;
  /** Last successful selector */
  lastSuccessSelector?: string;
  /** Confidence score (0-1) */
  confidence?: number;
  /** Node IDs from graph that evidence this step */
  evidenceNodeIds?: string[];
  /** Resolution metadata from last successful lint/apply */
  resolutionMeta?: ResolutionMeta;
  /** URL where this evidence was captured (guards against cross-page ref collision in SPAs) */
  pageUrl?: string;
  /**
   * V15.6: ISO timestamp when this evidence was recorded. Used to reject
   * stale evidence — data-agent-ref values are DOM-counter-based and unstable
   * across long gaps (page reloads, server restart + replay, browser restart).
   * When the cached ref is older than EVIDENCE_REF_TTL_MS, we bypass the
   * shortcut and go through full LLM resolution. The 60-minute default is
   * generous enough for same-session replays but catches cross-session staleness.
   */
  capturedAt?: string;
  /**
   * V14: Time between previous step recording and this step recording (ms).
   * Used as a minimum wait hint during replay — if user waited 3s between steps,
   * the page likely needs at least ~2s to be ready.
   */
  interStepDelayMs?: number;
  /** V15: Tab index where evidence was captured (multi-tab support) */
  tabIndex?: number;
  /** Number of times this step's selector was healed across runs (flakiness indicator) */
  healCount?: number;
  /** ISO timestamp of last heal */
  lastHealedAt?: string;
  /** Flagged for human review after repeated heals */
  needsReview?: boolean;
  /**
   * Hover-effect summary captured at recording time.  Set only on hover steps
   * that passed the structural-effect gate (the recorder confirmed the hover
   * caused a real DOM change: new interactive appeared, aria-expanded
   * flipped, or Radix data-state opened).  Replay can re-run the same probe
   * post-hover and assert the effect still happens — if not, we know we
   * targeted a different element than the recording.
   */
  hoverEffect?: {
    /** post.interactiveCount - pre.interactiveCount inside target's 3-up subtree. */
    newInteractive: number;
    /**
     * post.visualInteractiveCount - pre.visualInteractiveCount.
     * Stricter than `newInteractive`: filters out opacity:0 / visibility:hidden
     * elements.  Catches the row-affordance pattern (opacity:0 button revealed
     * on hover) which `newInteractive` alone misses because layout-visible
     * count doesn't change when only opacity transitions.
     */
    newVisualInteractive: number;
    /** Any aria-expanded along target → 3 ancestors flipped to "true". */
    expandedTriggered: boolean;
    /** Any data-state along target → 3 ancestors moved into open/active/checked/on. */
    dataStateOpened: boolean;
  };
}

/**
 * Etap 1D.2 — Failure evidence bundle.
 *
 * Captured when an apply exhausts the full resolver waterfall (compiled
 * plan failed AND lint/LLM/vision failed) so the user can debug WHY a
 * step is broken without re-running it. Persisted in
 * `IntentStep.failureEvidence`.
 *
 * Replaces silent failures: today a fully-failed apply emits a
 * `success: false` WS result and disappears. The user sees a red toast
 * but has no record of which strategies were tried, what the page looked
 * like, or what the resolver thought went wrong.
 *
 * Capped storage:
 *   - `attempts` keeps at most 10 most recent (oldest dropped)
 *   - the bundle as a whole keeps the LAST failure (single object, not
 *     a history array) — flaky steps would otherwise bloat JSONB rows
 */
export interface StepFailureEvidence {
  /** ISO timestamp of when this bundle was collected. */
  capturedAt: string;
  /** URL at the moment of failure — for debugging cross-page drift. */
  pageUrl: string;
  /**
   * V26 Batch A: WHERE in the apply pipeline did the failure originate.
   * Top-level field (mirrored into `attempts[0].failureKind` for older
   * consumers) so the dashboard can group/filter without iterating the
   * attempts array. Distinct values are stable identifiers consumed by
   * the editor's "stuck steps" widget — adding a new one is non-breaking
   * but consumers should treat unknown values as `'other'`.
   *
   * Domain:
   *   - `wait_for_timeout`            — wait_for didn't observe URL change
   *   - `wait_for_email_failed`       — wait_for_email IMAP poll failed
   *   - `select_no_match`             — no option matched the value
   *   - `upload_no_file`              — file chooser missed all paths
   *   - `navigate_failed`             — page.goto threw / 5xx
   *   - `click_action_threw`          — Playwright click() threw
   *   - `fake_success_guard`          — post-click verifier rejected
   *   - `pre_click_label_mismatch`    — pre-click guard aborted
   *   - `resolver_exhausted`          — full resolver waterfall failed
   *   - `session_invalid`             — session/page expired or closed
   *   - `apply_threw`                 — uncaught throw in applyStep
   *   - `other`                       — catch-all
   */
  originatingStrategy?:
    | 'wait_for_timeout'
    | 'wait_for_email_failed'
    | 'select_no_match'
    | 'upload_no_file'
    | 'navigate_failed'
    | 'click_action_threw'
    | 'fake_success_guard'
    | 'pre_click_label_mismatch'
    | 'resolver_exhausted'
    | 'session_invalid'
    | 'apply_threw'
    | 'other';
  /** Last error string from the resolver waterfall (already truncated). */
  lastError?: string;
  /**
   * Number of attempts the apply took before giving up. Distinct from
   * `attempts` (per-strategy detail) below — this is the high-level loop
   * counter, useful when the bundle is consumed by a UI that wants
   * "step retried 5 times before giving up" without rendering the full
   * per-attempt list.
   */
  totalAttempts?: number;
  /**
   * Per-strategy attempt log. Cap 10 most recent. Each entry mirrors what
   * the editor trace records but in a persisted, DB-friendly form.
   */
  attempts: Array<{
    strategy: string;
    tier?: string;
    /** True when this attempt found an element (may still have failed verify). */
    matched: boolean;
    /** Why this attempt failed — `not_found` / `ambiguous` / `fingerprint_mismatch` / `verify_failed` / `error`. */
    failureKind: string;
    /** Locator value tried, capped at 200 chars. */
    value?: string;
    /** Time the attempt took (ms). */
    durationMs?: number;
    /** Free-form error message, capped at 200 chars. */
    error?: string;
  }>;
  /**
   * Reference to a saved screenshot (artifact storage path, NOT base64).
   * Optional — collector best-effort tries to capture, falls through if
   * the page is in a state that doesn't allow screenshot.
   */
  screenshotRef?: string;
  /**
   * Compact snapshot summary: how many interactive nodes were visible,
   * top-level page heading. Lets the user see "page had 50 buttons but
   * none matched" vs "page was empty / loading".
   */
  pageContext?: {
    pageTitle?: string;
    interactiveNodeCount?: number;
    /** Did the recorder fingerprint at least *look* findable on this page? */
    recordedFingerprintPresent?: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPILED STEP PLAN (for reliable execution with fallback and heal)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Locator tier — coarse category that drives executor probe order at replay
 * time. Replaces the per-locator confidence number as the primary sort key.
 *
 * Within a tier, plan order is decided by the build-time validator (live
 * `count()` on the recorded page): unique matches go first, ambiguous or
 * dead matches go last or get dropped.
 *
 * Confidence stays as a derived legacy field for backward compat with old
 * plans in the DB (see `tierToConfidence` helper) — the executor reads tier
 * first and falls back to confidence-bucketing when tier is missing.
 */
export type LocatorTier =
  /**
   * Machine-readable identity authored as an identifier:
   *   testId, id (non-dynamic), form `name`, role+accessible name,
   *   label-for-input. Survives i18n, restyle, full re-renders.
   */
  | 'IDENTITY'
  /**
   * Accessible / human-described name:
   *   ariaLabel (standalone), alt, title, placeholder. Authored for a11y or
   *   UX, drifts faster than IDENTITY but stable across visual changes.
   */
  | 'SEMANTIC'
  /**
   * Component / domain attribute:
   *   mat-icon[svgicon], data-bs-toggle/target, data-row-key, data-value,
   *   childTestId (`:has([data-testid])`), customElementTag+leaf chains,
   *   href anchors, icon library attrs (data-lucide / data-feather / ...).
   */
  | 'STRUCTURAL'
  /**
   * Visible text:
   *   firstTextFragment, full text, token-chain (`:has-text("X"):has-text("Y")`),
   *   role partial-name. Drifts on copy edits and i18n.
   */
  | 'TEXTUAL'
  /**
   * Text resolved through a structural ancestor:
   *   landmark / containerTitle / nearText / row scope `>>` chains.
   *   Used to disambiguate when the same text repeats elsewhere on the page.
   */
  | 'CONTEXTUAL'
  /**
   * Position in siblings — last resort:
   *   siblingIndex + class + nth-of-type. Fragile to structural refactors.
   */
  | 'POSITIONAL';

/**
 * Tier comparison helper: lower number = higher priority. Plan executor and
 * build-time sort use this to walk tiers in order, IDENTITY first.
 */
export const TIER_ORDER: Record<LocatorTier, number> = {
  IDENTITY: 1,
  SEMANTIC: 2,
  STRUCTURAL: 3,
  TEXTUAL: 4,
  CONTEXTUAL: 5,
  POSITIONAL: 6,
};

/**
 * Single locator strategy
 * Represents one way to find an element (primary or fallback)
 */
export interface LocatorEntry {
  /** Strategy type: role, label, testId, placeholder, title, text, css, ref */
  strategy: 'role' | 'label' | 'testId' | 'placeholder' | 'title' | 'text' | 'css' | 'ref';
  /** Playwright locator string or params */
  value: string;
  /** Optional role name for getByRole */
  roleName?: string;
  /**
   * Confidence score (0-1).
   *
   * LEGACY — kept for old plans persisted before the tier rollout. New plans
   * still populate this via `tierToConfidence(tier, matchCount)` so consumers
   * that only check `confidence` keep working. Sort/dedup logic prefers
   * `tier` + `matchCount` when both are present.
   */
  confidence?: number;
  /**
   * Coarse priority category (Etap 1A). Optional: legacy plans in the DB
   * predate tier and the executor falls back to confidence-bucketing for
   * those. New plans always populate it.
   */
  tier?: LocatorTier;
  /**
   * Number of elements this locator matches on the recorded page at build
   * time. Set by `validateOnPage` in the builder. Undefined when the builder
   * was called without a live `page` (e.g. plan rebuilt from a stored
   * artifact).
   *
   *   0  — locator dropped from plan (page validation rejected it)
   *   1  — unique match, boosted to front of its tier
   *   >1 — ambiguous, demoted within tier (or dropped if scoping fails)
   */
  matchCount?: number;
  /**
   * True when `validateOnPage` confirmed `matchCount > 0`. Distinct from
   * "matchCount defined": a count of 0 explicitly invalidates a locator.
   * False also covers timeout / throw — not the same as proven-broken.
   */
  validated?: boolean;
  /**
   * V25 first-priority probe flag. Set ONLY on the stable-token `:has-text`
   * chain (`<tag>:has-text("X"):has-text("Y")`). `sortAndCap` orders flagged
   * entries ahead of ALL tiers so the cheap (~50ms) token chain is tried
   * before role/testId/etc. — its whole reason for existing (a token match
   * beats waiting on a full-text role/getByText timeout when the recorded
   * string drifted). Ordering is intentionally decoupled from `tier`: the
   * chain stays `TEXTUAL` for durability/legacy-confidence semantics, but
   * runs first as a probe. Safe to rank first because the chain is generated
   * ONLY when the node has no structural anchor (id/testId/href/…), so it
   * never out-orders a real identity attribute on the same element.
   */
  firstPriorityProbe?: boolean;
}

/**
 * Target element fingerprint for heal comparison
 * Stores identifying characteristics to help AI find the element if it changed
 *
 * V22: Mirrors all fields stored in `BindingHints` so the LLM resolver
 * (`selectElementWithLLM`) and the heal-time fingerprint check
 * (`quickFingerprintCheck`) operate from the same identifier set. Two paths
 * read this struct:
 *   - resolver prompt: renders fields as "hints from the original interaction"
 *   - heal score: weighs match between live DOM and the recorded snapshot
 * Anything in `BindingHints` that helps disambiguate icon-only targets must
 * also live here, otherwise the resolver can't lean on it during apply.
 */
export interface TargetFingerprint {
  tag?: string;
  role?: string;
  labelText?: string;
  ariaLabel?: string;
  testIdAttr?: string;
  placeholder?: string;
  boundingBox?: ElementBoundingBox;
  containerTitles?: string[];
  /** Nearest ARIA landmark (Phase 7) */
  nearestLandmark?: string;
  /** V22: title attribute (icon-only buttons) */
  title?: string;
  /** V22: alt attribute (<img> targets) */
  alt?: string;
  /** V22: visible text content (when distinct from labelText) */
  text?: string;
  /**
   * V26: First non-empty DOM-unit text fragment (single Text node OR
   * single descendant element with leaf text). Symmetric with
   * InteractiveNode.firstTextFragment. Stored ONLY when it differs from
   * `text` -- otherwise locator-plan-builder would emit redundant text
   * strategies. Powers title-only getByText() locators on Angular/Vue
   * card patterns where title and description live in separate children.
   */
  firstTextFragment?: string;
  /** V22: stable DOM id, framework-generated ids already stripped at probe time */
  elementId?: string;
  /** V22: First 1-3 stable className tokens (utility classes stripped) */
  cssClass?: string;
  /** V22: aria-controls — disambiguates dropdown / tab / menu triggers */
  ariaControls?: string;
  /** V22: href — for <a> tags, differentiates duplicate link text by destination */
  href?: string;
  /**
   * `<a target="...">` attribute at record time. Mirror of `BindingHints.linkTarget`.
   * Drives the replay-time new-tab path. Resolver treats it as a soft hint
   * for uniqueness (a `_blank` link is rarely a duplicate of a same-tab one).
   */
  linkTarget?: string;
  /** V22: Vue scoped style attribute (data-v-XXXXXXX) — narrows component instance */
  vueScopeId?: string;
  /** Etap 1B.2 — Angular `routerLink` directive value. */
  routerLink?: string;
  /** Etap 1B.2 — Angular reactive-forms `formControlName`. */
  formControlName?: string;
  /** V22: HTML name attribute (form field disambiguation). */
  name?: string;
  /**
   * V22: input type (`text|email|password|tel|number|date|...`). Probe
   * already records this on `ProbedElement.type`, mirror it here so the
   * resolver can prefer "the email input" over "the password input" when
   * multiple `<input>` fields share the same labelText.
   */
  type?: string;
  /**
   * V22: ARIA state at recording time. Mirror of `BindingHints.ariaState`
   * — see that interface for field rationale. `current`, `valueNow`,
   * `valueText` added in V22 Pkg1 for Pagination/Stepper and
   * Slider/SpinButton fidelity.
   */
  ariaState?: {
    expanded?: boolean;
    pressed?: boolean;
    checked?: boolean;
    invalid?: boolean;
    current?: string;
    valueNow?: number;
    valueText?: string;
  };
  /**
   * Radix/shadcn/Vaul `data-state` recorded at click time. Mirror of
   * `BindingHints.dataState`. NOT an identity-uniqueness gate (multiple
   * elements can share data-state="open"); used as a soft signal:
   * (1) heal-time tiebreaker when 2 candidates have equal id-quality,
   * (2) input to "did this click do anything?" verifier — recorded
   * 'closed' → live 'open' is a confirmed open transition.
   */
  dataState?: string;
  /** V22 Pkg1: data-value / `<option value>` — semantic key. */
  dataValue?: string;
  /** V22 Pkg1: data-testid of the single direct icon child (svg/i/img). */
  childTestId?: string;
  /** V22 Pkg4: semantic icon name (svg <title>/<desc>/<use href>/data-lucide/etc). */
  iconLabel?: string;
  /**
   * Angular Material icon registry name (`svgicon` / `data-mat-icon-name`
   * attribute on `<mat-icon>`). Strong identity signal for Material apps —
   * survives rebuilds because the value is the registration key, not a
   * generated hash. Distinct from `iconLabel` which sources from
   * `<title>`/`data-lucide`/FA classes.
   */
  svgIcon?: string;
  /**
   * Closest meaningful custom-element ancestor's tag name. Captures the
   * Angular component / Vue 3 SFC / Lit / Stencil semantic name that
   * wraps an otherwise-bare button (`<app-notifications-button>` →
   * `<button class="btn"><svg/></button>`). On Angular Material apps
   * this is often the ONLY identity available for icon-only header
   * actions where there's no id, testid, aria-label, title, or text.
   * Filtered to "semantic" tags only (≥3 dash-segments, no counter
   * suffix) so `<app-c134>` doesn't pass.
   */
  customElementTag?: string;
  /** V22 Pkg2: Bootstrap toggle marker. */
  bsToggle?: string;
  /** V22 Pkg2: Bootstrap target selector. */
  bsTarget?: string;
  /** V22 Pkg2: aria-haspopup popup-trigger marker. */
  ariaHasPopup?: string;
  /** V22 Pkg2: aria-activedescendant — current active descendant id. */
  ariaActiveDescendant?: string;
  /** V22 Pkg2: data-row-key / data-rk — stable row identity. */
  dataRowKey?: string;
  /** V22 Pkg5: sibling-cell text inside nearest row (uniqueness signal). */
  nearestRowText?: string;
  /** V22 Pkg5: nth-of-type index among same-class siblings (2..10). */
  siblingIndex?: number;
  /** V22 Pkg5: recorded disabled state (combines disabled attr / aria / class). */
  disabled?: boolean;
  /** V22 Pkg5: cardinal direction inferred from svg path geometry. */
  arrowDir?: 'left' | 'right' | 'up' | 'down';
  /** V22: Compact ancestor chain summary (see BindingHints.ancestorSummary). */
  ancestorSummary?: string;
}

/**
 * Versioning metadata for compiled plans
 */
export interface CompiledPlanMeta {
  /** Version of the compiled plan format */
  compiledVersion: string;
  /** Version of the resolver that created this plan */
  resolverVersion: string;
}

/**
 * Compiled execution plan for a step
 * Generated after successful apply, enables direct Playwright execution
 */
export interface CompiledStepPlan {
  /** Ordered list of locators to try (primary first, then fallbacks) */
  locatorPlan: LocatorEntry[];
  /** Action to perform */
  action: {
    type: IntentActionType;
    value?: string;
    options?: StepOptions;
  };
  /** Pre-conditions to check before action */
  preconditions?: ('visible' | 'enabled' | 'attached' | 'stable')[];
  /** Post-conditions / expected outcomes */
  postconditions?: ('navigation' | 'domChange' | 'urlChange' | 'stateChange')[];
  /** Context snapshot reference */
  context: {
    pageUrl: string;
    pageTitle?: string;
    /** Reference to dom_analysis snapshot (e.g., intelligent_page_visits.id) */
    snapshotRef?: string;
    /** Screenshot storage path (optional) */
    screenshotRef?: string;
    /** Timestamp when compiled */
    compiledAt: string;
    /** Page signature hash for staleness detection */
    pageSignature?: string;
  };
  /** Versioning metadata */
  meta?: CompiledPlanMeta;
  /** Target element fingerprint (for heal comparison) */
  targetFingerprint?: TargetFingerprint;
  /**
   * Etap 1A — true when `validateOnPage` could not confirm any locator
   * against the live page (all returned `count === 0`, or validation timed
   * out / threw). Plans flagged `unverified` keep their raw locators as a
   * best-effort fallback but the executor should weight them lower than
   * verified plans.
   */
  unverified?: boolean;
  /** Etap 1A — ISO timestamp of the last `validateOnPage` pass. */
  validatedAt?: string;
  /**
   * May 2026 — ISO timestamp of the apply that confirmed this plan via
   * runtime success (action ran AND post-verification passed). Set in
   * the same write that flips `unverified` from `true` to `false`, so
   * an audit trail explains why a plan that build-time validation
   * couldn't verify is no longer flagged. Independent of `validatedAt`,
   * which records the build-time `count()` probe.
   */
  runtimeConfirmedAt?: string;
}

/**
 * Iframe configuration for actions within iframes
 */
export interface IframeConfig {
  /** CSS selector for the iframe element */
  selector: string;
  /** Timeout for waiting for iframe to be ready (ms) */
  timeout?: number;
}

/**
 * URL matcher configuration for wait_for step (V5)
 * Supports Momentic-like matchers + internal auto-insert matcher
 */
export interface UrlMatcher {
  /** Match if URL contains this substring */
  substring?: string;
  /** Match using glob pattern (e.g., 'checkout' or 'products/*') */
  glob?: string;
  /** Match using regex pattern */
  regex?: string;
  /** Match if URL domain equals this value (strict host match) */
  domain?: string;
  /** Internal: wait until URL changes from this value (used by auto-insert) */
  changedFrom?: string;
  /** Case-sensitive matching (default: false) */
  caseSensitive?: boolean;
  /** Negate the match (wait until URL does NOT match) */
  negate?: boolean;
  /** Timeout in milliseconds (default: 15000) */
  timeoutMs?: number;
}

/**
 * Step options - shared between IntentStep and CompiledStepPlan
 */
export interface StepOptions {
  /** Action timeout in milliseconds */
  timeout?: number;
  /**
   * Human-like execution mode for UI actions.
   * When enabled, the backend tries to emulate real user behavior:
   * - type: gradual typing (per-character delays) instead of instant fill
   * - click: hover + small pause before clicking; sometimes clicks at a random point inside the element
   */
  humanLike?: boolean;
  /** If false, append text instead of replacing (for type actions) */
  replaceContent?: boolean;
  /** Press Enter after filling */
  pressEnter?: boolean;
  /** V13: Content was pasted (Ctrl+V / Cmd+V), not typed — dispatch paste event during replay */
  isPaste?: boolean;
  /** Delay between keystrokes in milliseconds (for type actions) */
  keyPressDelay?: number;
  /** Manual CSS selector override - bypasses AI resolution */
  cssSelector?: string;
  /** Skip visibility/enabled checks before action */
  disableStabilityChecks?: boolean;
  /** Force fresh element lookup, skip evidence cache */
  disableCaching?: boolean;
  /**
   * Force vision-only ("use screenshot") element resolution. When true, the
   * resolver SKIPS the text/DOM waterfall (identity fast-path, evidence cache,
   * compiled plan, text LLM) and resolves the element purely from a screenshot
   * via the vision model — vision-led: it still returns a stable element `ref`
   * when it can map the visual match to a captured node, falling back to a
   * bounding box. If vision yields no match the step HARD-FAILS (`not_found`)
   * — there is NO fallback to text resolution. Per-step, default false.
   * Only meaningful for element-targeting steps (not navigate/wait/ai_check/…).
   * Trade-off: every run captures a screenshot + one vision call — slightly
   * slower and more tokens. Deliberately bypasses the 3-stage waterfall
   * (CLAUDE.md Hard invariant #7 documents this as the single sanctioned skip).
   */
  useScreenshotOnly?: boolean;
  /**
   * User-authored "optional step" flag. When true, a failing step does NOT
   * fail the overall run — the preview-run loop continues to the next step and
   * background replay soft-fails it (step_soft_failed). Mirrors the mobile
   * runner's `options.continueOnError` (see step-result-classifier.ts).
   */
  continueOnError?: boolean;
  /** Iframe configuration for actions within iframes */
  iframe?: IframeConfig;
  /**
   * AI context mode for ai_check assertions (V3)
   * Specifies what context to provide to the LLM for evaluation
   * - 'html': HTML content only
   * - 'screenshot': Screenshot only
   * - 'html+a11y': HTML + accessibility tree (no screenshot)
   * - 'html+screenshot': HTML + screenshot
   * - 'html+a11y+screenshot': HTML + accessibility tree + screenshot (default, most comprehensive)
   */
  aiContextMode?: 'html' | 'screenshot' | 'html+a11y' | 'html+screenshot' | 'html+a11y+screenshot';
  /**
   * URL matcher configuration for wait_for step (V5)
   * Supports Momentic-like matchers (substring/glob/regex/domain) + internal changedFrom for auto-insert
   */
  urlMatcher?: UrlMatcher;
  /**
   * Advanced: Disable lookahead wait before this step.
   * Use when intentionally running on not-yet-ready element (rare).
   * Default: false (lookahead wait is enabled)
   */
  disableLookaheadWait?: boolean;
  /**
   * Override lookahead wait timeout for this step (ms).
   * Default: 10000. Use lower values for fast SPAs, higher for slow pages.
   */
  lookaheadTimeoutMs?: number;
  /** V10: CSS selector for drag-and-drop target element */
  dropTarget?: string;
  /** Upload configuration for upload step (V6) */
  upload?: {
    /** Source type: 'url' (download from public URL) or 'storage' (pre-uploaded file) */
    sourceType: 'url' | 'storage';
    /** Optional filename override */
    filename?: string;
    /** Store uploaded file path in environment variable */
    envVar?: string;
    /** Max file size in bytes (default: 50MB) */
    maxSizeBytes?: number;
  };
  /**
   * V13: Dialog handling options for dialog step type.
   * Records what the user did with a native browser dialog (alert/confirm/prompt).
   */
  dialog?: {
    /** Type of the native dialog */
    dialogType: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
    /** User's action: accept (OK) or dismiss (Cancel) */
    action: 'accept' | 'dismiss';
    /** Text entered by user in prompt() dialog */
    promptText?: string;
    /** The dialog message text (for logging/debugging) */
    message?: string;
  };
  /**
   * V13: Modifier keys held during click (Shift+Click, Ctrl+Click, etc.)
   * Captured during recording when user holds modifier keys while clicking.
   * Used in replay to reproduce multi-select and other modifier interactions.
   */
  modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean };
  /**
   * V12: Email filter for wait_for_email step.
   * Configures which email to wait for and what to extract.
   */
  emailFilter?: {
    /** Subject substring to match (case-insensitive) */
    subject?: string;
    /** Sender email address to match */
    from?: string;
    /** AI extraction prompt, e.g. "Extract the 6-digit OTP code" */
    extractPrompt: string;
    /** Variable name to store extracted value — accessible as {{email.<variable>}} in subsequent steps */
    extractVariable: string;
  };
  /**
   * V13: Download verification options.
   * Recorded when a file download is triggered during recording.
   */
  download?: {
    /** Expected filename (or pattern) */
    filename?: string;
    /** URL that triggered the download */
    url?: string;
    /** Timeout for waiting for download (ms, default 15000) */
    timeoutMs?: number;
  };
  /** CSS selector of scrollable container (for container scroll vs page scroll) */
  scrollContainer?: string;
  /**
   * Natural-language description of a scrollable container to scroll INSIDE.
   * When set, the scroll step resolves this container via the element resolver
   * (LLM/vision, same as click/fill targeting) and scrolls the resolved element
   * by the recorded delta instead of the page. Empty → page / recorded-CSS-container
   * scroll (legacy behaviour). NOT interpolated (see preview CLAUDE.md invariant #11).
   */
  scrollContainerDescription?: string;
  /**
   * V-cross-app: configuration for a `link_test_case` step — runs another
   * saved test case at this point in the sequence, possibly on a different
   * platform, splicing it into (same-platform) or nesting it beneath
   * (cross-platform) this test's own execution.
   */
  linkTestCase?: {
    /** ID of the test case to run at this point */
    linkedTestCaseId: string;
    /** Platform the linked test case runs on — may differ from this step's own test case's platform */
    linkedPlatform: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
    /** Values passed INTO the linked test case's own runtime parameters before it runs */
    inputBindings?: Array<{ targetParam: string; valueExpr: string }>;
    /**
     * Named values pulled OUT of the linked test case's own variable scope
     * after it completes (e.g. `extracted.orderId`), exposed to later steps
     * in THIS test case as `{{link.<alias>}}`.
     */
    outputBindings?: Array<{ alias: string; sourceVariable: string }>;
  };
}

/**
 * Intent step - user-authored test step with plain text description
 */
export interface IntentStep {
  /** Unique step ID */
  id: string;
  /** Action type */
  type: IntentActionType;
  /** Plain text description (user's intent) */
  description: string;
  /** Value for type actions */
  value?: string;
  /**
   * Assertion text for ai_check actions (V3)
   * Natural language assertion to be evaluated by LLM
   * Example: "There is a black nav bar with five links"
   * Required when type === 'ai_check'
   */
  assertionText?: string;
  /** Options for the action */
  options?: StepOptions;
  /** Hints for element resolution */
  bindingHints?: BindingHints;
  /**
   * Authoring-time flag: this step's `value` is a credential (password /
   * OTP / token / API key). Set by the mobile agent's draft authoring
   * (mirrors the `type_text` tool's isSensitive arg). Primary signal for
   * `sanitizeMobileSteps` at the save boundary — a flagged value is
   * parameterized regardless of what the description says.
   */
  isSensitive?: boolean;
  /**
   * Runtime-only marker: set when this step was inlined as a precondition
   * (a transitive dependency's step prepended before the target test's own
   * steps). Holds the owning test-case id. Used by post-run compiled-plan
   * writeback to EXCLUDE borrowed steps from the target's persisted
   * `steps_json`. Never persisted on the owning case.
   */
  _preconditionSource?: string;
  /** Cached evidence from last execution (optimization, not truth) */
  evidence?: StepEvidence;
  /**
   * Etap 1D.2 — Last-failure bundle. Set when an apply exhausts the full
   * resolver waterfall (compiled plan failed AND lint/LLM/vision failed).
   * Single object (last failure wins, not a history array) to keep JSONB
   * rows from bloating on chronically flaky steps.
   *
   * Cleared when the same step apply succeeds — see Apply path for the
   * unset semantics. Frontend reads this to show a "needs review" badge
   * with the failure detail.
   */
  failureEvidence?: StepFailureEvidence;
  /**
   * Etap 1D.3 — Natural-language description of the clicked/typed element,
   * generated by an LLM at recording time. Fed to the resolver at replay
   * as a 3rd channel alongside `recordedFingerprint` and snapshot,
   * dramatically improving disambiguation for icon-only / descriptor-poor
   * elements that have no text/aria-label/testId of their own.
   *
   * Examples:
   *   - "the Save button inside the user profile modal"
   *   - "the notification bell icon in the header navigation"
   *   - "the first row's Edit button in the courses table"
   *
   * Capped at 120 chars at write time. Empty string and undefined both
   * mean "no description" — caller should treat them identically.
   */
  recordedDescription?: string;
  /** Compiled execution plan (generated after successful apply) */
  compiled?: CompiledStepPlan;
  /**
   * V22: Fingerprint of the element AT RECORDING TIME (probe snapshot).
   *
   * Distinct from `compiled.targetFingerprint`, which is built from the
   * *resolved live DOM node* at apply time and only exists once the step has
   * been applied at least once. `recordedFingerprint` is set the moment the
   * recorder captures the click — so the LLM resolver has rich identifying
   * data even on the FIRST apply (before any compiled plan exists).
   *
   * Mirrors the fields written to `bindingHints` so the resolver prompt and
   * the heal-time fingerprint check operate on the same identifier set.
   */
  recordedFingerprint?: TargetFingerprint;
  /**
   * Type attribute of the focused input at recording time (e.g. 'password',
   * 'email'). Carried purely as metadata so downstream consumers can decide
   * to redact / sensitive-store the `value` (e.g. preview:save-login moves
   * password values into the resource sensitive envelope). Never influences
   * resolver / replay behaviour. Omit for non-input steps.
   */
  recordedInputType?: string;
  /**
   * Expected outcome for this step (V11: negative test support)
   * - 'success': Step should complete without errors (default)
   * - 'error': Step is a negative test — expects 4xx / validation error / error toast
   * Must be explicitly set by the LLM or user. Falls back to 'success' if not set.
   */
  expectedOutcome?: ExpectedStepOutcome;
  /** True if this step was auto-injected (e.g., auto wait_for URL change). Soft failure — won't fail the test. */
  isAutoInjected?: boolean;
  /** V15: Tab index this step targets (0 = initial tab, 1+ = popups). Omit or 0 for single-tab backward compat. */
  tabIndex?: number;
  /**
   * Lifecycle phase this step belongs to. Populated by `stitchPhases()` at
   * dispatch time when a test case has `setup_steps` / `teardown_steps`.
   * Absent on author-time steps and on test cases without extras —
   * downstream code treats missing / 'main' as the default.
   *
   *   - 'setup':    runs before main. If it fails, main is skipped but
   *                 teardown still runs, and the whole test fails.
   *   - 'main':     the actual case body (what users author today).
   *   - 'teardown': runs after main, even if main failed. A failing
   *                 teardown is logged as a warning but does NOT flip
   *                 the overall verdict (main phase owns pass/fail).
   */
  phase?: 'setup' | 'main' | 'teardown';
}

/**
 * Expected outcome classification for a test step.
 * Used to distinguish negative tests (expected 4xx) from regression bugs (unexpected 4xx).
 */
export type ExpectedStepOutcome = 'success' | 'error';

// ═══════════════════════════════════════════════════════════════════════════
// LINT RESULT (from linting engine)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lint status
 */
export type LintStatus = 'resolved' | 'ambiguous' | 'not_found' | 'needs_clarification' | 'error';

/**
 * Candidate element from linting
 */
export interface LintCandidate {
  /** Element ref */
  ref?: string;
  /** Human-readable label */
  label: string;
  /** Why this candidate matched */
  reason: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Bounding box for highlighting */
  boundingBox?: ElementBoundingBox;
  /** Full InteractiveNode data for compiled plan generation */
  node?: InteractiveNode;
}

/**
 * Lint result from step validation
 */
export interface LintResult {
  /** Status of linting */
  status: LintStatus;
  /** Human-readable message */
  message: string;
  /** Overall confidence (0-1) */
  confidence: number;
  /**
   * Which path actually selected the chosen candidate. Surfaced into
   * preview_run trace so a fake-success / wrong-element pass can be
   * traced to the exact step in the resolver pipeline that picked it.
   *   identity_id     — recordedFingerprint.elementId match (uniqueness gate passed)
   *   identity_testid — recordedFingerprint.testIdAttr match
   *   identity_href   — recordedFingerprint.href match (V26: SPA links)
   *   identity_name   — recordedFingerprint.name match
   *   evidence_shortcut — TTL/URL-valid lastSuccessRef hit
   *   compiled        — compiled plan locator hit
   *   llm             — LLM picked from candidates
   *   vision          — gemini-flash vision rescue picked it
   *   rule_fallback   — degraded mode, rule-based score
   *   user_confirmed  — user picked from clarification UI
   */
  resolverPath?: 'identity_id' | 'identity_testid' | 'identity_href' | 'identity_name' | 'identity_svgicon' | 'identity_custom_element' | 'identity_triple' | 'evidence_shortcut' | 'compiled' | 'llm' | 'vision' | 'rule_fallback' | 'user_confirmed';
  /** Candidate elements (for ambiguous cases) */
  candidates: LintCandidate[];
  /** Elements to highlight on UI */
  highlight: Array<{
    ref?: string;
    boundingBox?: ElementBoundingBox;
    type: 'success' | 'warning' | 'error';
  }>;
  /** V2: True if AI fallback is recommended (ambiguous/low confidence) */
  needsAiFallback?: boolean;
  /** V2: Reason for AI fallback (semantic_zero, ambiguous, low_confidence) */
  aiFallbackReason?: 'semantic_zero' | 'ambiguous' | 'low_confidence';
  /** V3: AI interpretation of user intent */
  interpretation?: string;
  /** V3: Clarification question for user (in user's language) */
  clarificationQuestion?: string;
  /**
   * V23: Resolver coaching for the editor — present when the LLM
   * couldn't confidently pick (no_match / ambiguous / weak resolved).
   * The frontend renders it as a hint near the description input
   * (red on no_match, yellow on ambiguous, soft warning on weak).
   * Always omitted on confident `resolved` results so a green badge
   * stays clean. Examples are validated against actual candidate
   * labels — no hallucinations are allowed through.
   */
  suggestion?: {
    issue: 'NO_MATCH' | 'AMBIGUOUS' | 'GENERIC_INTENT' | 'VAGUE_INTENT' | 'LOW_CONFIDENCE';
    hint: string;
    examples?: string[];
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM-based resolver fields
  // ═══════════════════════════════════════════════════════════════════════════
  /** True if LLM resolver failed and rule-based fallback was used */
  degradedMode?: boolean;
  /** Reason for degraded mode (e.g., "llm_circuit_breaker", "rate_limited") */
  degradedReason?: string;
  /** Top similarity score from LLM resolution */
  topSimilarity?: number;
  /** Whether LLM cache was hit */
  cacheHit?: boolean;
  /**
   * V23: per-phase timings from `_lintStepWithAIImpl`. Surfaced into
   * decisionTrace so analysis can answer "where did the 19s go?"
   * — snapshot collect (DOM evaluate), full resolve (LLM/vision/identity).
   */
  phaseTimings?: {
    snapshotMs?: number;
    resolveMs?: number;
    totalMs?: number;
    domNodeCount?: number;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGNOSTIC FIELDS (for trace logging, not sent to frontend)
  // ═══════════════════════════════════════════════════════════════════════════
  /** @internal Rule trace from buildAllowedSets */
  _ruleTrace?: Array<{ ruleId: string; version: string; action: 'exclude' | 'boost' | 'penalize'; evidence: string; affectedRefs: string[] }>;
  /** @internal Hard allowed count */
  _hardAllowedCount?: number;
  /** @internal Soft allowed count */
  _softAllowedCount?: number;
  /**
   * @internal Map of ref → exact candidateText buildCandidateText
   * produced for that node (before the 280-char truncation in the
   * candidate pruner). Populated by selectElementWithLLM; consumed by
   * intent-step-lint when emitting `element_resolution` editor trace
   * so post-hoc analysis can answer "what signals did the LLM see on
   * the chosen node?" without parsing `llm.prompt`. Undefined when
   * the resolver took a non-LLM path (evidence shortcut, identity
   * fast-path).
   */
  _candidateTextByRef?: Map<string, string>;
  /** @internal LLM call trace (prompt + response) for debugging */
  _llmTrace?: {
    model: string;
    prompt: string;
    response: string;
    latencyMs: number;
    path: 'selectElementWithLLM' | 'rescueWithGeminiFlash';
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME EXECUTION TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Runtime execution status for a step
 */
export type RuntimeStatus = 'executed' | 'healed' | 'failed';

/**
 * Source of the element resolution at runtime
 */
export type RuntimeSource = 'compiled' | 'resolver' | 'self_heal';

/**
 * Reason for step failure
 */
export type FailedReason =
  | 'element_not_found'
  | 'assertion_failed'
  | 'heal_blocked'
  | 'timeout'
  | 'silent_backend_failure'
  | 'unexpected_validation_error'
  | 'unknown';

/**
 * Resolution path used to find element at runtime
 */
export type ResolutionPath = 
  | 'compiled'
  | 'evidence'
  | 'llm_resolver'
  | 'rule_fallback'
  | 'self_heal';

/**
 * Root cause classification for failures
 */
export type RootCause = 'backend' | 'ui' | 'logic';

/**
 * Network verdict classification
 */
export type NetworkVerdict = 'backend_error' | 'clean' | 'warning' | 'expected_error' | 'validation_failure';

/**
 * Runtime metadata for step execution
 * Used for reporting and debugging
 */
export interface StepRuntimeMeta {
  /** Final status of the step execution */
  runtimeStatus: RuntimeStatus;
  /** Source of the element resolution */
  source: RuntimeSource;
  /** Confidence tier of the resolution */
  confidenceTier: ConfidenceTier;
  /** Reason for failure (if runtimeStatus === 'failed') */
  failedReason?: FailedReason;
  /** Human-readable explanation for failure (for CI reports) */
  failureExplanation?: string;
  /** True if step should be reviewed for flakiness */
  needsReview?: boolean;
  /** True if step is flagged as flaky */
  flaky?: boolean;
  /** Execution time in milliseconds */
  executionMs?: number;
  /** Which locator strategy worked (if any) */
  usedLocatorStrategy?: string;
  /** Whether compiled plan was expired */
  compiledExpired?: boolean;
  /** Whether page signature matched */
  pageSignatureMatched?: boolean;
  /** Self-healing confidence (if healed) */
  healConfidence?: number;
  /**
   * Self-heal provenance — what was rewritten and why.
   * Populated only when runtimeStatus === 'healed'. Surfaced in the run report
   * so QA can see "this selector was wrong, AI tried this instead".
   */
  /** Original selector that failed before self-heal kicked in. */
  healedFrom?: string;
  /** Selector the self-healer resolved to. */
  healedTo?: string;
  /** Short human-readable description of what changed (from SelfHealingResult.diff.what_changed). */
  healWhatChanged?: string;
  /**
   * V6: True if lookahead auto-wait was applied (waited > threshold)
   * Indicates significant inter-step wait due to element not being ready
   */
  autoWaitApplied?: boolean;
  /**
   * V6: Milliseconds waited during lookahead (if autoWaitApplied is true)
   */
  autoWaitMs?: number;

  // ═══════════════════════════════════════════════════════════════════════════
  // Resolution path and network correlation
  // ═══════════════════════════════════════════════════════════════════════════
  /**
   * Which resolution path was used to find the element
   */
  resolutionPath?: ResolutionPath;
  /**
   * Root cause classification for step failures (from correlation)
   */
  rootCause?: RootCause;
  /**
   * Network verdict for this step
   */
  networkVerdict?: NetworkVerdict;
  /**
   * Network errors that occurred during step execution (as evidence)
   */
  networkEvidence?: Array<{
    method: string;
    url: string;
    status?: number;
    error: string;
  }>;
  /**
   * Error counts during step execution window
   */
  stepErrors?: {
    console: number;
    network: number;
    ui: number;
  };
  /**
   * Slow API calls during this step execution window (>2s response time)
   */
  slowApiCalls?: Array<{
    url: string;
    method: string;
    responseTime: number;
  }>;

  // ═══════════════════════════════════════════════════════════════════════════
  // V14: Readiness & diagnosis trace (for Supabase — prod debugging)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Step readiness check results (what blocked, what was waited for) */
  readinessTrace?: {
    loadingCleared: boolean;
    apiIdle: boolean;
    animationDone: boolean;
    overlayClear: boolean;
    elementEnabled: boolean;
    iframeReady: boolean;
    waitedMs: number;
  };
  /** LLM blocker diagnosis (if first retry failed and LLM was invoked) */
  blockerDiagnosis?: {
    blocker: string;
    waitForSelector?: string;
    waitForDisappear?: boolean;
    shouldRetry: boolean;
    confidence: number;
    waitSucceeded?: boolean;
  };
  /** Number of retry attempts before success/failure */
  retryAttempts?: number;
  /** Screenshot URL at the time of failure (for bug investigation) */
  bugScreenshotUrl?: string;
  /**
   * Screenshot URL captured after every step (pass or fail) when per-step
   * capture is enabled. Distinct from `bugScreenshotUrl` (failure-only).
   */
  stepScreenshotUrl?: string;
  /** Step ID from intent step */
  stepId?: string;
}

/**
 * TTL values for compiled plan expiration (in milliseconds)
 * Type actions have shorter TTL since form fields change more often
 */
export const COMPILED_TTL_MS: Record<string, number> = {
  type: 7 * 24 * 60 * 60 * 1000,      // 7 days
  click: 14 * 24 * 60 * 60 * 1000,    // 14 days
  select: 7 * 24 * 60 * 60 * 1000,    // 7 days
  check: 14 * 24 * 60 * 60 * 1000,    // 14 days
  uncheck: 14 * 24 * 60 * 60 * 1000,  // 14 days
  hover: 14 * 24 * 60 * 60 * 1000,    // 14 days
  upload: 14 * 24 * 60 * 60 * 1000,  // 14 days
  // V12: Email inbox (short TTL — email-dependent steps are volatile)
  wait_for_email: 7 * 24 * 60 * 60 * 1000,  // 7 days
  default: 14 * 24 * 60 * 60 * 1000,  // 14 days
};

/**
 * Check if a compiled plan is expired based on action type.
 *
 * ── BUG FIX: Malformed compiledAt now treated as expired ──
 * Previously, `new Date(invalidString).getTime()` returned NaN,
 * and `NaN > number` = false → TTL check was silently bypassed.
 * Now: if compiledAt is missing or unparseable → treat as expired.
 */
export function isCompiledPlanExpired(
  compiledAt: string,
  actionType: string
): boolean {
  if (!compiledAt) return true;

  const ttl = COMPILED_TTL_MS[actionType] || COMPILED_TTL_MS.default;
  const compiledTime = new Date(compiledAt).getTime();

  // NaN check: if compiledAt is malformed, treat as expired
  if (isNaN(compiledTime)) return true;

  const now = Date.now();
  return now > compiledTime + ttl;
}

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW SESSION (runtime state)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Preview session state (in-memory)
 */
export interface PreviewSession {
  /** Session ID */
  id: string;
  /** User ID */
  userId: string;
  /** Project ID */
  projectId: string;
  /** Start URL */
  startUrl: string;
  /** Current page state */
  pageState: {
    url: string;
    pageTitle?: string;
    pageType?: string;
    domNodes: InteractiveNode[];
    screenshot?: string;
    /** Visible text content of the page (up to 3k chars, for AI chat context) */
    pageText?: string;
  };
  /** Creation timestamp */
  createdAt: number;
  /** Last activity timestamp */
  lastSeenAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// API PAYLOADS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Request to start preview session
 */
export interface StartPreviewRequest {
  projectId: string;
  startUrl: string;
  viewport?: {
    width: number;
    height: number;
  };
}

/**
 * Response from start preview
 */
export interface StartPreviewResponse {
  previewSessionId: string;
  url: string;
  domNodes: InteractiveNode[];
  screenshot?: string;
  viewport?: {
    width: number;
    height: number;
  };
  devicePixelRatio?: number;
}

/**
 * Intent test case status for lifecycle management
 */
export type IntentTestCaseStatus = 'draft' | 'published' | 'archived';

/**
 * Intent test case kind (classification)
 */
export type IntentTestCaseKind = 'standalone' | 'regression_member';

/**
 * Testing platform for test cases
 */
export type IntentTestCasePlatform = 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';

/**
 * Replay strategy for test execution
 */
export type ReplayStrategy = 'commands' | 'graph_extract';

/**
 * Request to create intent test case
 */
export interface CreateIntentTestCaseRequest {
  projectId: string;
  name: string;
  description?: string;
  startUrl?: string;
  steps: IntentStep[];
  /** Optional link to test flow */
  flowId?: string;
  /** Lifecycle status (defaults to 'draft') */
  status?: IntentTestCaseStatus;
  /** Classification */
  kind?: IntentTestCaseKind;
  /** Testing platform (defaults to 'web') */
  platform?: IntentTestCasePlatform;
}

/**
 * Intent test case (DB entity) - unified table for UI test cases
 * This is now the single source of truth for UI test cases,
 * supporting both draft/preview authoring and published regression tests.
 */
export interface IntentTestCase {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description?: string;

  // URL fields
  startUrl?: string;
  url?: string;

  // Steps for authoring
  stepsJson: IntentStep[];

  // Lifecycle
  status: IntentTestCaseStatus;
  kind: IntentTestCaseKind;
  platform?: IntentTestCasePlatform;
  /** Mobile per-test variant override. null = inherit (plan → project default → 'default'). */
  mobileVariantLabel?: string | null;

  // Replay data (populated when saved from completed test or published)
  replayStrategy?: ReplayStrategy;
  commands?: any[];
  graphRef?: any;
  parametersSchema?: Record<string, any>;

  // Organization
  flowId?: string;
  flowName?: string;
  dependsOn?: string[];
  resolvedDependencies?: Array<{ id: string; name: string }>;

  // Metadata
  /** Natural language description of the test's purpose/intent */
  goal?: string;
  tags?: string[];
  priority?: 'critical' | 'high' | 'medium' | 'low';
  preconditions?: string[];
  setupSteps?: any[];
  teardownSteps?: any[];
  expectedResult?: string;

  // Test Resources (Login / Environment / Secret / ...). Array of
  // { kind, resource_id, required? } — surfaces intent_test_cases.resource_bindings
  // to the UI without an extra fetch.
  resourceBindings?: Array<{
    kind: string;
    resource_id: string;
    required?: boolean;
  }>;

  // User-defined event→action rules forwarded to the mobile runner per run.
  // Surfaces intent_test_cases.triggers to the UI. CANONICAL cross-repo shape
  // (`Trigger` in @/services/mobile/mobile-runner.types) — do not diverge.
  triggers?: Trigger[];

  // Provenance (when saved from a completed test)
  sourceTestId?: string;
  sourceIntelligentSessionId?: string;

  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────
// Step Telemetry — per-step context collected during replay runs
// ─────────────────────────────────────────────────────────────────

/** Per-step telemetry entry collected during replay execution. */
export interface StepTelemetryEntry {
  stepIndex: number;
  stepId: string;
  actionType: IntentActionType;
  /** Step description, truncated to 80 chars. */
  description: string;
  timestamp: number;
  durationMs: number;
  status: 'pass' | 'fail' | 'skipped';
  urlBefore: string;
  urlAfter: string;
  urlChanged: boolean;
  /** Console errors that appeared during this step (max 3). */
  newConsoleErrors: string[];
  /** Network 4xx/5xx responses during this step (max 3). */
  newNetworkErrors: Array<{ url: string; method: string; status: number }>;
  /** Successful mutating API responses during this step — POST/PUT/PATCH/DELETE 2xx (max 3). */
  newNetworkSuccesses: Array<{ url: string; method: string; status: number }>;
  error?: string;
  retried?: boolean;
  attempts?: number;
}

/** Full step telemetry timeline for an entire test run. */
export interface StepTelemetryTimeline {
  version: '1.0';
  testCaseId?: string;
  startUrl: string;
  totalSteps: number;
  collectedAt: string;
  entries: StepTelemetryEntry[];
}
