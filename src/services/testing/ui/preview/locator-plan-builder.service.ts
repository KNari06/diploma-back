/**
 * Locator Plan Builder Service
 * Generates compiled execution plan from resolved InteractiveNode
 * Builds fallback chain for reliable execution and AI-heal support
 */

import { logger } from '@/utils/core/logger';
import type {
  CompiledStepPlan,
  IntentStep,
  InteractiveNode,
  LocatorEntry,
  TargetFingerprint,
} from './preview.types';
import { CELL_SEP, escapeHasText, normalizeText } from './text-normalizer.util';

/**
 * Escape value for CSS attribute selector.
 * Keeps selector valid even if value contains quotes/backslashes/brackets/
 * newlines. V22 Audit-fix H2: previous version only handled `\` and `"`,
 * which broke when bsTarget contained CSS metacharacters like `]`
 * (closing the attribute selector) or `[` (re-opening). Newlines also
 * break selector parsing in Playwright.
 *
 * Order matters: `\` MUST be escaped first, otherwise we double-escape
 * the backslashes we just added.
 */
function escapeCssAttrValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\]/g, '\\]')
    .replace(/\[/g, '\\[')
    .replace(/[\n\r]/g, ' ');
}

/**
 * ARIA roles that are too generic to be useful as locators.
 * These roles don't provide meaningful element identification.
 */
const GENERIC_ROLES = new Set(['generic', 'none', 'presentation', 'group']);

/**
 * Build ordered list of locators (primary + fallbacks)
 */
function buildLocatorChain(node: InteractiveNode): LocatorEntry[] {
  const locators: LocatorEntry[] = [];

  // ── BUG FIX: Removed 'ref' (data-agent-ref) strategy ──
  // data-agent-ref attributes are injected ONLY during preview sessions and are
  // not present during background replay/regression. Including them in the compiled
  // plan wastes the highest-priority slot on a strategy that never works at replay time.
  // The compiled-locator-executor already filters out 'ref' strategies, but the root fix
  // is to not generate them in the first place.

  // 1. getByRole(role, { name: labelText/ariaLabel }) - accessibility-first
  // Skip generic roles that don't provide meaningful identification
  if (node.role && !GENERIC_ROLES.has(node.role)) {
    const accessibleName = node.labelText || node.ariaLabel || node.text;
    // Skip role-only locator without accessible name (usually too ambiguous).
    if (accessibleName) {
      locators.push({
        strategy: 'role',
        value: accessibleName,
        roleName: node.role,
        confidence: 0.9,
      });
    }
  }

  // 3. getByLabel(labelText) - for labeled inputs
  if (node.labelText) {
    locators.push({
      strategy: 'label',
      value: node.labelText,
      confidence: 0.85,
    });
  }

  // 4. getByTestId(testIdAttr) - if present and not dynamic
  if (node.testIdAttr) {
    locators.push({
      strategy: 'testId',
      value: node.testIdAttr,
      confidence: 0.8,
    });
  }

  // V22: getById via attribute selector — high-priority, before placeholder.
  // The id attribute is the most stable locator for icon-only elements
  // (svg/i/img with no text/aria-label) — e.g. `#layout-header-setting` on
  // Element Plus pages. Already filtered for framework-generated ids via
  // `isDynamicId` (see dynamic-id.util.ts), so what reaches here is human-
  // named and survives reloads.
  // Confidence sits between testId (0.8) and placeholder (0.75) — id is
  // strong but testId remains gold standard when both exist.
  if (node.id && !node.isDynamicId) {
    const safeId = escapeCssAttrValue(node.id);
    locators.push({
      strategy: 'css',
      value: `[id="${safeId}"]`,
      confidence: 0.78,
    });
  }

  // V22 Pkg1: childTestId — lifts the icon's data-testid up to its parent
  // button/anchor for replay. CSS `:has()` is supported in all modern
  // browsers (Playwright Chromium ≥ 105). Confidence between testId and id
  // because the lift is parent-of-icon, not the element itself.
  if ((node as any).childTestId) {
    const safeChildId = escapeCssAttrValue((node as any).childTestId);
    locators.push({
      strategy: 'css',
      value: `${node.tag || '*'}:has([data-testid="${safeChildId}"])`,
      confidence: 0.77,
    });
  }

  // V22 Pkg4: iconLabel (svg <title>/data-lucide/FA class) — for
  // descriptor-poor icon-only buttons WITHOUT data-testid. Emit *scoped*
  // CSS selectors that constrain matching to actual icon ancestors, so we
  // don't accidentally click a navbar link that happens to contain the
  // same word as the icon name (a flat getByText("menu") would). Order:
  //   1. :has(svg title="X")     — most precise (matches probe step ①)
  //   2. :has([data-lucide="X"]) — icon-library attr (probe step ④)
  // Both stay below testId/childTestId. The plain `text` fallback was
  // intentionally dropped — too lossy without scope. The label still
  // travels to the LLM resolver via candidateText / fpHints for cases
  // these selectors miss (FA class, bg-image, etc).
  if ((node as any).iconLabel && !(node as any).childTestId
      // Skip when there's already a text/aria/testId hint that would compete.
      && !node.text && !node.ariaLabel && !node.labelText) {
    const iconLabel = String((node as any).iconLabel).slice(0, 60);
    if (iconLabel.length >= 2) {
      const safeIcon = escapeCssAttrValue(iconLabel);
      const tagPrefix = node.tag || '*';
      // Probe step ① — svg <title> is the WCAG-recommended icon name.
      // :has(svg title) traverses into the svg subtree. Playwright supports
      // `:text-is()` for exact-match text on the title element.
      locators.push({
        strategy: 'css',
        value: `${tagPrefix}:has(svg title:text-is("${safeIcon.replace(/"/g, '\\"')}"))`,
        confidence: 0.62,
      });
      // Probe step ④ — icon-library data attrs. Skip when the recorded
      // value contains spaces (we normalize "menu-icon" → "menu icon"
      // during probe, but DOM attrs hold the original hyphenated form).
      // Trying both forms costs little and dramatically widens coverage.
      const attrCandidates = [iconLabel, iconLabel.replace(/\s+/g, '-')];
      const tried = new Set<string>();
      for (const v of attrCandidates) {
        if (tried.has(v)) continue;
        tried.add(v);
        const safe = escapeCssAttrValue(v);
        locators.push({
          strategy: 'css',
          value: `${tagPrefix}:has([data-lucide="${safe}"], [data-feather="${safe}"], [data-icon="${safe}"], [data-iconify-name="${safe}"])`,
          confidence: 0.60,
        });
      }
    }
  }

  // V22 Pkg1: data-value — semantic key for select options / list items /
  // chips. Localized labels drift (Login → Войти → 登录) but the value attr
  // stays stable. Confidence below testId because data-value is product
  // semantics, not a test-only marker.
  if ((node as any).dataValue) {
    const safeVal = escapeCssAttrValue((node as any).dataValue);
    locators.push({
      strategy: 'css',
      value: `${node.tag || '*'}[data-value="${safeVal}"]`,
      confidence: 0.74,
    });
  }

  // V22 Pkg2: data-row-key — Ant Design Table / RainbowKit row identity.
  // Survives pagination, sorting, filtering — strong row locator.
  // V22 Audit M2: confidence dropped from 0.82 → 0.78 so testId (0.80)
  // remains the gold-standard primary strategy. data-row-key still beats
  // placeholder (0.75) and id-css (0.78) which is correct: it's product
  // semantics, but only relevant for table rows.
  if ((node as any).dataRowKey) {
    const safeKey = escapeCssAttrValue((node as any).dataRowKey);
    // AntD writes data-row-key on <tr>, others on the row container.
    locators.push({
      strategy: 'css',
      value: `[data-row-key="${safeKey}"]`,
      confidence: 0.78,
    });
  }

  // V22 Pkg5: nearestRowText — descriptor-poor row checkboxes/buttons.
  // Strategy: `tr:has-text("FIRST_CELL") <tag>` — Playwright's `:has-text()`
  // pseudo searches the entire row subtree, anchoring our otherwise
  // identical-looking checkbox to the row's payload (name/id/amount).
  // Confidence 0.73 — just below testId/dataRowKey but above name (0.70)
  // because text identity is robust on Documentolog/AntD/MUI alike.
  if ((node as any).nearestRowText && !node.testIdAttr && !(node as any).dataRowKey) {
    const rowText = String((node as any).nearestRowText);
    // V22 Pkg7+: split on the canonical Pkg5 cell separator (U+241F).
    // Falls back to legacy " | " for fingerprints persisted before the
    // separator change so old-recordings replay still works.
    const firstCellRaw = rowText.includes(CELL_SEP)
      ? rowText.split(CELL_SEP)[0]
      : rowText.split(' | ')[0];
    // V22 Pkg7+: normalize so RU/KZ/UZ rows still match across NFD-encoded
    // re-renders or zero-width contamination from CMS sources.
    const firstCell = (normalizeText(firstCellRaw) || '').trim();
    // Audit fix: skip strategy when tag is missing — `tr:has-text("X") *`
    // matches every descendant of the row, completely defeating the point.
    // Pair the strategy to a concrete tag so we only emit when we know
    // what we're locating (input/button/a/svg/etc).
    if (firstCell.length >= 3 && firstCell.length <= 60 && node.tag) {
      // V22 Pkg7+: escapeHasText handles backslash + double-quote per
      // Playwright :has-text() syntax. Unicode passes through unmodified.
      const safeText = escapeHasText(firstCell);
      // For checkboxes specifically, narrow further with [type="checkbox"]
      // so we don't pick a hidden input that came from a different control.
      const tagPart = (node.tag === 'input' && node.type)
        ? `input[type="${escapeCssAttrValue(node.type)}"]`
        : node.tag;
      locators.push({
        strategy: 'css',
        value: `tr:has-text("${safeText}") ${tagPart}`,
        confidence: 0.73,
      });
      // Same idea for li-based grids (no <tr>).
      locators.push({
        strategy: 'css',
        value: `li:has-text("${safeText}") ${tagPart}`,
        confidence: 0.68,
      });
    }
  }

  // V22 Pkg5: siblingIndex — nth-of-type within same-class sibling group.
  // Anchors pagination prev/next, tab strips, button groups when the
  // first className token is stable (not jss/sc-/css-/makeStyles).
  // Confidence 0.62 — below text/title because position is fragile to
  // structural refactors, but above pure cssClass.
  if (typeof (node as any).siblingIndex === 'number'
      && !node.testIdAttr
      && !node.text
      && !node.ariaLabel) {
    const idx = (node as any).siblingIndex as number;
    // cssClass arrives via the dom-analysis pass-through (see
    // dom-analysis-extractor.service.ts) and isn't declared on
    // InteractiveNode itself — cast through `any` keeps the field
    // optional without polluting the type with a fingerprint-only field.
    const rawCls = (node as any).cssClass;
    const cls = typeof rawCls === 'string' && rawCls.length > 0 ? rawCls.split(/\s+/)[0] : '';
    // Reuse the same skip-rx as probe — keep selectors symmetric.
    const skipRx = /^(jss\d+|sc-[a-zA-Z0-9]{6,}|css-[a-z0-9]{6,}|makeStyles-)/;
    if (cls && cls.length >= 2 && !skipRx.test(cls)) {
      const safeCls = escapeCssAttrValue(cls);
      // CSS :nth-of-type is 1-indexed; siblingIndex is 0-indexed → +1.
      locators.push({
        strategy: 'css',
        value: `.${safeCls}:nth-of-type(${idx + 1})`,
        confidence: 0.62,
      });
    }
  }

  // V22 Pkg5: arrowDir — soft hint for svg-only pagination buttons.
  // No direct CSS strategy possible (we can't query "svg pointing left"),
  // but emit a synthetic locator that the LLM resolver can use as a hint
  // alongside `boundingBox.x` ranking. The actual click resolution still
  // happens via positional + sibling text in the LLM prompt; this just
  // makes sure arrowDir survives into compiled plan as candidateText.
  // (Strategy: skipped here — purely informational, fed via fingerprint.)

  // V22 Pkg2: Bootstrap data-bs-toggle + data-bs-target combo. Either
  // alone is weakish (multiple modals share toggle="modal"), but together
  // they uniquely identify a real Bootstrap trigger.
  if ((node as any).bsToggle && (node as any).bsTarget) {
    const safeToggle = escapeCssAttrValue((node as any).bsToggle);
    const safeTarget = escapeCssAttrValue((node as any).bsTarget);
    locators.push({
      strategy: 'css',
      value: `[data-bs-toggle="${safeToggle}"][data-bs-target="${safeTarget}"]`,
      confidence: 0.76,
    });
  } else if ((node as any).bsTarget) {
    // Target alone is usually unique (CSS selector pointing to specific element).
    const safeTarget = escapeCssAttrValue((node as any).bsTarget);
    locators.push({
      strategy: 'css',
      value: `[data-bs-target="${safeTarget}"]`,
      confidence: 0.72,
    });
  }

  // 5. getByPlaceholder(placeholder) - for inputs
  if (node.placeholder) {
    locators.push({
      strategy: 'placeholder',
      value: node.placeholder,
      confidence: 0.75,
    });
  }

  // 6. aria-label as standalone locator — for elements with aria-label but no/generic role.
  // When role strategy already included aria-label via accessibleName, this is skipped.
  if (node.ariaLabel && node.ariaLabel.length >= 2) {
    const alreadyCovered = locators.some(
      l => l.strategy === 'role' && l.value === node.ariaLabel
    );
    if (!alreadyCovered) {
      locators.push({
        strategy: 'label',
        value: node.ariaLabel,
        confidence: 0.8,
      });
    }
  }

  // 7. CSS [name="..."] — for form inputs with HTML name attribute (email, password, etc.)
  if (node.name && !node.name.startsWith('_') && node.name.length >= 2) {
    const safeName = escapeCssAttrValue(node.name);
    locators.push({
      strategy: 'css',
      value: `${node.tag || '*'}[name="${safeName}"]`,
      confidence: 0.7,
    });
  }

  // 8. getByTitle(title) — for icon buttons with title attribute tooltip
  if (node.title && node.title.length >= 2) {
    locators.push({
      strategy: 'title',
      value: node.title,
      confidence: 0.7,
    });
  }

  // 7. getByText(text) — fallback for buttons/links with visible text.
  // Pierces shadow DOM and is more resilient than CSS selectors.
  // Always included as a fallback (lower confidence than role/label/testId/placeholder),
  // but essential for elements that lack those attributes.
  // Skip if text is too short (single char) or duplicates the role strategy's accessible name.
  if (node.text && node.text.length >= 2) {
    // Avoid duplicate: if role strategy already uses the same text as accessible name, skip
    const roleAlreadyUsesText = locators.some(
      l => l.strategy === 'role' && l.value === node.text
    );
    if (!roleAlreadyUsesText) {
      locators.push({
        strategy: 'text',
        value: node.text,
        confidence: 0.7,
      });
    }
  }

  // 7. CSS fallback: tag + data-testid combo (last resort, only when id strategy
  // wasn't already added above). The high-priority id-css strategy at step 4.5
  // covers the `[id="..."]` case; this branch only adds tag+testId when both
  // are present — a slightly more specific shape than testId alone.
  if (node.tag && node.testIdAttr) {
    const safeTestId = escapeCssAttrValue(node.testIdAttr);
    locators.push({
      strategy: 'css',
      value: `${node.tag}[data-testid="${safeTestId}"]`,
      confidence: 0.65,
    });
  }

  return locators;
}

/**
 * Build target fingerprint from InteractiveNode
 */
function buildTargetFingerprint(node: InteractiveNode): TargetFingerprint {
  // V22 Pkg1: ariaState compaction — only include states that were actually
  // present on the node so quickFingerprintCheck doesn't artificially deflate
  // the score on missing fields.
  const ariaState: NonNullable<TargetFingerprint['ariaState']> = {};
  if (node.ariaExpanded !== undefined) ariaState.expanded = node.ariaExpanded;
  if (node.ariaPressed !== undefined) ariaState.pressed = node.ariaPressed;
  if (node.checked !== undefined) ariaState.checked = node.checked;
  if (node.invalid !== undefined) ariaState.invalid = node.invalid;
  if ((node as any).ariaCurrent) ariaState.current = (node as any).ariaCurrent;
  if (typeof (node as any).ariaValueNow === 'number') ariaState.valueNow = (node as any).ariaValueNow;
  if ((node as any).ariaValueText) ariaState.valueText = (node as any).ariaValueText;

  return {
    tag: node.tag,
    role: node.role,
    labelText: node.labelText,
    ariaLabel: node.ariaLabel,
    testIdAttr: node.testIdAttr,
    placeholder: node.placeholder,
    boundingBox: node.boundingBox,
    containerTitles: node.containerTitles,
    nearestLandmark: node.nearestLandmark,
    // V22 Pkg1: extended identity / semantic / state fields. Sparse — only
    // populated when the underlying InteractiveNode had a value, so legacy
    // recordings without these don't get noisy fingerprints.
    elementId: node.id && !node.isDynamicId ? node.id : undefined,
    name: node.name,
    type: node.type,
    title: node.title,
    text: node.text,
    href: (node as any).href,
    ariaControls: (node as any).ariaControls,
    dataValue: (node as any).dataValue,
    childTestId: (node as any).childTestId,
    // V22 Pkg2: Bootstrap / aria-haspopup / activedescendant / row key.
    bsToggle: (node as any).bsToggle,
    bsTarget: (node as any).bsTarget,
    ariaHasPopup: (node as any).ariaHasPopup,
    ariaActiveDescendant: (node as any).ariaActiveDescendant,
    dataRowKey: (node as any).dataRowKey,
    // V22 Pkg5: row text + sibling index + disabled + arrow direction.
    nearestRowText: (node as any).nearestRowText,
    siblingIndex: (node as any).siblingIndex,
    disabled: (node as any).disabled,
    arrowDir: (node as any).arrowDir,
    // V22 Pkg4: iconLabel pass-through.
    iconLabel: (node as any).iconLabel,
    ariaState: Object.keys(ariaState).length > 0 ? ariaState : undefined,
  };
}

/**
 * Determine preconditions based on action type
 */
function determinePreconditions(actionType: string): ('visible' | 'enabled' | 'attached' | 'stable')[] {
  switch (actionType) {
    case 'click':
    case 'type':
    case 'select':
    case 'check':
    case 'uncheck':
    case 'toggle':
      return ['visible', 'enabled'];
    case 'assert':
      return ['visible'];
    case 'hover':
    case 'scroll':
      return ['visible'];
    case 'press':
      return ['attached'];
    default:
      return [];
  }
}

/**
 * Determine postconditions based on action type
 */
function determinePostconditions(actionType: string, node?: InteractiveNode): ('navigation' | 'domChange' | 'urlChange' | 'stateChange')[] {
  switch (actionType) {
    case 'click':
      // Link/button might navigate
      if (node?.tag === 'a' || node?.role === 'link') {
        return ['navigation'];
      }
      return ['domChange'];
    case 'type':
    case 'select':
    case 'check':
    case 'uncheck':
    case 'toggle':
      return ['stateChange'];
    case 'navigate':
      return ['urlChange'];
    case 'open':
    case 'close':
      return ['domChange', 'stateChange'];
    case 'hover':
      // Hover can trigger tooltips, submenus, and popover DOM changes
      return ['domChange'];
    default:
      return [];
  }
}

/** Current version of the compiled plan format */
const COMPILED_VERSION = '1.0.0';

/** Current version of the resolver */
const RESOLVER_VERSION = '3.0.0';

/**
 * Locator Plan Builder Service
 */
export class LocatorPlanBuilder {
  /**
   * Build compiled execution plan from resolved node and step
   * 
   * @param params.pageSignature Optional page signature for staleness detection
   */
  static buildCompiledPlan(params: {
    step: IntentStep;
    resolvedNode: InteractiveNode;
    pageUrl: string;
    pageTitle?: string;
    snapshotRef?: string;
    screenshotRef?: string;
    pageSignature?: string;
  }): CompiledStepPlan {
    const { step, resolvedNode, pageUrl, pageTitle, snapshotRef, screenshotRef, pageSignature } = params;

    logger.debug('[LOCATOR_PLAN_BUILDER] Building compiled plan', {
      stepId: step.id,
      stepType: step.type,
      nodeTag: resolvedNode.tag,
      nodeRole: resolvedNode.role,
      nodeRef: resolvedNode.ref,
      hasPageSignature: !!pageSignature,
    });

    // Build locator chain (primary + fallbacks)
    const locatorPlan = buildLocatorChain(resolvedNode);

    if (locatorPlan.length === 0) {
      logger.warn('[LOCATOR_PLAN_BUILDER] Empty locator plan — element has no durable selectors', {
        stepId: step.id,
        tag: resolvedNode.tag,
        role: resolvedNode.role,
        text: resolvedNode.text?.slice(0, 50),
        labelText: resolvedNode.labelText?.slice(0, 50),
        ariaLabel: resolvedNode.ariaLabel?.slice(0, 50),
        id: resolvedNode.id,
        testIdAttr: resolvedNode.testIdAttr,
        placeholder: resolvedNode.placeholder,
        isIconButton: resolvedNode.isIconButton,
        title: resolvedNode.title?.slice(0, 50),
      });
    }

    // Build target fingerprint
    const targetFingerprint = buildTargetFingerprint(resolvedNode);

    // Determine pre/postconditions
    const preconditions = determinePreconditions(step.type);
    const postconditions = determinePostconditions(step.type, resolvedNode);

    const compiled: CompiledStepPlan = {
      locatorPlan,
      action: {
        type: step.type,
        value: step.value,
        options: step.options,
      },
      preconditions,
      postconditions,
      context: {
        pageUrl,
        pageTitle,
        snapshotRef,
        screenshotRef,
        compiledAt: new Date().toISOString(),
        pageSignature,
      },
      meta: {
        compiledVersion: COMPILED_VERSION,
        resolverVersion: RESOLVER_VERSION,
      },
      targetFingerprint,
    };

    logger.info('[LOCATOR_PLAN_BUILDER] Compiled plan generated', {
      stepId: step.id,
      locatorCount: locatorPlan.length,
      primaryStrategy: locatorPlan[0]?.strategy,
      primaryConfidence: locatorPlan[0]?.confidence,
      compiledVersion: COMPILED_VERSION,
      resolverVersion: RESOLVER_VERSION,
    });

    return compiled;
  }

  /**
   * Build compiled plan for non-targeting actions (navigate, wait)
   */
  static buildCompiledPlanForNonTargetingAction(params: {
    step: IntentStep;
    pageUrl: string;
    pageTitle?: string;
  }): CompiledStepPlan {
    const { step, pageUrl, pageTitle } = params;

    logger.debug('[LOCATOR_PLAN_BUILDER] Building compiled plan for non-targeting action', {
      stepId: step.id,
      stepType: step.type,
    });

    const compiled: CompiledStepPlan = {
      locatorPlan: [], // No target element
      action: {
        type: step.type,
        value: step.value,
        options: step.options,
      },
      preconditions: [],
      postconditions: determinePostconditions(step.type),
      context: {
        pageUrl,
        pageTitle,
        compiledAt: new Date().toISOString(),
      },
    };

    return compiled;
  }
}
