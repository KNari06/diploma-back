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
} from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Step tree flattening (pre-AI: extract raw step data)
// ─────────────────────────────────────────────────────────────────────────────

interface FlattenedRawStep {
  name: string;
  status?: string;
  value?: string; // from first visible parameter
  parentName?: string; // parent grouping step name for context
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

      result.push({
        name: step.name,
        status: step.status,
        value: visibleParam?.value,
        parentName,
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

const STEP_CONVERSION_SYSTEM_PROMPT = `You convert Allure test report steps into UI test actions for a web testing platform.

## Input
You receive a test name and its steps. Each step has:
- name: the step description from Allure
- value: parameter value (if any)
- parent: parent grouping step name (context)
- status: passed/failed/broken/skipped

## Output
Convert each MEANINGFUL step into a UI test action.

## Action types (pick the most specific one)
- navigate: Go to a URL, open a page, redirect
- click: Click a button, link, element, submit
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
1. SKIP non-UI steps: API calls, database queries, internal assertions about response codes, screenshot captures, log statements, "Given/When/Then" wrappers that contain no action
2. SKIP redundant steps: if "Click Login" and "Login button clicked" both exist, keep only one
3. SPLIT composite steps: "Enter email and click Submit" → two separate actions (type + click)
4. For "type" actions: put the typed value in "value" field. If step says 'Type "hello"' → value: "hello"
5. For "navigate" actions: put the URL in "value" field if present
6. For "press" actions: put the key name in "value" field (e.g. "Enter", "Tab", "Escape")
7. For "assert" actions: write what should be verified as the description (e.g. "Verify error message is displayed")
8. Description should be clear, concise, human-readable (not code). Max 80 chars.
9. If a step is ambiguous but seems like a UI action, include it as "click" with a descriptive description
10. Return empty array [] if there are NO meaningful UI steps
11. Preserve the logical order of steps

## Response format
Return a JSON object with a "steps" array:
{
  "steps": [
    { "type": "navigate", "description": "Open login page", "value": "https://example.com/login" },
    { "type": "type", "description": "Enter email address", "value": "user@test.com" },
    { "type": "click", "description": "Click Sign In button" },
    { "type": "assert", "description": "Verify dashboard is displayed" }
  ]
}
If no meaningful UI steps exist, return: { "steps": [] }`;

/**
 * Maximum raw steps to send in a single AI call.
 * Keeps the prompt under ~4K tokens (each step ~30 tokens).
 * 50 steps × ~50 output tokens each ≈ 2500 tokens — safely within max_tokens.
 */
const AI_STEP_BATCH_SIZE = 50;

/**
 * Convert flattened Allure steps into IntentSteps using AI.
 * For tests with many steps, processes in batches.
 */
async function convertStepsWithAI(
  testName: string,
  rawSteps: FlattenedRawStep[],
): Promise<AIStepConversionResult> {
  if (rawSteps.length === 0) return { steps: [], degraded: false };

  const allResults: IntentStep[] = [];
  let degraded = false;

  // Process in batches to keep prompt size reasonable
  for (let i = 0; i < rawSteps.length; i += AI_STEP_BATCH_SIZE) {
    const batch = rawSteps.slice(i, i + AI_STEP_BATCH_SIZE);
    const batchNum = Math.floor(i / AI_STEP_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(rawSteps.length / AI_STEP_BATCH_SIZE);

    const stepsText = batch
      .map((s, idx) => {
        const parts = [`${idx + 1}. "${s.name}"`];
        if (s.value) parts.push(`value="${s.value}"`);
        if (s.parentName) parts.push(`(in: "${s.parentName}")`);
        if (s.status && s.status !== 'passed') parts.push(`[${s.status}]`);
        return parts.join(' ');
      })
      .join('\n');

    const batchContext = totalBatches > 1
      ? ` (batch ${batchNum}/${totalBatches}, steps ${i + 1}-${Math.min(i + AI_STEP_BATCH_SIZE, rawSteps.length)})`
      : '';

    const userPrompt = `Test: "${testName}"${batchContext}\n\nSteps:\n${stepsText}`;

    try {
      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: STEP_CONVERSION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        {
          model: AI_TASK_MODELS.allureStepConvert,
          temperature: 0,
          max_tokens: 8192,
          response_format: { type: 'json_object' },
        },
      );

      const rawContent = response.content?.trim() ?? '{"steps":[]}';
      // AI returns {steps: [...]} (json_object mode always returns objects)
      let parsed: AIStepResult[];
      try {
        const json = JSON.parse(rawContent);
        if (Array.isArray(json)) {
          parsed = json;
        } else if (Array.isArray(json.steps)) {
          parsed = json.steps;
        } else {
          parsed = [];
        }
      } catch (parseErr) {
        // JSON may be truncated if max_tokens was hit
        logger.warn('[AllureMapper] AI response JSON parse failed (truncated?)', {
          testName,
          batch: batchNum,
          contentLength: rawContent.length,
        });
        parsed = [];
      }

      for (const step of parsed) {
        // Skip malformed entries (AI sometimes returns nulls or strings)
        if (!step || typeof step !== 'object') continue;

        const desc = typeof step.description === 'string' ? step.description.trim() : '';
        if (!desc) continue; // skip steps with no description

        // Validate action type
        const actionType: IntentActionType = VALID_ACTION_TYPES.includes(step.type as IntentActionType)
          ? (step.type as IntentActionType)
          : 'click';

        allResults.push({
          id: randomUUID(),
          type: actionType,
          description: desc.slice(0, 120),
          ...(step.value !== undefined && step.value !== null && step.value !== '' && {
            value: String(step.value),
          }),
        });
      }
    } catch (err) {
      logger.warn('[AllureMapper] AI step conversion failed, using fallback', {
        testName,
        batch: batchNum,
        stepsCount: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });

      // Fallback: create basic steps from raw data without AI. Mark degraded —
      // step types are now unreliable ('click' for everything).
      degraded = true;
      for (const raw of batch) {
        allResults.push({
          id: randomUUID(),
          type: 'click', // safe default
          description: raw.name.slice(0, 120),
          ...(raw.value !== undefined && { value: raw.value }),
        });
      }
    }
  }

  return { steps: allResults, degraded };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV/PDF step conversion (exported for use by processCsvPdfImport)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert simple step descriptions (from CSV/PDF parser) into proper IntentSteps
 * using AI. The AI determines the correct action type, cleans up descriptions,
 * splits composite steps, and extracts values.
 *
 * If AI fails, falls back to deterministic mapping (all steps → type 'click').
 *
 * @param testName - Test case name (context for AI)
 * @param rawSteps - Steps from the deterministic CSV/PDF parser
 * @returns IntentStep[] with correct types, clean descriptions, and UUIDs
 */
export async function convertImportedStepsWithAI(
  testName: string,
  rawSteps: Array<{ type: string; description: string; value?: string }>,
): Promise<AIStepConversionResult> {
  if (rawSteps.length === 0) return { steps: [], degraded: false };

  const allResults: IntentStep[] = [];
  let degraded = false;

  // Process in batches (same limit as ZIP path) to avoid context overflow
  for (let i = 0; i < rawSteps.length; i += AI_STEP_BATCH_SIZE) {
    const batch = rawSteps.slice(i, i + AI_STEP_BATCH_SIZE);
    const batchNum = Math.floor(i / AI_STEP_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(rawSteps.length / AI_STEP_BATCH_SIZE);

    const stepsText = batch
      .map((s, idx) => {
        const parts = [`${i + idx + 1}. "${s.description}"`];
        if (s.value) parts.push(`value="${s.value}"`);
        return parts.join(' ');
      })
      .join('\n');

    const batchContext = totalBatches > 1
      ? ` (batch ${batchNum}/${totalBatches})`
      : '';

    const userPrompt = `Test: "${testName}"${batchContext}\n\nSteps:\n${stepsText}`;

    try {
      const response = await getChatCompletionWithMessages(
        [
          { role: 'system', content: STEP_CONVERSION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        {
          model: AI_TASK_MODELS.allureStepConvert,
          temperature: 0,
          max_tokens: 8192,
          response_format: { type: 'json_object' },
        },
      );

      const rawContent = response.content?.trim() ?? '{"steps":[]}';

      let parsed: AIStepResult[];
      try {
        const json = JSON.parse(rawContent);
        parsed = Array.isArray(json) ? json : Array.isArray(json.steps) ? json.steps : [];
      } catch {
        logger.warn('[AllureMapper] AI step conversion JSON parse failed', { testName, batch: batchNum });
        parsed = [];
      }

      // Trust AI result — even if empty (AI determined no meaningful UI steps)
      for (const s of parsed) {
        if (!s || typeof s !== 'object') continue;
        const desc = typeof s.description === 'string' ? s.description.trim() : '';
        if (!desc) continue;

        allResults.push({
          id: randomUUID(),
          type: VALID_ACTION_TYPES.includes(s.type as IntentActionType)
            ? (s.type as IntentActionType)
            : 'click',
          description: desc.slice(0, 120),
          ...(s.value != null && s.value !== '' && { value: String(s.value) }),
        });
      }
    } catch (err) {
      logger.warn('[AllureMapper] AI step conversion failed, using fallback for batch', {
        testName,
        batch: batchNum,
        stepsCount: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });

      // Fallback for this batch only — keep original descriptions, default type.
      // Mark degraded: step types are now unreliable ('click' for everything).
      degraded = true;
      for (const s of batch) {
        allResults.push({
          id: randomUUID(),
          type: 'click',
          description: (s.description ?? '').slice(0, 120),
          ...(s.value ? { value: s.value } : {}),
        });
      }
    }
  }

  return { steps: allResults, degraded };
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
    platform: 'web';
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
}

/**
 * Resolve module + flow from label names using the HierarchyCache.
 * Shared hierarchy resolution logic used by mapAllureResult.
 */
export async function resolveHierarchy(
  cache: HierarchyCache,
  webUiPlatformId: string,
  opts: MapperOptions,
  moduleName?: string,
  flowName?: string,
): Promise<{ moduleId?: string; flowId?: string }> {
  if (!moduleName) return {};

  const moduleId = await cache.resolveModule({
    projectId: opts.projectId,
    userId: opts.userId,
    platformId: webUiPlatformId,
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
  webUiPlatformId: string,
  opts: MapperOptions,
): Promise<{ moduleId?: string; flowId?: string; priority: ExtractedLabels['priority'] }> {
  const { moduleName, flowName, priority } = extractLabels(result.labels);
  const { moduleId, flowId } = await resolveHierarchy(cache, webUiPlatformId, opts, moduleName, flowName);
  return { moduleId, flowId, priority };
}

/**
 * Map a single AllureTestResult to a MappedTestCase.
 *
 * @param result          - Parsed Allure result
 * @param containerByUuid - Map from result UUID → container (for preconditions)
 * @param cache           - Shared HierarchyCache for this import batch
 * @param webUiPlatformId - The web_ui platform ID for this project
 * @param opts            - Import options
 */
export async function mapAllureResult(
  result: AllureTestResult,
  containerByUuid: Map<string, AllureContainer>,
  cache: HierarchyCache,
  webUiPlatformId: string,
  opts: MapperOptions,
): Promise<MappedTestCase> {
  const { projectId, userId } = opts;

  // ── 1. Flatten + AI-convert steps ──────────────────────────────────────────
  const rawSteps = flattenRawSteps(result.steps);
  const { steps, degraded: stepsDegraded } = await convertStepsWithAI(result.name, rawSteps);

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
    cache, webUiPlatformId, opts, moduleName, flowName,
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
      platform: 'web',
      tags,
      priority,
      preconditions,
    },
  };
}

/**
 * Ensure the web_ui platform exists for this project and return its ID.
 * Throws if PlatformService fails (caller should handle).
 */
export async function getWebUiPlatformId(
  projectId: string,
  userId: string,
): Promise<string> {
  const platforms = await PlatformService.ensurePlatformsExist(projectId, userId);
  return platforms.webUi.id;
}
