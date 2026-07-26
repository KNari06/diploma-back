/**
 * Pipeline → DiscoveredStep extraction (shared).
 *
 * Pulls the rounds→DiscoveredStep logic out of FlowRunner so BOTH the
 * background exploration flow AND the editor-chat iterative authoring service
 * build steps the same way — including frozen compiled locator plans, so a
 * discovered case hits replay's stage-1 fast path instead of re-resolving every
 * element through the LLM.
 *
 * Network-call attribution stays in FlowRunner (it needs a NetworkTracker
 * lifecycle that the editor path doesn't have) — this module covers only the
 * pure command → step mapping + compiled-plan capture.
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import type { CredentialKind } from '@/config/testing/credential-field-patterns';
import { buildSecretPlaceholder } from '@/utils/interpolation/redact-secrets';
import type { TestPipelineResult, ExecutedCommand } from '../pipeline/types';
import { ACTION_TO_INTENT_TYPE, type DiscoveredStep } from './types';
import { LocatorPlanBuilder } from '@/services/testing/ui/preview/locator-plan-builder.service';
import { adaptLiteElementsToInteractiveNodes } from '@/agent/execution/background-dom-collector';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { TestAction } from '../test-case/types';

/**
 * Actions worth freezing a compiled locator plan for — element-targeting only.
 * Non-targeting (navigate/press/scroll) and synthetic (verify) steps have no
 * durable target.
 */
export const PLAN_WORTHY_ACTIONS: ReadonlySet<TestAction> = new Set<TestAction>([
  'click', 'fill', 'select', 'hover', 'toggle', 'setRange', 'selectDate', 'clear',
  // 'assert' targets the element whose text is checked — freezing a compiled plan
  // gives replay's `assert` action the selector it requires.
  'assert',
]);

/**
 * Actions whose `value` is meaningful to replay (so it's carried into the
 * compiled plan). Credentials are still excluded by the `isSensitive` gate.
 */
export const VALUE_CARRYING_ACTIONS: ReadonlySet<TestAction> = new Set<TestAction>([
  'fill', 'select', 'setRange', 'selectDate',
]);

/**
 * Maps an injected credential kind → the name of the key inside a bound
 * `secret` resource, so a credential fill can be frozen as
 * `{{secrets.<key>}}` instead of being dropped. Return undefined to keep the
 * previous (value-less) behaviour for that kind.
 *
 * Supplied ONLY by editor authoring (`EditorIterativeAuthorService`) when the
 * caller bound a credential; exploration never passes it, so exploration's
 * output is unchanged.
 */
export type SecretKeyForKind = (kind: CredentialKind) => string | undefined;

/** Extract URL from a formatted snapshot text ("URL: https://… \n Title: …"). */
function extractUrlFromSnapshot(snapshot: string): string {
  const match = snapshot.match(/URL:\s*(\S+)/i);
  return match?.[1] || '';
}

/**
 * Convert a single executed command to a DiscoveredStep, or null for
 * infrastructure / non-replayable commands. Pure — mirrors the executor's
 * command vocabulary.
 */
export function commandToStep(
  executed: ExecutedCommand,
  stepNumber: number,
  pageUrl: string,
  secretKeyForKind?: SecretKeyForKind,
): DiscoveredStep | null {
  const cmd = executed.command;
  // result.output is the human-readable description ('Clicked "CONTACT" (a)').
  // Strip the internal [POST-ACTION: …] suffix.
  const output = (executed.result.output || '').replace(/\s*\[POST-ACTION:.*$/s, '').trim();

  switch (cmd.name) {
    case 'fill_field': {
      // Credential fills: freeze a `{{secrets.<key>}}` placeholder — NEVER the
      // literal (CLAUDE.md invariant #10). We key off the credential kind the
      // executor ACTUALLY injected, not off `cmd.args.value` (which is the LLM's
      // throwaway placeholder by design — see the executor prompt's CREDENTIALS
      // block). No binding, or a field we couldn't identify as a credential →
      // drop the value, exactly as before.
      const injectedKind = executed.result.injectedCredentialKind;
      const secretKey = injectedKind ? secretKeyForKind?.(injectedKind) : undefined;
      // buildSecretPlaceholder returns undefined for a key that wouldn't
      // resolve — better to drop the value than to freeze a placeholder replay
      // would type verbatim into the app's password field.
      const sensitiveValue = secretKey ? buildSecretPlaceholder(secretKey) : undefined;
      if (secretKeyForKind && !injectedKind && cmd.args.is_sensitive) {
        // The executor injects a credential for ANY classified kind but only
        // REPORTS the kind at HIGH (Level-1 type/autocomplete/inputmode)
        // confidence. So a credential field identified only by label text is
        // filled for real during authoring and then persisted WITHOUT a
        // placeholder — the saved test replays with an empty/garbage field and
        // 401s, while authoring looked perfect. Name it in the log; silence
        // here is what makes that class of failure so expensive to diagnose.
        logger.warn('[PIPELINE_STEP_EXTRACTOR] Sensitive fill with no high-confidence credential kind — not frozen', {
          ref: cmd.args.ref,
        });
      }
      if (secretKeyForKind && injectedKind && !sensitiveValue) {
        // Otherwise this is a silent value-drop: replay leaves the field empty
        // and 401s with nothing in the logs explaining why.
        logger.warn('[PIPELINE_STEP_EXTRACTOR] Credential injected but no usable secret key — value dropped', {
          kind: injectedKind,
          ref: cmd.args.ref,
          hadKey: !!secretKey,
        });
      }
      // An injected credential is GROUND TRUTH and outranks the model's
      // `is_sensitive` flag. The executor injects whenever the field CLASSIFIES
      // as a credential, regardless of that flag, so keying on the flag alone
      // is wrong in both directions:
      //   - flag false + credential injected → we'd persist the model's
      //     throwaway literal and replay would type gibberish into a password
      //     box (silently reintroducing the 401 this rung fixes);
      //   - worse, if the model copied a credential it read off the page into
      //     that arg, we'd persist a REAL credential in plaintext.
      // So: a credential field never keeps `cmd.args.value`. Without a binding
      // it loses its value (previous behaviour); with one it gets the
      // placeholder.
      const isCredential = !!injectedKind || !!cmd.args.is_sensitive;
      return {
        stepNumber,
        description: output || `Fill "${cmd.args.ref}" with ${isCredential ? '[credential]' : `"${cmd.args.value}"`}`,
        action: 'fill',
        ref: cmd.args.ref,
        value: isCredential ? sensitiveValue : cmd.args.value,
        isSensitive: isCredential,
        pageUrl,
        expectedOutcome: 'Field is filled with the value',
      };
    }
    case 'click_element':
      return {
        stepNumber,
        description: output || `Click "${cmd.args.ref}"`,
        action: 'click',
        ref: cmd.args.ref,
        pageUrl,
        expectedOutcome: executed.result.success ? 'Element clicked successfully' : undefined,
      };
    case 'select_option':
      return {
        stepNumber,
        description: output || `Select option "${cmd.args.value}" in "${cmd.args.ref}"`,
        action: 'select',
        ref: cmd.args.ref,
        value: cmd.args.value,
        pageUrl,
      };
    case 'press_key':
      return {
        stepNumber,
        description: output || `Press key "${cmd.args.key}"`,
        action: 'press',
        value: cmd.args.key,
        pageUrl,
      };
    case 'hover_element':
      return {
        stepNumber,
        description: output || `Hover over "${cmd.args.ref}"`,
        action: 'hover',
        ref: cmd.args.ref,
        pageUrl,
      };
    case 'scroll_page':
    case 'scroll_to_element':
      return {
        stepNumber,
        description: output || (cmd.name === 'scroll_to_element'
          ? `Scroll to element "${cmd.args.ref}"`
          : `Scroll ${cmd.args.direction || 'down'}`),
        action: 'scroll',
        ref: cmd.args.ref,
        pageUrl,
      };
    case 'navigate_to':
      return {
        stepNumber,
        description: output || `Navigate to ${cmd.args.url}`,
        action: 'navigate',
        value: cmd.args.url,
        pageUrl,
      };
    case 'toggle_element':
      return {
        stepNumber,
        description: output || `Toggle "${cmd.args.ref}"`,
        action: 'toggle',
        ref: cmd.args.ref,
        pageUrl,
        expectedOutcome: 'Element toggled successfully',
      };
    case 'set_range':
      return {
        stepNumber,
        description: output || `Set range "${cmd.args.ref}" to "${cmd.args.value}"`,
        action: 'setRange',
        ref: cmd.args.ref,
        value: cmd.args.value,
        pageUrl,
      };
    case 'select_date':
      return {
        stepNumber,
        description: output || `Set date "${cmd.args.ref}" to "${cmd.args.value}"`,
        action: 'selectDate',
        ref: cmd.args.ref,
        value: cmd.args.value,
        pageUrl,
      };
    case 'clear_field':
      return {
        stepNumber,
        description: output || `Clear field "${cmd.args.ref}"`,
        action: 'clear',
        ref: cmd.args.ref,
        pageUrl,
      };
    case 'assert_text': {
      // Deterministic assertion (editor authoring only). value = the text-contains
      // `expected`; selector = a STRUCTURAL locator captured from the resolved
      // element so replay's primary is text-independent (see toIntentSteps). Only
      // successful (grounded) asserts reach here — extractDiscoveredSteps drops
      // failed commands.
      const el = executed.result.resolvedElement;
      const structuralSelector = el?.testIdAttr
        ? `[data-testid="${String(el.testIdAttr).replace(/"/g, '\\"')}"]`
        : el?.id
          ? `[id="${String(el.id).replace(/"/g, '\\"')}"]`
          : undefined;
      // Freeze the TRIMMED expected — the same value the handler grounded against
      // (assertText trims before comparing). Replay compares raw DOM text against
      // this frozen value, so any surrounding whitespace here would false-RED.
      const expected = String(cmd.args.expected ?? '').trim();
      return {
        stepNumber,
        description: cmd.args.description || output || `Assert "${cmd.args.ref}" contains "${expected}"`,
        action: 'assert',
        ref: cmd.args.ref,
        value: expected,
        selector: structuralSelector,
        pageUrl,
        expectedOutcome: `Text "${expected}" is present`,
      };
    }
    case 'mark_done':
      return {
        stepNumber,
        description: `Verify: ${cmd.args.evidence || 'Goal achieved'}`,
        action: 'verify',
        pageUrl,
        expectedOutcome: cmd.args.evidence,
      };
    // Infrastructure / non-replayable commands.
    case 'observe_page':
    case 'wait_for_page':
    case 'report_blocked':
      return null;
    default:
      logger.debug('[PIPELINE_STEP_EXTRACTOR] Unmapped command, skipping', { command: cmd.name });
      return null;
  }
}

/**
 * Build a compiled locator plan from the element the executor actually acted on
 * (`result.resolvedElement`) and attach it to `step.compiled`. Best-effort:
 * any throw is swallowed (the step keeps working, just without a frozen plan).
 * Passing the live `page` validates each locator (`unverified: false`).
 */
export async function attachCompiledPlan(
  step: DiscoveredStep,
  executed: ExecutedCommand,
  pageUrl: string,
  page?: Page,
): Promise<void> {
  const resolvedElement = executed.result.resolvedElement;
  if (!resolvedElement) return;
  if (!PLAN_WORTHY_ACTIONS.has(step.action)) return;

  try {
    const [node] = adaptLiteElementsToInteractiveNodes([resolvedElement]);
    if (!node) return;

    const intentType = ACTION_TO_INTENT_TYPE[step.action] || 'click';
    // Carry value only for replay-meaningful actions, never credentials.
    const carriesValue =
      VALUE_CARRYING_ACTIONS.has(step.action) && !step.isSensitive && !!step.value;
    // When the resolved element lives inside a same-origin iframe, carry the
    // durable iframe selector into the step options. buildCompiledPlan copies
    // `step.options` onto `compiled.action.options`, so replay's compiled
    // executor (and live-apply's getLocatorContext) re-enter the frame via
    // `page.frameLocator(selector)` instead of failing on the main page.
    const iframeSelector = node.iframeSelector;
    const planStep: IntentStep = {
      id: `step-${step.stepNumber}`,
      type: intentType,
      description: step.description,
      ...(carriesValue ? { value: step.value } : {}),
      ...(iframeSelector ? { options: { iframe: { selector: iframeSelector } } } : {}),
    };

    const compiled = await LocatorPlanBuilder.buildCompiledPlan({
      step: planStep,
      resolvedNode: node,
      pageUrl,
      page,
    });

    if (compiled?.locatorPlan?.length) {
      step.compiled = compiled;
    }
  } catch (err) {
    logger.debug('[PIPELINE_STEP_EXTRACTOR] Compiled-plan capture skipped', {
      action: step.action,
      ref: step.ref,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Extract DiscoveredStep[] from pipeline execution rounds, attaching a compiled
 * locator plan to each element-targeting step. Keeps ONLY successful commands
 * (failed ones are noise). `stepsByRound[i]` = index into `steps` of the LAST
 * step produced by round i (or null) — used by FlowRunner's network attribution.
 */
export async function extractDiscoveredSteps(
  result: TestPipelineResult,
  page?: Page,
  secretKeyForKind?: SecretKeyForKind,
): Promise<{ steps: DiscoveredStep[]; stepsByRound: Array<number | null> }> {
  const steps: DiscoveredStep[] = [];
  const stepsByRound: Array<number | null> = [];
  let stepNumber = 0;

  for (const round of result.rounds) {
    const roundPageUrl = extractUrlFromSnapshot(round.pageSnapshotBefore);
    let lastStepIdxInRound: number | null = null;

    for (const executed of round.commands) {
      if (!executed.result.success) continue;

      const step = commandToStep(executed, stepNumber + 1, roundPageUrl, secretKeyForKind);
      if (step) {
        step.stepNumber = ++stepNumber;
        await attachCompiledPlan(step, executed, roundPageUrl, page);
        steps.push(step);
        lastStepIdxInRound = steps.length - 1;
      }
    }

    stepsByRound.push(lastStepIdxInRound);
  }

  return { steps, stepsByRound };
}
