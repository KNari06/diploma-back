/**
 * Locator Plan Builder Service
 * Generates compiled execution plan from resolved InteractiveNode
 * Builds fallback chain for reliable execution and AI-heal support
 */

import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';
import { getEffectiveLabel } from './element-resolver.service';
import type {
  CompiledStepPlan,
  IntentStep,
  InteractiveNode,
  LocatorEntry,
  LocatorTier,
  TargetFingerprint,
} from './preview.types';
import { TIER_ORDER } from './preview.types';
import { CELL_SEP, escapeHasText, normalizeText } from './text-normalizer.util';
import { extractStableTokensViaLLM } from './stable-tokens-llm.service';
import { buildStrategyLocator, safeCountWithTimeout } from './locator-resolution.util';
import {
  DEFAULT_LOCATOR_CONFIG,
  isClassBanned,
  type LocatorConfig,
} from '@/config/testing/locator-config';

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
async function buildLocatorChain(node: InteractiveNode, config: LocatorConfig): Promise<LocatorEntry[]> {
  const locators: LocatorEntry[] = [];

  // V25 — Stable-token enrichment for long-text labels.
  //
  // Class of element this targets: Angular Material card / Vue tile /
  // dashboard widget where the recorder captured ONLY a long visible text
  // (e.g. "МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды") plus bbox.
  // No id, testId, name, href, svgIcon — nothing structural to grip.
  //
  // For these elements we ask an LLM to pick 2-3 stable identifying
  // tokens (brand + author surname). Three places below use the tokens:
  //   1. NEW first-priority CSS chain `<tag>:has-text("X"):has-text("Y")`
  //   2. Augmented role strategy with token as accessible-name partial
  //   3. Scoped chain inside landmark / containerTitles
  //
  // Existing full-text strategies remain as fallbacks — we ADD, never
  // REPLACE. On testId-rich sites (`hasStructuralAnchor === true`) we
  // skip the LLM call entirely → no latency penalty.
  //
  // The LLM call is short (~150-300ms) and cached by text-hash, so
  // subsequent plan builds for the same recorded label are 0ms.
  const hasStructuralAnchor =
    !!node.id
    || !!node.testIdAttr
    || !!(node as any).childTestId
    || !!(node as any).href
    || !!node.svgIcon
    || !!(node as any).iconLabel
    || !!(node as any).customElementTag
    || !!(node as any).dataValue
    || !!(node as any).dataRowKey;
  const isLongText = !!node.text && node.text.length >= 30;
  const shouldEnrichWithTokens = !hasStructuralAnchor && isLongText;
  const enrichStartedAt = shouldEnrichWithTokens ? Date.now() : 0;
  const stableTokens: string[] = shouldEnrichWithTokens
    ? await extractStableTokensViaLLM(node.text!)
    : [];
  if (shouldEnrichWithTokens) {
    // Diagnostic: lets post-mortem trace whether the V25 enrichment fired
    // for a given step, what tokens (if any) made it into the plan, and
    // whether the extractor was a cache hit (~0ms) or a fresh LLM call
    // (~150-300ms). Logged once per buildLocatorChain call.
    const enrichDurationMs = Date.now() - enrichStartedAt;
    logger.info('[LOCATOR_PLAN_BUILDER] Token enrichment', {
      tokenCount: stableTokens.length,
      tokens: stableTokens,
      textPreview: node.text!.slice(0, 60),
      tagPrefix: node.tag || '(none)',
      latencyMs: enrichDurationMs,
      cacheHit: enrichDurationMs < 20, // heuristic — LLM cold call ~150ms+
    });
  }

  // V25 — Enhancement #1: token-chain CSS as first-priority strategy.
  // Inserted BEFORE role/testId/etc. so a successful token chain match
  // (cheap, ~50ms) beats waiting on full-text role/getByText timeouts
  // when the recorded full string drifted. Tag prefix narrows by element
  // type — `a:has-text("X"):has-text("Y")` won't match a parent <div>
  // that incidentally contains both tokens.
  //
  // Skip when tag is missing/empty: a wildcard prefix `*:has-text(X)` would
  // match every ancestor that contains the token in its descendant tree
  // (including <body>), which produces cheap-but-useless plans. Better to
  // emit no chain than a globally-matching one — falls through to scoped
  // chains (landmark / containerTitles) below where the scope itself
  // restricts matches.
  const hasUsableTag = !!(node.tag && node.tag.length > 0);
  if (stableTokens.length >= 2 && hasUsableTag) {
    const tagPrefix = node.tag!;
    const chain = stableTokens
      .map(tok => `:has-text("${escapeHasText(tok)}")`)
      .join('');
    locators.push({
      strategy: 'css',
      value: `${tagPrefix}${chain}`,
      // Above bare text (0.7) and below testId (0.8). Chained :has-text
      // is strong identity but not as durable as an explicit attribute.
      confidence: 0.82,
      // Durability class stays TEXTUAL (drifts on copy/i18n). Ordering is
      // separate: `firstPriorityProbe` makes sortAndCap rank it first.
      tier: 'TEXTUAL',
      firstPriorityProbe: true,
    });
  }

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
        tier: 'IDENTITY',
      });
      // V25 — Enhancement #2: role with stable token as accessible-name
      // partial. Playwright's `getByRole(role, {name})` does substring
      // matching by default — so `name: "МАТ-SMART"` matches any element
      // whose accessible name CONTAINS that substring.
      //
      // ⚠ Ambiguity caveat: substring match cuts both ways. The same
      // partial name will also match OTHER cards / nav links / breadcrumbs
      // that mention the brand. On a multi-card page this entry is more
      // a "rescue if full-name fails" than a precise locator. Confidence
      // is intentionally low (0.65) so it sits AFTER label / testId / id /
      // role-full-name / token-chain — only used when those drift.
      //
      // Gating widened (vs. earlier draft): we extract tokens from
      // `node.text` regardless of which source provided `accessibleName`
      // (text might be the descendant's text content while accessibleName
      // came from a short ariaLabel like "card"). Any time we have ≥1
      // token AND a long node.text, the partial role rescue is worth
      // adding.
      if (stableTokens.length >= 1 && node.text && node.text.length >= 30) {
        const partialName = stableTokens[0];
        if (partialName !== accessibleName && partialName.length >= 2) {
          locators.push({
            strategy: 'role',
            value: partialName,
            roleName: node.role,
            // Below role-full-name (0.9), text (0.7), and the token-chain
            // CSS (0.82). Last-resort "did the full name change but the
            // brand survives?" probe.
            confidence: 0.65,
            tier: 'TEXTUAL',
          });
        }
      }
    }
  }

  // 3. getByLabel(labelText) - for labeled inputs
  if (node.labelText) {
    locators.push({
      strategy: 'label',
      value: node.labelText,
      confidence: 0.85,
      tier: 'IDENTITY',
    });
  }

  // 4. getByTestId(testIdAttr) - if present and not dynamic
  if (node.testIdAttr) {
    locators.push({
      strategy: 'testId',
      value: node.testIdAttr,
      confidence: 0.8,
      tier: 'IDENTITY',
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
      tier: 'IDENTITY',
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
        tier: 'STRUCTURAL',
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
      tier: 'STRUCTURAL',
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
        tier: 'STRUCTURAL',
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
          tier: 'STRUCTURAL',
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
          tier: 'STRUCTURAL',
        });
      } else {
        // Variant 2: wrapper button/link contains the mat-icon.
        locators.push({
          strategy: 'css',
          value: `${tagPrefix}:has(mat-icon[svgicon="${safe}"])`,
          confidence: 0.77,
          tier: 'STRUCTURAL',
        });
        // Mirror via data-mat-icon-name (same value, different attribute path)
        // — covers Material versions where svgicon was renamed in v15+.
        locators.push({
          strategy: 'css',
          value: `${tagPrefix}:has(mat-icon[data-mat-icon-name="${safe}"])`,
          confidence: 0.76,
          tier: 'STRUCTURAL',
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
      tier: 'STRUCTURAL',
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
      tier: 'STRUCTURAL',
    });
  }

  // Etap 1B.2 — Angular `formControlName` directive.
  //
  // Reactive-forms identity authored by the developer:
  // `<input formcontrolname="email">`. Survives i18n, layout refactors,
  // and form re-renders. Strongest input identity on Angular projects
  // that don't use data-testid.
  //
  // Why IDENTITY tier: this is a machine-readable, developer-authored
  // identifier — same category as `name`, `id`, `data-testid`. Confidence
  // 0.78 sits between testId (0.80) and id (0.78) — formControlName is
  // as durable as `name` (which is 0.70 here) but more specific because
  // Angular forces uniqueness within a FormGroup.
  const formControlNameAttr = (node as any).formControlName as string | undefined;
  if (formControlNameAttr
      && formControlNameAttr.length >= 1
      && !node.testIdAttr
      && !(node.id && !node.isDynamicId)) {
    const safe = escapeCssAttrValue(formControlNameAttr);
    locators.push({
      strategy: 'css',
      // Pair with tag — formControlName is unique inside one FormGroup
      // but the same name (`email`) can appear in multiple forms on a
      // page (login + signup). Tag pinning is a small extra guard.
      value: `${node.tag || '*'}[formcontrolname="${safe}"]`,
      confidence: 0.78,
      tier: 'IDENTITY',
    });
  }

  // Etap 1B.2 — Angular `routerLink` directive.
  //
  // Declarative SPA navigation — more stable than `href` because it
  // survives origin/proxy rewrites, auth-redirect URLs, and route
  // reorganisations. The captured value is the directive input as
  // written in the template (`./profile`, `/curator`, `['./users', id]`
  // — for array form Angular renders the joined string).
  //
  // Why STRUCTURAL tier: it's a component-routing identifier, not a
  // test hook. Confidence 0.77 just below mat-icon[svgicon] (0.79) —
  // routerLink can drift when routes are reorganised, but stable across
  // origin/auth/build refactors.
  //
  // Skipped when stronger anchors won so we don't bloat plans on
  // testId-rich Angular projects.
  const routerLinkAttr = (node as any).routerLink as string | undefined;
  if (routerLinkAttr
      && routerLinkAttr.length >= 1
      && routerLinkAttr.length <= 100
      && !node.testIdAttr
      && !(node.id && !node.isDynamicId)) {
    const safe = escapeCssAttrValue(routerLinkAttr);
    locators.push({
      strategy: 'css',
      // Pair with tag — routerLink is typically on `<a>` but Angular
      // can also bind it to `<button>` via `[routerLink]`. Pinning to
      // recorded tag avoids cross-tag false matches.
      value: `${node.tag || '*'}[routerlink="${safe}"]`,
      confidence: 0.77,
      tier: 'STRUCTURAL',
    });
  }

  // Etap 1B.2 — Vue scoped style attribute (`data-v-XXXXXXXX`).
  //
  // Captured by the recorder as the attribute NAME (value is empty —
  // see PROBE_AT_POINT_FN: `vueScopeId = attr.name`). The attribute is
  // shared by every element of one Vue SFC (Single File Component), so
  // selecting `[data-v-2a3b4c5d]` narrows to the component subtree.
  //
  // Why STRUCTURAL: it's a build-time component identifier, not a test
  // hook — survives content edits, fails when the component is rebuilt
  // with different `data-v-` salt (rare but possible across major Vue
  // upgrades).
  //
  // Combined with `tag` to disambiguate when the wrapper component
  // contains multiple leaf elements of different tags. Without `tag`,
  // `[data-v-XXX]` picks the first one (the wrapper itself).
  //
  // Skipped when stronger anchors (testId / id) already won so we don't
  // bloat plans on testId-rich Vue projects.
  const vueScopeIdAttr = (node as any).vueScopeId as string | undefined;
  if (vueScopeIdAttr
      && /^data-v-[a-f0-9]{6,}$/i.test(vueScopeIdAttr)
      && !node.testIdAttr
      && !(node.id && !node.isDynamicId)) {
    const safeAttr = escapeCssAttrValue(vueScopeIdAttr);
    locators.push({
      strategy: 'css',
      // Attribute presence selector — Vue scoped attrs have empty values
      // by spec, so `[data-v-XXX]` (no `=`) is the correct form.
      value: `${node.tag || '*'}[${safeAttr}]`,
      // Below testId (0.8), id (0.78), data-row-key (0.78). Above
      // placeholder (0.75) — vueScopeId narrows to component scope which
      // is more discriminative than a placeholder string.
      confidence: 0.76,
      tier: 'STRUCTURAL',
    });
  }

  // Etap 1B.2 — cssClass-based selector for projects with stable class
  // conventions (BEM, Tailwind utility-stripped, design-system roots).
  //
  // The recorder already filters cssClass aggressively — see the token
  // filter in PROBE_AT_POINT_FN around line 1245 of recording-capture
  // .service.ts. By the time `cssClass` reaches the builder it has
  // already been stripped of:
  //   - Tailwind utilities (w-*, p-*, flex, grid, hover:, ...)
  //   - CSS-in-JS hashes (jss\d+, sc-*, css-*, makeStyles-*)
  //   - Vue scoped attrs (data-v-*)
  //   - Angular runtime (ng-tns-*, ng-star-inserted, ng-touched, ...)
  //   - BEM state suffixes (--active, --selected, ...)
  //   - styled-components display-name hashes
  // What's left is the element's *semantic* class — `btn-primary`,
  // `card-header`, `tabs__item`, etc. Genuinely useful as an anchor on
  // sites without testIds.
  //
  // The builder-side guard mirrors the bannedClassPatterns from
  // locator-config.ts (and the inline regex on line 481 below for
  // siblingIndex) — defensive double-check in case a generated class
  // somehow slipped through the recorder filter.
  //
  // Why STRUCTURAL: a stable class name is a structural component
  // identifier authored by the developer, not a test hook (would be
  // IDENTITY) and not visible text (TEXTUAL). Confidence below
  // vueScopeId because BEM modifiers can drift more than scoped attrs.
  //
  // Skipped when stronger anchors won OR when the recorder ran in a
  // weak-resolve mode that doesn't trust class identity.
  const cssClassRaw = (node as any).cssClass as string | undefined;
  if (cssClassRaw
      && !node.testIdAttr
      && !(node.id && !node.isDynamicId)
      && !(node as any).childTestId
      && !(node as any).dataRowKey) {
    // The recorder may stash up to 3 tokens space-joined. Take the first
    // — it is the most specific (recorder ordering puts longest / most
    // unique first via the surrounding token filter).
    const firstCls = cssClassRaw.split(/\s+/)[0];
    // Etap 1B.3 — defensive class filter via shared config (was inline regex).
    // Recorder already strips most generated classes; this catches anything
    // that slipped through plus per-workspace bannedClassPatterns overrides.
    if (firstCls && firstCls.length >= 2 && firstCls.length <= 60 && !isClassBanned(firstCls, config)) {
      const safeCls = escapeCssAttrValue(firstCls);
      locators.push({
        strategy: 'css',
        // Pair class with tag so `.btn` doesn't pick the first <a> on
        // the page when the recorded element was a <button>.
        value: `${node.tag || '*'}.${safeCls}`,
        // Below vueScopeId (0.76) and id-attr (0.78). Above siblingIndex
        // (0.62) and bare text (0.7) — class identity is more durable
        // than position, less than scoped attrs.
        confidence: 0.66,
        tier: 'STRUCTURAL',
      });
    }
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
        tier: 'CONTEXTUAL',
      });
      // Same idea for li-based grids (no <tr>).
      locators.push({
        strategy: 'css',
        value: `li:has-text("${safeText}") ${tagPart}`,
        confidence: 0.68,
        tier: 'CONTEXTUAL',
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
    // Etap 1B.3 — class filter via shared config (was inline regex).
    if (cls && cls.length >= 2 && !isClassBanned(cls, config)) {
      const safeCls = escapeCssAttrValue(cls);
      // CSS :nth-of-type is 1-indexed; siblingIndex is 0-indexed → +1.
      locators.push({
        strategy: 'css',
        value: `.${safeCls}:nth-of-type(${idx + 1})`,
        confidence: 0.62,
        tier: 'POSITIONAL',
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

  // V25 — Strategies that read fields the extractor was already populating
  // but the builder ignored. Extractor fills `alt`, `href`, `customElementTag`,
  // `nearText` from the live snapshot; without dedicated strategies they
  // were only flowing into LLM prompts and fingerprints, never into the
  // compiled plan as actionable locators. Each one is gated to avoid
  // duplicating stronger anchors (id / testId) that already won.

  // <img alt="..."> direct attribute. The accessibleName chain in the role
  // strategy already considers `alt` for image roles, but a bare image link
  // (`<img alt="JUZ40 Logo">` inside a clickable wrapper) often loses that
  // path because the role lookup hits the wrapper, not the img. Direct
  // attr selector recovers it. Skipped when stronger anchors exist so we
  // don't bloat plans on testId-rich pages.
  if (node.tag === 'img'
      && node.alt
      && node.alt.length >= 2
      && !node.testIdAttr
      && !(node.id && !node.isDynamicId)) {
    const safeAlt = escapeCssAttrValue(node.alt);
    locators.push({
      strategy: 'css',
      value: `img[alt="${safeAlt}"]`,
      // Below testId (0.8) and id (0.78) — alt drifts when designers
      // rename, but it's stable enough for nav/brand images.
      confidence: 0.74,
      tier: 'SEMANTIC',
    });
  }

  // <a href="..."> for full paths (not only fragment-anchors which the
  // existing block above already handles). Substring match `[href*="..."]`
  // survives origin/protocol changes and querystring noise — `/curator/archive`
  // matches `https://juz40-edu.kz/curator/archive?tab=active`.
  // Skipped when a stronger anchor already won.
  if (node.href
      && typeof node.href === 'string'
      && !node.href.startsWith('#')
      && !node.href.startsWith('javascript:')
      && !node.href.startsWith('mailto:')
      && node.href.length >= 4
      && !node.testIdAttr
      && !(node.id && !node.isDynamicId)) {
    // Strip query / hash so the substring stays focused on the route path.
    // Avoid `URL` parse so we don't choke on relative hrefs (`./foo`,
    // `?modal=login`); split-on-? is enough for our substring use.
    const hrefForMatch = node.href.split('?')[0].split('#')[0];
    if (hrefForMatch.length >= 4) {
      const safeHref = escapeCssAttrValue(hrefForMatch);
      // V26: prefer ends-with for short relative paths or the unique tail
      // segment of a longer URL — `[href$="/uuid"]` is faster to evaluate
      // than `[href*=...]` and survives origin / proxy rewrites that
      // change the prefix while preserving the route. We emit it FIRST
      // (higher confidence) so the executor probes it before the looser
      // substring locator. The `*=` variant stays as a fallback so
      // existing planning paths (relative paths, query-string variations)
      // continue to work — locators are tried in confidence order, the
      // first to match wins.
      const tailSegment = hrefForMatch.split('/').filter(Boolean).pop();
      if (tailSegment && tailSegment.length >= 4) {
        const safeTail = escapeCssAttrValue('/' + tailSegment);
        locators.push({
          strategy: 'css',
          value: `a[href$="${safeTail}"]`,
          // Slightly above the substring variant — endsWith is stricter
          // and faster, but we don't want to outrank testId / id / role.
          confidence: 0.74,
          tier: 'STRUCTURAL',
        });
      }
      locators.push({
        strategy: 'css',
        value: `a[href*="${safeHref}"]`,
        // Below testId (0.8) — paths get reorganised more often than
        // testIds, but they survive copy-edits to the visible label.
        confidence: 0.72,
        tier: 'STRUCTURAL',
      });
    }
  }

  // V26: WRAPPER + LEAF-TAG locator. Angular / Vue / Web Components render
  // branded wrappers (`<app-folders>`, `<v-card>`) AROUND a real leaf tag
  // (`<li>`, `<a>`, `<button>`). The bare-wrapper locator below
  // (`app-folders:has-text(...)`) finds the WRAPPER, not the leaf — when
  // the recorded fingerprint expects `tag=li`, fingerprint validation
  // rejects with matchScore=0. Solution: scope from wrapper DOWN to the
  // recorded leaf tag, then constrain by visible text.
  //
  // Universality: works on every framework that uses custom elements
  // (Angular/Vue/Web Components/Stencil/Lit/etc.). Plain-HTML pages don't
  // have `customElementTag` set → this branch is silently skipped.
  //
  // Confidence above the bare-wrapper variant — the leaf-tag scope removes
  // the wrapper-vs-leaf ambiguity that was the entire reason the bare
  // form fails on Angular Material list-item patterns.
  if (node.customElementTag
      && node.customElementTag.length >= 3
      && node.tag
      && node.tag !== node.customElementTag
      && (node.firstTextFragment || node.text || stableTokens.length > 0)) {
    // Prefer V26 firstTextFragment (single DOM unit, matches getByText
    // contracts), then stable token, then full text. Fragment gives us
    // the most precise text-anchor on cards where text is split across
    // child components — exactly the juz40 MAT-SMART/folders pattern.
    const anchorText = node.firstTextFragment
      || stableTokens[0]
      || node.text
      || '';
    const trimmedAnchor = anchorText.trim();
    if (trimmedAnchor.length >= 2) {
      const safeWrapper = escapeCssAttrValue(node.customElementTag);
      const safeLeaf = escapeCssAttrValue(node.tag);
      const safeAnchor = escapeHasText(trimmedAnchor);
      locators.push({
        strategy: 'css',
        value: `${safeWrapper} ${safeLeaf}:has-text("${safeAnchor}")`,
        // Above bare wrapper (0.75) and bare text (0.7): the leaf-tag
        // scope is what makes the fingerprint validate (tag matches
        // recorded). Below testId (0.8) — testIds win when present.
        confidence: 0.78,
        tier: 'STRUCTURAL',
      });
    }
  }

  // V26: ROLE-SCOPED leaf locator. For frameworks WITHOUT custom-element
  // wrappers (plain React/MUI, Bootstrap, vanilla HTML): combine the
  // leaf's tag + role attribute + visible text. Same idea as the wrapper
  // strategy above, but uses ARIA role as the structural anchor instead
  // of a custom-element ancestor.
  //
  // Why both: a card might have BOTH a custom wrapper AND a role
  // (e.g. `<app-folders><li role="listitem">`); we emit both locators —
  // executor tries by confidence and the first to validate wins. On
  // pages with neither — both branches skip and we fall back to the
  // existing wrapper/text locators.
  //
  // Filter out generic roles (presentation/none/group) which would just
  // multiply the matches without disambiguating.
  if (node.role
      && node.tag
      && !GENERIC_ROLES.has(node.role)
      && (node.firstTextFragment || node.text)) {
    const anchorText = node.firstTextFragment || node.text || '';
    const trimmedAnchor = anchorText.trim();
    if (trimmedAnchor.length >= 2) {
      const safeLeaf = escapeCssAttrValue(node.tag);
      const safeRole = escapeCssAttrValue(node.role);
      const safeAnchor = escapeHasText(trimmedAnchor);
      locators.push({
        strategy: 'css',
        value: `${safeLeaf}[role="${safeRole}"]:has-text("${safeAnchor}")`,
        // Slightly below wrapper+leaf because role attributes get
        // dropped/refactored more often than custom-element wrappers.
        // Above bare-wrapper (0.75) for the same reason: tag pinned.
        confidence: 0.76,
        tier: 'STRUCTURAL',
      });
    }
  }

  // Custom element wrapper as semantic anchor. Angular / Vue / Web Components
  // often render branded leaf elements like `<app-course-card>`, `<v-btn>`,
  // `<sl-button>`. Combine the wrapper tag with the leaf text (or a stable
  // token from V25) to disambiguate two cards in the same list. Without
  // this, descriptor-poor cards fell back to `getByText("...")` only.
  if (node.customElementTag
      && node.customElementTag.length >= 3
      && (node.text || stableTokens.length > 0)) {
    // Prefer the most stable token if V25 LLM extraction returned one;
    // otherwise the full text. Skip empty/whitespace anchors.
    const anchorText = stableTokens[0] || node.text || '';
    const trimmedAnchor = anchorText.trim();
    if (trimmedAnchor.length >= 2) {
      const safeTag = escapeCssAttrValue(node.customElementTag);
      const safeAnchor = escapeHasText(trimmedAnchor);
      locators.push({
        strategy: 'css',
        value: `${safeTag}:has-text("${safeAnchor}")`,
        // Above bare text (0.7) because the tag prefix narrows by
        // component type; below testId (0.8) since custom-element names
        // can be renamed during refactors.
        confidence: 0.75,
        tier: 'STRUCTURAL',
      });
    }
  }

  // nearText-scoped chain to disambiguate duplicate-label leaves. The probe
  // captures a sibling/row text snippet that uniquely sits next to the
  // target element on busy pages (e.g. table action buttons that all say
  // "Edit" — nearText is the row's first cell text).
  // Why scoped: a flat `getByText("Edit")` would pick the first match;
  // anchoring to nearText forces "the Edit button NEAR <row label>".
  if (node.nearText
      && node.nearText.length >= 3
      && node.nearText.length <= 80
      && node.text
      && node.tag
      && !node.testIdAttr) {
    const leafAnchor = stableTokens[0] || node.text;
    const trimmedLeaf = leafAnchor.trim();
    if (trimmedLeaf.length >= 2) {
      const safeNear = escapeHasText(node.nearText);
      const safeLeaf = escapeHasText(trimmedLeaf);
      locators.push({
        strategy: 'css',
        // Two-stage chain: outer container that contains the nearText anchor,
        // then the leaf with our target text. `>>` narrows successive
        // locators within the previous match.
        value: `:has-text("${safeNear}") >> ${node.tag}:has-text("${safeLeaf}")`,
        // Below containerTitles scope (0.74) because nearText is more
        // brittle than a section heading — sibling text re-orders more
        // often than container titles do.
        confidence: 0.73,
        tier: 'CONTEXTUAL',
      });
    }
  }

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
      tier: 'STRUCTURAL',
    });
  } else if ((node as any).bsTarget) {
    // Target alone is usually unique (CSS selector pointing to specific element).
    const safeTarget = escapeCssAttrValue((node as any).bsTarget);
    locators.push({
      strategy: 'css',
      value: `[data-bs-target="${safeTarget}"]`,
      confidence: 0.72,
      tier: 'STRUCTURAL',
    });
  }

  // 5. getByPlaceholder(placeholder) - for inputs
  if (node.placeholder) {
    locators.push({
      strategy: 'placeholder',
      value: node.placeholder,
      confidence: 0.75,
      tier: 'SEMANTIC',
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
      tier: 'SEMANTIC',
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
        tier: 'SEMANTIC',
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
      tier: 'IDENTITY',
    });
  }

  // 8. getByTitle(title) — for icon buttons with title attribute tooltip
  if (node.title && node.title.length >= 2) {
    locators.push({
      strategy: 'title',
      value: node.title,
      confidence: 0.7,
      tier: 'SEMANTIC',
    });
  }

  // V26: 6.5. firstTextFragment — title-only `getByText(...)` for cases
  // where `node.text` is the concatenated full innerText (Angular Material
  // / Vue scoped / Web Component card pattern: title + description live
  // in DIFFERENT children). The full-text strategy below CANNOT match a
  // single text node when the DOM splits it; the fragment IS a single
  // node and matches on its own.
  //
  // Confidence above the bare-text variant (0.7) because narrowing to the
  // title alone is more discriminative — a card title is far less likely
  // to appear elsewhere on the page than a substring of the description.
  // Below role/testId/id (≥0.78) so explicit identity always wins first.
  //
  // Two variants:
  //   1. Plain `getByText(fragment)` — pierces shadow DOM, fastest
  //   2. Wrapper-scoped `${tag}:has-text(fragment)` — kills false positives
  //      when the same title text appears in a sidebar / breadcrumb etc.
  let firstFragmentTextAdded = false;
  if (node.firstTextFragment
      && node.firstTextFragment.length >= 2
      && node.firstTextFragment !== node.text) {
    const fragmentValue = node.firstTextFragment.slice(0, 80);
    locators.push({
      strategy: 'text',
      value: fragmentValue,
      confidence: 0.78,
      tier: 'TEXTUAL',
    });
    firstFragmentTextAdded = true;
    if (node.tag) {
      const safeFragment = escapeHasText(fragmentValue);
      locators.push({
        strategy: 'css',
        value: `${node.tag}:has-text("${safeFragment}")`,
        // Slightly below bare text — the wrapper scope helps when there
        // ARE duplicates, but for unique-text pages the bare match is
        // already correct and a degree faster on Playwright's end.
        confidence: 0.76,
        tier: 'TEXTUAL',
      });
    }
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
    // V26: also skip when firstTextFragment-based locator already covers
    // the same content (firstTextFragment is a prefix of the full text in
    // the common case — emitting both bare strategies would be redundant
    // and waste an executor probe slot).
    const fragmentDuplicatesText = firstFragmentTextAdded
      && node.firstTextFragment
      && node.text.startsWith(node.firstTextFragment);
    if (!roleAlreadyUsesText && !fragmentDuplicatesText) {
      locators.push({
        strategy: 'text',
        value: node.text,
        confidence: 0.7,
        tier: 'TEXTUAL',
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
    // V25 — Enhancement #3: token-based scoped chain. Inserted BEFORE
    // the full-text scoped variants below so a successful match on the
    // resilient form is preferred. Confidence is bumped above the full-
    // text scoped (0.78) but stays below role-with-name (0.9) — chained
    // tokens inside a landmark are more durable than full text but not
    // as deterministic as an aria-named role.
    const tokenChainInner = stableTokens.length >= 2
      ? stableTokens.map(tok => `:has-text("${escapeHasText(tok)}")`).join('')
      : '';
    // Landmark scope (header / main / nav / footer / aside / form / search).
    // `nearestLandmark` already filters to known ARIA landmarks at probe time,
    // so we trust its value. Picks role-attr selector first (`[role="main"]`)
    // and falls back to the implicit-role tag (`main`) — same Playwright
    // resolves either form, but role-attr is more specific when sites
    // duplicate landmark elements (e.g. nested `<nav>`s).
    if (node.nearestLandmark) {
      const escLandmark = escapeCssAttrValue(node.nearestLandmark);
      // V25: token-chain variant FIRST when tokens available.
      if (tokenChainInner) {
        locators.push({
          strategy: 'css',
          value: `[role="${escLandmark}"] >> ${tokenChainInner}`,
          confidence: 0.80,
          tier: 'CONTEXTUAL',
        });
      }
      locators.push({
        strategy: 'css',
        value: `[role="${escLandmark}"] >> text="${escText}"`,
        confidence: 0.78,
        tier: 'CONTEXTUAL',
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
          tier: 'CONTEXTUAL',
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
        // V25: token-chain variant FIRST when tokens available.
        if (tokenChainInner) {
          locators.push({
            strategy: 'css',
            value: `:has-text("${escTitle}") >> ${tokenChainInner}`,
            confidence: 0.76,
            tier: 'CONTEXTUAL',
          });
        }
        locators.push({
          strategy: 'css',
          value: `:has-text("${escTitle}") >> text="${escText}"`,
          // Slightly above bare text (0.7) but below landmark (0.78)
          // because container titles drift faster than landmarks (the
          // section heading may be edited, while landmark roles are
          // structural).
          confidence: 0.74,
          tier: 'CONTEXTUAL',
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
      tier: 'IDENTITY',
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
    // Stage 1: Radix/shadcn `data-state` recorded for fingerprint match.
    // Stored as a top-level field (not inside ariaState) because it's a
    // string keyword that doesn't fit the boolean schema, AND can be
    // set independently of aria-* (Radix Dialog/Popover do not mirror).
    // Used by quickFingerprintCheck at replay as soft signal — NOT a
    // uniqueness gate (multiple elements can share data-state="open").
    dataState: (node as any).dataState,
    // Etap 1B.2 — Angular routerLink + formControlName. Persisted into
    // the fingerprint so quickFingerprintCheck at replay can score
    // identity drift (rename of `formcontrolname="email"` → `email-input`
    // is detected as a real change, not silently absorbed).
    routerLink: (node as any).routerLink,
    formControlName: (node as any).formControlName,
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
 * Etap 1A — Build-time validation phase.
 *
 * For each locator in the plan, ask Playwright `count()` on the LIVE recorded
 * page. The result populates `matchCount` + `validated` on each entry, which
 * downstream sortAndCap uses to drop dead locators (count==0) and to push
 * unique matches (count==1) to the front of their tier.
 *
 * Symmetry guarantee: uses the same `buildStrategyLocator` as the executor.
 * Anything the executor will resolve at replay, the builder validates here.
 *
 * Budget — total cap 1000ms, per-locator cap 200ms. On long pages or under
 * load these caps fire silently: matchCount stays undefined, validated=false,
 * and sortAndCap treats the entry as best-effort. The plan can never get
 * stuck waiting on validation.
 */
async function validateOnPage(
  plan: LocatorEntry[],
  page: Page,
  config: LocatorConfig,
  // When the recorded element lives inside a same-origin iframe, its locators
  // only resolve INSIDE that Frame — `page.locator()` never crosses a frame
  // boundary, so a build-time count on the main page is always 0 and would drop
  // every iframe locator, leaving the compiled plan empty. We skip the live
  // count for iframe-scoped plans (matchCount stays undefined, sortAndCap keeps
  // them — drop only fires on an explicit 0) and rely on replay-time frame
  // resolution (action-executor resolveIframeFrame / compiled-locator-executor
  // frameLocator scope). Mirrors the role-without-roleName skip below.
  iframeScoped = false,
): Promise<LocatorEntry[]> {
  const startedAt = Date.now();
  const PER_LOCATOR_MS = 200;
  // Defensive: a malformed config (deserialised partial JSON, hand-built
  // override forgetting `thresholds`) shouldn't crash the build. Fall back
  // field-by-field to defaults — same protection lives in sortAndCap.
  const thresholds = config.thresholds ?? DEFAULT_LOCATOR_CONFIG.thresholds;
  const maxAmbiguous = thresholds.maxAmbiguous ?? DEFAULT_LOCATOR_CONFIG.thresholds.maxAmbiguous;

  const results = await Promise.all(
    plan.map(async (entry) => {
      // Guard: 'role' strategy without `roleName` would fall through in
      // buildStrategyLocator to scope.locator(entry.value), which treats
      // the accessible name (e.g. "Save") as a CSS selector — that always
      // returns 0 and would mark the entry as dead even though it might
      // be resolvable at replay through a different strategy. Skip count
      // entirely; sortAndCap keeps it (matchCount undefined, drop only
      // fires on explicit 0).
      if (entry.strategy === 'role' && !entry.roleName) {
        return { ...entry, validated: false };
      }
      // Iframe-scoped plan — can't count against the main page (see the
      // `iframeScoped` param doc). Skip the count so the entry survives to
      // replay, where the frame is resolved. validated=false, matchCount
      // undefined → sortAndCap keeps it.
      if (iframeScoped) {
        return { ...entry, validated: false };
      }
      const locator = buildStrategyLocator(page, entry);
      if (!locator) {
        // Unknown strategy — neither validate nor count. validated stays
        // false; matchCount stays undefined so sortAndCap doesn't drop it
        // (drop only on explicit matchCount === 0).
        return { ...entry, validated: false };
      }
      const count = await safeCountWithTimeout(locator, PER_LOCATOR_MS);
      // count: ≥0 actual, -1 timeout, 0 also returned on throw
      // We can't distinguish "0 matches" from "0 due to throw" cheaply —
      // both downgrade the locator the same way (validated=false, drop).
      return {
        ...entry,
        matchCount: count >= 0 ? count : undefined,
        validated: count > 0,
      };
    }),
  );

  const valid = results.filter((r) => r.validated).length;
  const unique = results.filter((r) => r.matchCount === 1).length;
  const dead = results.filter((r) => r.matchCount === 0).length;
  const ambiguous = results.filter((r) => typeof r.matchCount === 'number' && r.matchCount > maxAmbiguous).length;
  logger.info('[LOCATOR_PLAN_BUILDER] Validation phase', {
    total: plan.length,
    valid,
    unique,
    dead,
    ambiguous,
    maxAmbiguous,
    durationMs: Date.now() - startedAt,
  });

  return results;
}

// Etap 1B.3 — thresholds moved to LocatorConfig.thresholds:
//   maxLocatorsTotal — final plan size cap
//   maxPerTier       — diversity cap per tier
//   maxAmbiguous     — drop entries matching > N live elements
// Defaults still 10 / 2 / 5 (see DEFAULT_LOCATOR_CONFIG); per-workspace
// overrides will land in 1B.3+ once persistence is wired.

/**
 * Etap 1A — Sort and cap.
 *
 * Order rules (most → least important):
 *   0. firstPriorityProbe first — the V25 stable-token `:has-text` chain is a
 *      cheap probe deliberately tried before any tier (decoupled from its
 *      TEXTUAL durability class). Only ever present when the node has no
 *      structural anchor, so it can't out-order a real testId/id.
 *   1. tier ASC (IDENTITY before SEMANTIC before STRUCTURAL …)
 *   2. matchCount === 1 first (unique matches), then ASC count, undefined last
 *   3. preserve original index on full tie (stable sort)
 *
 * Cap rules:
 *   - drop entries with matchCount === 0 (dead locators)
 *   - keep at most config.thresholds.maxPerTier per tier (diversity)
 *   - keep at most config.thresholds.maxLocatorsTotal overall
 *
 * Fallback:
 *   - if every locator dropped (all count===0) AND raw plan was non-empty,
 *     return the top-3 raw entries with validated=false. This protects
 *     against transient page state where the validation phase fired during
 *     a re-render and saw nothing — better to ship a best-effort plan than
 *     no plan at all. The executor will treat unverified plans as soft.
 */
function sortAndCap(plan: LocatorEntry[], config: LocatorConfig): LocatorEntry[] {
  // Defensive: see validateOnPage — partial config shouldn't crash.
  const tDefault = DEFAULT_LOCATOR_CONFIG.thresholds;
  const t = config.thresholds ?? tDefault;
  const maxAmbiguous = t.maxAmbiguous ?? tDefault.maxAmbiguous;
  const maxLocatorsTotal = t.maxLocatorsTotal ?? tDefault.maxLocatorsTotal;
  const maxPerTier = t.maxPerTier ?? tDefault.maxPerTier;

  // 1. Drop count===0 (dead) and count>maxAmbiguous (way too generic).
  // 2..maxAmbiguous pass through — small ambiguity is recoverable via
  // fingerprint match at replay. matchCount undefined (timeout / not
  // validated) also passes through as best-effort.
  const alive = plan.filter((l) => {
    if (l.matchCount === 0) return false;
    if (typeof l.matchCount === 'number' && l.matchCount > maxAmbiguous) return false;
    return true;
  });

  if (alive.length === 0 && plan.length > 0) {
    return plan.slice(0, 3).map((l) => ({ ...l, validated: false }));
  }

  // 2. Sort: tier, then unique-first, then count ASC, then original index
  const indexed = alive.map((l, i) => ({ l, i }));
  indexed.sort((a, b) => {
    // 0. First-priority probe (V25 token chain) jumps ahead of all tiers.
    const aProbe = a.l.firstPriorityProbe ? 0 : 1;
    const bProbe = b.l.firstPriorityProbe ? 0 : 1;
    if (aProbe !== bProbe) return aProbe - bProbe;

    const ta = TIER_ORDER[a.l.tier ?? 'POSITIONAL'];
    const tb = TIER_ORDER[b.l.tier ?? 'POSITIONAL'];
    if (ta !== tb) return ta - tb;

    const aUnique = a.l.matchCount === 1 ? 0 : 1;
    const bUnique = b.l.matchCount === 1 ? 0 : 1;
    if (aUnique !== bUnique) return aUnique - bUnique;

    const ac = a.l.matchCount ?? Number.POSITIVE_INFINITY;
    const bc = b.l.matchCount ?? Number.POSITIVE_INFINITY;
    if (ac !== bc) return ac - bc;

    return a.i - b.i;
  });

  // 3. Cap maxPerTier + maxLocatorsTotal (from config.thresholds)
  const perTier = new Map<LocatorTier, number>();
  const kept: LocatorEntry[] = [];
  for (const { l } of indexed) {
    const t = (l.tier ?? 'POSITIONAL') as LocatorTier;
    const used = perTier.get(t) ?? 0;
    if (used >= maxPerTier) continue;
    perTier.set(t, used + 1);
    kept.push(l);
    if (kept.length >= maxLocatorsTotal) break;
  }

  return kept;
}

/**
 * Locator Plan Builder Service
 */
export class LocatorPlanBuilder {
  /**
   * Build compiled execution plan from resolved node and step.
   *
   * V25: now async — `buildLocatorChain` may consult an LLM-backed token
   * extractor for long-text labels without structural anchors. The chain
   * itself is still computed synchronously; the only async surface is
   * the optional token enrichment for `:has-text()` chains. All existing
   * deterministic strategies (id / testId / role / ...) run unchanged
   * before any LLM call is even considered, so on testId-rich sites this
   * function returns synchronously fast (no LLM latency).
   *
   * @param params.pageSignature Optional page signature for staleness detection
   */
  static async buildCompiledPlan(params: {
    step: IntentStep;
    resolvedNode: InteractiveNode;
    pageUrl: string;
    pageTitle?: string;
    snapshotRef?: string;
    screenshotRef?: string;
    pageSignature?: string;
    /**
     * Etap 1A — Live page for build-time `count()` validation. Optional:
     * when absent (e.g. plan rebuilt from a stored artifact, or test
     * harness without a browser) the validate phase is skipped and the
     * raw plan from `buildLocatorChain` is returned with `unverified=true`.
     */
    page?: Page;
    /**
     * Etap 1B.3 — Locator config for thresholds + banned attribute/class
     * lists. Optional; falls back to `DEFAULT_LOCATOR_CONFIG` when caller
     * doesn't supply a workspace/test-case override. Tests without a
     * config still work because the resolver tier (tier-priority sort,
     * `count()` validation) is config-independent at the algorithm level
     * — only the cap thresholds and ban-lists differ.
     */
    config?: LocatorConfig;
    /**
     * Etap May 2026 — optional callback fired once after the live
     * `count()` validation phase. Receives aggregate counts (total /
     * valid / unique / dead / ambiguous) so callers with their own
     * trace (editor-trace JSONL) can emit a `compiled_validation`
     * event without duplicating the logger.info that already runs
     * inside validateOnPage. NEVER throws — wrap in try/catch on the
     * caller side anyway to keep build path resilient.
     *
     * When omitted, validation still runs and emits the server-side
     * log; only the JSONL trace event is skipped.
     */
    onValidation?: (stats: {
      total: number;
      valid: number;
      unique: number;
      dead: number;
      ambiguous: number;
      maxAmbiguous: number;
      durationMs: number;
    }) => void;
  }): Promise<CompiledStepPlan> {
    const { step, resolvedNode, pageUrl, pageTitle, snapshotRef, screenshotRef, pageSignature, page, onValidation } = params;
    const config = params.config ?? DEFAULT_LOCATOR_CONFIG;

    logger.debug('[LOCATOR_PLAN_BUILDER] Building compiled plan', {
      stepId: step.id,
      stepType: step.type,
      nodeTag: resolvedNode.tag,
      nodeRole: resolvedNode.role,
      nodeRef: resolvedNode.ref,
      hasPageSignature: !!pageSignature,
      hasPage: !!page,
    });

    // Build locator chain (primary + fallbacks). Async since V25: the
    // chain may consult the LLM-backed token extractor for long-text
    // labels without structural anchors. On testId-rich elements the
    // function returns synchronously fast (no LLM call).
    const rawPlan = await buildLocatorChain(resolvedNode, config);

    if (rawPlan.length === 0) {
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

    // Etap 1A — validateOnPage + sortAndCap.
    //
    // When `page` is available AND we have raw locators, run live `count()`
    // on each one to populate matchCount/validated. sortAndCap then orders
    // by tier + uniqueness, drops dead locators, and caps the final plan.
    //
    // When `page` is absent: skip validation, fall through to sortAndCap
    // which still applies tier order + cap, marks plan unverified.
    let locatorPlan: LocatorEntry[];
    let unverified: boolean;
    let validatedAt: string | undefined;

    if (page && rawPlan.length > 0) {
      const validationStart = Date.now();
      // Iframe-scoped elements can't be counted on the main page — skip the
      // live count for them so their locators aren't dropped as "dead".
      const iframeScoped = !!step.options?.iframe?.selector
        || (typeof resolvedNode.ref === 'string' && resolvedNode.ref.startsWith('ifr'));
      const validated = await validateOnPage(rawPlan, page, config, iframeScoped);
      // Compute aggregate stats from the same `validated` array the
      // logger.info inside validateOnPage already reads. Re-derived
      // here (cheap) so we don't have to plumb a return type through
      // a function with one call site.
      if (onValidation) {
        try {
          const thresholdsLocal = config.thresholds ?? DEFAULT_LOCATOR_CONFIG.thresholds;
          const maxAmbiguousLocal = thresholdsLocal.maxAmbiguous ?? DEFAULT_LOCATOR_CONFIG.thresholds.maxAmbiguous;
          onValidation({
            total: validated.length,
            valid: validated.filter((r) => r.validated).length,
            unique: validated.filter((r) => r.matchCount === 1).length,
            dead: validated.filter((r) => r.matchCount === 0).length,
            ambiguous: validated.filter((r) => typeof r.matchCount === 'number' && r.matchCount > maxAmbiguousLocal).length,
            maxAmbiguous: maxAmbiguousLocal,
            durationMs: Date.now() - validationStart,
          });
        } catch { /* callback never breaks the build path */ }
      }
      locatorPlan = sortAndCap(validated, config);
      // Plan is unverified if not a single locator survived validation.
      // sortAndCap's fallback path keeps top-3 with validated=false, so
      // detecting unverified requires checking every entry's flag.
      unverified = locatorPlan.every((l) => !l.validated);
      validatedAt = new Date().toISOString();
    } else {
      locatorPlan = sortAndCap(rawPlan, config);
      unverified = true;
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
      unverified,
      validatedAt,
    };

    // V25: count locators that were produced by token enrichment so we can
    // see at-a-glance whether long-text steps got chain coverage. Token
    // entries are recognised by the canonical `:has-text("X"):has-text(`
    // shape — single-token-only entries (regex partial role / single
    // text) intentionally aren't counted here because they aren't
    // chain-form.
    const tokenChainCount = locatorPlan.filter(
      l => l.strategy === 'css' && /:has-text\([^)]*\):has-text\(/.test(l.value),
    ).length;
    // Etap 1A — distribution by tier so we can see at a glance whether
    // a step landed mostly on IDENTITY locators (strong) or fell back to
    // CONTEXTUAL/POSITIONAL (descriptor-poor element). On real users this
    // surfaces sites that need additional strategies in Etap 1B.
    const tierDistribution: Partial<Record<LocatorTier, number>> = {};
    for (const e of locatorPlan) {
      if (e.tier) tierDistribution[e.tier] = (tierDistribution[e.tier] ?? 0) + 1;
    }
    logger.info('[LOCATOR_PLAN_BUILDER] Compiled plan generated', {
      stepId: step.id,
      rawCount: rawPlan.length,
      locatorCount: locatorPlan.length,
      primaryStrategy: locatorPlan[0]?.strategy,
      primaryTier: locatorPlan[0]?.tier,
      primaryMatchCount: locatorPlan[0]?.matchCount,
      primaryConfidence: locatorPlan[0]?.confidence,
      tokenChainCount,
      tierDistribution,
      unverified,
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
