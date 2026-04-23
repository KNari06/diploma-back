/**
 * Compiled Locator Executor
 *
 * Executes locators from CompiledStepPlan with fallback chain.
 * Performs pageSignature check before attempting compiled locators.
 *
 * Flow:
 * 1. Check pageSignature (if present) - mismatch = skip compiled entirely
 * 2. Check soft-expire based on actionType TTL
 * 3. Try each locator in the plan in order
 * 4. Return success with used locator, or failure for fallback
 */

import {
  isCompiledPlanExpired,
  type CompiledStepPlan,
  type ConfidenceTier,
  type LocatorEntry,
  type RuntimeSource,
  type StepRuntimeMeta,
  type TargetFingerprint,
} from '@/services/testing/ui/preview/preview.types';
import { logger } from '@/utils/core/logger';
import { Frame, Locator, Page } from 'playwright';

/**
 * Playwright "page-like" context that supports locator + evaluate APIs.
 * We use this to run compiled locator plans either on the main Page or inside an iframe Frame.
 */
type PageLike = Page | Frame;

// ─────────────────────────────────────────────────────────────────────────────
// V15: Shadow-aware locator priority
// ─────────────────────────────────────────────────────────────────────────────
//
// Raw CSS locators (`.my-form > input`) do NOT automatically pierce shadow DOM.
// Playwright's user-facing locators (`getByRole` / `getByLabel` / `getByPlaceholder`
// / `getByTestId` / `getByText`) DO pierce open shadow roots transparently.
//
// When a page uses web components (custom elements with `-` in the tag name,
// or any element with a non-null `shadowRoot`), the compiled plan's CSS entry
// is much more likely to miss than its semantic siblings. In that case we want
// to try the semantic entries FIRST and fall back to CSS only if they fail —
// the opposite of the plan's recorded order on some sites.
//
// On pages without shadow DOM, the original plan order is respected (semantic
// and CSS are both reliable, recorded confidence wins).

/** Strategies that automatically pierce open shadow roots (Playwright guarantee). */
const SHADOW_SAFE_STRATEGIES = new Set<string>(['role', 'label', 'placeholder', 'testId', 'text']);

/**
 * Tiny in-memory cache of shadow-DOM presence keyed by URL.
 * Rationale: probing is ~1 page.evaluate per step. Most runs stay on a handful
 * of URLs, so caching eliminates the per-step cost after the first hit.
 * TTL is short because SPA navigation keeps the same URL while the DOM mutates.
 */
interface ShadowCacheEntry { present: boolean; at: number }
const shadowCache = new Map<string, ShadowCacheEntry>();
const SHADOW_CACHE_TTL_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Disambiguation tunables
// ─────────────────────────────────────────────────────────────────────────────
// Used by the multi-match ranking path when a locator resolves to several
// elements and we have a recorded TargetFingerprint to break the tie.
//
// The combined score is:  FP_WEIGHT * fingerprintScore + BBOX_WEIGHT * bboxScore
// where fingerprintScore ∈ [0, 1] is structural similarity and bboxScore ∈
// [0, 1] is continuous spatial proximity to the recorded bounding box.
//
// Weights favour semantic fingerprint over position because:
//   • Recorded tag/role/label/container survive redesigns and i18n.
//   • Position drifts when users resize, when responsive breakpoints flip,
//     and when the same page reflows across runs.
//
// A candidate is picked only when BOTH minimums hold:
//   • winner.score >= WINNER_MIN_SCORE  — avoid clicking on weak evidence
//   • winner.score - runnerUp.score >= WINNER_MIN_LEAD  — avoid guessing on a
//     tie between two plausible candidates; let the LLM self-heal decide.
const FP_WEIGHT = 0.7;
const BBOX_WEIGHT = 0.3;
const WINNER_MIN_SCORE = 0.55;
const WINNER_MIN_LEAD = 0.12;

// Cap on how many sibling matches we rank. Beyond this the locator is too
// broad to salvage anyway — pushing it to the LLM with the full count gives
// better context than a partial ranking.
const MAX_DISAMBIGUATION_CANDIDATES = 8;

// Minimum fingerprint score required to accept a landmark-scoped match as
// "the recorded element, scoped correctly". Lower than WINNER_MIN_SCORE
// because landmark scoping is already structural — we only need proof the
// element inside is not a false positive (e.g. first-nav happened to contain
// a candidate but the recorded target was in the second nav).
const LANDMARK_ACCEPT_MIN_FP = 0.5;
const SHADOW_PROBE_MAX_NODES = 200;
const SHADOW_PROBE_HARD_CAP_MS = 200;

/**
 * Probe the page to determine whether any element is using shadow DOM.
 * Bounded BFS (up to SHADOW_PROBE_MAX_NODES) — cheap on normal pages, and
 * short-circuits on the first shadow root found.
 *
 * Always fail-open (returns `false` on any error) — a probe failure must never
 * break locator execution.
 */
async function pageUsesShadowDom(page: PageLike): Promise<boolean> {
  // Page and Frame both expose url(); fall back to a static key on error.
  let url = '';
  try { url = (page as Page).url(); } catch { /* Frame may not expose url in edge cases */ }
  const cacheKey = url || '__no_url__';

  const cached = shadowCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SHADOW_CACHE_TTL_MS) {
    return cached.present;
  }

  let present = false;
  try {
    // Race the probe against a hard cap — a hung evaluate cannot stall us past this.
    const probe = (page as Page).evaluate((maxNodes: number) => {
      // @ts-expect-error - document exists in browser context
      const doc = document;
      const body = doc.body;
      if (!body) return false;
      const stack: any[] = [body];
      let scanned = 0;
      while (stack.length && scanned < maxNodes) {
        const node: any = stack.shift();
        if (!node) continue;
        scanned++;
        const kids: ArrayLike<any> | undefined = node.children;
        if (!kids) continue;
        for (let i = 0; i < kids.length; i++) {
          const el: any = kids[i];
          if (el.shadowRoot) return true;              // open shadow root found
          const tag: string = (el.tagName || '').toLowerCase();
          if (tag.includes('-')) return true;          // custom element — likely closed shadow
          stack.push(el);
        }
      }
      return false;
    }, SHADOW_PROBE_MAX_NODES);

    let timer: ReturnType<typeof setTimeout> | undefined;
    present = await Promise.race([
      probe,
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), SHADOW_PROBE_HARD_CAP_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch {
    present = false;
  }

  shadowCache.set(cacheKey, { present, at: Date.now() });
  return present;
}

/**
 * Return a new LocatorEntry array re-ordered so shadow-safe strategies come first
 * when the page uses shadow DOM. Otherwise returns the input as-is.
 *
 * Order within each group is preserved (stable sort by `confidence`-then-original
 * position, same as the plan's recorded order).
 */
function reorderForShadowDom(entries: LocatorEntry[], shadowPresent: boolean): LocatorEntry[] {
  if (!shadowPresent) return entries;

  const withIndex = entries.map((e, i) => ({ e, i }));
  const shadowSafe = withIndex.filter(x => SHADOW_SAFE_STRATEGIES.has(x.e.strategy));
  const rest = withIndex.filter(x => !SHADOW_SAFE_STRATEGIES.has(x.e.strategy));
  // Preserve original order within each bucket (stable).
  const result = [...shadowSafe, ...rest].map(x => x.e);
  // No-op reordering? Avoid a log line on pages where shadow-safe is already first.
  const wasReordered = result.some((e, i) => e !== entries[i]);
  if (wasReordered) {
    logger.debug('[COMPILED_EXECUTOR] Reordered locator plan for shadow DOM', {
      before: entries.map(e => e.strategy),
      after: result.map(e => e.strategy),
    });
  }
  return result;
}

/**
 * Result from compiled locator execution attempt
 */
export interface CompiledExecutionResult {
  /** Whether a locator was successfully found */
  success: boolean;
  /** The Playwright locator that worked */
  locator?: Locator;
  /** Which locator strategy was used */
  usedStrategy?: string;
  /** Confidence from the locator entry */
  confidence?: number;
  /** Reason for skipping/failure */
  skipReason?: 'signature_mismatch' | 'expired' | 'no_plan' | 'locator_failed' | 'ambiguous';
  /** Whether compiled plan was expired */
  expired?: boolean;
  /** Whether page signature matched */
  signatureMatched?: boolean;
  /** Runtime source for reporting */
  source: RuntimeSource;
  /** Ambiguity details — which strategies hit multiple elements and how many */
  ambiguityDetails?: Array<{ strategy: string; matchCount: number }>;
}

/**
 * Get page signature from current page
 * Uses a simple hash of form/input structure for quick comparison
 */
async function getCurrentPageSignature(page: PageLike): Promise<string> {
  try {
    const signature = await page.evaluate(() => {
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

      // Simple hash from sorted element signatures
      return elements.sort().join('|').slice(0, 500);
    });

    return signature;
  } catch {
    return '';
  }
}

/**
 * Check if page signature matches compiled plan signature
 * Returns true if no signature is stored (backward compatibility)
 *
 * Note: Recording (preview-session) stores a base64-encoded signature
 * (url|nodeCount|refs), while replay computes tag:type:name:id:role strings.
 * When formats are incompatible, we return matched=true to avoid false negatives
 * — the locator plan itself (with fingerprint validation) is the real guard.
 */
async function checkPageSignature(
  page: PageLike,
  compiledSignature?: string
): Promise<{ matched: boolean; currentSignature: string }> {
  if (!compiledSignature) {
    // No signature stored - skip check (backward compatibility)
    return { matched: true, currentSignature: '' };
  }

  const currentSignature = await getCurrentPageSignature(page);

  // Detect format mismatch: recording stores base64 (no ':' inside parts),
  // replay computes "tag:type:name:id:role" (always contains ':'). If the compiled
  // signature has no ':' in any split part, it's base64-encoded from recording —
  // comparison is meaningless, treat as matched and let fingerprint validation guard.
  const compiledParts = compiledSignature.split('|');
  const isBase64Signature = compiledParts.length <= 1 || compiledParts.every(p => !p.includes(':'));

  if (isBase64Signature) {
    // V14: Decode base64 signature — format: base64(url|nodeCount|refs).
    // Compare decoded URL path against current page URL to detect page mismatch.
    // nodeCount comparison is unreliable (recording uses broader selectors than replay),
    // so we only use URL-based matching here; fingerprint validation guards element accuracy.
    try {
      const decoded = Buffer.from(compiledSignature, 'base64').toString('utf-8');
      const decodedParts = decoded.split('|');
      if (decodedParts.length >= 1 && decodedParts[0]) {
        const compiledUrl = decodedParts[0];
        const currentUrl = page.url();
        // Compare pathname — ignore query params and hash (they change between runs)
        try {
          const compiledPath = new URL(compiledUrl).pathname;
          const currentPath = new URL(currentUrl).pathname;
          if (compiledPath !== currentPath) {
            logger.warn('[COMPILED_EXECUTOR] Base64 signature: URL path mismatch — likely different page', {
              compiledPath,
              currentPath,
            });
            return { matched: false, currentSignature };
          }
        } catch {
          // URL parsing failed — skip comparison
        }
      }
    } catch {
      // Decode failed — treat as matched (backward compatibility for truncated signatures)
    }
    logger.debug('[COMPILED_EXECUTOR] Compiled signature is base64 format (from recording), URL check passed');
    return { matched: true, currentSignature };
  }

  // Both signatures use the same tag:type:name:id:role format — compare overlap
  const compiledSet = new Set(compiledParts);
  const currentParts = currentSignature.split('|');

  if (compiledSet.size === 0 || currentParts.length === 0) {
    return { matched: true, currentSignature };
  }

  let matchCount = 0;
  for (const part of currentParts) {
    if (compiledSet.has(part)) {
      matchCount++;
    }
  }

  const matchRatio = matchCount / Math.max(compiledSet.size, currentParts.length);
  const matched = matchRatio >= 0.6;

  logger.debug('[COMPILED_EXECUTOR] Page signature check', {
    matched,
    matchRatio: Math.round(matchRatio * 100),
    compiledPartsCount: compiledSet.size,
    currentPartsCount: currentParts.length,
  });

  return { matched, currentSignature };
}

/**
 * Quick fingerprint check to validate found element matches expected attributes.
 * Returns match score 0-1 (1 = perfect match).
 *
 * ── BUG FIX: Now checks ALL 8 fingerprint attributes ──
 * Previously only 4 were checked (tag, role, ariaLabel, placeholder).
 * Now also checks: labelText, testIdAttr, containerTitles, boundingBox.
 * This catches cases like two "Submit" buttons in different forms
 * (same tag/role but different containers/labels).
 */
export async function quickFingerprintCheck(
  page: PageLike,
  locator: Locator,
  fingerprint: TargetFingerprint
): Promise<number> {
  try {
    const element = await locator.evaluate((el: any) => {
      // Symmetry with recorder: `TargetFingerprint.role` was written as the
      // explicit-or-implicit role via computeRole() at record time, so the
      // comparison target must be computed the same way. Reading raw
      // getAttribute('role') here would mismatch every native <button>/<a>/
      // <select>/etc. against its own recorded fingerprint → fp score
      // silently degrades for every candidate, weakening the tiebreaker.
      // MUST MATCH COMPUTE_ROLE_SRC in recording-capture.service.ts.
      function computeRole(node: any): string | undefined {
        if (!node || !node.tagName) return undefined;
        if (node.hasAttribute?.('role')) return node.getAttribute('role') || undefined;
        const t = node.tagName.toLowerCase();
        switch (t) {
          case 'button': return 'button';
          case 'a': return node.hasAttribute('href') ? 'link' : undefined;
          case 'input': {
            const inputType = (node.getAttribute('type') || 'text').toLowerCase();
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
          case 'select': return node.hasAttribute('multiple') ? 'listbox' : 'combobox';
          case 'img': return node.hasAttribute('alt') ? 'img' : undefined;
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

      // Extract associated label text
      let labelText: string | null = null;
      const doc = el.ownerDocument;
      if (el.id && doc) {
        // @ts-expect-error - CSS.escape is available in browser context
        const label = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) labelText = label.textContent?.trim() || null;
      }
      if (!labelText && el.closest?.('label')) {
        labelText = el.closest('label').textContent?.trim() || null;
      }

      // Extract container titles (nearest semantic containers)
      const containerTitles: string[] = [];
      let parent = el.parentElement;
      let depth = 0;
      while (parent && depth < 5) {
        const tag = parent.tagName?.toLowerCase();
        if (['fieldset', 'form', 'section', 'article', 'nav', 'dialog'].includes(tag)) {
          const legend = parent.querySelector(':scope > legend');
          const heading = parent.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
          const title = legend?.textContent?.trim() || heading?.textContent?.trim() || parent.getAttribute('aria-label') || '';
          if (title) containerTitles.push(title);
        } else if (parent.getAttribute('role') === 'group' || parent.getAttribute('role') === 'region') {
          const title = parent.getAttribute('aria-label') || '';
          if (title) containerTitles.push(title);
        }
        parent = parent.parentElement;
        depth++;
      }

      return {
        tag: el?.tagName?.toLowerCase(),
        role: computeRole(el),
        ariaLabel: el?.getAttribute?.('aria-label'),
        placeholder: el?.getAttribute?.('placeholder'),
        labelText,
        testIdAttr: el?.getAttribute?.('data-testid'),
        containerTitles,
        boundingBox: el?.getBoundingClientRect ? (() => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })() : null,
      };
    });

    let matches = 0;
    let total = 0;

    // ── Core attributes (weighted: each counts as 1) ──

    // Compare tag
    if (fingerprint.tag) {
      total++;
      if (element.tag === fingerprint.tag.toLowerCase()) matches++;
    }

    // Compare role
    if (fingerprint.role) {
      total++;
      if (element.role === fingerprint.role) matches++;
    }

    // Compare ariaLabel
    if (fingerprint.ariaLabel) {
      total++;
      if (element.ariaLabel === fingerprint.ariaLabel) matches++;
    }

    // Compare placeholder
    if (fingerprint.placeholder) {
      total++;
      if (element.placeholder === fingerprint.placeholder) matches++;
    }

    // ── Extended attributes (also weighted: each counts as 1) ──

    // Compare labelText
    if (fingerprint.labelText) {
      total++;
      if (element.labelText === fingerprint.labelText) matches++;
    }

    // Compare testIdAttr
    if (fingerprint.testIdAttr) {
      total++;
      if (element.testIdAttr === fingerprint.testIdAttr) matches++;
    }

    // Compare containerTitles (at least one common container = match)
    if (fingerprint.containerTitles && fingerprint.containerTitles.length > 0) {
      total++;
      const fpContainers = new Set(fingerprint.containerTitles.map(c => c.toLowerCase()));
      const elContainers = (element.containerTitles || []).map((c: string) => c.toLowerCase());
      const hasCommon = elContainers.some((c: string) => fpContainers.has(c));
      if (hasCommon) matches++;
    }

    // NOTE: bbox comparison intentionally omitted here. Spatial proximity is
    // handled by bboxCloseScore() as a dedicated continuous signal in the
    // multi-match disambiguation path, so counting it here too would double-
    // weight position inside every call that feeds the combined score.
    // Single-candidate validation callers (e.g. the post-match fingerprint
    // gate) do not need bbox — if the locator matched at all and structural
    // attrs align, position is not a differentiator.

    // If no fingerprint attributes, return 1 (no validation needed)
    if (total === 0) return 1;

    const score = matches / total;
    return score;
  } catch {
    // If fingerprint check fails, assume element is ok (best effort)
    return 1;
  }
}

/**
 * Extended version of quickFingerprintCheck that ALSO returns the
 * candidate's bounding box from the same page.evaluate roundtrip.
 *
 * Exists so the multi-match disambiguation path can score fingerprint AND
 * bbox with a single page call per candidate. Previously the ranking loop
 * ran two sequential page.evaluate invocations per candidate (once for
 * fingerprint, once for bbox), adding ~40-120ms on pages with 5-8
 * candidates. This merges both.
 */
async function fingerprintCheckWithBbox(
  page: PageLike,
  locator: Locator,
  fingerprint: TargetFingerprint
): Promise<{ score: number; bbox: { x: number; y: number; width: number; height: number } | null }> {
  // Reuse quickFingerprintCheck, but also request bbox via a companion probe.
  // Running both concurrently (Promise.all) halves the wall-clock wait per
  // candidate compared to strictly-sequential calls.
  const [score, bbox] = await Promise.all([
    quickFingerprintCheck(page, locator, fingerprint).catch(() => 0),
    locator.evaluate((el: any) => {
      if (!el?.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }).catch(() => null),
  ]);
  return { score, bbox };
}

/**
 * Continuous bbox-closeness score used as a soft tiebreaker between
 * fingerprint-equal candidates.
 *
 * Returns 1.0 when the candidate's bounding box matches the recorded one
 * exactly, decays smoothly to 0 as distance grows, and stays at 0 beyond
 * ~400px — by that point the element is clearly not "the same thing moved
 * slightly" and positional info is no longer trustworthy.
 *
 * Why continuous (not just binary 100px): for pages like tutor listings,
 * every card can match the 100px threshold for its neighbour but only one
 * candidate is TRULY the recorded element. The continuous score ranks them.
 *
 * Returns 0.5 (neutral) when either side has no bbox, so missing data does
 * not penalize the candidate — we just have no signal.
 */
function bboxCloseScore(
  recorded: { x: number; y: number; width: number; height: number } | undefined,
  candidate: { x: number; y: number; width: number; height: number } | null | undefined,
): number {
  if (!recorded || !candidate) return 0.5;
  // Degenerate recorded bbox (w=0 OR h=0) usually means the element was
  // detached or off-screen at capture time. Keeping the "(0,0) center"
  // would bias disambiguation toward whichever candidate happens to sit at
  // the top-left of the viewport. Return neutral so fingerprint alone
  // decides.
  if (recorded.width <= 0 || recorded.height <= 0) return 0.5;
  if (candidate.width <= 0 || candidate.height <= 0) return 0.5;
  const dx = (recorded.x + recorded.width / 2) - (candidate.x + candidate.width / 2);
  const dy = (recorded.y + recorded.height / 2) - (candidate.y + candidate.height / 2);
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Smooth decay: 0px → 1.0, 100px → ~0.6, 200px → ~0.3, 400px+ → ~0.
  const score = Math.max(0, 1 - dist / 400);
  return score;
}

/**
 * Try a single locator entry.
 *
 * When a locator matches multiple elements (`count > 1`) and a `fingerprint`
 * is provided, we rank each candidate via a COMBINED score:
 *   - quickFingerprintCheck (structural match: tag/role/label/container)
 *   - bboxCloseScore (continuous spatial proximity to recorded position)
 *
 * Both are computed fail-safely. If scoring throws (detached node, DOM
 * mutation mid-check, timeout), that candidate is skipped silently and the
 * remaining candidates are still considered. Worst case: all scores fail →
 * we fall through to `ambiguous` which routes to the LLM self-heal path
 * with the original strategy value intact — the user never sees an error,
 * just a slightly slower step.
 *
 * A winner is accepted only when its combined score is clearly above the
 * runners-up (≥0.55 AND leads by ≥0.12). Anything closer is still reported
 * as ambiguous so the LLM can make the call on full page context.
 */
/**
 * Build a locator for a strategy entry — optionally scoped inside the
 * recorded ARIA landmark. Returns the globally-scoped locator when scoping
 * is not applicable or the scope root itself is missing, so callers never
 * need to special-case "landmark not found".
 */
function buildStrategyLocator(
  page: PageLike,
  entry: LocatorEntry,
  scope: Locator | PageLike = page,
): Locator | null {
  switch (entry.strategy) {
    case 'ref':
    case 'css':
      return scope.locator(entry.value);
    case 'role':
      return entry.roleName
        ? scope.getByRole(entry.roleName as any, { name: entry.value })
        : scope.locator(entry.value);
    case 'label':
      return scope.getByLabel(entry.value);
    case 'testId':
      return scope.getByTestId(entry.value);
    case 'placeholder':
      return scope.getByPlaceholder(entry.value);
    case 'title':
      return scope.getByTitle(entry.value);
    case 'text':
      return scope.getByText(entry.value, { exact: false });
    default:
      return null;
  }
}

async function tryLocatorEntry(
  page: PageLike,
  entry: LocatorEntry,
  timeout: number,
  fingerprint?: TargetFingerprint
): Promise<{
  success: boolean;
  locator?: Locator;
  error?: string;
  failureKind?: 'ambiguous' | 'not_found' | 'error';
  matchCount?: number;
}> {
  try {
    // ── Landmark scoping (soft prefilter) ───────────────────────────────
    // When the recorded element had a nearestLandmark (e.g. 'navigation'),
    // first try resolving INSIDE each landmark of that role. Narrows the
    // search space to the right section and eliminates ambiguity caused
    // by the same label recurring in multiple parts of the page (header
    // vs footer vs sidebar).
    //
    // Correctness guard: when multiple landmarks exist (e.g. site-nav +
    // footer-nav), picking `landmark.first()` would silently commit to the
    // wrong section if the recorded element lived elsewhere. Instead we
    // iterate candidates inside EACH landmark, require exactly one match
    // total, AND validate it against the recorded fingerprint before
    // accepting. Anything ambiguous falls through to the global locator
    // plus the ranking path.
    //
    // All failures are soft — throws, missing landmark, 0 matches, or a
    // scoped candidate that fails fingerprint validation all route back to
    // the global locator below. The prefilter can never cause a step to
    // fail; it can only make it succeed earlier.
    if (fingerprint?.nearestLandmark) {
      try {
        const landmarkRole = fingerprint.nearestLandmark.toLowerCase();
        const landmark = page.getByRole(landmarkRole as any);
        const landmarkCount = await landmark.count().catch(() => 0);
        if (landmarkCount > 0) {
          // Collect every (landmarkIdx, matchIdx) pair inside any landmark
          // of this role. If exactly one pair survives, we have a strong
          // candidate; otherwise defer to the broader path.
          const scopedHits: Array<{ scoped: Locator }> = [];
          for (let li = 0; li < Math.min(landmarkCount, 4); li++) {
            const scopedLocator = buildStrategyLocator(page, entry, landmark.nth(li));
            if (!scopedLocator) break;
            const scopedTotal = await scopedLocator.count().catch(() => 0);
            for (let mi = 0; mi < scopedTotal; mi++) {
              scopedHits.push({ scoped: scopedLocator.nth(mi) });
              if (scopedHits.length > 1) break; // early exit: 2 is already ambiguous
            }
            if (scopedHits.length > 1) break;
          }

          if (scopedHits.length === 1) {
            const scoped = scopedHits[0].scoped;
            try {
              await scoped.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });
              // Validate against fingerprint — protects against the case
              // where the landmark role appears multiple times and we
              // accidentally landed in the wrong one (but still found one
              // candidate there). With no fingerprint attributes to check,
              // quickFingerprintCheck returns 1 and we accept.
              const fpScore = await quickFingerprintCheck(page, scoped, fingerprint).catch(() => 0);
              if (fpScore >= LANDMARK_ACCEPT_MIN_FP) {
                logger.info('[COMPILED_EXECUTOR] Landmark scoping resolved ambiguity', {
                  landmark: landmarkRole,
                  strategy: entry.strategy,
                  value: entry.value.slice(0, 80),
                  fpScore: Math.round(fpScore * 100) / 100,
                });
                return { success: true, locator: scoped, matchCount: 1 };
              }
              logger.debug('[COMPILED_EXECUTOR] Landmark-scoped match failed fingerprint gate', {
                landmark: landmarkRole,
                fpScore: Math.round(fpScore * 100) / 100,
              });
            } catch {
              // Candidate disappeared / threw — fall through to global.
            }
          }
          // 0, >1, or fingerprint-rejected → fall through; the global
          // locator below + ranking path will retry with full context.
        }
      } catch {
        // Scoping machinery itself failed — ignore and try global.
      }
    }

    const locator = buildStrategyLocator(page, entry);
    if (!locator) {
      return { success: false, error: `Unknown strategy: ${entry.strategy}` };
    }

    // Wait for element to be visible (quick check)
    await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });

    const count = await locator.count();
    if (count === 0) {
      return { success: false, error: 'No elements found', failureKind: 'not_found', matchCount: 0 };
    }
    if (count === 1) {
      return { success: true, locator, matchCount: 1 };
    }

    // ── Multi-match disambiguation ──────────────────────────────────────
    // Rank candidates by combined (fingerprint + bbox) score. Both signals
    // come from ONE page.evaluate per candidate via fingerprintCheckWithBbox,
    // keeping latency under ~80ms even with MAX_DISAMBIGUATION_CANDIDATES
    // candidates on a slow page.
    //
    // All failure modes are soft. Per-candidate errors drop just that entry
    // from ranking. If ranking yields no clear winner, we report `ambiguous`
    // and let LLM self-heal decide on full page context — never silently
    // clicking an uncertain candidate.
    if (fingerprint) {
      const maxCandidates = Math.min(count, MAX_DISAMBIGUATION_CANDIDATES);
      const scores: Array<{ idx: number; score: number; fp: number; bbox: number }> = [];
      for (let i = 0; i < maxCandidates; i++) {
        try {
          const candidate = locator.nth(i);
          const { score: fpScore, bbox: candidateBox } =
            await fingerprintCheckWithBbox(page, candidate, fingerprint);
          const bScore = bboxCloseScore(fingerprint.boundingBox, candidateBox);
          const combined = FP_WEIGHT * fpScore + BBOX_WEIGHT * bScore;
          scores.push({ idx: i, score: combined, fp: fpScore, bbox: bScore });
        } catch {
          // Absolute last-resort catch — drop this candidate, keep ranking.
        }
      }
      scores.sort((a, b) => b.score - a.score);
      const winner = scores[0];
      const runnerUp = scores[1];
      const clearlyBetter =
        !!winner
        && winner.score >= WINNER_MIN_SCORE
        && (!runnerUp || winner.score - runnerUp.score >= WINNER_MIN_LEAD);

      if (clearlyBetter) {
        logger.debug('[COMPILED_EXECUTOR] Fingerprint+bbox disambiguated multi-match', {
          strategy: entry.strategy,
          value: entry.value.slice(0, 80),
          count,
          winnerIdx: winner.idx,
          winnerScore: Math.round(winner.score * 100) / 100,
          winnerFp: Math.round(winner.fp * 100) / 100,
          winnerBbox: Math.round(winner.bbox * 100) / 100,
          runnerUpScore: runnerUp ? Math.round(runnerUp.score * 100) / 100 : null,
        });
        return { success: true, locator: locator.nth(winner.idx), matchCount: count };
      }

      logger.warn('[COMPILED_EXECUTOR] Multi-match with no clear winner — deferring to LLM', {
        strategy: entry.strategy,
        value: entry.value.slice(0, 80),
        count,
        topScore: winner ? Math.round(winner.score * 100) / 100 : null,
        runnerUpScore: runnerUp ? Math.round(runnerUp.score * 100) / 100 : null,
      });
    } else {
      logger.warn('[COMPILED_EXECUTOR] Multiple elements matched, no fingerprint — deferring to LLM', {
        strategy: entry.strategy,
        value: entry.value,
        count,
      });
    }

    return { success: false, error: `Ambiguous: ${count} elements matched`, failureKind: 'ambiguous', matchCount: count };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage, failureKind: 'error' };
  }
}

/**
 * Execute compiled locator plan
 *
 * @param page Playwright Page
 * @param compiled CompiledStepPlan from IntentStep
 * @param actionType Action type for TTL calculation
 * @param timeout Action timeout
 * @returns Result with success status and locator if found
 */
/**
 * V15: Tracer contract for per-attempt observability. Structural interface — callers
 * pass EditorTraceService methods (or any compatible shape). Fire-and-forget; every
 * call is wrapped in try/catch internally so a broken tracer can't break execution.
 */
export interface CompiledExecutorTracer {
  attempt(data: {
    stepId: string;
    attempt: number;
    strategy: string;
    value: string;
    confidence?: number;
    timeoutMs: number;
    success: boolean;
    durationMs: number;
    failureKind?: 'not_found' | 'ambiguous' | 'fingerprint_mismatch' | 'timeout' | 'error';
    matchCount?: number;
    fingerprintScore?: number;
    error?: string;
  }): void;
  reorder(data: { stepId: string; reason: string; before: string[]; after: string[] }): void;
}

export async function executeCompiledLocatorPlan(
  page: PageLike,
  compiled: CompiledStepPlan | undefined,
  actionType: string,
  timeout: number = 30000,
  tracer?: CompiledExecutorTracer,
  stepId?: string,
): Promise<CompiledExecutionResult> {
  const safeTrace = {
    attempt: (d: Parameters<CompiledExecutorTracer['attempt']>[0]) => {
      try { tracer?.attempt(d); } catch { /* non-fatal */ }
    },
    reorder: (d: Parameters<CompiledExecutorTracer['reorder']>[0]) => {
      try { tracer?.reorder(d); } catch { /* non-fatal */ }
    },
  };
  const traceStepId = stepId ?? 'unknown';
  // 1. Check if compiled plan exists
  if (!compiled || !compiled.locatorPlan || compiled.locatorPlan.length === 0) {
    logger.debug('[COMPILED_EXECUTOR] No compiled plan available');
    return {
      success: false,
      skipReason: 'no_plan',
      source: 'resolver',
    };
  }

  // 2. Check soft-expire based on actionType TTL
  const compiledAt = compiled.context?.compiledAt;
  const expired = compiledAt ? isCompiledPlanExpired(compiledAt, actionType) : false;
  if (expired) {
    logger.info('[COMPILED_EXECUTOR] Compiled plan expired, skipping', {
      compiledAt,
      actionType,
    });
    return {
      success: false,
      skipReason: 'expired',
      expired: true,
      source: 'resolver',
    };
  }

  // 3. Check pageSignature (if present)
  const signatureCheck = await checkPageSignature(page, compiled.context?.pageSignature);

  // ── BUG FIX: Signature mismatch must skip compiled execution ──────────
  // Previously this check was performed but never enforced — locators ran
  // even on drastically different pages, risking wrong element interaction.
  if (!signatureCheck.matched) {
    logger.warn('[COMPILED_EXECUTOR] Page signature mismatch — skipping compiled plan', {
      compiledSignaturePreview: compiled.context?.pageSignature?.slice(0, 50),
      currentSignaturePreview: signatureCheck.currentSignature.slice(0, 50),
    });
    return {
      success: false,
      skipReason: 'signature_mismatch',
      signatureMatched: false,
      source: 'resolver',
    };
  }

  // Always filter out ref strategy — data-agent-ref attributes only exist during preview sessions,
  // not during background replay/regression. Trying ref locators wastes 5s per step on timeout.
  // Keep stable strategies (role, label, testId, placeholder, css) that work without injected refs.
  let locatorsToTry = compiled.locatorPlan.filter(entry => entry.strategy !== 'ref');

  if (locatorsToTry.length === 0) {
    logger.info('[COMPILED_EXECUTOR] Only ref locators in plan, skipping (refs not available during replay)', {
      originalCount: compiled.locatorPlan.length,
    });
    return {
      success: false,
      skipReason: 'no_plan',
      signatureMatched: signatureCheck.matched,
      source: 'resolver',
    };
  }

  if (locatorsToTry.length < compiled.locatorPlan.length) {
    logger.debug('[COMPILED_EXECUTOR] Filtered ref strategy from plan', {
      originalCount: compiled.locatorPlan.length,
      filteredCount: locatorsToTry.length,
      remainingStrategies: locatorsToTry.map(e => e.strategy),
    });
  }

  // V15: Shadow-aware reordering.
  // Only probe + reorder when we have BOTH a shadow-safe entry AND a non-shadow-safe
  // (e.g. css) entry — otherwise reordering is a no-op and the probe is wasted work.
  const hasShadowSafe = locatorsToTry.some(e => SHADOW_SAFE_STRATEGIES.has(e.strategy));
  const hasNonShadowSafe = locatorsToTry.some(e => !SHADOW_SAFE_STRATEGIES.has(e.strategy));
  if (hasShadowSafe && hasNonShadowSafe) {
    const shadowPresent = await pageUsesShadowDom(page);
    if (shadowPresent) {
      const before = locatorsToTry.map(e => e.strategy);
      locatorsToTry = reorderForShadowDom(locatorsToTry, true);
      const after = locatorsToTry.map(e => e.strategy);
      if (before.some((s, i) => s !== after[i])) {
        safeTrace.reorder({
          stepId: traceStepId,
          reason: 'shadow_dom_detected',
          before,
          after,
        });
      }
    }
  }

  // 4. Try each locator in order
  let sawAmbiguous = false;
  const ambiguityDetails: Array<{ strategy: string; matchCount: number }> = [];
  let attemptIdx = 0;
  for (const entry of locatorsToTry) {
    attemptIdx++;
    logger.debug('[COMPILED_EXECUTOR] Trying locator', {
      strategy: entry.strategy,
      value: entry.value.slice(0, 50),
      confidence: entry.confidence,
    });

    const attemptStart = Date.now();
    const result = await tryLocatorEntry(page, entry, timeout, compiled.targetFingerprint);
    const attemptDur = Date.now() - attemptStart;

    if (result.success && result.locator) {
      // Validate fingerprint if available
      if (compiled.targetFingerprint) {
        const matchScore = await quickFingerprintCheck(page, result.locator, compiled.targetFingerprint);

        if (matchScore < 0.3) {
          logger.warn('[COMPILED_EXECUTOR] Fingerprint mismatch - element found but may be wrong', {
            strategy: entry.strategy,
            matchScore: Math.round(matchScore * 100) / 100,
            fingerprint: {
              tag: compiled.targetFingerprint.tag,
              role: compiled.targetFingerprint.role,
              ariaLabel: compiled.targetFingerprint.ariaLabel,
              placeholder: compiled.targetFingerprint.placeholder,
            },
          });
          safeTrace.attempt({
            stepId: traceStepId,
            attempt: attemptIdx,
            strategy: entry.strategy,
            value: entry.value.slice(0, 200),
            confidence: entry.confidence,
            timeoutMs: timeout,
            success: false,
            durationMs: attemptDur,
            failureKind: 'fingerprint_mismatch',
            fingerprintScore: Math.round(matchScore * 100) / 100,
          });
          // Skip this locator, try next one
          continue;
        }

        logger.debug('[COMPILED_EXECUTOR] Fingerprint validated', {
          strategy: entry.strategy,
          matchScore: Math.round(matchScore * 100) / 100,
        });
      }

      safeTrace.attempt({
        stepId: traceStepId,
        attempt: attemptIdx,
        strategy: entry.strategy,
        value: entry.value.slice(0, 200),
        confidence: entry.confidence,
        timeoutMs: timeout,
        success: true,
        durationMs: attemptDur,
      });

      logger.info('[COMPILED_EXECUTOR] Locator succeeded', {
        strategy: entry.strategy,
        confidence: entry.confidence,
      });

      return {
        success: true,
        locator: result.locator,
        usedStrategy: entry.strategy,
        confidence: entry.confidence,
        expired: false,
        signatureMatched: signatureCheck.matched,
        source: 'compiled',
      };
    }

    if (result.failureKind === 'ambiguous') {
      sawAmbiguous = true;
      ambiguityDetails.push({
        strategy: entry.strategy,
        matchCount: result.matchCount ?? 0,
      });
    }

    // Map result.failureKind to tracer enum. `tryLocatorEntry` returns
    // 'not_found' | 'ambiguous' | 'error' | undefined.
    const failureKind: 'not_found' | 'ambiguous' | 'error' =
      (result.failureKind === 'ambiguous' ? 'ambiguous'
      : result.failureKind === 'error' ? 'error'
      : 'not_found');
    safeTrace.attempt({
      stepId: traceStepId,
      attempt: attemptIdx,
      strategy: entry.strategy,
      value: entry.value.slice(0, 200),
      confidence: entry.confidence,
      timeoutMs: timeout,
      success: false,
      durationMs: attemptDur,
      failureKind,
      matchCount: result.failureKind === 'ambiguous' ? result.matchCount : undefined,
      error: result.error?.slice(0, 200),
    });

    logger.debug('[COMPILED_EXECUTOR] Locator failed, trying next', {
      strategy: entry.strategy,
      error: result.error,
    });
  }

  // All locators failed
  logger.warn('[COMPILED_EXECUTOR] All locators in plan failed', {
    sawAmbiguous,
    ambiguityDetails: ambiguityDetails.length > 0 ? ambiguityDetails : undefined,
  });
  return {
    success: false,
    skipReason: sawAmbiguous ? 'ambiguous' : 'locator_failed',
    expired: false,
    signatureMatched: signatureCheck.matched,
    source: 'resolver',
    ambiguityDetails: ambiguityDetails.length > 0 ? ambiguityDetails : undefined,
  };
}

/**
 * Build StepRuntimeMeta from compiled execution result
 */
export function buildRuntimeMeta(
  result: CompiledExecutionResult,
  executionMs: number,
  healResult?: { success: boolean; confidence?: number }
): StepRuntimeMeta {
  // Determine runtime status
  let runtimeStatus: 'executed' | 'healed' | 'failed' = 'failed';
  let source = result.source;
  let confidenceTier: ConfidenceTier = 'low';
  let resolutionPath: 'compiled' | 'self_heal' | undefined;

  if (result.success) {
    runtimeStatus = 'executed';
    confidenceTier = (result.confidence ?? 0) >= 0.8 ? 'high' :
                     (result.confidence ?? 0) >= 0.6 ? 'medium' : 'low';
    resolutionPath = 'compiled';
  } else if (healResult?.success) {
    runtimeStatus = 'healed';
    source = 'self_heal';
    confidenceTier = (healResult.confidence ?? 0) >= 0.85 ? 'medium' : 'low';
    resolutionPath = 'self_heal';
  }

  const meta: StepRuntimeMeta = {
    runtimeStatus,
    source,
    confidenceTier,
    executionMs,
    usedLocatorStrategy: result.usedStrategy,
    compiledExpired: result.expired,
    pageSignatureMatched: result.signatureMatched,
    resolutionPath,
  };

  // Add failure reason and explanation if failed
  if (runtimeStatus === 'failed') {
    switch (result.skipReason) {
      case 'signature_mismatch':
        meta.failedReason = 'element_not_found';
        meta.failureExplanation = 'Page structure changed significantly since step was created. Element locators no longer match current page.';
        break;
      case 'expired':
        meta.failedReason = 'element_not_found';
        meta.failureExplanation = 'Compiled locator plan expired (too old). Re-linting recommended.';
        break;
      case 'locator_failed':
        meta.failedReason = 'element_not_found';
        meta.failureExplanation = 'All compiled locators failed to find element. Element may have been removed or changed.';
        break;
      case 'ambiguous': {
        meta.failedReason = 'element_not_found';
        const details = result.ambiguityDetails;
        if (details && details.length > 0) {
          const strategyInfo = details.map(d => `${d.strategy}(${d.matchCount} matches)`).join(', ');
          meta.failureExplanation = `Multiple elements matched compiled locators [${strategyInfo}]. Cannot determine which element to interact with.`;
        } else {
          meta.failureExplanation = 'Multiple elements matched the locator. Cannot determine which element to interact with.';
        }
        break;
      }
      default:
        meta.failedReason = 'unknown';
        meta.failureExplanation = 'Unknown failure reason.';
    }
  }

  // Flag for review if healed with low confidence or compiled failed
  if (runtimeStatus === 'healed' && confidenceTier === 'low') {
    meta.needsReview = true;
    meta.flaky = true;
    meta.healConfidence = healResult?.confidence;
    meta.failureExplanation = `Self-healing succeeded but with low confidence (${Math.round((healResult?.confidence ?? 0) * 100)}%). Manual review recommended.`;
  }

  return meta;
}
