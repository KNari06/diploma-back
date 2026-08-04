/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRODUCT BRIEF — what the app is FOR, so exploration can test what matters
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The durable Phase 0 artifact. Exploration's agents previously had no product
 * understanding at all: the only channel was `scopeHint`, one optional string
 * that never even reached the per-flow Planner, and the thing called "product
 * context" was a DOM scrape (title / meta / h1 / nav / CTA regex) with no LLM
 * reasoning. So every flow came out `priority:'medium'`, test names were
 * mechanical ("Contact Form Submission" rather than "New lead can reach sales"),
 * and Sentinel scored coverage against *discovered entry points* instead of
 * business need.
 *
 * ── SAFETY BY CONSTRUCTION ──
 * Carries NO credentials, NO card data, NO tokens. `normalizeProductBrief` is a
 * WHITELIST that rebuilds the object key by key, so an extra key on untrusted
 * input is DROPPED rather than filtered — the blob cannot become a
 * plaintext-credential sink. Modelled on `normalizeMobileBriefing`
 * ([mobile-briefing.util.ts](../../../../../services/mobile/mobile-briefing.util.ts)),
 * which exists for exactly this reason.
 *
 * Test credentials ride `ExplorationConfig.credentials` / `authFixture`; on-page
 * demo credentials ride Cartographer's `authDetection.testCredentials`. Never here.
 * `paymentPolicy` carries the POLICY only — never a card number.
 *
 * ── UNCERTAINTY IS FIRST-CLASS ──
 * Every non-trivial field is a `BriefField<T>` with `source` + `confidence`, and
 * `source:'unknown'` means NO value. Downstream prompts must print nothing for an
 * unknown field rather than "Roles: unknown" — an LLM shown "unknown" invents,
 * an LLM shown nothing doesn't.
 */

/** Where a field's value came from. Downstream MUST NOT treat 'inferred' as fact. */
export type BriefFieldSource = 'observed' | 'inferred' | 'user' | 'unknown';

/** Deliberately 3-valued — a float would imply precision we do not have. */
export type BriefConfidence = 'high' | 'medium' | 'low';

/**
 * A single brief field plus its provenance.
 *
 * `basis` is not decoration: the normalizer DOWNGRADES any field claiming
 * `observed`/`inferred` without one to `confidence:'low'`, so a hallucinated value
 * cannot present itself as evidence-backed ("evidence or it didn't happen").
 */
export interface BriefField<T> {
  value: T;
  source: BriefFieldSource;
  confidence: BriefConfidence;
  /** ≤200 chars. What evidence produced this — shown in the UI review card. */
  basis?: string;
}

export type ProductType =
  | 'ecommerce'
  | 'saas_dashboard'
  | 'marketplace'
  | 'fintech'
  | 'content_media'
  | 'booking'
  | 'internal_admin'
  | 'other';

export type EnvironmentKind = 'production' | 'staging' | 'sandbox' | 'demo' | 'unknown';

/**
 * Payment / irreversible-action policy.
 *
 * FAIL-CLOSED: absent an explicit `source:'user'` grant this is `'never'`. Low
 * confidence must make the agent MORE conservative, not more creative — an
 * over-broad prohibition costs a flow, a missed one places a real order.
 */
export type PaymentPolicy =
  /** Do not click pay, ever. The default whenever the environment is unproven. */
  | 'never'
  /** Fill everything, stop at the final irreversible confirm. */
  | 'stop_before_commit'
  /** Explicit user grant, non-production only. */
  | 'allowed_sandbox';

/** A flow the business actually cares about. Drives Strategist ordering. */
export interface BriefCriticalFlow {
  /** ≤120 chars, e.g. "Guest checkout with one item". */
  name: string;
  /** ≤240 chars. What "done" means in OBSERVABLE terms — feeds Planner + Reviewer. */
  successSignal?: string;
  /** 1 = most critical. */
  rank: number;
  /** Stop at the final irreversible click instead of skipping the flow entirely. */
  stopBeforeCommit?: boolean;
  source: BriefFieldSource;
  confidence: BriefConfidence;
}

/** A distinct user role. A role nobody knows about is a whole untested app. */
export interface BriefRole {
  /** ≤60 chars, e.g. "seller", "workspace admin", "guest". */
  name: string;
  /** How this role gets in — a URL or label, NEVER a credential. */
  entryHint?: string;
  source: BriefFieldSource;
}

/** A domain term and what it means in this product. */
export interface BriefGlossaryEntry {
  /** ≤60 chars. */
  term: string;
  /** ≤160 chars. */
  meaning: string;
}

/** One question the analyst asked, and whether the user engaged. */
export interface BriefAskLogEntry {
  /** Field key the question targeted, e.g. 'environmentKind'. */
  key: string;
  answered: boolean;
}

export interface ProductBrief {
  readonly schemaVersion: 1;

  // ── Provenance ──────────────────────────────────────────────────────
  /** Origin this brief describes. Reuse across runs keys on this + projectId. */
  originUrl: string;
  /** ISO timestamp. */
  generatedAt: string;
  /** Which fetches actually succeeded — makes every "unknown" auditable. */
  evidenceSources: string[];
  /** Questions asked (cap 3 by product decision) and whether each was answered. */
  askLog?: BriefAskLogEntry[];

  // ── Identity & purpose ──────────────────────────────────────────────
  /** ≤2000 chars. → Cartographer's productContext. */
  purpose: BriefField<string>;
  /** Gates the type-specific priors (see the analyst's branching). */
  productType: BriefField<ProductType>;
  /**
   * Which surface is under test. Exploring a marketing site and reporting 80%
   * coverage while the app was never entered is a real false-coverage mode.
   */
  testedSurface: BriefField<'marketing' | 'app' | 'both'>;
  /** Gates `paymentPolicy` and destructive-flow permission. */
  environmentKind: BriefField<EnvironmentKind>;

  // ── Users & roles ───────────────────────────────────────────────────
  /** cap 8. → Strategist per-role allocation; Sentinel per-role gaps. */
  roles: BriefField<BriefRole[]>;
  /** ≤60 chars. Which role the supplied test account holds. */
  testAccountRole: BriefField<string>;
  /** Is "Registration" a real entry point or a guaranteed dead end? */
  selfSignupAvailable: BriefField<boolean>;

  // ── Critical paths & success ────────────────────────────────────────
  /**
   * cap 6. THE highest-value field — it replaces the hardcoded English
   * e-commerce heuristic in the Strategist prompt ("login, checkout,
   * registration") with this product's actual priorities.
   */
  criticalFlows: BriefField<BriefCriticalFlow[]>;

  // ── Money ───────────────────────────────────────────────────────────
  /** Defaults to 'never' whenever the environment is not confidently non-prod. */
  paymentPolicy: BriefField<PaymentPolicy>;
  /** ≤60 chars, provider NAME only ('stripe'). → Planner: expect an iframe. */
  paymentProvider?: BriefField<string>;
  /** ≤120 chars: 'subscription' | 'one_off' | 'quote' | 'ad_supported' | 'none'. */
  conversionModel: BriefField<string>;

  // ── Data model ──────────────────────────────────────────────────────
  /** cap 20 × 60 chars. → Cartographer dataEntities; Sentinel "what exists". */
  entities: BriefField<string[]>;
  /** cap 10 × 200 chars, e.g. "dashboard is empty until a project is created". */
  dataPrerequisites: BriefField<string[]>;
  /**
   * ≤2000 chars. Field formats + known-good seed values. "Search for `test`"
   * returning 0 results is the most common false failure in exploration.
   */
  dataHints: BriefField<string>;

  // ── Language, locale, vocabulary ────────────────────────────────────
  /**
   * cap 5 × 12 chars, BCP-47. Load-bearing: `auth-url-patterns` is English-only
   * by design and the CTA regex is English-only, so an agent told "the UI is
   * Kazakh" stops expecting "Sign in".
   */
  uiLanguages: BriefField<string[]>;
  /** ≤120 chars. Currency / date / phone / address conventions. */
  region: BriefField<string>;
  /** cap 15. Domain jargon → meaning. */
  glossary: BriefField<BriefGlossaryEntry[]>;
  /** 'standard' | 'regulated' | 'high_consequence'. Tightens mustNeverTouch. */
  riskProfile: BriefField<string>;

  // ── Risk, prohibitions, constraints ─────────────────────────────────
  /**
   * cap 20 × 200 chars. HARD prohibitions — the highest-consequence field.
   * Enforced even when `source:'inferred'`: an over-broad ban costs a flow, a
   * missed one emails 400 real customers.
   */
  mustNeverTouch: BriefField<string[]>;
  /** cap 20 × 200 chars. URL prefixes out of scope (blog/careers/docs). */
  outOfScopePaths: BriefField<string[]>;
  /** cap 10 × 160 chars, e.g. 'recaptcha on /login', '3DS iframe at checkout'. */
  knownBlockers: BriefField<string[]>;
  /** cap 10 × 160 chars. Rate limits / lockouts a crawl would trip. */
  rateLimitWarnings: BriefField<string[]>;

  // ── Observability of verdicts ───────────────────────────────────────
  /** ≤240 chars, e.g. 'inline field errors + top-right toast'. */
  errorSurfacePattern: BriefField<string>;

  // ── Self-assessment ─────────────────────────────────────────────────
  /** Overall usability. 'low' ⇒ the UI nudges the user to edit. */
  overallConfidence: BriefConfidence;
  /**
   * cap 6 × 160 chars. Field keys whose ignorance costs the most, ranked. Drives
   * the UI's "fix these first" list, tells Sentinel that a gap traceable to an
   * unknown field is NOT a product defect, and seeds the next run's questions.
   * Explicit ignorance, ranked.
   */
  openQuestions: string[];
}
