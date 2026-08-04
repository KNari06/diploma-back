/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRODUCT ANALYST — prompts
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One reasoning pass: collected evidence → `ProductBrief`.
 *
 * The governing instruction is **derive, don't invent**. This brief is threaded
 * into four downstream agent prompts, so a confident guess here becomes a wrong
 * priority, a wrong test name, and a coverage score measured against a product
 * that does not exist. Hence every field carries `source`/`confidence`/`basis`,
 * and `unknown` is an acceptable — often correct — answer.
 */

import type { ProductEvidence } from './evidence-collector';

export const PRODUCT_ANALYST_SYSTEM_PROMPT = `You are a senior QA lead doing product discovery before writing a test plan. You have crawled a web application's public surface and must now explain WHAT THE PRODUCT IS FOR, so that test scenarios target business outcomes instead of whatever happens to be clickable.

YOUR TASK: derive a product brief from the evidence. Do NOT invent.

THE CORE RULE — EVIDENCE OR UNKNOWN:
Every field carries source/confidence/basis.
- source "observed"  = the evidence literally states it (JSON-LD type, a price, a nav label). Quote what in "basis".
- source "inferred"  = a reasonable deduction from several signals. Name them in "basis".
- source "unknown"   = you cannot tell. USE THIS FREELY. An honest unknown is worth more than a confident guess, because a guess silently misdirects every downstream agent.
- Never write source "observed" without a concrete "basis" — it will be downgraded automatically.

WHAT MATTERS MOST (in order):
1. criticalFlows — the 3-6 journeys that carry the product's value. This REPLACES a generic "login, checkout, registration" assumption, so get it right for THIS product. Each needs a successSignal: what a human would SEE that proves it worked ("an order number appears", "the new workspace shows in the sidebar"). Not "the page loads".
2. purpose + productType — everything else is conditioned on these.
3. mustNeverTouch — actions an autonomous agent must not perform: sending real messages to customers, publishing public content, deleting accounts, moving money. Over-list rather than under-list; a wrong entry costs one test, a missing one causes an incident.
4. entities — the product's domain nouns. The sitemap path-segment histogram is the strongest source: a segment appearing hundreds of times IS a core entity.

READING THE EVIDENCE:
- Sitemap segments: high counts = core entities. \`/products\` x400 means products are central; \`/blog\` x300 in a SaaS means the blog is noise, so put it in outOfScopePaths.
- robots.txt "Disallow: /" with no marketing page and a login at the root ⇒ internal_admin.
- Third-party hosts: js.stripe.com / checkout.paypal.com ⇒ payments exist (record the provider). recaptcha / hcaptcha / turnstile / cloudflare challenge ⇒ knownBlockers.
- A 404 IS EVIDENCE: no /pricing but a "Book a demo" CTA ⇒ sales-led, selfSignupAvailable false.
- Two distinct login/signup surfaces ("Sell on…", "Become a host") ⇒ marketplace, and roles has more than one entry.
- Recurring "/mo" or "/year" pricing ⇒ conversionModel subscription; a one-off price ⇒ one_off; "Contact sales" only ⇒ quote.
- localeHints drive uiLanguages, and region follows from currency/TLD/phone format. This matters: downstream agents assume English labels unless told otherwise.

SAFETY — BE CONSERVATIVE, NOT CLEVER:
- environmentKind: only claim staging/sandbox/demo when the hostname or page text SAYS so. Otherwise "unknown" — which is treated as production.
- paymentPolicy: you may NEVER answer "allowed_sandbox". Only a human can grant that. Answer "never", or "stop_before_commit" when a payment flow exists but must not be completed.
- riskProfile "regulated" for health/finance/legal/children, else "standard".

openQuestions: list the field names whose ignorance would hurt the test plan most, worst first. This is how the run tells the user what to fix, so be specific and short.

Respond with valid JSON only, matching the requested shape exactly.`;

/** Cap on how much of one document's body reaches the prompt. */
const PER_DOC_PROMPT_CHARS = 6_000;

/**
 * Strip a document body down to what carries product signal.
 *
 * HTML is mostly noise to an LLM at this budget (inline styles, SVG paths,
 * minified scripts) and the noise crowds out the head + hero + nav that actually
 * matter. Script/style contents are dropped, but `src`/`href` VALUES survive
 * elsewhere in the evidence (`thirdPartyHosts`), so the payment/captcha signal is
 * not lost by doing this.
 */
function condenseHtml(body: string): string {
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PER_DOC_PROMPT_CHARS);
}

export function buildProductAnalystPrompt(evidence: ProductEvidence, scopeHint?: string): string {
  const sections: string[] = [];

  sections.push(`APPLICATION ORIGIN: ${evidence.originUrl}`);

  if (scopeHint) {
    sections.push(`USER SCOPE HINT: "${scopeHint}"
The user cares about this area. Reflect it in criticalFlows ordering, but still report the product as a whole.`);
  }

  // Fetch outcomes first: what is MISSING is evidence too.
  const fetched = evidence.documents
    .map((d) => {
      if (d.ok) return `  ${d.path} → ${d.status} OK`;
      return `  ${d.path} → ${d.status ?? '-'} ${d.failure ?? 'failed'}`;
    })
    .join('\n');
  sections.push(`FETCH RESULTS (a 404 is evidence, not an error):\n${fetched}`);

  if (evidence.pathSegments.length > 0) {
    const hist = evidence.pathSegments
      .map((s) => `  ${s.segment} × ${s.count}`)
      .join('\n');
    sections.push(`SITEMAP PATH SEGMENTS (${evidence.sitemapUrlCount} urls — highest counts are the core entities):\n${hist}`);
  } else {
    sections.push('SITEMAP: none found or empty. Entity discovery must rely on nav labels and page text.');
  }

  if (evidence.robotsDisallowsAll) {
    sections.push('ROBOTS: "Disallow: /" — the whole site is closed to crawlers. Strong signal for an internal tool.');
  }
  if (evidence.disallowedPaths.length > 0) {
    sections.push(`ROBOTS DISALLOWED PATHS (candidates for outOfScopePaths):\n  ${evidence.disallowedPaths.join(', ')}`);
  }

  if (evidence.thirdPartyHosts.length > 0) {
    sections.push(`THIRD-PARTY HOSTS on the landing page (payment / captcha / analytics tells):\n  ${evidence.thirdPartyHosts.join(', ')}`);
  }

  if (evidence.localeHints.length > 0) {
    sections.push(`LOCALE HINTS (html lang / hreflang / og:locale):\n  ${evidence.localeHints.join(', ')}`);
  }

  for (const doc of evidence.documents) {
    if (!doc.ok || !doc.body) continue;
    const condensed = condenseHtml(doc.body);
    if (!condensed) continue;
    sections.push(`── ${doc.path} ──\n${condensed}`);
  }

  if (evidence.budgetExhausted) {
    sections.push('NOTE: some fetches timed out, so the evidence is incomplete. Prefer "unknown" over guessing for anything you cannot see.');
  }

  sections.push(`RESPONSE FORMAT (JSON). Every wrapped field is {"value":…, "source":"observed|inferred|unknown", "confidence":"high|medium|low", "basis":"≤200 chars of what you saw"}:
{
  "purpose": {"value": "One paragraph: what the product does and for whom", "source": "observed", "confidence": "high", "basis": "og:description + h1"},
  "productType": {"value": "ecommerce|saas_dashboard|marketplace|fintech|content_media|booking|internal_admin|other", "source": "inferred", "confidence": "medium", "basis": "JSON-LD Product + /cart in sitemap"},
  "testedSurface": {"value": "marketing|app|both", "source": "inferred", "confidence": "medium", "basis": "login links to app.* subdomain"},
  "environmentKind": {"value": "production|staging|sandbox|demo|unknown", "source": "unknown", "confidence": "low"},
  "roles": {"value": [{"name": "buyer", "entryHint": "/login", "source": "inferred"}], "source": "inferred", "confidence": "medium", "basis": "single login surface"},
  "testAccountRole": {"value": "", "source": "unknown", "confidence": "low"},
  "selfSignupAvailable": {"value": true, "source": "observed", "confidence": "high", "basis": "/signup returns a form"},
  "criticalFlows": {"value": [{"name": "Guest checkout with one item", "successSignal": "an order number is shown", "rank": 1, "source": "inferred", "confidence": "medium"}], "source": "inferred", "confidence": "medium", "basis": "primary CTA chain + /checkout path"},
  "paymentPolicy": {"value": "never|stop_before_commit", "source": "inferred", "confidence": "medium", "basis": "stripe.js present, environment unknown"},
  "paymentProvider": {"value": "stripe", "source": "observed", "confidence": "high", "basis": "js.stripe.com script"},
  "conversionModel": {"value": "subscription|one_off|quote|ad_supported|none", "source": "inferred", "confidence": "medium", "basis": "/mo pricing"},
  "entities": {"value": ["products", "orders"], "source": "observed", "confidence": "high", "basis": "sitemap segments"},
  "dataPrerequisites": {"value": ["dashboard is empty until a project is created"], "source": "inferred", "confidence": "low", "basis": "onboarding copy"},
  "dataHints": {"value": "Phone must be +7 format; a known-good search term is 'laptop'", "source": "inferred", "confidence": "low", "basis": "sample products on /"},
  "uiLanguages": {"value": ["en"], "source": "observed", "confidence": "high", "basis": "html lang"},
  "region": {"value": "US (USD, +1 phones)", "source": "inferred", "confidence": "medium", "basis": "currency symbols"},
  "glossary": {"value": [{"term": "run", "meaning": "one execution of a test plan"}], "source": "observed", "confidence": "medium", "basis": "/docs"},
  "riskProfile": {"value": "standard|regulated|high_consequence", "source": "inferred", "confidence": "medium", "basis": "no compliance badges"},
  "mustNeverTouch": {"value": ["publish a public review", "delete an account"], "source": "inferred", "confidence": "medium", "basis": "public review form present"},
  "outOfScopePaths": {"value": ["/blog", "/careers"], "source": "observed", "confidence": "high", "basis": "robots + sitemap clusters"},
  "knownBlockers": {"value": ["recaptcha on /login"], "source": "observed", "confidence": "high", "basis": "recaptcha script"},
  "rateLimitWarnings": {"value": [], "source": "unknown", "confidence": "low"},
  "errorSurfacePattern": {"value": "inline field errors", "source": "inferred", "confidence": "low", "basis": "form markup"},
  "overallConfidence": "medium",
  "openQuestions": ["environmentKind — cannot tell prod from staging", "testAccountRole — unknown"]
}`);

  return sections.join('\n\n');
}

/**
 * Parse the analyst response into a raw object for `normalizeProductBrief`.
 *
 * Deliberately does NOT validate: the normalizer is the single validation
 * boundary, and duplicating field rules here is how the two drift apart. This
 * only strips code fences and returns `null` when there is no JSON at all.
 */
export function parseProductAnalystResponse(raw: string): unknown | null {
  try {
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
