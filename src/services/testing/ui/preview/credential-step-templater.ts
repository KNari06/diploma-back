/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CREDENTIAL STEP TEMPLATER — replace a credential the app RENDERS BACK with
 * the `{{secrets.<key>}}` placeholder it came from.
 *
 * The freeze in `commandToStep` covers the value the agent TYPES. It does not
 * cover the value the app echoes: a login lands on "Welcome back,
 * demo@qait.dev", so the authored assertion, the step description, and the
 * compiled locator chain built from that element's text all capture the
 * credential as a literal — and those are persisted to `intent_test_cases`.
 *
 * Templating keeps the assertion meaningful (replay interpolates it back to the
 * real value from the store — see `interpolateCommandPlaceholders`) while the
 * stored row holds only a placeholder.
 *
 * NOT COVERED, deliberately: run screenshots still show the rendered
 * credential. Closing that is separate work.
 *
 * Ordering contract: run this BEFORE `toIntentSteps` / `sanitizeSteps`, and
 * note it must ALSO run after `attachCompiledPlan` (which happens inside
 * `extractDiscoveredSteps`) — hence it takes already-extracted steps.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { buildSecretPlaceholder, SECRET_PLACEHOLDER_SOURCE } from '@/utils/interpolation/redact-secrets';
import type { DiscoveredStep } from '@/agent/core/lite/exploration/types';

/**
 * Below this length a "credential" is too generic to substitute safely — it
 * would shred unrelated prose (a 1-char secret would match everywhere). Mirrors
 * `redact-secrets`' own MIN_REDACT_LENGTH.
 */
const MIN_TEMPLATE_LENGTH = 4;


/** Escape a literal for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the replacer once. Longest value first so a credential that is a
 * substring of another (password "pass" inside "password123") can't
 * half-replace the longer one.
 */
function buildReplacer(valueToKey: Map<string, string>): ((text: string) => string) | null {
  const byValue = new Map<string, string>();
  const alternatives: string[] = [];

  for (const [value, key] of [...valueToKey.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (typeof value !== 'string' || value.length < MIN_TEMPLATE_LENGTH) continue;
    const placeholder = buildSecretPlaceholder(key);
    // A key that can't round-trip through resolvePlaceholders would leave an
    // unresolvable literal in the assertion — skip rather than corrupt it.
    if (!placeholder) continue;
    byValue.set(value, placeholder);
    alternatives.push(escapeRe(value));
  }

  if (alternatives.length === 0) return null;

  // ONE pass over the text, not one pass per credential. Replacing
  // sequentially lets a short credential match inside a placeholder the
  // previous pass just inserted — with values `password123` and `pass`, the
  // second pass rewrites `{{secrets.login_password}}` into
  // `{{secrets.login_{{secrets.short}}word}}`. A single alternation, ordered
  // longest-first, consumes each match once and never re-scans output.
  //
  // An EXISTING placeholder is matched first and returned verbatim. This is
  // load-bearing, not defensive: the credential fill was already frozen to
  // `{{secrets.<key>}}` upstream, and a key is usually NAMED after what it
  // holds — so the password value `password` occurs inside the key name
  // `login_password`. Substituting there would corrupt the frozen placeholder
  // into `{{secrets.login_{{secrets.login_password}}}}`, which is no longer a
  // bound placeholder, so `toIntentSteps` falls back to the legacy
  // `{{password}}` mask and the saved test types that literal into the app and
  // 401s. Authoring still looks perfect — this only shows up on replay.
  const re = new RegExp(`${SECRET_PLACEHOLDER_SOURCE}|${alternatives.join('|')}`, 'g');
  return (text: string): string => text.replace(re, (m) => byValue.get(m) ?? m);
}

/**
 * Return a copy of `steps` with every rendered credential replaced by its
 * placeholder, across the fields that get PERSISTED:
 *   - `value`           — a deterministic `assert` step's expected text
 *   - `expectedOutcome` — becomes `ai_check.assertionText`
 *   - `description`     — human-facing, and persisted verbatim
 *   - `compiled.action.value` and `context.pageTitle` — templated
 *   - `compiled.locatorPlan` / `targetFingerprint` — credential-quoting entries
 *     are REMOVED rather than templated, because those are matched literally
 *     against the live DOM and never interpolated
 *
 * Steps are only cloned when something actually changed.
 */
export function templateCredentialsInSteps(
  steps: DiscoveredStep[],
  valueToKey: Map<string, string>,
): DiscoveredStep[] {
  const replace = buildReplacer(valueToKey);
  if (!replace) return steps;

  const sub = (v: unknown): unknown => (typeof v === 'string' ? replace(v) : v);

  return steps.map((step) => {
    const next: DiscoveredStep = { ...step };
    let changed = false;

    for (const field of ['value', 'expectedOutcome', 'description'] as const) {
      const cur = step[field];
      if (typeof cur !== 'string') continue;
      const replaced = replace(cur);
      if (replaced === cur) continue;
      (next as unknown as Record<string, unknown>)[field] = replaced;
      changed = true;
    }

    if (step.compiled) {
      const compiled = step.compiled as unknown as Record<string, any>;
      const nextCompiled: Record<string, any> = { ...compiled };
      let compiledChanged = false;

      if (Array.isArray(compiled.locatorPlan)) {
        // DROP, don't template. Locators are deliberately NOT interpolated at
        // replay (Hard invariant #9 excludes selectors), so a templated
        // strategy — `role=heading[name="Welcome, {{secrets.login_email}}"]` —
        // is permanently unmatchable and the compiled fast path misses every
        // time. Removing the affected strategies keeps the credential out of
        // the persisted row AND lets resolution fall through to the structural
        // strategies (testId / css / id) that don't quote the credential.
        const kept = compiled.locatorPlan.filter((e: Record<string, unknown>) => {
          const quotesCredential = sub(e.value) !== e.value || sub(e.roleName) !== e.roleName;
          return !quotesCredential;
        });
        if (kept.length !== compiled.locatorPlan.length) {
          nextCompiled.locatorPlan = kept;
          compiledChanged = true;
        }
      }

      if (compiled.action && typeof compiled.action.value === 'string') {
        const v = replace(compiled.action.value);
        if (v !== compiled.action.value) {
          nextCompiled.action = { ...compiled.action, value: v };
          compiledChanged = true;
        }
      }

      if (compiled.targetFingerprint) {
        const fp = compiled.targetFingerprint as Record<string, unknown>;
        const nextFp: Record<string, unknown> = { ...fp };
        let fpChanged = false;
        // Same reasoning as the locator plan: the fingerprint is matched
        // literally against the live DOM, never interpolated, so a templated
        // channel would never match. DELETE the credential-bearing channels and
        // leave the rest (tag / role / geometry / testIdAttr) to identify the
        // element.
        for (const f of ['labelText', 'ariaLabel', 'placeholder', 'title', 'alt', 'text', 'firstTextFragment'] as const) {
          const cur = fp[f];
          if (typeof cur !== 'string' || replace(cur) === cur) continue;
          delete nextFp[f];
          fpChanged = true;
        }
        if (Array.isArray(fp.containerTitles)) {
          const titles = (fp.containerTitles as unknown[]).filter((t) => sub(t) === t);
          if (titles.length !== (fp.containerTitles as unknown[]).length) {
            nextFp.containerTitles = titles;
            fpChanged = true;
          }
        }
        if (fpChanged) {
          nextCompiled.targetFingerprint = nextFp;
          compiledChanged = true;
        }
      }

      // `context.pageTitle` IS persisted and a logged-in dashboard routinely
      // renders the account identifier into it. Nothing matches on it, so
      // templating is safe here (no unmatchable-locator risk).
      if (compiled.context && typeof compiled.context.pageTitle === 'string') {
        const t = replace(compiled.context.pageTitle);
        if (t !== compiled.context.pageTitle) {
          nextCompiled.context = { ...compiled.context, pageTitle: t };
          compiledChanged = true;
        }
      }

      if (compiledChanged) {
        next.compiled = nextCompiled as DiscoveredStep['compiled'];
        changed = true;
      }
    }

    return changed ? next : step;
  });
}
