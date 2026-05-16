/**
 * Candidate-pruner via LLM.
 *
 * A small, fast LLM call that narrows the resolver's candidate set from
 * ~60 down to ~15 BEFORE the main resolver prompt. Cuts the resolver's
 * prompt size by ~45% (60 candidates × ~280 chars dominate the 29 KB
 * prompt) and lets cross-script intents reach the resolver — the failure
 * mode that motivated this work was the juz40-edu.kz course card never
 * making it through ASCII-only word matching when the page rendered the
 * card label in Cyrillic but the user typed it in Latin (МАТ vs MAT).
 *
 * Architecture (do-not-break list):
 *   - Identity fast-path runs BEFORE pruner (on `allAllowed`, not output)
 *     so V8 wrong-element fix is preserved
 *   - DOM-order top-60 cap is the deterministic fallback when pruner fails:
 *     fail-open returns the original (uncut) candidatesToProcess, which is
 *     just `allAllowed.slice(0, MAX_CANDIDATES_FOR_LLM)` — neutral, no
 *     language coupling
 *   - Identity rescue: any node whose id/testId/name/svgIcon/alt matches
 *     the recorded fingerprint is force-included in pruner output, so the
 *     pruner CANNOT remove a deterministically-matched element
 *   - Cache key prefixed `prune|` — separate namespace from resolver cache
 *   - `invalidatePrunerForRef` mirrors `invalidateLlmSelectionsForRef`
 *     so the V24 wrong-element guards flush both layers in one rejection
 *
 * Cost model (Gemini 2.5 Flash Lite, Apr 2026):
 *   Pruner call:    ~5 KB prompt → ~1250 input tokens × $0.10/1M = $0.000125
 *                   + ~50 output tokens × $0.40/1M               = $0.00002
 *                   = ~$0.000145 per call
 *   Resolver shrink: ~3200 fewer input tokens × $0.10/1M         = -$0.00032
 *   Net: cost-neutral or slightly negative.
 *
 * Latency: cache hit 0ms, cache miss 300-800ms (small prompt). 60s TTL +
 * singleflight dedup keeps cost bounded under Apply-All bursts.
 *
 * Fail-open: every error path returns `prunerSkipped:true`, the resolver
 * receives the unmodified DOM-order top-60 set as if pruner never existed.
 */

import { createHash } from 'crypto';
import { getChatCompletionWithGemini } from '@/services/ai/core/gemini.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { withAILogFields } from '@/services/ai/tracking/ai-context';
import type {
  BindingHints,
  IntentActionType,
  InteractiveNode,
  TargetFingerprint,
} from './preview.types';

// ───────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────

const PRUNER_TOP_K_DEFAULT = 15;
// V26: bumped 3s→7s. Real prod traffic on dense Angular Material pages
// (60+ candidates, ~30KB prompt) hit Gemini Flash Lite p95 ~4-5s; 3s gave
// ~30% timeout rate. 7s covers p99 without making the per-step ceiling
// painful — fail-open path still works if we exceed.
const PRUNER_TIMEOUT_MS = 7_000;
const PRUNER_CACHE_TTL_MS = 60_000;       // 60s — same as resolver cache
const PRUNER_CACHE_MAX_SIZE = 400;
const PRUNER_SKIP_THRESHOLD = 16;          // Skip pruner when ≤ this many candidates
// V26: upper-bound skip. When the candidate set is huge (heavy enterprise
// pages with 200-500 interactive nodes) the pruner LLM call almost always
// times out — we burn 7s, fall open, then the full resolver still has to
// re-rank the same 60. Skip ahead and save the wall time. The DOM-order
// top-60 fallback is the resolver's natural input anyway.
const PRUNER_UPPER_BOUND = 100;
const PRUNER_MIN_OUTPUT = 5;               // Below this, pad from input DOM-order set
// Prompt-side cap on intent text. The cache key hashes the SAME truncated
// form so two intents differing only past the cap share a slot.
const INTENT_PROMPT_CAP = 500;

// Bumped on prompt edits to invalidate caches across deploys.
// v2: action-aware preferences, ref format spec, candidate-notation key,
//     href in identity, bbox dropped, TOP_K reminder in user prompt.
// v3: cross-script semantic match elevated above token overlap in ranking
//     order — fixes regression where Russian intent ("иконка папка") with
//     0 token overlap to Kazakh target ("Папкалар") got demoted out of
//     pruner top-K, then semantic-floor reject killed the resolver.
// v4 — pass sceneSummary (PAGE STATE) into the pruner so it can keep
// popup/dropdown options in the top-K when the intent uses a popup-scope
// word ("in search results", "из списка", "в выпадающем", etc.).
const PROMPT_VERSION = 'v4';

// ───────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────

export type PrunerSkipReason =
  | 'too_few'                  // Not enough candidates to prune
  | 'too_many'                 // Above PRUNER_UPPER_BOUND — LLM would time out
  | 'invalid_json'             // LLM returned non-JSON
  | 'timeout'                  // LLM timed out
  | 'no_grounded_refs'         // 0 returned refs exist in input
  | 'llm_failed'               // Other LLM error (5xx, abort)
  | 'disabled';                // Feature flag off (Phase 2)

export interface PrunerCandidate {
  node: InteractiveNode;
  candidateText: string;
}

export interface PrunerResult {
  prunedCandidates: PrunerCandidate[];
  cacheHit: boolean;
  latencyMs: number;
  prunerSkipped: boolean;
  reason?: PrunerSkipReason;
  // Diagnostics (always populated, even on skip)
  inputCount: number;
  outputCount: number;
  identityRescueCount: number;
}

interface PrunerCacheEntry {
  refs: string[];           // Pruner output (ordered)
  createdAt: number;
}

// ───────────────────────────────────────────────────────────────────────
// Cache + singleflight
// ───────────────────────────────────────────────────────────────────────

const prunerCache = new Map<string, PrunerCacheEntry>();
// Singleflight: concurrent callers on the same key share the in-flight
// Promise. Apply-All issues N consecutive lints; without dedup, two
// parallel "Find" clicks would fire two pruner calls on the same input.
const inFlight = new Map<string, Promise<string[]>>();

/**
 * Cache key shape (pipe-delimited segments):
 *   {version}|prune|{mode}|{urlHash}|{pageSig}|{actionType}|{intentHash}|{fpDigest}|{bhDigest}|{refsHash}|{topK}
 *
 * All variable-length fields hashed to 16-char hex to keep the key bounded
 * (~190 chars max) and structured so `invalidatePrunerForRef` can split
 * by `|` and match exact segments instead of substring scan. The earlier
 * implementation joined all 60 candidate refs into the key directly,
 * producing ~400-char keys × 400 entries = ~160 KB just on keys, plus
 * O(N×M) scans on substring invalidation.
 *
 * Hashes use the same truncation pattern as the resolver cache (16 hex
 * chars = 64 bits) — collision probability is negligible at 400 entries.
 */
function hash16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

const KEY_SEGMENT_INDEX = {
  version: 0,
  tag: 1,
  mode: 2,
  urlHash: 3,
  pageSig: 4,
  actionType: 5,
  intentHash: 6,
  fpDigest: 7,
  bhDigest: 8,
  descDigest: 9,
  sceneDigest: 10,
  refsHash: 11,
  topK: 12,
} as const;

function buildCacheKey(args: {
  mode: 'apply' | 'heal';
  pageUrl: string;
  pageSignature: string;
  actionType: string;
  intentText: string;
  recordedFingerprint?: TargetFingerprint;
  priorApplyHints?: BindingHints;
  recordedDescription?: string;
  sceneSummary?: string;
  candidateRefs: string[];
  topK: number;
}): string {
  const urlHash = hash16(args.pageUrl);
  const fpDigest = args.recordedFingerprint
    ? hash16(JSON.stringify(args.recordedFingerprint))
    : '';
  const bhDigest = args.priorApplyHints
    ? hash16(JSON.stringify(args.priorApplyHints))
    : '';
  // Etap 1D.4 — recordedDescription participates in the cache key so two
  // recordings with the same intent text but different captured-time
  // descriptions don't collide on a stale prune result.
  const descDigest = args.recordedDescription ? hash16(args.recordedDescription) : '';
  // v4 — sceneSummary participates in the cache key. Same intent + same
  // 60 refs but the popup-list snapshot changed (different items visible)
  // must NOT hit the stale entry.
  const sceneDigest = args.sceneSummary ? hash16(args.sceneSummary) : '';
  // Hash the truncated intent (matches the prompt cap of 500 chars) so
  // intent texts that differ only past the cap hit the same cache slot —
  // they produce identical prompts.
  const intentHash = hash16(args.intentText.slice(0, INTENT_PROMPT_CAP));
  const refsHash = hash16(args.candidateRefs.join(','));
  return [
    PROMPT_VERSION,
    'prune',
    args.mode,
    urlHash,
    args.pageSignature,
    args.actionType,
    intentHash,
    fpDigest,
    bhDigest,
    descDigest,
    sceneDigest,
    refsHash,
    String(args.topK),
  ].join('|');
}

function evictIfFull(): void {
  if (prunerCache.size < PRUNER_CACHE_MAX_SIZE) return;
  const dropCount = Math.max(1, Math.floor(PRUNER_CACHE_MAX_SIZE * 0.1));
  const keys = Array.from(prunerCache.keys()).slice(0, dropCount);
  for (const k of keys) prunerCache.delete(k);
}

// ───────────────────────────────────────────────────────────────────────
// Identity rescue — paranoid guard
// ───────────────────────────────────────────────────────────────────────

/**
 * Find candidate refs whose recorded-identity fields match the recorded
 * fingerprint. These MUST appear in the pruner output regardless of what
 * the LLM thought — they're deterministic identity matches, not
 * semantic guesses. Without this rescue, a flaky pruner LLM could remove
 * the very element that the downstream identity-fast-path would have
 * picked deterministically.
 */
function findIdentityMatches(
  candidates: PrunerCandidate[],
  fp: TargetFingerprint | undefined,
): string[] {
  if (!fp) return [];
  const matches: string[] = [];
  for (const c of candidates) {
    const n = c.node;
    // Skip nodes without a ref — they can't be referenced in the LLM
    // output anyway. Defensive: ref is normally always present in
    // pruner input but we never trust call-site invariants.
    if (!n.ref) continue;
    if (
      (fp.elementId && n.id && n.id === fp.elementId && !n.isDynamicId) ||
      (fp.testIdAttr && n.testIdAttr && n.testIdAttr === fp.testIdAttr) ||
      (fp.name && n.name && n.name === fp.name) ||
      // svgIcon / alt / iconLabel are typed on InteractiveNode (V23 commit
      // — see preview.types.ts). The earlier `(n as any)` casts dated
      // back to before those fields were promoted; they're now strict.
      (fp.svgIcon && n.svgIcon && n.svgIcon === fp.svgIcon) ||
      (fp.alt && n.alt && n.alt === fp.alt) ||
      (fp.iconLabel && n.iconLabel && n.iconLabel === fp.iconLabel)
    ) {
      matches.push(n.ref);
    }
  }
  return matches;
}

// ───────────────────────────────────────────────────────────────────────
// Prompt
// ───────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a fast pre-filter for a UI-test element resolver.

TASK: From the candidate list, return the refs of up to {TOP_K} elements most likely to match the user's INTENT (any language) and the recorded identity hints. A second, slower model picks the final element from your shortlist.

Be PERMISSIVE — if you exclude the right element here, the resolver cannot recover. INCLUDE rather than EXCLUDE when uncertain. Keep candidates that:
- share a token (in any script) with the intent — treat МАТ (Cyrillic) as equivalent to MAT (Latin), case-insensitive
- semantically match the intent across languages even with ZERO token overlap — "иконка папка" (Russian) ≡ "Папкалар" (Kazakh) ≡ "Folders" (English). Translate / transliterate before comparing.
- match any RECORDED IDENTITY value (id / testId / href / name / svgIcon / iconLabel / alt)
- sit inside a container named in the intent (e.g. "MAT-SMART", "Login modal")
- have an icon name that visually maps to a word in the intent

Cross-script reminder: lowercase + Unicode-fold both sides before comparing tokens. When the intent and the candidate are in different languages (Russian intent, Kazakh/English UI), translate semantically — token overlap of 0 is NOT grounds for exclusion.

ACTIVE POPUP / DROPDOWN (HARD RULE — overrides all "soft" preferences below):
When PAGE STATE describes an "Active popup/dropdown" AND the intent uses a popup-scope word — EN: "in/from/inside the dropdown / menu / popup / popover / suggestions / suggestion list / autocomplete / typeahead / search results / results / options / list / picker"; RU: "в выпадающем списке / в меню / в попапе / в подсказках / в результатах поиска / в результатах / в списке / в выборе"; KZ: "тізімде / мәзірде / іздеу нәтижелерінде / нұсқаларда" — you MUST include in your top-K every candidate that:
  • is listed in PAGE STATE's "visible items" block, OR
  • shares any token (after lowercase + Unicode-fold + transliteration) with the intent's anchor and looks like an inline popup option (role=option / menuitem / row / treeitem / listitem, or a bare <a>/<li>/<div> with isInsideActiveModal=true), OR
  • matches the intent's anchor semantically across languages.
Reserve at most 3 slots for non-popup candidates in this case — language switchers, footer links, hero CTAs etc. are NOT the target when the user said "in the popup/results/dropdown". Pattern "<ANCHOR> in <POPUP-WORD>" means "find the option named <ANCHOR> inside the active popup", not "find a button somewhere on the page". The trigger that opened the popup (the [expanded] combobox / search input) is also NOT what the user picks — keep it at most once for context.

ACTION-AWARE PREFERENCE (soft, not exclusion — still INCLUDE when intent strongly points elsewhere):
- click / hover: prefer button, a, [role=button|link|menuitem|tab|option], elements with onclick
- type / fill: prefer input (text/email/password/search), textarea, [contenteditable], [role=textbox|searchbox|combobox]
- select: prefer select, [role=combobox|listbox], [aria-haspopup], [aria-expanded]
- check / uncheck: prefer input[type=checkbox|radio], [role=checkbox|radio|switch]

CANDIDATE NOTATION (already added by upstream; respect when ranking):
- "[N of M]" suffix → N-th of M same-labeled siblings; use the recorded position / container hints to pick the right one
- "(CONTEXT: ...)" → nearby parent / section text for disambiguation between duplicates

OUTPUT (JSON only): {"refs":["e1","e7",...]}
- Refs MUST be copied verbatim from the CANDIDATES list (e.g. "e7", never "7" or "candidate-7" — use the exact value inside ref="...")
- Up to {TOP_K} refs total
- Order by descending confidence: identity match > active-popup option match (when popup-scope intent) > cross-script semantic match > token overlap > container/context match > action-tag fit
- No reasoning, no scores, no explanations`;

function buildPrompt(args: {
  topK: number;
  intentText: string;
  actionType: string;
  recordedFingerprint?: TargetFingerprint;
  priorApplyHints?: BindingHints;
  recordedDescription?: string;
  sceneSummary?: string;
  candidates: PrunerCandidate[];
}): { system: string; user: string } {
  const system = SYSTEM_PROMPT.replace(/\{TOP_K\}/g, String(args.topK));

  const fpLines: string[] = [];
  if (args.recordedFingerprint) {
    const fp = args.recordedFingerprint;
    if (fp.tag) fpLines.push(`tag=${fp.tag}`);
    if (fp.role) fpLines.push(`role=${fp.role}`);
    if (fp.elementId) fpLines.push(`id=${fp.elementId}`);
    if (fp.testIdAttr) fpLines.push(`testid=${fp.testIdAttr}`);
    if (fp.text) fpLines.push(`text=${String(fp.text).slice(0, 120)}`);
    if (fp.labelText) fpLines.push(`label=${String(fp.labelText).slice(0, 80)}`);
    if (fp.ariaLabel) fpLines.push(`aria-label=${String(fp.ariaLabel).slice(0, 80)}`);
    if (fp.svgIcon) fpLines.push(`svgicon=${fp.svgIcon}`);
    if (fp.iconLabel) fpLines.push(`icon=${fp.iconLabel}`);
    if (fp.alt) fpLines.push(`alt=${fp.alt}`);
    // V26: href is a strong identity signal for SPA links (semantic URLs
    // survive label rewrites and i18n). Listed alongside id/testId.
    if (fp.href) fpLines.push(`href=${String(fp.href).slice(0, 120)}`);
    // Bbox intentionally omitted — pruner has no live coordinates to
    // compare against, so it was a dead 30-token line. Position-based
    // disambiguation belongs in the resolver, not the shortlist stage.
    if (fp.containerTitles?.length) fpLines.push(`containers=${fp.containerTitles.slice(0, 2).join(' > ')}`);
  }
  const recordedBlock = fpLines.length > 0
    ? `\nRECORDED IDENTITY:\n${fpLines.join('\n').slice(0, 600)}\n`
    : '';

  const hintsLines: string[] = [];
  if (args.priorApplyHints) {
    const h = args.priorApplyHints;
    if (h.label) hintsLines.push(`prior-label=${h.label}`);
    if (h.text) hintsLines.push(`prior-text=${String(h.text).slice(0, 80)}`);
    if (h.nearText) hintsLines.push(`prior-near=${String(h.nearText).slice(0, 80)}`);
  }
  const hintsBlock = hintsLines.length > 0
    ? `\nPRIOR APPLY HINTS:\n${hintsLines.join('\n').slice(0, 200)}\n`
    : '';

  // Etap 1D.4 — recordedDescription as a soft hint here too. Pruner runs
  // BEFORE the main resolver, so dropping the right candidate at this
  // stage is irrecoverable. Description helps the model keep the right
  // one in the top-K when intent text alone is generic.
  const descBlock = args.recordedDescription
    ? `\nRECORDED DESCRIPTION:\n"${args.recordedDescription.replace(/"/g, '\\"').slice(0, 200)}"\n`
    : '';

  // v4 — PAGE STATE (active modal/popup, expanded containers, selected
  // tabs + the visible items inside the popup). Needed for the
  // popup-scope HARD RULE in the system prompt: without this block the
  // pruner can't tell which candidates live inside the active popup, so
  // intents like "sun in search results" / "из выпадающего списка"
  // would drop the listbox options in favor of louder background links.
  // Cap at 400 chars to keep the prompt bounded on dense pages.
  const sceneBlock = args.sceneSummary
    ? `\nPAGE STATE:\n${args.sceneSummary.slice(0, 400)}\n`
    : '';

  const candidateLines = args.candidates
    .map((c, i) => `${i + 1}. ref="${c.node.ref}" <${c.node.tag}> ${c.candidateText.slice(0, 280)}`)
    .join('\n');

  const user = `INTENT: "${args.intentText.slice(0, INTENT_PROMPT_CAP)}"
ACTION: ${args.actionType}${recordedBlock}${hintsBlock}${descBlock}${sceneBlock}
CANDIDATES (${args.candidates.length}):
${candidateLines}

Return JSON with at most ${args.topK} refs, copied verbatim from the list above.`;

  return { system, user };
}

// ───────────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────────

interface LlmResponseShape {
  refs?: unknown;
}

function parseAndValidateRefs(
  raw: string,
  validRefs: Set<string>,
  topK: number,
): string[] | null {
  let parsed: LlmResponseShape;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const refs = parsed.refs;
  if (!Array.isArray(refs)) return null;

  const seen = new Set<string>();
  const validated: string[] = [];
  for (const r of refs) {
    if (typeof r !== 'string') continue;
    const trimmed = r.trim();
    // Sanity bounds: refs are like `e23` — reject anything wild.
    if (trimmed.length < 1 || trimmed.length > 20) continue;
    // Must come from the input set (drop hallucinations silently).
    if (!validRefs.has(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    validated.push(trimmed);
    // Slop tolerance: accept up to topK + 5, then trim.
    if (validated.length >= topK + 5) break;
  }
  return validated.slice(0, topK);
}

// ───────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────

/**
 * Prune a candidate list down to top-K via a small LLM call.
 *
 * Always fail-open: any error path returns `prunerSkipped:true` so the
 * caller falls back to the unmodified DOM-order top-60 candidate set.
 *
 * Identity rescue: candidates whose recorded-identity fields match are
 * force-included even if the LLM omitted them.
 */
export async function pruneCandidatesViaLLM(params: {
  intentText: string;
  actionType: IntentActionType;
  candidates: PrunerCandidate[];
  pageUrl: string;
  pageSignature: string;
  recordedFingerprint?: TargetFingerprint;
  priorApplyHints?: BindingHints;
  /**
   * Etap 1D.4 — Natural-language description of the recorded element
   * (generated at capture time). Soft hint to help the pruner keep the
   * right candidate in the top-K when intent text is generic. Without
   * this the pruner can drop the target before the main resolver ever
   * sees it — irrecoverable.
   */
  recordedDescription?: string;
  /**
   * v4 — PAGE STATE summary built from the full candidate set BEFORE
   * pruning (active popup/dropdown, expanded containers, selected tabs +
   * visible items inside the popup). Optional: pruner stays popup-agnostic
   * if the caller doesn't pass one — old behaviour preserved.
   */
  sceneSummary?: string;
  topK?: number;
  mode?: 'apply' | 'heal';
}): Promise<PrunerResult> {
  const startedAt = Date.now();
  const topK = params.topK ?? PRUNER_TOP_K_DEFAULT;
  const mode = params.mode ?? 'apply';
  const inputCount = params.candidates.length;

  // Skip when too few candidates — pruning ≤16 is a waste of tokens.
  // This branch also handles `inputCount === 0` (caller bug or empty page)
  // which would otherwise issue a wasted LLM call against `CANDIDATES (0)`.
  if (inputCount <= PRUNER_SKIP_THRESHOLD) {
    return {
      prunedCandidates: params.candidates,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      prunerSkipped: true,
      reason: 'too_few',
      inputCount,
      outputCount: inputCount,
      identityRescueCount: 0,
    };
  }

  // V26: skip when too many — Gemini Flash Lite reliably times out on
  // 200+ candidate prompts, so calling at all just adds 7s of dead wall
  // time before we fall open to DOM-order top-60. Better to skip cheaply
  // and let the resolver work on its natural input.
  if (inputCount > PRUNER_UPPER_BOUND) {
    return {
      prunedCandidates: params.candidates,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      prunerSkipped: true,
      reason: 'too_many',
      inputCount,
      outputCount: inputCount,
      identityRescueCount: 0,
    };
  }

  const candidateRefs = params.candidates
    .map(c => c.node.ref)
    .filter((r): r is string => !!r);
  const validRefs = new Set<string>(candidateRefs);

  const cacheKey = buildCacheKey({
    mode,
    pageUrl: params.pageUrl,
    pageSignature: params.pageSignature,
    actionType: params.actionType,
    intentText: params.intentText,
    recordedFingerprint: params.recordedFingerprint,
    priorApplyHints: params.priorApplyHints,
    recordedDescription: params.recordedDescription,
    sceneSummary: params.sceneSummary,
    candidateRefs,
    topK,
  });

  // Cache check
  const cached = prunerCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < PRUNER_CACHE_TTL_MS) {
    const refSet = new Set(cached.refs);
    const pruned = params.candidates.filter(c => c.node.ref && refSet.has(c.node.ref));
    return {
      prunedCandidates: pruned.length > 0 ? pruned : params.candidates,
      cacheHit: true,
      latencyMs: Date.now() - startedAt,
      prunerSkipped: pruned.length === 0,
      reason: pruned.length === 0 ? 'no_grounded_refs' : undefined,
      inputCount,
      outputCount: pruned.length || inputCount,
      identityRescueCount: 0,
    };
  }

  // Singleflight — concurrent identical calls await the same Promise.
  let llmRefsPromise = inFlight.get(cacheKey);
  if (!llmRefsPromise) {
    llmRefsPromise = (async () => {
      const { system, user } = buildPrompt({
        topK,
        intentText: params.intentText,
        actionType: params.actionType,
        recordedFingerprint: params.recordedFingerprint,
        priorApplyHints: params.priorApplyHints,
        recordedDescription: params.recordedDescription,
        sceneSummary: params.sceneSummary,
        candidates: params.candidates,
      });
      const response = await withAILogFields(
        { logActionType: 'prune-step' },
        () => getChatCompletionWithGemini({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          model: AI_TASK_MODELS.disambiguation,
          temperature: 0,
          maxTokens: 200,
          timeout: PRUNER_TIMEOUT_MS,
          jsonMode: true,
        }),
      );
      const validated = parseAndValidateRefs(response.content, validRefs, topK);
      if (validated === null) {
        throw new PrunerError('invalid_json', `LLM returned non-JSON: ${response.content.slice(0, 80)}`);
      }
      return validated;
    })();
    inFlight.set(cacheKey, llmRefsPromise);
  }

  let llmRefs: string[];
  try {
    llmRefs = await llmRefsPromise;
  } catch (err) {
    const reason = err instanceof PrunerError ? err.reason : classifyError(err);
    logger.warn('[CANDIDATE_PRUNER] LLM call failed — falling open', {
      reason,
      error: err instanceof Error ? err.message : String(err),
      inputCount,
      latencyMs: Date.now() - startedAt,
    });
    return {
      prunedCandidates: params.candidates,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      prunerSkipped: true,
      reason,
      inputCount,
      outputCount: inputCount,
      identityRescueCount: 0,
    };
  } finally {
    // Single cleanup site (was duplicated on success/error paths). Critical:
    // if a synchronous throw happens between `await` and the post-await
    // logic (e.g. identity rescue), the entry would otherwise stick in
    // `inFlight` and block subsequent callers waiting on a never-settling
    // Promise. `finally` runs in both code paths.
    inFlight.delete(cacheKey);
  }

  // Identity rescue: force-include any candidate whose fingerprint matches
  // a strong identity field. This guards against an LLM bug where the
  // pruner removes the very element the downstream identity-fast-path
  // would have picked deterministically.
  const identityMatches = findIdentityMatches(params.candidates, params.recordedFingerprint);
  let finalRefs = [...llmRefs];
  let identityRescueCount = 0;
  for (const idRef of identityMatches) {
    if (!finalRefs.includes(idRef)) {
      finalRefs.unshift(idRef); // Place at top — strongest signal
      identityRescueCount++;
    }
  }
  // Cap at topK (rescue takes priority)
  if (finalRefs.length > topK) finalRefs = finalRefs.slice(0, topK);

  // Pad if pruner returned too few — we want at least PRUNER_MIN_OUTPUT
  // so the resolver has a meaningful set to choose from.
  if (finalRefs.length < PRUNER_MIN_OUTPUT) {
    for (const r of candidateRefs) {
      if (finalRefs.length >= PRUNER_MIN_OUTPUT) break;
      if (!finalRefs.includes(r)) finalRefs.push(r);
    }
  }

  // Materialize pruned set, preserving ranked order from LLM
  const refOrder = new Map<string, number>();
  finalRefs.forEach((r, i) => refOrder.set(r, i));
  const prunedCandidates = params.candidates
    .filter(c => c.node.ref && refOrder.has(c.node.ref))
    .sort((a, b) =>
      (refOrder.get(a.node.ref!) ?? 0) - (refOrder.get(b.node.ref!) ?? 0),
    );

  // Cache + return
  evictIfFull();
  prunerCache.set(cacheKey, { refs: finalRefs, createdAt: Date.now() });

  const latencyMs = Date.now() - startedAt;
  logger.info('[CANDIDATE_PRUNER] LLM prune complete', {
    inputCount,
    outputCount: prunedCandidates.length,
    identityRescueCount,
    latencyMs,
    cacheHit: false,
  });

  return {
    prunedCandidates,
    cacheHit: false,
    latencyMs,
    prunerSkipped: false,
    inputCount,
    outputCount: prunedCandidates.length,
    identityRescueCount,
  };
}

/**
 * Invalidate cached pruner outputs that returned a now-rejected ref.
 * Called by the wrong-element guards (preview-step-apply.service.ts) so
 * the next plan build / next run re-asks the LLM with a fresh sample.
 *
 * Implementation: split each cache key on `|`, compare urlHash + intentHash
 * by EXACT segment (not substring) to avoid:
 *   1. False positives where pageUrl happens to appear in pageSignature
 *      or intentHash by accident.
 *   2. Empty pageUrl matching every entry.
 *   3. Special-character interference (URLs with `?` / `&`).
 */
export function invalidatePrunerForRef(args: {
  rejectedRef: string | undefined;
  pageUrl: string;
  intentText: string;
}): number {
  if (!args.rejectedRef) return 0;
  if (!args.pageUrl) return 0; // Defensive — empty URL would match all keys
  const targetUrlHash = hash16(args.pageUrl);
  const targetIntentHash = hash16(args.intentText.slice(0, INTENT_PROMPT_CAP));
  let removed = 0;
  for (const [key, entry] of prunerCache) {
    const segments = key.split('|');
    if (segments[KEY_SEGMENT_INDEX.urlHash] !== targetUrlHash) continue;
    if (segments[KEY_SEGMENT_INDEX.intentHash] !== targetIntentHash) continue;
    if (entry.refs.includes(args.rejectedRef)) {
      prunerCache.delete(key);
      removed++;
    }
  }
  return removed;
}

// ───────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────

class PrunerError extends Error {
  constructor(public reason: PrunerSkipReason, message: string) {
    super(message);
    this.name = 'PrunerError';
  }
}

function classifyError(err: unknown): PrunerSkipReason {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('timeout') || msg.includes('aborted')) return 'timeout';
  if (msg.includes('503') || msg.includes('429') || msg.includes('500')) return 'llm_failed';
  return 'llm_failed';
}

// ───────────────────────────────────────────────────────────────────────
// Test helpers (not exported through index)
// ───────────────────────────────────────────────────────────────────────

/** @internal — for tests only. Resets cache + in-flight between runs. */
export function _resetPrunerCacheForTests(): void {
  prunerCache.clear();
  inFlight.clear();
}

/** @internal — for tests only. */
export function _getPrunerCacheSizeForTests(): number {
  return prunerCache.size;
}
