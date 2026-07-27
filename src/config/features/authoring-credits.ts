import { env } from '@/config/environment/env';
import type { LintResult } from '@/services/testing/ui/preview/preview.types';

/**
 * Feature flags for charging credits on AI-assisted step authoring.
 *
 * Why: element resolution is a 5-stage waterfall (identity → evidence →
 * compiled → LLM → vision). The first three resolve WITHOUT any LLM call and
 * cost nothing; only the LLM/vision stages spend money. Historically the whole
 * editor path — including those paid LLM resolves — deducted 0 credits. This
 * feature charges only when an Apply actually used the LLM, keyed off the
 * `resolverPath` the apply already computes. Lint (fires on nearly every edit)
 * and the background observer are intentionally NOT charged.
 *
 * OFF by default, independent of import's flag.
 */

/** resolverPaths that mean the LLM actually ran (i.e. money was spent). */
const PAID_RESOLVER_PATHS: ReadonlySet<NonNullable<LintResult['resolverPath']>> = new Set([
  'llm',
  'vision',
]);

/**
 * Mobile equivalent of PAID_RESOLVER_PATHS. The mobile editor reports
 * `resolvedVia` (from the runner) rather than the web `resolverPath`, with its
 * own vocabulary — deterministic wins (`compiled` / `exact_label` /
 * `exact_text` / `text_match` / `coordinates` / …) cost nothing, and only these
 * three mean an LLM call was actually made.
 *
 * Deliberately an ALLOW-list, not a deny-list: the runner emits values beyond
 * the documented `resolvedVia` union (`compiled_fast_path`, `cache`,
 * `text_match` are all matched in mobile-step-apply.service.ts but absent from
 * the type), so an unrecognised value must resolve to "don't charge". Billing
 * fails toward not taking the user's money.
 */
const PAID_MOBILE_RESOLVED_VIA: ReadonlySet<string> = new Set([
  'llm',
  'vision',
  'thinking',
]);

export const AuthoringCreditsFeature = {
  /** Deduct credits for AI-assisted applies? */
  isEnabled(): boolean {
    return env.AUTHORING_CREDITS_ENABLED;
  },

  /** Credits charged per AI-assisted Apply (decimal-safe, >= 0). */
  getPerResolve(): number {
    const n = Number.isFinite(env.AUTHORING_CREDITS_PER_RESOLVE) ? env.AUTHORING_CREDITS_PER_RESOLVE : 1;
    return Math.max(0, n);
  },

  /** Did this apply use a paid (LLM/vision) resolution path? */
  isPaidResolverPath(resolverPath: LintResult['resolverPath'] | undefined): boolean {
    return !!resolverPath && PAID_RESOLVER_PATHS.has(resolverPath);
  },

  /** Mobile: did this apply's `resolvedVia` mean an LLM actually ran? */
  isPaidMobileResolvedVia(resolvedVia: string | undefined): boolean {
    return !!resolvedVia && PAID_MOBILE_RESOLVED_VIA.has(resolvedVia);
  },
};
