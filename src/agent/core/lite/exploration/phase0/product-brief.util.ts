/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRODUCT BRIEF — normalizer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Turns untrusted input (an LLM response, a user edit, a persisted blob) into a
 * safe `ProductBrief`. Pure and defensive: never throws, safe on any shape.
 *
 * WHITELIST BY CONSTRUCTION — the returned object is rebuilt key by key, so an
 * extra key on the input is DROPPED rather than filtered. That is what makes it
 * impossible for this blob to become a plaintext-credential sink, and it is the
 * same discipline `normalizeMobileBriefing` uses
 * ([mobile-briefing.util.ts](../../../../../services/mobile/mobile-briefing.util.ts)).
 *
 * Three rules are enforced HERE rather than trusted to a prompt:
 *
 *   1. **Fail-closed safety.** `paymentPolicy` falls back to `'never'`, and
 *      `stopBeforeCommit` is forced on any critical flow that isn't explicitly
 *      user-granted. Low confidence must make the agent more conservative, not
 *      more creative.
 *   2. **Evidence or it didn't happen.** A field claiming `observed`/`inferred`
 *      with no `basis` is DOWNGRADED to `confidence:'low'`, so a hallucination
 *      cannot present itself as evidence-backed.
 *   3. **Unknown beats a guess.** A malformed `BriefField` wrapper degrades to
 *      `{source:'unknown', confidence:'low'}` with an empty value — never to a
 *      bare value that reads as fact.
 */

import { logger } from '@/utils/core/logger';
import { redactCredentialValues, type RedactableCredentials } from '@/utils/interpolation/redact-secrets';
import type {
  ProductBrief,
  BriefField,
  BriefFieldSource,
  BriefConfidence,
  BriefRole,
  BriefCriticalFlow,
  BriefGlossaryEntry,
  BriefAskLogEntry,
  ProductType,
  EnvironmentKind,
  PaymentPolicy,
} from './product-brief.types';

// ── Caps. Mirrors the field docs; single place to tune. ───────────────────
const CAP = {
  purpose: 2000,
  dataHints: 2000,
  shortText: 120,
  mediumText: 200,
  longText: 240,
  name: 60,
  glossaryMeaning: 160,
  basis: 200,
  roles: 8,
  criticalFlows: 6,
  entities: 20,
  dataPrerequisites: 10,
  uiLanguages: 5,
  langTag: 12,
  glossary: 15,
  mustNeverTouch: 20,
  outOfScopePaths: 20,
  knownBlockers: 10,
  rateLimitWarnings: 10,
  openQuestions: 6,
  evidenceSources: 12,
  /** Product decision: the analyst may ask at most 3 questions. */
  askLog: 3,
} as const;

const SOURCES: readonly BriefFieldSource[] = ['observed', 'inferred', 'user', 'unknown'];
const CONFIDENCES: readonly BriefConfidence[] = ['high', 'medium', 'low'];
const PRODUCT_TYPES: readonly ProductType[] = [
  'ecommerce', 'saas_dashboard', 'marketplace', 'fintech',
  'content_media', 'booking', 'internal_admin', 'other',
];
const ENVIRONMENTS: readonly EnvironmentKind[] = ['production', 'staging', 'sandbox', 'demo', 'unknown'];
const PAYMENT_POLICIES: readonly PaymentPolicy[] = ['never', 'stop_before_commit', 'allowed_sandbox'];
const SURFACES = ['marketing', 'app', 'both'] as const;

// ── Primitives ───────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown, cap: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : undefined;

const strArr = (v: unknown, cap: number, itemCap: number): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim().slice(0, itemCap))
    .slice(0, cap);
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

// ── BriefField ───────────────────────────────────────────────────────────

/**
 * Rebuild a `BriefField<T>`.
 *
 * `parseValue` returns `undefined` when the payload can't yield a usable value —
 * that collapses the whole field to `unknown`, which downstream prompts print as
 * nothing at all.
 */
function field<T>(
  raw: unknown,
  parseValue: (v: unknown) => T | undefined,
  emptyValue: T,
): BriefField<T> {
  if (!isObj(raw)) {
    return { value: emptyValue, source: 'unknown', confidence: 'low' };
  }

  const parsed = parseValue(raw.value);
  if (parsed === undefined) {
    return { value: emptyValue, source: 'unknown', confidence: 'low' };
  }

  const source = oneOf(raw.source, SOURCES, 'inferred');
  const basis = str(raw.basis, CAP.basis);
  let confidence = oneOf(raw.confidence, CONFIDENCES, 'low');

  // Rule 2 — evidence or it didn't happen. A claim of observation with nothing
  // to point at is not high-confidence, whatever the model asserted.
  if ((source === 'observed' || source === 'inferred') && !basis) {
    confidence = 'low';
  }

  return { value: parsed, source, confidence, ...(basis ? { basis } : {}) };
}

/** A field whose value is a non-empty array; an empty array collapses to unknown. */
function arrayField<T>(
  raw: unknown,
  parseItems: (v: unknown) => T[],
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): BriefField<T[]> {
  return field<T[]>(
    raw,
    (v) => {
      const items = parseItems(v);
      return items.length > 0 || allowEmpty ? items : undefined;
    },
    [],
  );
}

// ── Composite item parsers ───────────────────────────────────────────────

function parseRoles(v: unknown): BriefRole[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .map((r): BriefRole | undefined => {
      const name = str(r.name, CAP.name);
      if (!name) return undefined;
      const entryHint = str(r.entryHint, CAP.mediumText);
      return {
        name,
        ...(entryHint ? { entryHint } : {}),
        source: oneOf(r.source, SOURCES, 'inferred'),
      };
    })
    .filter((r): r is BriefRole => !!r)
    .slice(0, CAP.roles);
}

/**
 * Parse critical flows.
 *
 * Rule 1 — fail-closed: `stopBeforeCommit` is TRUE unless the flow is explicitly
 * `source:'user'`. An agent-inferred flow gets the conservative treatment, so an
 * irreversible action is never attempted on a guess.
 */
function parseCriticalFlows(v: unknown): BriefCriticalFlow[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .map((f, i): BriefCriticalFlow | undefined => {
      const name = str(f.name, CAP.shortText);
      if (!name) return undefined;
      const source = oneOf(f.source, SOURCES, 'inferred');
      const successSignal = str(f.successSignal, CAP.longText);
      const rank = typeof f.rank === 'number' && Number.isFinite(f.rank) && f.rank > 0
        ? Math.floor(f.rank)
        : i + 1;
      const userGranted = source === 'user' && f.stopBeforeCommit === false;
      return {
        name,
        ...(successSignal ? { successSignal } : {}),
        rank,
        stopBeforeCommit: !userGranted,
        source,
        confidence: oneOf(f.confidence, CONFIDENCES, 'low'),
      };
    })
    .filter((f): f is BriefCriticalFlow => !!f)
    .slice(0, CAP.criticalFlows)
    .sort((a, b) => a.rank - b.rank);
}

function parseGlossary(v: unknown): BriefGlossaryEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .map((g): BriefGlossaryEntry | undefined => {
      const term = str(g.term, CAP.name);
      const meaning = str(g.meaning, CAP.glossaryMeaning);
      return term && meaning ? { term, meaning } : undefined;
    })
    .filter((g): g is BriefGlossaryEntry => !!g)
    .slice(0, CAP.glossary);
}

function parseAskLog(v: unknown): BriefAskLogEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .map((a): BriefAskLogEntry | undefined => {
      const key = str(a.key, CAP.name);
      return key ? { key, answered: a.answered === true } : undefined;
    })
    .filter((a): a is BriefAskLogEntry => !!a)
    .slice(0, CAP.askLog);
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Normalize untrusted input into a safe `ProductBrief`.
 *
 * Always returns a brief — an all-`unknown` one is strictly better than
 * `undefined`, because downstream code then has ONE path and the UI can still
 * render the review card. (Mirrors `parseCartographerResponse`, which returns an
 * empty object rather than null on a parse failure.)
 *
 * @param credentials When supplied, every free-text field gets a belt-and-braces
 *   credential redaction: the analyst reads `/docs` pages, which frequently print
 *   demo credentials verbatim, and this text is LLM-facing (folder invariant #3).
 */
export function normalizeProductBrief(
  raw: unknown,
  originUrl: string,
  credentials?: RedactableCredentials,
): ProductBrief {
  try {
    return buildBrief(raw, originUrl, credentials);
  } catch (error) {
    // "Never throws" is a contract, not an aspiration. Property ACCESS itself can
    // throw — a getter on a rehydrated blob, or a Proxy — and this function sits
    // between untrusted input and four agent prompts. An all-unknown brief is the
    // documented degraded outcome, so degrade rather than take down the run.
    logger.warn('[PRODUCT_BRIEF] Normalization threw; returning an empty brief', {
      originUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyBrief(originUrl);
  }
}

/**
 * All-`unknown` brief — the documented degraded value. Built from a literal `{}`
 * so it cannot re-enter the failing path that sent us here.
 */
function emptyBrief(originUrl: string): ProductBrief {
  return buildBrief({}, originUrl);
}

function buildBrief(
  raw: unknown,
  originUrl: string,
  credentials?: RedactableCredentials,
): ProductBrief {
  const r = isObj(raw) ? raw : {};
  const redact = (s: string): string => (credentials ? redactCredentialValues(s, credentials) : s);

  const purpose = field<string>(r.purpose, (v) => {
    const s = str(v, CAP.purpose);
    return s ? redact(s) : undefined;
  }, '');

  const dataHints = field<string>(r.dataHints, (v) => {
    const s = str(v, CAP.dataHints);
    return s ? redact(s) : undefined;
  }, '');

  const glossary = arrayField<BriefGlossaryEntry>(r.glossary, (v) =>
    parseGlossary(v).map((g) => ({ term: g.term, meaning: redact(g.meaning) })));

  // Rule 1 — fail-closed. Anything other than an explicit, recognised policy
  // becomes 'never'; a missing/garbled value must not authorise a real payment.
  const paymentPolicy = field<PaymentPolicy>(
    r.paymentPolicy,
    (v) => oneOf(v, PAYMENT_POLICIES, 'never'),
    'never',
  );
  if (paymentPolicy.source === 'unknown') {
    paymentPolicy.value = 'never';
  }
  // Only a HUMAN can authorise completing a real payment. The analyst prompt says
  // so, but a prompt is not a guard — an LLM that answers 'allowed_sandbox'
  // because a hostname "looked like staging" would otherwise place real orders.
  // Downgrade to the strictest policy that still lets the flow be explored.
  if (paymentPolicy.value === 'allowed_sandbox' && paymentPolicy.source !== 'user') {
    logger.warn('[PRODUCT_BRIEF] Refusing a non-user allowed_sandbox payment grant', {
      source: paymentPolicy.source,
    });
    paymentPolicy.value = 'stop_before_commit';
    paymentPolicy.confidence = 'low';
  }

  const brief: ProductBrief = {
    schemaVersion: 1,

    originUrl,
    generatedAt: str(r.generatedAt, CAP.shortText) || new Date().toISOString(),
    evidenceSources: strArr(r.evidenceSources, CAP.evidenceSources, CAP.mediumText),
    ...(parseAskLog(r.askLog).length ? { askLog: parseAskLog(r.askLog) } : {}),

    purpose,
    productType: field<ProductType>(r.productType, (v) => oneOf(v, PRODUCT_TYPES, 'other'), 'other'),
    testedSurface: field<'marketing' | 'app' | 'both'>(
      r.testedSurface,
      (v) => oneOf(v, SURFACES, 'both'),
      'both',
    ),
    environmentKind: field<EnvironmentKind>(
      r.environmentKind,
      (v) => oneOf(v, ENVIRONMENTS, 'unknown'),
      'unknown',
    ),

    roles: arrayField<BriefRole>(r.roles, parseRoles),
    testAccountRole: field<string>(r.testAccountRole, (v) => str(v, CAP.name), ''),
    selfSignupAvailable: field<boolean>(
      r.selfSignupAvailable,
      (v) => (typeof v === 'boolean' ? v : undefined),
      false,
    ),

    criticalFlows: arrayField<BriefCriticalFlow>(r.criticalFlows, parseCriticalFlows),

    paymentPolicy,
    ...(isObj(r.paymentProvider)
      ? { paymentProvider: field<string>(r.paymentProvider, (v) => str(v, CAP.name), '') }
      : {}),
    conversionModel: field<string>(r.conversionModel, (v) => str(v, CAP.shortText), ''),

    entities: arrayField<string>(r.entities, (v) => strArr(v, CAP.entities, CAP.name)),
    dataPrerequisites: arrayField<string>(r.dataPrerequisites, (v) =>
      strArr(v, CAP.dataPrerequisites, CAP.mediumText).map(redact)),
    dataHints,

    uiLanguages: arrayField<string>(r.uiLanguages, (v) => strArr(v, CAP.uiLanguages, CAP.langTag)),
    region: field<string>(r.region, (v) => str(v, CAP.shortText), ''),
    glossary,
    riskProfile: field<string>(r.riskProfile, (v) => str(v, CAP.name), 'standard'),

    mustNeverTouch: arrayField<string>(r.mustNeverTouch, (v) =>
      strArr(v, CAP.mustNeverTouch, CAP.mediumText).map(redact)),
    outOfScopePaths: arrayField<string>(r.outOfScopePaths, (v) =>
      strArr(v, CAP.outOfScopePaths, CAP.mediumText)),
    knownBlockers: arrayField<string>(r.knownBlockers, (v) =>
      strArr(v, CAP.knownBlockers, CAP.glossaryMeaning)),
    rateLimitWarnings: arrayField<string>(r.rateLimitWarnings, (v) =>
      strArr(v, CAP.rateLimitWarnings, CAP.glossaryMeaning)),

    errorSurfacePattern: field<string>(r.errorSurfacePattern, (v) => str(v, CAP.longText), ''),

    overallConfidence: oneOf(r.overallConfidence, CONFIDENCES, 'low'),
    openQuestions: strArr(r.openQuestions, CAP.openQuestions, CAP.glossaryMeaning),
  };

  return brief;
}

/**
 * Is this brief worth threading into the agents at all?
 *
 * An all-`unknown` brief is a valid object (see above) but carries no signal, and
 * feeding it to four prompts would cost tokens for nothing. `purpose` and
 * `criticalFlows` are the two fields every consumer reads.
 */
export function briefHasSignal(brief: ProductBrief | undefined): boolean {
  if (!brief) return false;
  return (
    brief.purpose.source !== 'unknown' ||
    brief.criticalFlows.source !== 'unknown' ||
    brief.entities.source !== 'unknown' ||
    brief.productType.source !== 'unknown'
  );
}
