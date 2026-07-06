/**
 * Ancestor-scoped locator strategies — PURE, side-effect-free.
 *
 * Point/recording captures `ancestorSummary` on the fingerprint — a compact
 * `header#layout-header > div.icon-group > svg` path whose segments carry the
 * ancestors' STABLE identifiers (testId / non-dynamic id, filtered at probe
 * time). Until now that data was only a soft text hint in the LLM prompt:
 * the compiled plan never built `#parent child` selectors, and the identity
 * fast-path only reads the target's own attributes. The exact class this
 * misses is the icon-only / dynamic-id target inside a well-marked container
 * (e.g. `<svg>` inside `<header id="layout-header">`) — every run went to
 * the LLM lottery.
 *
 * This util turns the strongest recorded ancestor anchors into deterministic
 * compiled strategies: `[data-testid="nav"] button:has-text("Войти")`,
 * `#layout-header svg`. Uniqueness is NOT assumed here — the builder's
 * existing `validateOnPage` counts every entry live and drops/demotes
 * ambiguous ones, so a bare-tag child inside a busy container simply
 * validates to matchCount>1 and loses.
 *
 * Only emitted when the target itself has NO strong identity (own testId or
 * stable id) — when it does, the plain IDENTITY strategies already win.
 */

import type { InteractiveNode, LocatorEntry, TargetFingerprint } from './preview.types';
import { escapeCssAttrValue, escapeHasText } from './text-normalizer.util';

/** Max scoped entries added to a plan — keeps compiled plans compact. */
const MAX_SCOPED_ENTRIES = 3;
/** Max anchored ancestors considered (innermost first). */
const MAX_ANCHORS = 2;
/** Child text longer than this is too drift-prone for a scoped chain. */
const MAX_CHILD_TEXT = 40;

/** Tags narrow enough to be useful as a bare child selector inside a scope. */
const NARROW_CHILD_TAGS = new Set(['svg', 'img', 'i', 'input', 'textarea', 'select', 'summary']);

export interface AncestorAnchor {
  tag: string;
  kind: 'testId' | 'id';
  value: string;
}

/**
 * Parse the probe's `ancestorSummary` into anchored segments.
 *
 * Segment grammar (see PROBE_AT_POINT_FN summary builder):
 *   `tag[data-testid=VALUE]` | `tag#id` | `tag[role=x]` | `tag[text='...']` |
 *   `tag.class` | bare `tag` (the last segment is the target itself).
 *
 * Only testId/#id segments are returned — machine-readable anchors. Role,
 * text and class anchors are deliberately skipped in v1: they over-match and
 * drift, and the text-scoped CONTEXTUAL strategies already cover them.
 * Returned INNERMOST-FIRST (closest ancestor = most specific scope).
 */
export function parseAncestorAnchors(summary: string | undefined): AncestorAnchor[] {
  if (!summary) return [];
  const segments = summary.split(' > ');
  if (segments.length < 2) return [];

  const anchors: AncestorAnchor[] = [];
  // Last segment is the target's own tag — ancestors only.
  for (const seg of segments.slice(0, -1)) {
    const testIdMatch = /^([a-z][a-z0-9-]*)\[data-testid=(.+)\]$/i.exec(seg);
    if (testIdMatch) {
      anchors.push({ tag: testIdMatch[1].toLowerCase(), kind: 'testId', value: testIdMatch[2] });
      continue;
    }
    const idMatch = /^([a-z][a-z0-9-]*)#([^\s>]+)$/i.exec(seg);
    if (idMatch) {
      anchors.push({ tag: idMatch[1].toLowerCase(), kind: 'id', value: idMatch[2] });
    }
  }
  return anchors.reverse().slice(0, MAX_ANCHORS);
}

function anchorSelector(anchor: AncestorAnchor): string {
  return anchor.kind === 'testId'
    ? `[data-testid="${escapeCssAttrValue(anchor.value)}"]`
    : `#${cssEscapeIdent(anchor.value)}`;
}

/**
 * Minimal CSS.escape for id selectors (Node has no global CSS.escape).
 * Escapes every character outside the safe ident set — handles React 18
 * `:rN:` colons and other metacharacters.
 */
function cssEscapeIdent(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/**
 * Most-specific child selector variants for the scoped chain, best first.
 * Empty when the target is too generic to scope safely (a bare `div` inside
 * a container would match everything — validateOnPage would drop it anyway,
 * so don't spend plan slots on it).
 */
export function buildChildSelectors(node: {
  tag?: string;
  ariaLabel?: string;
  svgIcon?: string;
  text?: string;
  firstTextFragment?: string;
}): string[] {
  const tag = (node.tag || '').toLowerCase();
  if (!tag) return [];

  const variants: string[] = [];
  if (node.ariaLabel) {
    variants.push(`${tag}[aria-label="${escapeCssAttrValue(node.ariaLabel)}"]`);
  }
  if (node.svgIcon) {
    variants.push(`[svgicon="${escapeCssAttrValue(node.svgIcon)}"]`);
  }
  const text = node.firstTextFragment || node.text;
  if (text && text.length >= 2 && text.length <= MAX_CHILD_TEXT) {
    variants.push(`${tag}:has-text("${escapeHasText(text)}")`);
  }
  if (variants.length === 0 && NARROW_CHILD_TAGS.has(tag)) {
    variants.push(tag);
  }
  return variants.slice(0, 2);
}

/**
 * Build ancestor-scoped `css` strategies for the compiled plan.
 *
 * @param fingerprint - The step's recordedFingerprint (Point / recording).
 * @param node - The live resolved node (child identity source of truth;
 *   fingerprint fields are the fallback when the live node is sparse).
 */
export function buildAncestorScopedLocators(params: {
  fingerprint: TargetFingerprint | undefined;
  node: InteractiveNode;
}): LocatorEntry[] {
  const { fingerprint, node } = params;
  if (!fingerprint?.ancestorSummary) return [];

  // Target already carries strong own identity — plain IDENTITY strategies
  // (testId / stable id) beat any scoped chain; don't spend plan slots.
  if (node.testIdAttr || (node.id && !node.isDynamicId)) return [];

  const anchors = parseAncestorAnchors(fingerprint.ancestorSummary);
  if (anchors.length === 0) return [];

  const childSelectors = buildChildSelectors({
    tag: node.tag || fingerprint.tag,
    ariaLabel: node.ariaLabel || fingerprint.ariaLabel,
    svgIcon: node.svgIcon || fingerprint.svgIcon,
    text: node.text || fingerprint.text,
    firstTextFragment: fingerprint.firstTextFragment,
  });
  if (childSelectors.length === 0) return [];

  const entries: LocatorEntry[] = [];
  for (const anchor of anchors) {
    for (const child of childSelectors) {
      if (entries.length >= MAX_SCOPED_ENTRIES) return entries;
      entries.push({
        strategy: 'css',
        value: `${anchorSelector(anchor)} ${child}`,
        // STRUCTURAL: machine-readable ancestor identity + leaf shape — same
        // family as the customElementTag+leaf chains. Above the text-scoped
        // CONTEXTUAL entries, below the target's own IDENTITY/SEMANTIC.
        confidence: anchor.kind === 'testId' ? 0.72 : 0.7,
        tier: 'STRUCTURAL',
      });
    }
  }
  return entries;
}
