/**
 * Locator Plan Builder Service
 * Generates compiled execution plan from resolved InteractiveNode
 * Builds fallback chain for reliable execution and AI-heal support
 */

import { logger } from '@/utils/core/logger';
import { getEffectiveLabel } from './element-resolver.service';
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

  // 1. getByRole(role, { name: <accessible name> }) - accessibility-first
  // Skip generic roles that don't provide meaningful identification.
  //
  // V23: include `title` in the accessible-name chain. Per WAI-ARIA Accessible
  // Name and Description Computation, a `title` attribute IS an accessible
  // name source when no aria-label/aria-labelledby/labelText present. Angular
  // routerLink icon menus (`<a title="Папкалар"><svg/></a>`) used to fall
  // through to weaker strategies because we only read labelText/ariaLabel/text.
  //
  // We deliberately DON'T inline `getEffectiveLabel` here — that one lifts
  // iconLabel/svgIcon/childTestId/customElementTag, which are derived
  // *display* labels, not accessible names. Playwright's `getByRole({name})`
  // matches against the live a11y tree; passing a derived value (e.g. a
  // Lucide class token "folder") would yield a substring match that doesn't
  // correspond to anything the screen reader announces. Stay strict here;
  // the LLM/candidateText path already sees the wider set via getEffectiveLabel.
  if (node.role && !GENERIC_ROLES.has(node.role)) {
    const accessibleName = node.labelText || node.ariaLabel || node.title || node.text;
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

  // Hash-anchor href for <a href="#..."> intra-page links. ATK Hub's
  // `<a href="#AboutATKHUB">About ATK HUB</a>`-style anchor menu fell
  // through to the LLM every replay because the compiled plan only had
  // `text=` (0.7 conf). LLM sometimes takes 5+ seconds → 7-second step.
  //
  // Why scoped to hash anchors only (not all hrefs):
  //   - External urls (`/login`) get rebranded; matching by absolute path
  //     breaks when the site reorganises routes.
  //   - Hash anchors are intra-page only, stable across redesigns by
  //     definition (the hash IS the section identifier).
  //
  // Guards mirror what we apply to ids:
  //   - Skip when fragment looks generated (`#section-1700123456789`).
  //   - Require ≥3 chars so we don't anchor to `#` or `#x`.
  //   - Filter through escapeCssAttrValue for quote / bracket safety.
  const hrefAttr = (node as any).href;
  if (typeof hrefAttr === 'string' && hrefAttr.startsWith('#')) {
    const fragment = hrefAttr.slice(1);
    const looksGenerated =
      /^\d{6,}$/.test(fragment)                      // pure long digits
      || /^[a-f0-9]{8,}-/i.test(fragment)            // UUID-prefix
      || /^[0-9a-f]{16,}$/i.test(fragment)           // long hex blob
      || /^section-\d+$/.test(fragment)              // numeric section-N
      || /^tab-\d{4,}$/.test(fragment);              // numeric tab-NNNN
    if (fragment.length >= 3 && !looksGenerated) {
      const safeHref = escapeCssAttrValue(hrefAttr);
      locators.push({
        strategy: 'css',
        value: `a[href="${safeHref}"]`,
        // Below id (0.78) — anchor menus can have multiple <a href="#top">
        // duplicates in long pages; waterfall keeps text-locator as backup.
        confidence: 0.72,
      });
    }
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

  // V23: Angular Material `<mat-icon svgicon="...">` registry name. Strong
  // identity for Material icon-only buttons — survives builds, themes, and
  // language because the value is a registration key. Two strategy variants:
  //   1. <mat-icon svgicon="X"> directly (when the target IS the mat-icon)
  //   2. <tag>:has(mat-icon[svgicon="X"]) (when target wraps the icon, e.g.
  //      `<app-excel-btn><mat-icon svgicon="excel">` — common Angular pattern)
  // Confidence between testId (0.80) and id-css (0.78) — registry names are
  // stable but a re-organisation of the icon library can alias keys.
  if (node.svgIcon
      && !node.testIdAttr
      && !node.text
      && !node.ariaLabel
      && !node.labelText
      && !node.title) {
    const svgIcon = String(node.svgIcon).slice(0, 60);
    if (svgIcon.length >= 2) {
      const safe = escapeCssAttrValue(svgIcon);
      const tagPrefix = node.tag || '*';
      // Variant 1: target IS the mat-icon (rare — usually has role="img" so
      // wouldn't pass interactive filter, but covered for completeness).
      if (node.tag === 'mat-icon') {
        locators.push({
          strategy: 'css',
          value: `mat-icon[svgicon="${safe}"]`,
          confidence: 0.79,
        });
      } else {
        // Variant 2: wrapper button/link contains the mat-icon.
        locators.push({
          strategy: 'css',
          value: `${tagPrefix}:has(mat-icon[svgicon="${safe}"])`,
          confidence: 0.77,
        });
        // Mirror via data-mat-icon-name (same value, different attribute path)
        // — covers Material versions where svgicon was renamed in v15+.
        locators.push({
          strategy: 'css',
          value: `${tagPrefix}:has(mat-icon[data-mat-icon-name="${safe}"])`,
          confidence: 0.76,
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

  // V23: <img alt> / <area alt> — accessible name for image targets. Stable
  // across asset hash rotation when the alt text stays consistent. Confidence
  // sits between placeholder (0.75) and title (0.7) — alt is more deliberately
  // authored than title for screen readers. Only emit when alt is non-trivial
  // (≥2 chars) and there's no stronger label already (else we'd redundant-pick).
  if (node.alt && node.alt.length >= 2 && !node.testIdAttr && !node.id) {
    const safeAlt = escapeCssAttrValue(node.alt);
    locators.push({
      strategy: 'css',
      value: `${node.tag || '*'}[alt="${safeAlt}"]`,
      confidence: 0.73,
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
  let textStrategyAdded = false;
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
      textStrategyAdded = true;
    }
  }

  // 7b. SCOPED text fallbacks — pin a `getByText` match to a structural
  // ancestor so re-renders that introduce a duplicate copy of the same
  // visible text elsewhere on the page (sidebar item that mirrors a card
  // title, hidden tab pane carrying the same heading, etc.) don't pull
  // the click to the wrong copy.
  //
  // These run AFTER the bare text strategy so legacy single-match pages
  // keep their fast path; multi-match pages get a scoped follow-up
  // before falling back to LLM. Confidence is bumped slightly above the
  // bare text (0.7) because adding scope removes ambiguity, but below
  // role (0.9) because we still rely on text equality at the leaf.
  //
  // Playwright chaining syntax: `<scope-selector> >> text="..."`. The
  // `>>` operator narrows successive locators within the previous match.
  // Both halves are escaped so values containing `"` / `\` / `]` /
  // newlines can't break selector parsing — same rule as
  // escapeCssAttrValue at the top of this file.
  //
  // Manual-add steps benefit the most: their compiled chain is often a
  // SINGLE bare-text locator (no role/label/testId/href). On replay
  // ambiguity made them flap to the wrong element + LLM-fallthrough,
  // which is the canonical "Run picks differently than Apply" symptom
  // we hunt with manual steps. Recorded steps usually have stronger
  // primary strategies, but the scoped fallbacks help them too on
  // pages where text drifts (i18n, SSR vs CSR mounts, etc.).
  if (textStrategyAdded) {
    const escText = escapeCssAttrValue(node.text!);
    // Landmark scope (header / main / nav / footer / aside / form / search).
    // `nearestLandmark` already filters to known ARIA landmarks at probe time,
    // so we trust its value. Picks role-attr selector first (`[role="main"]`)
    // and falls back to the implicit-role tag (`main`) — same Playwright
    // resolves either form, but role-attr is more specific when sites
    // duplicate landmark elements (e.g. nested `<nav>`s).
    if (node.nearestLandmark) {
      const escLandmark = escapeCssAttrValue(node.nearestLandmark);
      locators.push({
        strategy: 'css',
        value: `[role="${escLandmark}"] >> text="${escText}"`,
        confidence: 0.78,
      });
      // Tag-form fallback when the page uses semantic HTML elements
      // without an explicit role attr (`<main>` instead of `<div role="main">`).
      // Skip when the landmark string would produce an invalid tag selector
      // (only ASCII letters survive after the regex below, mirrors how
      // browsers validate custom element names).
      if (/^[a-z]+$/i.test(node.nearestLandmark)) {
        locators.push({
          strategy: 'css',
          value: `${node.nearestLandmark.toLowerCase()} >> text="${escText}"`,
          confidence: 0.76,
        });
      }
    }
    // Container-title scope — emitted when the recorder/probe captured
    // titled section ancestors (e.g. card heading, panel title, expansion
    // label). We use `:has-text()` to anchor on the title's literal text
    // and then chain into the leaf's text. Useful for pages with multiple
    // sections sharing the same item names (e.g. "Архив" tab + "Активные"
    // tab both showing "Курс A") — title disambiguates which section's
    // copy we mean. Cap at top 2 titles to keep the plan compact; the
    // recorder already orders containerTitles by proximity.
    if (node.containerTitles && node.containerTitles.length > 0) {
      for (const title of node.containerTitles.slice(0, 2)) {
        if (!title || title.length < 2) continue;
        const escTitle = escapeHasText(title);
        locators.push({
          strategy: 'css',
          value: `:has-text("${escTitle}") >> text="${escText}"`,
          // Slightly above bare text (0.7) but below landmark (0.78)
          // because container titles drift faster than landmarks (the
          // section heading may be edited, while landmark roles are
          // structural).
          confidence: 0.74,
        });
      }
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
