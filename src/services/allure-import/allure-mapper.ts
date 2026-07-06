/**
 * Allure → IntentTestCase Mapper
 *
 * Transforms AllureTestResult objects into IntentTestCase creation params:
 *  - Flattens nested Allure step trees and uses AI to convert them to IntentSteps
 *  - AI infers IntentActionType, description, and value from step context
 *  - Extracts labels (epic/parentSuite → Module, feature/suite → Flow, severity → priority)
 *  - Resolves/creates Modules and Flows (with an in-process cache to avoid
 *    redundant DB round-trips)
 *  - Links container befores/afters as preconditions
 *  - Returns a create-params object ready for IntentTestCaseService.create()
 */

import { randomUUID } from 'crypto';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { ModuleService } from '@/services/testing/modules/module.service';
import { FlowService } from '@/services/testing/flows/flow.service';
import { PlatformService } from '@/services/testing/platforms/platform.service';
import type { IntentStep, IntentActionType } from '@/services/testing/ui/preview/preview.types';
import type {
  AllureTestResult,
  AllureContainer,
  AllureStep,
  AllureLabel,
  AllureImportResultHierarchy,
  AllureImportedModuleNode,
  AllureImportedFlowNode,
  AllureImportedTestNode,
  ImportPlatform,
} from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Step tree flattening (pre-AI: extract raw step data)
// ─────────────────────────────────────────────────────────────────────────────

interface FlattenedRawStep {
  name: string;
  status?: string;
  value?: string; // from first visible parameter
  parentName?: string; // parent grouping step name for context
  /**
   * Expected-result text derived from the Allure step's statusDetails
   * (failure message / expected-vs-actual). Parity with the CSV path's
   * per-step `expected[]`: the AI converter emits one assert per entry right
   * after the action step, so ZIP assertions aren't lost. See the ZIP-parity
   * audit (statusDetails was previously dropped entirely).
   */
  expected?: string[];
}

/**
 * Recursively walk an Allure step tree and collect leaf steps as raw data.
 * Parent grouping step names are passed as context so AI can understand
 * what section each leaf step belongs to.
 */
function flattenRawSteps(allureSteps: AllureStep[], parentName?: string): FlattenedRawStep[] {
  const result: FlattenedRawStep[] = [];

  for (const step of allureSteps) {
    const children = step.steps ?? [];

    if (children.length > 0) {
      // Grouping step — recurse with this step's name as parent context
      result.push(...flattenRawSteps(children, step.name));
    } else {
      // Leaf step — extract value from first non-masked parameter
      const visibleParam = step.parameters?.find(
        (p) => p.mode !== 'masked' && p.mode !== 'hidden' && p.value,
      );

      // statusDetails.message carries the failure / expected-vs-actual text on
      // a non-passed step — the closest thing the ZIP format has to an
      // "expected result". Capture it (NOT `trace`, which is a stacktrace).
      // Skip empty and obvious stacktrace-only blobs (multi-line with file:line
      // noise) so we don't feed garbage to the assert generator.
      const msg = step.statusDetails?.message?.trim();
      const expected = msg && msg.length > 0 && msg.length <= MAX_EXPECTED_SOURCE_CHARS && !/\n\s*at\s/.test(msg)
        ? [msg]
        : undefined;

      result.push({
        name: step.name,
        status: step.status,
        value: visibleParam?.value,
        parentName,
        ...(expected && { expected }),
      });
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI step conversion
// ─────────────────────────────────────────────────────────────────────────────

/** Valid action types for the AI prompt. Exported for reuse in CSV/PDF parsers. */
export const VALID_ACTION_TYPES: IntentActionType[] = [
  'navigate', 'click', 'type', 'select', 'hover', 'scroll', 'press',
  'assert', 'wait', 'check', 'uncheck', 'upload', 'dblclick', 'drag_and_drop',
];

interface AIStepResult {
  type: IntentActionType;
  description: string;
  value?: string;
}

/**
 * Result of an AI step conversion. `degraded` is true when at least one batch
 * fell back to the deterministic all-'click' mapping (AI call or JSON parse
 * failed) — the steps still exist but their action TYPES are unreliable. The
 * caller bumps `stats.testsWithDegradedSteps` so the user can review them.
 *
 * Note: a JSON parse failure that yields an empty batch is NOT degraded — that
 * path produces no steps rather than wrong ones; only the exception fallback
 * (which fabricates 'click' steps) sets the flag.
 */
export interface AIStepConversionResult {
  steps: IntentStep[];
  degraded: boolean;
}

/**
 * Max length of a generated step `description`. Applied to every step the
 * converter emits (action + assert, AI + fallback) and surfaced to the model
 * in the prompt so the two never drift. Exported so the CSV scenario parser
 * caps its action descriptions the same way (single source of truth).
 */
export const MAX_STEP_DESC_CHARS = 120;

/**
 * Max length of an Allure `statusDetails.message` we accept as an expected
 * result on the ZIP path. Longer blobs are almost always stacktraces / dumps,
 * not human-readable expectations — skipped so we don't feed garbage to the
 * assert generator.
 */
const MAX_EXPECTED_SOURCE_CHARS = 300;

/**
 * Build the step-conversion system prompt.
 *
 * Conservation-biased by design: imported steps are curated test documentation
 * (TestOps exports, authored Allure steps), NOT noisy automation logs — the
 * model's job is to normalize types, never to filter. The old prompt's SKIP
 * rules ("skip non-UI", "skip redundant", "return [] if nothing meaningful")
 * silently reduced multi-step test cases to 1-2 steps in production.
 *
 * Platform-aware: mobile imports were previously told they target a "web
 * testing platform", giving the model license to drop mobile-shaped steps.
 */
function buildStepConversionSystemPrompt(platform: ImportPlatform): string {
  const platformLabel = platform === 'web'
    ? 'web application'
    : 'mobile application (Android/iOS)';

  return `You convert imported test-case steps into UI test actions for a ${platformLabel} testing platform.

## Input
You receive a test name and its steps, imported from an Allure report or TestOps export. Each step has:
- name: the step text as the QA engineer wrote it
- value: parameter value (if any)
- parent: parent grouping step name (context)
- status: passed/failed/broken/skipped
- optional "expected results" listed under the step

## Output
Convert EVERY step into a UI test action. These steps are curated test documentation written by a QA engineer — your job is to normalize them, NOT to filter them.

## Action types (pick the most specific one)
- navigate: Go to a URL, open a page/screen, redirect
- click: Click/tap a button, link, element, submit
- type: Type/fill text into an input field, textarea, search box
- select: Choose an option from a dropdown/select/combobox
- hover: Mouse over an element
- scroll: Scroll page or element
- press: Press a keyboard key (Enter, Tab, Escape, etc.)
- assert: Verify something is visible, exists, has text, matches condition
- wait: Wait for page load, element to appear, timeout
- check: Check a checkbox, enable a toggle
- uncheck: Uncheck a checkbox, disable a toggle
- upload: Upload/attach a file
- dblclick: Double-click an element
- drag_and_drop: Drag element to another position

## Rules
1. PRESERVE EVERY STEP: each input step becomes EXACTLY ONE action, in the same order. Never drop, merge, or summarize steps. N input steps must produce at least N output actions.
2. SPLIT composite ACTIONS only: "Enter email and click Submit" → two actions (type + click). Splitting adds actions; dropping is never allowed. Do NOT split a single assertion sentence into multiple asserts.
3. If a step is ambiguous or technical (API call, precondition, log statement), still convert it: use "assert" if it describes a verification or expected state, otherwise "click", keeping the original text as the description.
4. For "type" actions: put the typed value in "value" field. If step says 'Type "hello"' → value: "hello"
5. For "navigate" actions: put the URL in "value" field if present
6. For "press" actions: put the key name in "value" field (e.g. "Enter", "Tab", "Escape")
7. For "assert" actions: write what should be verified as the description (e.g. "Verify error message is displayed")
8. EXPECTED RESULTS: when a step lists "expected results", emit exactly ONE assert per expected-result item, and place those asserts IMMEDIATELY AFTER that step's action (before the next step). Never merge several expected results into one assert, never drop one, and never move them away from their step. The action step keeps its own type (click/type/...).
9. Description should be clear, concise, human-readable (not code), in the SAME LANGUAGE as the source step. Max ${MAX_STEP_DESC_CHARS} chars.
10. Preserve the logical order of steps.

## Response format
Return a JSON object with a "steps" array:
{
  "steps": [
    { "type": "navigate", "description": "Open login page", "value": "https://example.com/login" },
    { "type": "type", "description": "Enter email address", "value": "user@test.com" },
    { "type": "click", "description": "Click Sign In button" },
    { "type": "assert", "description": "Verify dashboard is displayed" }
  ]
}`;
}

/**
 * Maximum raw steps to send in a single AI call.
 *
 * Halved from 50: the conversion model is a reasoning-tier model whose hidden
 * reasoning tokens count against `max_tokens`, so large batches risk truncated
 * JSON (which used to silently delete the whole batch). 25 steps × ~50 output
 * tokens ≈ 1250 tokens of payload, leaving generous reasoning headroom.
 */
const AI_STEP_BATCH_SIZE = 25;

/**
 * Minimum acceptable output/input step ratio for LARGE batches. Below this we
 * assume steps were dropped and retry once, then fall back to the deterministic
 * 1:1 mapping. Not 1.0 for large batches because a long list may legitimately
 * contain a few noise lines the model won't fabricate actions for; splitting
 * can only ADD steps, so the ratio only guards against loss.
 */
const MIN_CONVERSION_RATIO = 0.8;

/**
 * Minimum output steps required for a batch of `inputCount` steps.
 *
 * Small batches demand ZERO loss: the reported bug was multi-step tests
 * collapsing to 1-2 steps, which are exactly small inputs — a 3-step test that
 * returns 2 steps must trigger the guard. Only once a batch is large enough
 * that a ratio is meaningful do we tolerate a handful of unconverted lines.
 */
function minStepsFor(inputCount: number): number {
  if (inputCount <= 5) return inputCount;
  return Math.max(5, Math.ceil(inputCount * MIN_CONVERSION_RATIO));
}

/**
 * A source step normalized for AI conversion — the common denominator of the
 * ZIP path (FlattenedRawStep) and the CSV path (ParsedTestCaseFromLLM steps).
 */
interface NormalizedStep {
  text: string;
  value?: string;
  parentName?: string;
  status?: string;
  expected?: string[];
}

/**
 * Parse an AI response into step entries.
 * Returns null on JSON parse failure (typically max_tokens truncation) so the
 * caller can retry/fall back — an unparseable batch must NEVER be treated as
 * "the model found no steps" (that silently deleted up to a full batch of
 * steps in production, with `degraded` never set).
 */
function parseAIStepsContent(rawContent: string): AIStepResult[] | null {
  try {
    const json = JSON.parse(rawContent);
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.steps)) return json.steps;
    return [];
  } catch {
    return null;
  }
}

/** Validate AI step entries and convert to IntentSteps (malformed entries dropped). */
function toIntentSteps(parsed: AIStepResult[]): IntentStep[] {
  const result: IntentStep[] = [];
  for (const step of parsed) {
    if (!step || typeof step !== 'object') continue;

    const desc = typeof step.description === 'string' ? step.description.trim() : '';
    if (!desc) continue;

    result.push({
      id: randomUUID(),
      type: VALID_ACTION_TYPES.includes(step.type as IntentActionType)
        ? (step.type as IntentActionType)
        : 'click',
      description: desc.slice(0, MAX_STEP_DESC_CHARS),
      ...(step.value !== undefined && step.value !== null && step.value !== '' && {
        value: String(step.value),
      }),
    });
  }
  return result;
}

/**
 * Deterministic 1:1 fallback: every step becomes a 'click' with the original
 * text, every expected result becomes an assert right after its step. Step
 * TYPES are unreliable (caller must set `degraded`), but no step is lost.
 */
function fallbackIntentSteps(batch: NormalizedStep[]): IntentStep[] {
  const result: IntentStep[] = [];
  for (const raw of batch) {
    result.push({
      id: randomUUID(),
      type: 'click',
      description: raw.text.slice(0, MAX_STEP_DESC_CHARS),
      ...(raw.value !== undefined && raw.value !== '' && { value: raw.value }),
    });
    for (const exp of raw.expected ?? []) {
      result.push({
        id: randomUUID(),
        type: 'assert',
        description: exp.slice(0, MAX_STEP_DESC_CHARS),
      });
    }
  }
  return result;
}

/**
 * Convert normalized source steps into IntentSteps using AI, in batches.
 *
 * Conservation contract per batch:
 *  1. AI call → parse → must yield ≥ minStepsFor(batch) steps.
 *  2. Short/unparseable output → ONE corrective retry (previous output echoed
 *     back with an explicit "you dropped steps" instruction).
 *  3. Still short → deterministic 1:1 fallback + degraded flag. A batch can
 *     shrink below the ratio ONLY by explicit fallback, never silently.
 */
async function convertNormalizedStepsWithAI(
  testName: string,
  items: NormalizedStep[],
  platform: ImportPlatform,
): Promise<AIStepConversionResult> {
  if (items.length === 0) return { steps: [], degraded: false };

  const systemPrompt = buildStepConversionSystemPrompt(platform);
  const allResults: IntentStep[] = [];
  let degraded = false;

  for (let i = 0; i < items.length; i += AI_STEP_BATCH_SIZE) {
    const batch = items.slice(i, i + AI_STEP_BATCH_SIZE);
    const batchNum = Math.floor(i / AI_STEP_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(items.length / AI_STEP_BATCH_SIZE);

    const stepsText = batch
      .map((s, idx) => {
        const parts = [`${i + idx + 1}. "${s.text}"`];
        if (s.value) parts.push(`value="${s.value}"`);
        if (s.parentName) parts.push(`(in: "${s.parentName}")`);
        if (s.status && s.status !== 'passed') parts.push(`[${s.status}]`);
        // Expected results are listed under their step so the model emits one
        // assert per item, right after the action — preserving the link.
        if (s.expected?.length) {
          parts.push(
            '\n   expected results (emit one assert each, right after this step):\n' +
            s.expected.map((e) => `     - ${e}`).join('\n'),
          );
        }
        return parts.join(' ');
      })
      .join('\n');

    const batchContext = totalBatches > 1
      ? ` (batch ${batchNum}/${totalBatches}, steps ${i + 1}-${Math.min(i + AI_STEP_BATCH_SIZE, items.length)})`
      : '';

    const baseMessages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: `Test: "${testName}"${batchContext}\n\nSteps:\n${stepsText}` },
    ];

    const callModel = async (
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    ): Promise<string> => {
      const response = await getChatCompletionWithMessages(messages, {
        model: AI_TASK_MODELS.allureStepConvert,
        temperature: 0,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        // Mechanical normalization task — low effort keeps reasoning tokens
        // from eating the output budget (truncated JSON = dropped steps).
        reasoning_effort: 'low',
      });
      return response.content?.trim() ?? '';
    };

    try {
      let rawContent = await callModel(baseMessages);
      let parsed = parseAIStepsContent(rawContent);
      let steps = parsed === null ? null : toIntentSteps(parsed);

      // Conservation guard: unparseable OR fewer steps than the floor →
      // one corrective retry before falling back.
      if (steps === null || steps.length < minStepsFor(batch.length)) {
        logger.warn('[AllureMapper] AI batch under-converted, retrying once', {
          testName,
          batch: batchNum,
          inputSteps: batch.length,
          outputSteps: steps?.length ?? 'unparseable',
        });

        rawContent = await callModel([
          ...baseMessages,
          { role: 'assistant', content: rawContent.slice(0, 2000) },
          {
            role: 'user',
            content:
              `Your response had ${steps === null ? 'invalid JSON' : `only ${steps.length} steps`} ` +
              `for ${batch.length} input steps. Every input step must become at least one action — ` +
              `do not drop, merge, or summarize any step. Return the full corrected JSON.`,
          },
        ]);
        parsed = parseAIStepsContent(rawContent);
        steps = parsed === null ? null : toIntentSteps(parsed);
      }

      if (steps === null || steps.length < minStepsFor(batch.length)) {
        logger.warn('[AllureMapper] AI batch still under-converted after retry, using 1:1 fallback', {
          testName,
          batch: batchNum,
          inputSteps: batch.length,
          outputSteps: steps?.length ?? 'unparseable',
        });
        degraded = true;
        allResults.push(...fallbackIntentSteps(batch));
      } else {
        allResults.push(...steps);
      }
    } catch (err) {
      logger.warn('[AllureMapper] AI step conversion failed, using 1:1 fallback', {
        testName,
        batch: batchNum,
        stepsCount: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
      degraded = true;
      allResults.push(...fallbackIntentSteps(batch));
    }
  }

  return { steps: allResults, degraded };
}

/**
 * Convert flattened Allure steps (ZIP path) into IntentSteps using AI.
 */
async function convertStepsWithAI(
  testName: string,
  rawSteps: FlattenedRawStep[],
  platform: ImportPlatform,
): Promise<AIStepConversionResult> {
  return convertNormalizedStepsWithAI(
    testName,
    rawSteps.map((s) => ({
      text: s.name,
      value: s.value,
      parentName: s.parentName,
      status: s.status,
      expected: s.expected,
    })),
    platform,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV/PDF step conversion (exported for use by processCsvPdfImport)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert simple step descriptions (from the CSV parser) into proper
 * IntentSteps using AI. The AI determines the correct action type, cleans up
 * descriptions, splits composite steps, and extracts values.
 *
 * Same conservation contract as the ZIP path (see convertNormalizedStepsWithAI):
 * an under-converted or unparseable batch retries once, then falls back to the
 * deterministic 1:1 mapping with `degraded` set.
 *
 * @param testName - Test case name (context for AI)
 * @param rawSteps - Steps from the deterministic CSV parser
 * @param platform - Import target platform (framing for the AI prompt)
 */
export async function convertImportedStepsWithAI(
  testName: string,
  rawSteps: Array<{ type: string; description: string; value?: string; expected?: string[] }>,
  platform: ImportPlatform = 'web',
): Promise<AIStepConversionResult> {
  return convertNormalizedStepsWithAI(
    testName,
    rawSteps.map((s) => ({
      text: s.description,
      value: s.value,
      expected: s.expected,
    })),
    platform,
  );
}

/**
 * Finalize steps that ALREADY carry real action types — the PDF path.
 *
 * The PDF parser's LLM infers types and per-step expected results in the same
 * pass that extracts the test cases, so running its output through the step
 * converter was a SECOND lossy LLM pass over the same data (production imports
 * lost steps to it). This is the deterministic replacement: validate the type,
 * cap the description, emit one assert per expected item right after its step.
 * No LLM, nothing can be dropped, not degraded.
 */
export function finalizeTypedSteps(
  rawSteps: Array<{ type: string; description: string; value?: string; expected?: string[] }>,
): IntentStep[] {
  const result: IntentStep[] = [];
  for (const s of rawSteps) {
    const desc = (s.description ?? '').trim();
    if (!desc) continue;

    result.push({
      id: randomUUID(),
      type: VALID_ACTION_TYPES.includes(s.type as IntentActionType)
        ? (s.type as IntentActionType)
        : 'click',
      description: desc.slice(0, MAX_STEP_DESC_CHARS),
      ...(s.value != null && s.value !== '' && { value: String(s.value) }),
    });
    for (const exp of s.expected ?? []) {
      result.push({
        id: randomUUID(),
        type: 'assert',
        description: exp.slice(0, MAX_STEP_DESC_CHARS),
      });
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Label extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractedLabels {
  /**
   * Module name — resolved with fallback chain:
   *   epic → parentSuite → suite (when no epic/parentSuite)
   */
  moduleName?: string;
  /**
   * Flow name — resolved with fallback chain:
   *   feature → suite (when module came from parentSuite) → subSuite
   */
  flowName?: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  tags: string[];
  descriptionSuffix: string; // Extra context from story/layer/owner labels
}

/**
 * Extract hierarchy and metadata labels from an Allure test result.
 *
 * Allure supports TWO navigation hierarchies:
 *   Behaviors:  epic → feature → story
 *   Suites:     parentSuite → suite → subSuite
 *
 * Our platform hierarchy:  Module → Flow → TestCase
 *
 * Resolution strategy (first non-empty wins):
 *   Module ← epic  ‖  parentSuite  ‖  suite (only if no parentSuite)
 *   Flow   ← feature  ‖  suite (when module came from parentSuite)  ‖  subSuite
 *
 * This ensures projects using BDD-style (epic/feature) AND projects using
 * JUnit/NUnit-style (parentSuite/suite/subSuite) both produce meaningful
 * hierarchy instead of everything landing in "Unassigned".
 */
function extractLabels(labels: AllureLabel[]): ExtractedLabels {
  const byName = (name: string) =>
    labels.filter((l) => l.name === name).map((l) => l.value);

  // ── BDD hierarchy labels ────────────────────────────────────────────────
  const epicNames      = byName('epic');
  const featureNames   = byName('feature');
  const stories        = byName('story');

  // ── Suite hierarchy labels (fallback) ───────────────────────────────────
  const parentSuites   = byName('parentSuite');
  const suiteNames     = byName('suite');
  const subSuites      = byName('subSuite');

  // ── Metadata labels ─────────────────────────────────────────────────────
  const severities     = byName('severity');
  const tagValues      = byName('tag');
  const layers         = byName('layer');
  const owners         = byName('owner');

  // ── Resolve Module name (fallback chain) ────────────────────────────────
  let moduleName: string | undefined;
  let moduleSource: 'epic' | 'parentSuite' | 'suite' | undefined;

  if (epicNames[0]) {
    moduleName = epicNames[0];
    moduleSource = 'epic';
  } else if (parentSuites[0]) {
    moduleName = parentSuites[0];
    moduleSource = 'parentSuite';
  } else if (suiteNames[0] && !featureNames[0] && !subSuites[0]) {
    // suite as module ONLY when it's the sole grouping label
    // (no feature/subSuite to disambiguate flow-level meaning)
    moduleName = suiteNames[0];
    moduleSource = 'suite';
  }

  // ── Resolve Flow name (fallback chain) ──────────────────────────────────
  let flowName: string | undefined;

  if (featureNames[0]) {
    flowName = featureNames[0];
  } else if (moduleSource === 'parentSuite' && suiteNames[0]) {
    // parentSuite is the module → suite becomes the flow
    flowName = suiteNames[0];
  } else if (subSuites[0]) {
    flowName = subSuites[0];
  }

  // ── Priority from severity ──────────────────────────────────────────────
  // Allure severity order: blocker > critical > normal > minor > trivial
  // Mapped to our priority: critical > high > medium > low
  const severity = severities[0]?.toLowerCase() ?? '';
  let priority: ExtractedLabels['priority'] = 'medium';
  if (severity === 'blocker' || severity === 'critical') priority = 'critical';
  else if (severity === 'major')                         priority = 'high';
  else if (severity === 'normal')                        priority = 'medium';
  else if (severity === 'minor' || severity === 'trivial') priority = 'low';

  // ── Composite tags ──────────────────────────────────────────────────────
  const tags: string[] = [
    ...tagValues,
    ...stories.map((s) => `story:${s}`),
    ...layers.map((l) => `layer:${l}`),
    ...owners.map((o) => `owner:${o}`),
  ];

  // ── Description suffix from story labels ────────────────────────────────
  const descriptionSuffix = stories.length > 0
    ? `\n\n**Story:** ${stories.join(', ')}`
    : '';

  return {
    moduleName,
    flowName,
    priority,
    tags,
    descriptionSuffix,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Description builder
// ─────────────────────────────────────────────────────────────────────────────

function buildDescription(
  result: AllureTestResult,
  descSuffix: string,
  preconditions: string[],
): string {
  const parts: string[] = [];

  if (result.description) {
    parts.push(result.description);
  }

  // Preconditions from Allure container befores (before-fixtures)
  if (preconditions.length > 0) {
    const list = preconditions.map((p) => `- ${p}`).join('\n');
    parts.push(`**Preconditions:**\n${list}`);
  }

  // Status context (useful for failed/broken test cases)
  if (result.status && result.status !== 'passed') {
    parts.push(`**Status:** ${result.status}`);
  }

  if (result.statusDetails?.message) {
    parts.push(`**Failure message:** ${result.statusDetails.message}`);
  }

  // External links (Jira issues, TMS, etc.)
  if (result.links.length > 0) {
    const linkLines = result.links.map((l) => {
      const label = l.name ?? l.type ?? 'link';
      return `- [${label}](${l.url})`;
    });
    parts.push(`**Links:**\n${linkLines.join('\n')}`);
  }

  if (descSuffix) parts.push(descSuffix);

  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchy cache (module + flow resolution with in-memory dedup)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Caches module and flow IDs to avoid redundant DB lookups or duplicate
 * creates across multiple test results in the same import batch.
 *
 * Key format:
 *   moduleCache: `${projectId}::${epicName}` → moduleId | null
 *   flowCache:   `${moduleId}::${featureName}` → flowId | null
 */
export class HierarchyCache {
  private readonly moduleCache = new Map<string, string | null>();
  private readonly flowCache   = new Map<string, string | null>();

  /** Number of NEW modules created during this import batch. */
  public modulesCreated = 0;
  /** Number of NEW flows created during this import batch. */
  public flowsCreated = 0;

  // ── Hierarchy tree tracking ───────────────────────────────────────────────
  /** Module metadata: id → { name, isNew } */
  private readonly moduleInfo = new Map<string, { name: string; isNew: boolean }>();
  /** Flow metadata: id → { name, isNew, moduleId } */
  private readonly flowInfo = new Map<string, { name: string; isNew: boolean; moduleId: string }>();
  /** Test nodes tracked per flow or unassigned. Key: flowId or '__unassigned__' */
  private readonly testsByFlow = new Map<string, AllureImportedTestNode[]>();
  /** Flow IDs grouped by module. Key: moduleId */
  private readonly flowsByModule = new Map<string, Set<string>>();

  /**
   * Register a test node in the hierarchy tree.
   *
   * When a test has a moduleId but no flowId (epic label without feature label),
   * it's placed under a synthetic "General" flow within that module — instead of
   * falling through to the "unassigned" bucket.
   */
  addTestNode(node: AllureImportedTestNode, flowId?: string, moduleId?: string): void {
    let key: string;

    if (flowId) {
      key = flowId;
    } else if (moduleId) {
      // Module exists but no flow — use synthetic "General" flow under this module
      const syntheticKey = `__general__::${moduleId}`;
      key = syntheticKey;

      // Register the synthetic flow node once
      if (!this.flowInfo.has(syntheticKey)) {
        this.flowInfo.set(syntheticKey, { name: 'General', isNew: false, moduleId });
        if (!this.flowsByModule.has(moduleId)) this.flowsByModule.set(moduleId, new Set());
        this.flowsByModule.get(moduleId)!.add(syntheticKey);
      }
    } else {
      key = '__unassigned__';
    }

    let list = this.testsByFlow.get(key);
    if (!list) {
      list = [];
      this.testsByFlow.set(key, list);
    }
    list.push(node);
  }

  /** Build the final hierarchy for the frontend popup. */
  buildHierarchy(): AllureImportResultHierarchy {
    const modules: AllureImportedModuleNode[] = [];

    for (const [moduleId, moduleData] of this.moduleInfo) {
      const flowIds = this.flowsByModule.get(moduleId) ?? new Set();
      const flows: AllureImportedFlowNode[] = [];

      for (const flowId of flowIds) {
        const flowData = this.flowInfo.get(flowId);
        if (!flowData) continue;
        flows.push({
          id: flowId,
          name: flowData.name,
          isNew: flowData.isNew,
          tests: this.testsByFlow.get(flowId) ?? [],
        });
      }

      modules.push({
        id: moduleId,
        name: moduleData.name,
        isNew: moduleData.isNew,
        flows,
      });
    }

    return {
      modules,
      unassigned: this.testsByFlow.get('__unassigned__') ?? [],
    };
  }

  /**
   * Prefetched module list for a project (fetched once, reused for all lookups).
   * Key: `${projectId}::${platformId}` — ensures one fetch per project+platform.
   */
  private readonly prefetchedModules = new Map<string, Map<string, { id: string; name: string }>>();

  /**
   * Fetch all modules for a project once and cache by lowercase name.
   * Subsequent calls with the same projectId+platformId return the cached map.
   */
  private async getModulesByName(
    projectId: string,
    userId: string,
    platformId: string,
  ): Promise<Map<string, { id: string; name: string }>> {
    const pfKey = `${projectId}::${platformId}`;
    if (this.prefetchedModules.has(pfKey)) {
      return this.prefetchedModules.get(pfKey)!;
    }

    const map = new Map<string, { id: string; name: string }>();
    try {
      const { items } = await ModuleService.listByProject(projectId, userId, {
        limit: 1000,
        platformId,
      });
      for (const m of items) {
        map.set(m.name.toLowerCase(), { id: m.id, name: m.name });
      }
    } catch (err) {
      logger.warn('[AllureMapper] Failed to prefetch modules', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.prefetchedModules.set(pfKey, map);
    return map;
  }

  /**
   * Resolve (or create) a Module for the given epic label.
   * Returns the module ID, or null if not applicable / creation fails.
   */
  async resolveModule(params: {
    projectId: string;
    userId: string;
    platformId: string;
    epicName: string;
    autoCreate: boolean;
  }): Promise<string | null> {
    const { projectId, userId, platformId, epicName, autoCreate } = params;
    const cacheKey = `${projectId}::${epicName}`;

    if (this.moduleCache.has(cacheKey)) {
      return this.moduleCache.get(cacheKey) ?? null;
    }

    try {
      // Single prefetch for all modules — reused across all resolveModule calls
      const modulesByName = await this.getModulesByName(projectId, userId, platformId);
      const existing = modulesByName.get(epicName.toLowerCase());

      if (existing) {
        this.moduleCache.set(cacheKey, existing.id);
        this.moduleInfo.set(existing.id, { name: existing.name, isNew: false });
        return existing.id;
      }

      if (!autoCreate) {
        this.moduleCache.set(cacheKey, null);
        return null;
      }

      // Create new module
      const created = await ModuleService.create({
        projectId,
        userId,
        platformId,
        name: epicName,
        description: `Auto-created from Allure epic label during import`,
      });

      logger.info('[AllureMapper] Created module from Allure epic', {
        moduleId: created.id,
        epicName,
        projectId,
      });

      this.modulesCreated++;
      this.moduleCache.set(cacheKey, created.id);
      this.moduleInfo.set(created.id, { name: epicName, isNew: true });
      // Also add to prefetched map so subsequent lookups find it
      modulesByName.set(epicName.toLowerCase(), { id: created.id, name: epicName });
      return created.id;
    } catch (err) {
      logger.warn('[AllureMapper] Failed to resolve/create module', {
        epicName,
        error: err instanceof Error ? err.message : String(err),
      });
      this.moduleCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Prefetched flow list per module (fetched once per moduleId, reused).
   */
  private readonly prefetchedFlows = new Map<string, Map<string, { id: string; name: string }>>();

  /**
   * Fetch all flows for a module once and cache by lowercase name.
   */
  private async getFlowsByName(
    moduleId: string,
    userId: string,
  ): Promise<Map<string, { id: string; name: string }>> {
    if (this.prefetchedFlows.has(moduleId)) {
      return this.prefetchedFlows.get(moduleId)!;
    }

    const map = new Map<string, { id: string; name: string }>();
    try {
      const flows = await FlowService.listByModule(moduleId, userId);
      for (const f of flows) {
        map.set(f.name.toLowerCase(), { id: f.id, name: f.name });
      }
    } catch (err) {
      logger.warn('[AllureMapper] Failed to prefetch flows', {
        moduleId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.prefetchedFlows.set(moduleId, map);
    return map;
  }

  /**
   * Resolve (or create) a Flow for the given feature label under a module.
   * Returns the flow ID, or null if not applicable / creation fails.
   */
  async resolveFlow(params: {
    moduleId: string;
    userId: string;
    featureName: string;
    autoCreate: boolean;
  }): Promise<string | null> {
    const { moduleId, userId, featureName, autoCreate } = params;
    const cacheKey = `${moduleId}::${featureName}`;

    if (this.flowCache.has(cacheKey)) {
      return this.flowCache.get(cacheKey) ?? null;
    }

    try {
      // Single prefetch per module — reused for all resolveFlow calls
      const flowsByName = await this.getFlowsByName(moduleId, userId);
      const existing = flowsByName.get(featureName.toLowerCase());

      if (existing) {
        this.flowCache.set(cacheKey, existing.id);
        this.flowInfo.set(existing.id, { name: existing.name, isNew: false, moduleId });
        if (!this.flowsByModule.has(moduleId)) this.flowsByModule.set(moduleId, new Set());
        this.flowsByModule.get(moduleId)!.add(existing.id);
        return existing.id;
      }

      if (!autoCreate) {
        this.flowCache.set(cacheKey, null);
        return null;
      }

      const created = await FlowService.create({
        moduleId,
        userId,
        name: featureName,
      });

      logger.info('[AllureMapper] Created flow from Allure feature', {
        flowId: created.id,
        featureName,
        moduleId,
      });

      this.flowsCreated++;
      this.flowCache.set(cacheKey, created.id);
      this.flowInfo.set(created.id, { name: featureName, isNew: true, moduleId });
      if (!this.flowsByModule.has(moduleId)) this.flowsByModule.set(moduleId, new Set());
      this.flowsByModule.get(moduleId)!.add(created.id);
      // Add to prefetched map so subsequent lookups find it
      flowsByName.set(featureName.toLowerCase(), { id: created.id, name: featureName });
      return created.id;
    } catch (err) {
      logger.warn('[AllureMapper] Failed to resolve/create flow', {
        featureName,
        error: err instanceof Error ? err.message : String(err),
      });
      this.flowCache.set(cacheKey, null);
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface MappedTestCase {
  /** Params for IntentTestCaseService.create() */
  createParams: {
    projectId: string;
    userId: string;
    name: string;
    description: string;
    steps: IntentStep[];
    flowId?: string;
    status: 'draft';
    kind: 'standalone';
    platform: ImportPlatform;
    tags: string[];
    priority: 'critical' | 'high' | 'medium' | 'low';
    preconditions: string[];
  };
  /** Resolved module ID (for hierarchy tree). */
  moduleId?: string;
  /** Source UUID from Allure, for cross-referencing. */
  sourceUuid: string;
  /** Source testCaseId from Allure, for dedup checks. */
  sourceTestCaseId?: string;
  /**
   * True when AI step conversion fell back to all-'click' for at least one
   * batch — step types are unreliable. Caller bumps stats.testsWithDegradedSteps.
   */
  stepsDegraded: boolean;
}

export interface MapperOptions {
  projectId: string;
  userId: string;
  autoCreateModules: boolean;
  autoCreateFlows: boolean;
  /** Platform written to each created test case. Default: 'web'. */
  platform: ImportPlatform;
}

/**
 * Resolve module + flow from label names using the HierarchyCache.
 * Shared hierarchy resolution logic used by mapAllureResult.
 */
export async function resolveHierarchy(
  cache: HierarchyCache,
  platformTreeId: string,
  opts: MapperOptions,
  moduleName?: string,
  flowName?: string,
): Promise<{ moduleId?: string; flowId?: string }> {
  if (!moduleName) return {};

  const moduleId = await cache.resolveModule({
    projectId: opts.projectId,
    userId: opts.userId,
    platformId: platformTreeId,
    epicName: moduleName,
    autoCreate: opts.autoCreateModules,
  });

  if (!moduleId) return {};

  let flowId: string | undefined;
  if (flowName) {
    const resolved = await cache.resolveFlow({
      moduleId,
      userId: opts.userId,
      featureName: flowName,
      autoCreate: opts.autoCreateFlows,
    });
    if (resolved) flowId = resolved;
  }

  return { moduleId, flowId };
}

/**
 * Lightweight label-only mapper — resolves module/flow hierarchy WITHOUT
 * calling AI for step conversion. Used for duplicate tests that need
 * hierarchy placement but not full mapping.
 */
export async function mapAllureResultLabelsOnly(
  result: AllureTestResult,
  cache: HierarchyCache,
  platformTreeId: string,
  opts: MapperOptions,
): Promise<{ moduleId?: string; flowId?: string; priority: ExtractedLabels['priority'] }> {
  const { moduleName, flowName, priority } = extractLabels(result.labels);
  const { moduleId, flowId } = await resolveHierarchy(cache, platformTreeId, opts, moduleName, flowName);
  return { moduleId, flowId, priority };
}

/**
 * Map a single AllureTestResult to a MappedTestCase.
 *
 * @param result          - Parsed Allure result
 * @param containerByUuid - Map from result UUID → container (for preconditions)
 * @param cache           - Shared HierarchyCache for this import batch
 * @param platformTreeId  - The platform-tree node ID (web_ui or mobile) that
 *                          imported Modules/Flows are placed under
 * @param opts            - Import options
 */
export async function mapAllureResult(
  result: AllureTestResult,
  containerByUuid: Map<string, AllureContainer>,
  cache: HierarchyCache,
  platformTreeId: string,
  opts: MapperOptions,
): Promise<MappedTestCase> {
  const { projectId, userId } = opts;

  // ── 1. Flatten + AI-convert steps ──────────────────────────────────────────
  const rawSteps = flattenRawSteps(result.steps);
  const { steps, degraded: stepsDegraded } = await convertStepsWithAI(result.name, rawSteps, opts.platform);

  // ── 2. Extract labels ──────────────────────────────────────────────────────
  const { moduleName, flowName, priority, tags, descriptionSuffix } =
    extractLabels(result.labels);

  // ── 3. Extract preconditions from container (needed before buildDescription) ──
  const container = containerByUuid.get(result.uuid);
  const preconditions: string[] = [];

  if (container?.befores?.length) {
    for (const fixture of container.befores) {
      if (fixture.name) preconditions.push(fixture.name);
    }
  }

  // ── 4. Build description (includes preconditions) ─────────────────────────
  const description = buildDescription(result, descriptionSuffix, preconditions);

  // ── 5. Resolve hierarchy (Module → Flow) ──────────────────────────────────
  const { moduleId: resolvedModuleId, flowId } = await resolveHierarchy(
    cache, platformTreeId, opts, moduleName, flowName,
  );

  // ── 6. Compose create params ──────────────────────────────────────────────
  return {
    sourceUuid: result.uuid,
    sourceTestCaseId: result.testCaseId,
    stepsDegraded,
    ...(resolvedModuleId && { moduleId: resolvedModuleId }),
    createParams: {
      projectId,
      userId,
      name: result.name,
      description,
      steps,
      ...(flowId && { flowId }),
      status: 'draft',
      kind: 'standalone',
      platform: opts.platform,
      tags,
      priority,
      preconditions,
    },
  };
}

/**
 * Resolve the platform-tree node ID that imported Modules/Flows should be
 * placed under, based on the chosen import platform. All three mobile
 * variants share the single `mobile` tree node — the specific variant
 * (android/ios/flutter) lives on each test case's `platform` field, while
 * the tree only distinguishes web vs mobile.
 *
 * Throws if PlatformService fails (caller should handle).
 */
export async function getPlatformTreeId(
  projectId: string,
  userId: string,
  platform: ImportPlatform,
): Promise<string> {
  const platforms = await PlatformService.ensurePlatformsExist(projectId, userId);
  return platform === 'web' ? platforms.webUi.id : platforms.mobile.id;
}
