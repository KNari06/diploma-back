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
): DiscoveredStep | null {
  const cmd = executed.command;
  // result.output is the human-readable description ('Clicked "CONTACT" (a)').
  // Strip the internal [POST-ACTION: …] suffix.
  const output = (executed.result.output || '').replace(/\s*\[POST-ACTION:.*$/s, '').trim();

  switch (cmd.name) {
    case 'fill_field':
      return {
        stepNumber,
        description: output || `Fill "${cmd.args.ref}" with ${cmd.args.is_sensitive ? '[credential]' : `"${cmd.args.value}"`}`,
        action: 'fill',
        ref: cmd.args.ref,
        value: cmd.args.is_sensitive ? undefined : cmd.args.value,
        isSensitive: cmd.args.is_sensitive,
        pageUrl,
        expectedOutcome: 'Field is filled with the value',
      };
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
): Promise<{ steps: DiscoveredStep[]; stepsByRound: Array<number | null> }> {
  const steps: DiscoveredStep[] = [];
  const stepsByRound: Array<number | null> = [];
  let stepNumber = 0;

  for (const round of result.rounds) {
    const roundPageUrl = extractUrlFromSnapshot(round.pageSnapshotBefore);
    let lastStepIdxInRound: number | null = null;

    for (const executed of round.commands) {
      if (!executed.result.success) continue;

      const step = commandToStep(executed, stepNumber + 1, roundPageUrl);
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
