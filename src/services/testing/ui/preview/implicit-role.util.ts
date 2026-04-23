/**
 * W3C ARIA implicit role mapping for HTML elements.
 *
 * One source of truth for Node-side callers (DOM analysis extractor, background
 * DOM collector). Browser-side callers that run via `page.evaluate` keep their
 * own inlined copy as a string — they cannot reach this module from the browser
 * context. Keep these in sync when changing the mapping:
 *
 *   • `recording-capture.service.ts` → COMPUTE_ROLE_SRC (inlined for probe IIFEs)
 *   • `compiled-locator-executor.ts` → quickFingerprintCheck's inline computeRole
 *     (inlined for the candidate scoring evaluate call)
 *
 * HISTORICAL BUG this fixes:
 *   Before this util, `dom-analysis-extractor.service.ts:149` used
 *     `if (element.role && element.role !== element.tag) node.role = element.role;`
 *   Which meant native `<button>` / `<a href>` / `<nav>` / etc. — whose tag
 *   equals their computed implicit role — ended up with `node.role = undefined`.
 *   Downstream `buildLocatorChain` then skipped the `role` strategy entirely,
 *   producing weak `[text]`-only plans and breaking cross-pipeline symmetry
 *   with the recorder (which did populate implicit role via COMPUTE_ROLE_SRC).
 *
 * REFERENCE: WAI-ARIA 1.2 HTML mapping § "default semantics" — we include only
 * the interactive subset plus landmarks. Non-interactive decorative tags return
 * `undefined` so downstream GENERIC_ROLES filters skip them correctly.
 */

/**
 * Minimal shape the util needs — both `InteractiveNode` (preview) and the raw
 * browser-side element pass this loose duck-typed subset.
 */
export interface ImplicitRoleInput {
  /** Lowercased HTML tag name (e.g. 'button', 'input'). */
  tag?: string | null;
  /** Explicit `role` attribute if present, otherwise undefined/empty. */
  explicitRole?: string | null;
  /** For `<input>` — the `type` attribute. Other tags may leave undefined. */
  inputType?: string | null;
  /** For `<a>` — true when `href` attribute is present. */
  hasHref?: boolean;
  /** For `<select>` — true when `multiple` attribute is present. */
  hasMultiple?: boolean;
  /** For `<img>` — true when `alt` attribute is present (even if empty). */
  hasAlt?: boolean;
}

/**
 * Return the element's ARIA role: explicit when set, otherwise the implicit
 * role from the HTML → ARIA spec. Returns `undefined` when no implicit role
 * applies (plain `<div>`, `<span>`, `<canvas>`, etc.) so callers can skip the
 * role strategy cleanly.
 */
export function computeImplicitRole(input: ImplicitRoleInput): string | undefined {
  const explicit = input.explicitRole?.trim();
  if (explicit) return explicit;

  const tag = input.tag?.toLowerCase();
  if (!tag) return undefined;

  switch (tag) {
    case 'button':
      return 'button';
    case 'a':
      return input.hasHref ? 'link' : undefined;
    case 'input': {
      const inputType = (input.inputType || 'text').toLowerCase();
      switch (inputType) {
        case 'button':
        case 'submit':
        case 'reset':
        case 'image':
          return 'button';
        case 'checkbox':
          return 'checkbox';
        case 'radio':
          return 'radio';
        case 'range':
          return 'slider';
        case 'text':
        case 'email':
        case 'tel':
        case 'url':
        case 'search':
        case 'password':
        case 'number':
        case 'date':
        case 'datetime-local':
        case 'time':
        case 'week':
        case 'month':
        case 'color':
          return 'textbox';
        default:
          return undefined;
      }
    }
    case 'textarea':
      return 'textbox';
    case 'select':
      return input.hasMultiple ? 'listbox' : 'combobox';
    case 'img':
      return input.hasAlt ? 'img' : undefined;
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    case 'aside':
      return 'complementary';
    case 'form':
      return 'form';
    case 'dialog':
      return 'dialog';
    case 'output':
      return 'status';
    case 'meter':
      return 'meter';
    case 'progress':
      return 'progressbar';
    case 'fieldset':
      return 'group';
    case 'menu':
      return 'menu';
    case 'menuitem':
      return 'menuitem';
    case 'area':
      return 'link';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return 'columnheader';
    case 'article':
      return 'article';
    case 'section':
      return 'region';
    case 'search':
      return 'search';
    case 'figure':
      return 'figure';
    case 'details':
      return 'group';
    case 'summary':
      return 'button';
    default:
      return undefined;
  }
}
