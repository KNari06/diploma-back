/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BRIEF → PROMPT TEXT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One renderer, four consumers (Cartographer / Strategist / Planner / Sentinel).
 * Each gets the SLICE it can act on — a Planner does not need the glossary, a
 * Sentinel does not need data hints — but they all share the provenance rules
 * below, because four hand-rolled renderers would drift.
 *
 * ── THE UNCERTAINTY RULES (the whole point of BriefField) ──
 *
 * 1. An `unknown` field prints NOTHING. Not "Roles: unknown", not "Roles: []".
 *    An LLM shown "unknown" fills the gap with invention; an LLM shown nothing
 *    simply doesn't reason about it.
 * 2. A low-confidence field is LABELLED, so the model can discount it rather than
 *    treat a guess as a specification.
 * 3. `mustNeverTouch` prints even when inferred, and prints as an imperative. An
 *    over-broad prohibition costs one flow; a missed one sends real email to real
 *    customers.
 */

import type { ProductBrief, BriefField } from './product-brief.types';

/** Renders `value` only when the field is known; `undefined` otherwise. */
function known<T>(f: BriefField<T> | undefined): T | undefined {
  if (!f || f.source === 'unknown') return undefined;
  return f.value;
}

/** `"…"` plus a caveat when the value is a low-confidence guess. */
function withCaveat<T>(f: BriefField<T> | undefined, text: string): string | undefined {
  if (!f || f.source === 'unknown' || !text) return undefined;
  return f.confidence === 'low' ? `${text} (low confidence — verify against the page)` : text;
}

const list = (items: string[], cap: number): string => items.slice(0, cap).join(', ');

/**
 * Cartographer — per-page entry-point discovery.
 *
 * Needs to know what the product IS, what its domain nouns are, and what it must
 * not surface as a testable flow. Replaces the DOM-scraped `productContext`
 * string, which was page furniture (title / meta / h1 / nav) with no reasoning.
 */
export function formatBriefForCartographer(brief: ProductBrief): string | undefined {
  const lines: string[] = [];

  const purpose = withCaveat(brief.purpose, known(brief.purpose) || '');
  if (purpose) lines.push(`PRODUCT: ${purpose}`);

  const type = known(brief.productType);
  if (type && type !== 'other') lines.push(`TYPE: ${type}`);

  const entities = known(brief.entities);
  if (entities?.length) lines.push(`DOMAIN ENTITIES: ${list(entities, 15)}`);

  const roles = known(brief.roles);
  if (roles?.length) lines.push(`USER ROLES: ${list(roles.map((r) => r.name), 8)}`);

  const langs = known(brief.uiLanguages);
  if (langs?.length) {
    lines.push(`UI LANGUAGE: ${list(langs, 5)} — do NOT assume English labels.`);
  }

  const glossary = known(brief.glossary);
  if (glossary?.length) {
    lines.push(`DOMAIN TERMS: ${glossary.slice(0, 8).map((g) => `${g.term} = ${g.meaning}`).join('; ')}`);
  }

  const never = known(brief.mustNeverTouch);
  if (never?.length) {
    lines.push(`DO NOT create entry points for: ${list(never, 10)}`);
  }

  const outOfScope = known(brief.outOfScopePaths);
  if (outOfScope?.length) lines.push(`OUT OF SCOPE PATHS: ${list(outOfScope, 10)}`);

  const errorSurface = known(brief.errorSurfacePattern);
  if (errorSurface) lines.push(`ERRORS APPEAR AS: ${errorSurface}`);

  return lines.length ? lines.join('\n') : undefined;
}

/**
 * Strategist — flow prioritisation.
 *
 * `criticalFlows` is the payload that matters: it replaces the prompt's hardcoded
 * "login, checkout, registration" assumption with THIS product's priorities.
 */
export function formatBriefForStrategist(brief: ProductBrief): string | undefined {
  const lines: string[] = [];

  const purpose = known(brief.purpose);
  if (purpose) lines.push(`PRODUCT: ${purpose}`);

  const type = known(brief.productType);
  if (type && type !== 'other') lines.push(`TYPE: ${type}`);

  const flows = known(brief.criticalFlows);
  if (flows?.length) {
    const rendered = flows
      .map((f) => {
        const signal = f.successSignal ? ` — success: ${f.successSignal}` : '';
        const caveat = f.confidence === 'low' ? ' [low confidence]' : '';
        const stop = f.stopBeforeCommit ? ' [STOP before the final irreversible click]' : '';
        return `  ${f.rank}. ${f.name}${signal}${stop}${caveat}`;
      })
      .join('\n');
    lines.push(`BUSINESS-CRITICAL FLOWS — prioritise these over generic coverage:\n${rendered}`);
  }

  const roles = known(brief.roles);
  if (roles?.length) {
    lines.push(`USER ROLES: ${roles.map((r) => (r.entryHint ? `${r.name} (${r.entryHint})` : r.name)).join(', ')}`);
  }

  const accountRole = known(brief.testAccountRole);
  if (accountRole) {
    lines.push(`THE TEST ACCOUNT IS: ${accountRole} — do not plan flows another role owns.`);
  }

  const surface = known(brief.testedSurface);
  if (surface === 'marketing') {
    lines.push('SURFACE: this origin is the MARKETING site, not the app. Prefer surveying toward the app.');
  }

  const never = known(brief.mustNeverTouch);
  if (never?.length) lines.push(`NEVER PLAN: ${list(never, 10)}`);

  const outOfScope = known(brief.outOfScopePaths);
  if (outOfScope?.length) lines.push(`SKIP THESE AREAS: ${list(outOfScope, 10)}`);

  const blockers = known(brief.knownBlockers);
  if (blockers?.length) lines.push(`KNOWN AUTOMATION BLOCKERS: ${list(blockers, 6)}`);

  const rateLimits = known(brief.rateLimitWarnings);
  if (rateLimits?.length) lines.push(`RATE LIMITS: ${list(rateLimits, 4)}`);

  const signup = known(brief.selfSignupAvailable);
  if (signup === false) {
    lines.push('SELF-SIGNUP IS NOT AVAILABLE — a registration flow is a dead end here.');
  }

  return lines.length ? lines.join('\n') : undefined;
}

/**
 * Per-flow Planner — the agent that writes the actual steps.
 *
 * Kept SHORT: this is merged into `pageInsightContext`, which is length-capped and
 * shares the Planner's prompt with page state. Only what changes the next action.
 */
export function formatBriefForPlanner(brief: ProductBrief, flowName?: string): string | undefined {
  const lines: string[] = [];

  const type = known(brief.productType);
  const purpose = known(brief.purpose);
  if (purpose) {
    // One sentence only — the Planner needs orientation, not a briefing.
    const firstSentence = purpose.split(/(?<=[.!?])\s/)[0] || purpose;
    lines.push(`Product: ${firstSentence.slice(0, 200)}${type && type !== 'other' ? ` (${type})` : ''}`);
  }

  // The matching critical flow's success signal is the single most useful thing a
  // Planner can be told: it turns "click around" into "reach THIS observable state".
  const flows = known(brief.criticalFlows) || [];
  const match = flowName
    ? flows.find((f) => f.name.toLowerCase().includes(flowName.toLowerCase())
        || flowName.toLowerCase().includes(f.name.toLowerCase()))
    : undefined;
  if (match?.successSignal) {
    lines.push(`Success for this flow: ${match.successSignal}`);
  }
  if (match?.stopBeforeCommit) {
    lines.push('STOP before the final irreversible click (do not complete the purchase/booking/publish).');
  }

  const hints = known(brief.dataHints);
  if (hints) lines.push(`Data hints: ${hints.slice(0, 400)}`);

  const prereqs = known(brief.dataPrerequisites);
  if (prereqs?.length) lines.push(`Precondition: ${list(prereqs, 3)}`);

  const region = known(brief.region);
  if (region) lines.push(`Region/format: ${region}`);

  const never = known(brief.mustNeverTouch);
  if (never?.length) lines.push(`NEVER: ${list(never, 6)}`);

  const errorSurface = known(brief.errorSurfacePattern);
  if (errorSurface) lines.push(`Errors show as: ${errorSurface}`);

  return lines.length ? lines.join('\n') : undefined;
}

/**
 * Sentinel — coverage evaluation.
 *
 * Lets coverage be scored against what MATTERS rather than against the raw count
 * of discovered entry points. `openQuestions` is included so a gap caused by an
 * unknown brief field is reported as "we lacked information", not as a product
 * defect.
 */
export function formatBriefForSentinel(brief: ProductBrief): string | undefined {
  const lines: string[] = [];

  const purpose = known(brief.purpose);
  if (purpose) lines.push(`PRODUCT: ${purpose}`);

  const flows = known(brief.criticalFlows);
  if (flows?.length) {
    lines.push(
      `BUSINESS-CRITICAL FLOWS (score coverage against THESE, not against the raw entry-point count):\n${
        flows.map((f) => `  ${f.rank}. ${f.name}`).join('\n')
      }`,
    );
  }

  const roles = known(brief.roles);
  if (roles?.length) {
    lines.push(`USER ROLES: ${list(roles.map((r) => r.name), 8)} — untested roles are real gaps.`);
  }

  const risk = known(brief.riskProfile);
  if (risk && risk !== 'standard') {
    lines.push(`RISK PROFILE: ${risk} — hold this product to a higher bar.`);
  }

  if (brief.openQuestions.length) {
    lines.push(
      `UNKNOWN AT DISCOVERY TIME (a gap caused by one of these is a MISSING-INFORMATION gap, not a product defect):\n  ${
        brief.openQuestions.slice(0, 6).join('; ')
      }`,
    );
  }

  // Only meaningful ALONGSIDE content. On an all-unknown brief this would be the
  // sole line — a caveat about nothing, which still costs tokens and still tells
  // the model a brief exists when effectively none does.
  if (lines.length > 0 && brief.overallConfidence === 'low') {
    lines.push('NOTE: this brief is low-confidence overall; weight your own observations above it.');
  }

  return lines.length ? lines.join('\n') : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// HUMAN VIEW — what the USER sees, not what an agent reads
// ═══════════════════════════════════════════════════════════════════════════

/** One field as shown to a person: the value plus how much to trust it. */
export interface BriefViewField {
  label: string;
  value: string;
  /** 'observed' | 'inferred' | 'user' — where the value came from. */
  source: string;
  confidence: string;
}

/**
 * The brief, rendered for a READER rather than a prompt.
 *
 * Structured, not a formatted string: the client renders it, and a UI that has
 * to parse prose breaks the moment the wording changes. Deliberately a SUBSET —
 * the brief has ~20 fields and a wall of them is not reviewable. These are the
 * ones that change what the agents do, so a wrong value here is a wrong run.
 *
 * `source` and `confidence` ride along on every field because they are the
 * whole point of showing this: "checkout is critical (inferred, low)" tells the
 * reader where to look, while a bare list of facts does not.
 */
export interface ProductBriefView {
  originUrl: string;
  overallConfidence: string;
  /** Present only when the brief came from the store rather than a fresh derive. */
  reusedFrom?: string;
  fields: BriefViewField[];
  criticalFlows: Array<{ name: string; rank: number; source: string; stopBeforeCommit?: boolean }>;
  openQuestions: string[];
  /** Questions the user was asked this run, and whether they answered. */
  askLog: Array<{ key: string; answered: boolean }>;
}

/**
 * Build the human-facing view.
 *
 * `unknown` fields are omitted rather than rendered as "unknown" — same rule the
 * prompt renderers follow (invariant #26). A reader scanning for what the agent
 * got WRONG is not helped by ten rows saying it knows nothing.
 */
export function buildProductBriefView(
  brief: ProductBrief,
  reusedFrom?: string,
): ProductBriefView {
  const fields: BriefViewField[] = [];

  const add = (label: string, field: { value: unknown; source: string; confidence: string } | undefined) => {
    if (!field || field.source === 'unknown') return;
    const value = Array.isArray(field.value)
      ? field.value.map((v) => (typeof v === 'string' ? v : (v as { name?: string })?.name ?? '')).filter(Boolean).join(', ')
      : String(field.value ?? '');
    if (!value || value === 'unknown') return;
    fields.push({ label, value, source: field.source, confidence: field.confidence });
  };

  add('What it is', brief.purpose);
  add('Product type', brief.productType);
  add('Environment', brief.environmentKind);
  add('Payments', brief.paymentPolicy);
  add('User roles', brief.roles);
  add('Test account role', brief.testAccountRole);
  add('Domain entities', brief.entities);
  add('UI languages', brief.uiLanguages);
  add('Never touch', brief.mustNeverTouch);

  return {
    originUrl: brief.originUrl,
    overallConfidence: brief.overallConfidence,
    reusedFrom,
    fields,
    criticalFlows: (brief.criticalFlows?.value ?? []).map((f) => ({
      name: f.name,
      rank: f.rank,
      source: f.source,
      stopBeforeCommit: f.stopBeforeCommit,
    })),
    openQuestions: brief.openQuestions ?? [],
    askLog: brief.askLog ?? [],
  };
}
