/**
 * Intent Step to PlaywrightCommand Converter
 *
 * DESIGN PHILOSOPHY (per plan): This converter is strictly "dumb" -
 * it does NOT resolve elements or look them up. It only transfers:
 * - intent (type/description/value/options)
 * - compiled/evidence/bindingHints into metadata
 *
 * Element resolution happens at runtime in CommandExecutor via:
 * 1. compiled.locatorPlan (if present and valid)
 * 2. Fallback to smart-locator + self-healing
 */

import { PlaywrightCommand } from '@/types';
import { logger } from '@/utils/core/logger';
import type { BindingHints, CompiledStepPlan, ExpectedStepOutcome, IntentActionType, IntentStep, StepEvidence, TargetFingerprint } from './preview.types';
// Step.options.* forwarding (replaceContent, keyPressDelay, cssSelector,
// disableStabilityChecks, disableCaching) lives in a dedicated module so
// this converter stays focused on the action→command shape.
import { applyStepOptionsToCommand } from './intent-step-options-forwarder';

/**
 * Extended PlaywrightCommand with intent metadata for runtime resolution
 * This metadata enables the executor to use compiled plans and self-healing
 */
export interface IntentPlaywrightCommand extends PlaywrightCommand {
  /**
   * Intent metadata for runtime resolution and reporting
   */
  intentMeta?: {
    /** Original IntentStep ID */
    stepId: string;
    /** Original intent description */
    intentDescription: string;
    /** Compiled execution plan (if available) */
    compiled?: CompiledStepPlan;
    /** Evidence from previous executions */
    evidence?: StepEvidence;
    /** Binding hints for resolution */
    bindingHints?: BindingHints;
    /**
     * Recorded element fingerprint (id/testId/name/text/ancestor/landmark/…).
     * Forwarded so the AUTO-HEAL resolver gets the same strong identity the
     * editor had. Without this, a regression heal resolved blind (only
     * description + soft bindingHints) — the #2 heal-context gap (2026-06).
     */
    recordedFingerprint?: TargetFingerprint;
    /** Recorded natural-language description (record-time LLM note) — soft heal hint. */
    recordedDescription?: string;
    /** Step index in the test case */
    stepIndex: number;
    /** V2: Parent IntentTestCase ID for heal persistence */
    intentTestCaseId?: string;
    /** V3: Assertion text for ai_check */
    assertionText?: string;
    /** V3: AI context mode for ai_check */
    aiContextMode?: 'html' | 'screenshot' | 'html+a11y' | 'html+screenshot' | 'html+a11y+screenshot';
    /** Iframe selector for actions within iframes */
    iframeSelector?: string;
    /** V6: Original action type for lookahead checks */
    actionType?: IntentActionType;
    /** V6: Disable lookahead wait before this step */
    disableLookaheadWait?: boolean;
    /** Override lookahead wait timeout (ms) */
    lookaheadTimeoutMs?: number;
    /** V10: Press Enter after type action (from step.options.pressEnter) */
    pressEnter?: boolean;
    /**
     * Clear field before typing (from step.options.replaceContent).
     * - undefined / true → clear before typing (default, matches preview behavior)
     * - false → append to existing content
     * See preview-step-apply.service.ts:2548 for the canonical condition shape.
     */
    replaceContent?: boolean;
    /**
     * Per-keystroke delay (ms) for `pressSequentially` in the intent `type`
     * path. From `step.options.keyPressDelay`. When undefined we pass no
     * `delay` option (Playwright default) — same as preview's non-humanLike
     * branch when the user didn't set it. We deliberately do NOT inject a
     * random delay here (that's preview's `humanLike` path, not wired).
     */
    keyPressDelay?: number;
    /**
     * Marks `command.selector` as a user-pinned raw CSS override from
     * `step.options.cssSelector`. When set, the executor must short-circuit
     * the resolver waterfall and use the literal selector — failing the step
     * if the locator doesn't match, with no AI/self-heal fallback. Mirrors
     * preview-step-apply.service.ts:2093.
     */
    cssSelectorOverride?: string;
    /**
     * From `step.options.disableStabilityChecks`. When true the executor
     * skips smartStepWait calls (matches preview-step-apply.service.ts:2451).
     */
    disableStabilityChecks?: boolean;
    /**
     * From `step.options.disableCaching`. When true the executor skips the
     * `evidence.lastSuccessRef` fast-path and always runs full resolution.
     * Matches the gate in intent-step-lint.service.ts:1227 used by preview.
     */
    disableCaching?: boolean;
    /** V13: Content was pasted — use clipboard paste instead of fill/pressSequentially */
    isPaste?: boolean;
    /** V11: Expected outcome for 4xx detection (default: 'success') */
    expectedOutcome?: ExpectedStepOutcome;
    /** V12: Email filter for wait_for_email step */
    emailFilter?: {
      subject?: string;
      from?: string;
      extractPrompt: string;
      extractVariable: string;
    };
    /** V12: Timeout override for wait_for_email */
    emailTimeoutMs?: number;
  };
}

/**
 * Map IntentActionType to PlaywrightCommand action
 * Some actions map directly, others need translation
 */
function mapActionType(intentAction: IntentActionType): string {
  switch (intentAction) {
    case 'type':
      return 'type';
    case 'click':
      return 'click';
    case 'wait':
      return 'wait';
    case 'timeout':
      return 'wait'; // Explicit sleep — reuses the executor's waitForTimeout command
    case 'assert':
      return 'assert'; // Dispatcher in executor: delegates by assertion.type (visible/text/value/etc)
    case 'navigate':
      return 'goto';
    case 'select':
      return 'select';
    case 'hover':
      return 'hover';
    case 'scroll':
      return 'scroll';
    case 'press':
      return 'press';
    // V2: State-aware actions
    case 'check':
      return 'check';
    case 'uncheck':
      return 'uncheck';
    case 'toggle':
      return 'toggle'; // State-aware: checks current state before clicking
    case 'open':
      return 'open'; // Semantic click with enabled guard
    case 'close':
      return 'close'; // Semantic click with enabled guard
    // V3: AI check
    case 'ai_check':
      return 'aiCheck'; // New runtime action for AI-based assertions
    // V5: URL wait
    case 'wait_for':
      return 'waitFor'; // SPA-safe URL waiting
    // V12: Email inbox
    case 'wait_for_email':
      return 'waitForEmail'; // IMAP polling + AI extraction
    // V6: File upload
    case 'upload':
      return 'upload';
    // V10: Advanced recording types
    case 'dblclick':
      return 'dblclick';
    case 'contextmenu':
      return 'contextmenu';
    case 'drag_and_drop':
      return 'dragAndDrop';
    // V13: Dialog handling
    case 'dialog':
      return 'handleDialog';
    // V13: Download verification
    case 'download':
      return 'verifyDownload';
    // V15: Multi-tab
    case 'switch_tab':
      return 'switchTab';
    // Multi-tab close — symmetric with switch_tab. Background replay maps
    // this to the existing `closeTab` Playwright action used by the same
    // command-executor branch that handles the live preview path.
    case 'close_tab':
      return 'closeTab';
    // Multi-tab open — symmetric with switch/close. Background replay maps
    // this to the `openTab` Playwright action (context.newPage + goto).
    case 'open_tab':
      return 'openTab';
    // V16: Gestures and coordinates
    case 'swipe':
      return 'swipe';
    case 'click_at':
      return 'clickAt';
    // V17: Scratchpad
    case 'store':
      return 'store';
    default:
      return 'click'; // Fallback
  }
}

/**
 * Build selector from compiled locatorPlan (primary locator only)
 * Returns undefined if no compiled plan or no locators
 *
 * The CommandExecutor will try all locators in the plan at runtime.
 * Here we just provide the primary one for backward compatibility.
 */
function buildPrimarySelector(compiled?: CompiledStepPlan): string | undefined {
  if (!compiled?.locatorPlan || compiled.locatorPlan.length === 0) {
    return undefined;
  }

  const primary = compiled.locatorPlan[0];

  switch (primary.strategy) {
    case 'ref':
    case 'css':
      return primary.value;
    case 'role':
      // Format: role=button[name="Submit"]
      if (primary.roleName && primary.value) {
        return `role=${primary.roleName}[name="${primary.value}"]`;
      }
      return undefined;
    case 'label':
      // Format: getByLabel locator syntax
      return `text="${primary.value}"`;
    case 'testId':
      return `[data-testid="${primary.value}"]`;
    case 'placeholder':
      return `[placeholder="${primary.value}"]`;
    case 'title':
      return `[title="${primary.value}"]`;
    case 'text':
      return `text="${primary.value}"`;
    default:
      return undefined;
  }
}

/**
 * Resolve expected outcome for a step.
 * Uses the explicitly set step.expectedOutcome if present.
 * Falls back to 'success' — LLM that generates steps is responsible
 * for setting expectedOutcome: 'error' on negative test steps.
 */
function resolveExpectedOutcome(step: IntentStep): ExpectedStepOutcome {
  return step.expectedOutcome ?? 'success';
}

/**
 * Convert a single IntentStep to IntentPlaywrightCommand
 *
 * This is a "dumb" converter - it does NOT:
 * - Resolve elements
 * - Make API calls
 * - Validate selectors
 *
 * Resolution happens at runtime in CommandExecutor.
 */
export function convertIntentStepToCommand(
  step: IntentStep,
  stepIndex: number,
  testCaseStartUrl?: string
): IntentPlaywrightCommand {
  const action = mapActionType(step.type);

  // Build primary selector from compiled plan if available
  // If not available, CommandExecutor will use intent-based resolution
  const primarySelector = buildPrimarySelector(step.compiled);

  // Build command
  const command: IntentPlaywrightCommand = {
    action,
    description: step.description,
    timeout: step.options?.timeout || 30000,
    continueOnError: step.isAutoInjected === true
      || (step.type === 'wait_for' && !!step.options?.urlMatcher?.changedFrom)
      // Teardown steps never fail the overall verdict — they run
      // best-effort after the body. If a teardown step throws, we want
      // the executor to log it and move on rather than abort.
      || step.phase === 'teardown',
    // Propagate the lifecycle phase marker from IntentStep so the
    // executor (and the downstream RunReportStep) can distinguish
    // setup / main / teardown. Absent on pre-Phase-3 runs.
    ...(step.phase ? { phase: step.phase } : {}),

    // Intent metadata for runtime resolution
    intentMeta: {
      stepId: step.id,
      intentDescription: step.description,
      compiled: step.compiled,
      evidence: step.evidence,
      bindingHints: step.bindingHints,
      // Forward recorded identity so auto-heal resolves with the same strong
      // fingerprint the editor had (regression-heal #2 gap fix, 2026-06).
      recordedFingerprint: step.recordedFingerprint,
      recordedDescription: step.recordedDescription,
      stepIndex,
      // V6: Action type for lookahead checks
      actionType: step.type,
      // V6: Lookahead wait disable flag
      disableLookaheadWait: step.options?.disableLookaheadWait,
      lookaheadTimeoutMs: step.options?.lookaheadTimeoutMs,
      // V3: AI check metadata
      ...(step.type === 'ai_check' && {
        assertionText: step.assertionText,
        aiContextMode: step.options?.aiContextMode || 'html+a11y+screenshot',
      }),
      // V12: Email inbox metadata
      ...(step.type === 'wait_for_email' && step.options?.emailFilter && {
        emailFilter: step.options.emailFilter,
        emailTimeoutMs: step.options.timeout,
      }),
      // Iframe metadata (if step is within an iframe)
      ...(step.options?.iframe?.selector && {
        iframeSelector: step.options.iframe.selector,
      }),
      // V11: Expected outcome for 4xx detection in replay
      expectedOutcome: resolveExpectedOutcome(step),
    },
  };

  // Add selector if compiled plan available
  if (primarySelector) {
    command.selector = primarySelector;
  }

  // Forward user-toggle step.options.* (replaceContent, keyPressDelay,
  // cssSelector, disableStabilityChecks, disableCaching). May also
  // override command.selector when cssSelector is pinned.
  applyStepOptionsToCommand(step, command);

  // Handle specific action types
  switch (step.type) {
    case 'type':
      command.value = step.value || '';
      // V10: Pass pressEnter flag to intentMeta so executor knows
      // to press Enter after type without calling AI
      if (step.options?.pressEnter && command.intentMeta) {
        command.intentMeta.pressEnter = true;
      }
      // V13: Pass isPaste flag so executor dispatches clipboard paste instead of fill
      if (step.options?.isPaste && command.intentMeta) {
        command.intentMeta.isPaste = true;
      }
      break;

    case 'navigate':
      // For navigate, use the value as URL, or fallback to test case startUrl
      command.url = step.value || testCaseStartUrl;
      command.waitFor = 'load';
      break;

    case 'press':
      // For press, value is the key to press (e.g., "Enter", "Tab")
      command.value = step.value || 'Enter';
      break;

    case 'select':
      // For select, value is the option to select
      command.value = step.value || '';
      break;

    case 'wait':
    case 'timeout': {
      // For wait/timeout, value is the time in ms to pause
      // ESLint: wrap in block to avoid no-case-declarations
      const waitTimeMsRaw = step.value ?? '1000';
      const waitTimeMs = typeof waitTimeMsRaw === 'number' ? waitTimeMsRaw : Number(waitTimeMsRaw);
      const normalizedWaitMs = Number.isFinite(waitTimeMs) ? Math.max(0, Math.floor(waitTimeMs)) : 1000;
      command.timeout = normalizedWaitMs;
      break;
    }

    case 'assert':
      // For assert, set up assertion config — executor dispatches by assertion.type
      if (step.value && step.value.trim().length > 0) {
        command.assertion = {
          type: 'text',
          expected: step.value,
          operator: 'contains',
        };
      } else {
        // No value → visibility check (action stays 'assert', executor defaults to visible)
        command.assertion = {
          type: 'visible',
          expected: true,
        };
      }
      break;

    case 'ai_check':
      // For ai_check, no additional command fields needed
      // All data is in intentMeta (assertionText, aiContextMode)
      break;

    case 'wait_for':
      // V5: For wait_for, pass urlMatcher to command
      if (step.options?.urlMatcher) {
        command.urlMatcher = {
          substring: step.options.urlMatcher.substring,
          glob: step.options.urlMatcher.glob,
          regex: step.options.urlMatcher.regex,
          domain: step.options.urlMatcher.domain,
          changedFrom: step.options.urlMatcher.changedFrom,
          caseSensitive: step.options.urlMatcher.caseSensitive,
          negate: step.options.urlMatcher.negate,
          timeoutMs: step.options.urlMatcher.timeoutMs ?? 15000,
        };
      }
      break;

    case 'wait_for_email':
      // V12: Email inbox — emailFilter is passed through intentMeta
      // Actual execution handled in preview-step-apply.service.ts (early return path)
      break;

    case 'scroll':
      // V14: Pass deltaY,deltaX value so regression scroll matches recorded distance
      if (step.value) {
        command.value = step.value;
      }
      // Container scroll: pass selector so background replay scrolls the right element
      if (step.options?.scrollContainer && command.intentMeta) {
        (command.intentMeta as any).scrollContainer = step.options.scrollContainer;
      }
      break;

    case 'drag_and_drop':
      // V14: Pass coordinate data or dropTarget for regression replay
      command.value = step.value || '';
      if (step.options?.dropTarget) {
        command.dropTarget = step.options.dropTarget;
      }
      break;

    case 'upload': {
      // For upload, value is the file URL or storage path
      command.value = step.value || '';
      const uploadOpts = step.options?.upload;
      command.upload = {
        fileUrl: step.value || '',
        sourceType: uploadOpts?.sourceType || 'url',
        filename: uploadOpts?.filename,
        envVar: uploadOpts?.envVar,
        maxSizeBytes: uploadOpts?.maxSizeBytes,
      };
      break;
    }

    case 'click':
    case 'dblclick':
    case 'contextmenu':
      // V13: Pass modifier keys for multi-select (Shift+Click, Ctrl+Click)
      if (step.options?.modifiers) {
        command.modifiers = step.options.modifiers;
      }
      break;

    case 'dialog':
      // V13: Pass dialog options for replay
      if (step.options?.dialog) {
        command.dialog = step.options.dialog;
      }
      break;

    case 'download':
      // V13: Pass download options for verification
      if (step.options?.download) {
        command.download = step.options.download;
      }
      break;

    // V18: Multi-tab switch — pass target tab index
    case 'switch_tab':
      command.value = step.value || '0';
      break;

    // Multi-tab close — target tab index in `value`, same shape as switch.
    case 'close_tab':
      command.value = step.value || '0';
      break;

    // Multi-tab open — destination URL in `value`. CommandExecutor opens a new
    // page in the context and navigates it there.
    case 'open_tab':
      command.value = step.value || '';
      break;

    // V18: Coordinate-based swipe gesture (mobile)
    case 'swipe':
      command.value = step.value || '';
      break;

    // V18: Coordinate-based click (canvas, maps, etc.)
    case 'click_at':
      command.value = step.value || '';
      break;

    // V18: Scratchpad — store key-value pair for cross-step memory
    case 'store':
      command.value = step.value || '';
      break;

    default:
      // For hover, check, uncheck, toggle, open, close
      // Just need the selector which is handled above
      break;
  }

  logger.debug('[INTENT_STEP_CONVERTER] Converted step', {
    stepId: step.id,
    stepType: step.type,
    action: command.action,
    hasCompiledPlan: !!step.compiled,
    hasSelector: !!command.selector,
    stepIndex,
  });

  return command;
}

/**
 * Convert array of IntentSteps to IntentPlaywrightCommands
 *
 * @param steps Array of IntentSteps from the test case
 * @param startUrl Starting URL for navigate actions
 * @param intentTestCaseId Optional parent test case ID for heal persistence
 * @returns Array of IntentPlaywrightCommands ready for execution
 */
export function convertIntentStepsToCommands(
  steps: IntentStep[],
  startUrl: string,
  intentTestCaseId?: string
): IntentPlaywrightCommand[] {
  logger.info('[INTENT_STEP_CONVERTER] Converting intent steps', {
    stepsCount: steps.length,
    startUrl,
    intentTestCaseId,
  });

  // Add initial goto command for startUrl
  const commands: IntentPlaywrightCommand[] = [
    {
      action: 'goto',
      url: startUrl,
      waitFor: 'load',
      timeout: 30000,
      description: `Navigate to ${startUrl}`,
    },
  ];

  // Convert each step
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const command = convertIntentStepToCommand(step, i, startUrl);

    // V2: Add intentTestCaseId for heal persistence
    if (intentTestCaseId && command.intentMeta) {
      command.intentMeta.intentTestCaseId = intentTestCaseId;
    }

    // Peek ahead: if next step expects URL change, mark this command to await navigation.
    // This makes performClick use Promise.all([page.waitForNavigation(), locator.click()])
    // which correctly captures navigation triggered by the click.
    if (i < steps.length - 1) {
      const nextStep = steps[i + 1];
      if (nextStep.type === 'wait_for' && nextStep.options?.urlMatcher?.changedFrom) {
        if (['click', 'open', 'close', 'toggle'].includes(step.type)) {
          command.awaitNavigation = true;
        }
      }
    }

    commands.push(command);
  }

  logger.info('[INTENT_STEP_CONVERTER] Conversion complete', {
    inputSteps: steps.length,
    outputCommands: commands.length,
    stepsWithCompiledPlan: steps.filter(s => !!s.compiled).length,
  });

  return commands;
}

/**
 * Service class for Intent Step conversion
 */
export class IntentStepConverterService {
  /**
   * Convert intent steps to Playwright commands
   *
   * This is the main entry point for the converter.
   * The conversion is "dumb" - no resolution, no API calls.
   *
   * @param steps Array of IntentSteps
   * @param startUrl Starting URL
   * @param intentTestCaseId Optional parent test case ID for heal persistence
   */
  static convertToCommands(
    steps: IntentStep[],
    startUrl: string,
    intentTestCaseId?: string
  ): IntentPlaywrightCommand[] {
    return convertIntentStepsToCommands(steps, startUrl, intentTestCaseId);
  }

  /**
   * Convert a single step (for preview/testing)
   */
  static convertSingleStep(
    step: IntentStep,
    stepIndex: number,
    startUrl?: string
  ): IntentPlaywrightCommand {
    return convertIntentStepToCommand(step, stepIndex, startUrl);
  }
}
