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
import type { BindingHints, CompiledStepPlan, ExpectedStepOutcome, IntentActionType, IntentStep, StepEvidence } from './preview.types';

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
    /** V11: Expected outcome for 4xx detection (default: 'success') */
    expectedOutcome?: ExpectedStepOutcome;
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
    // V6: File upload
    case 'upload':
      return 'upload';
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
    default:
      return undefined;
  }
}

/**
 * Keyword-based heuristic to classify whether a step expects an error outcome.
 *
 * Uses description analysis. NO AI call — pure heuristic for speed.
 * Deliberately conservative: only returns 'error' when signals are strong.
 * Default is always 'success' (safe for existing tests).
 *
 * V11: Negative test auto-detection for 4xx handling in replay.
 */
function classifyExpectedOutcome(step: IntentStep): ExpectedStepOutcome {
  const desc = (step.description || '').toLowerCase();

  // Strong negative test indicators in description
  const negativeKeywords = [
    'invalid', 'wrong', 'incorrect', 'bad', 'expired', 'empty form',
    'without', 'missing', 'fake', 'nonexistent', 'negative test',
    'should fail', 'should error', 'submit empty', 'submit invalid',
    'try submitting empty', 'enter invalid', 'enter wrong', 'enter incorrect',
  ];

  const hasNegativeKeyword = negativeKeywords.some(kw => desc.includes(kw));
  if (!hasNegativeKeyword) return 'success';

  // Only classify as 'error' for submit-like actions:
  // - 'click': clicking a button/submit (any click on a negative-described step)
  // - 'press': ONLY Enter/Return/NumpadEnter — NOT Tab, Escape, Space, etc.
  //   Tab/Escape with negative keywords are navigation/dismiss actions, not form submissions.
  const SUBMIT_KEYS = ['Enter', 'Return', 'NumpadEnter'];
  const isSubmitLike =
    step.type === 'click' ||
    (step.type === 'press' && SUBMIT_KEYS.includes(step.value || ''));
  if (isSubmitLike) return 'error';

  return 'success'; // Conservative default
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
    continueOnError: false,

    // Intent metadata for runtime resolution
    intentMeta: {
      stepId: step.id,
      intentDescription: step.description,
      compiled: step.compiled,
      evidence: step.evidence,
      bindingHints: step.bindingHints,
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
      // Iframe metadata (if step is within an iframe)
      ...(step.options?.iframe?.selector && {
        iframeSelector: step.options.iframe.selector,
      }),
      // V11: Expected outcome for 4xx detection in replay
      expectedOutcome: step.expectedOutcome || classifyExpectedOutcome(step),
    },
  };

  // Add selector if compiled plan available
  if (primarySelector) {
    command.selector = primarySelector;
  }

  // Handle specific action types
  switch (step.type) {
    case 'type':
      command.value = step.value || '';
      // V10: Pass pressEnter flag to intentMeta so executor knows
      // to press Enter after type without calling AI
      if (step.options?.pressEnter && command.intentMeta) {
        command.intentMeta.pressEnter = true;
      }
      break;

    case 'navigate':
      // For navigate, use the value as URL, or fallback to test case startUrl
      command.url = step.value || testCaseStartUrl;
      command.waitFor = 'domcontentloaded';
      break;

    case 'press':
      // For press, value is the key to press (e.g., "Enter", "Tab")
      command.value = step.value || 'Enter';
      break;

    case 'select':
      // For select, value is the option to select
      command.value = step.value || '';
      break;

    case 'wait': {
      // For wait, value might be time in ms
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

    case 'scroll':
      // Scroll doesn't need value, but may have selector
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

    default:
      // For click, hover, check, uncheck, toggle, open, close
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
      waitFor: 'domcontentloaded',
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
