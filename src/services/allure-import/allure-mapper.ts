/**
 * Allure → IntentTestCase Mapper
 *
 * Transforms AllureTestResult objects into IntentTestCase creation params:
 *  - Flattens nested Allure step trees into flat IntentStep arrays
 *  - Infers IntentActionType from step names via regex
 *  - Extracts labels (epic → Module, feature → Flow, severity → priority, tags)
 *  - Resolves/creates Modules and Flows (with an in-process cache to avoid
 *    redundant DB round-trips)
 *  - Links container befores/afters as preconditions
 *  - Returns a create-params object ready for IntentTestCaseService.create()
 */

import { randomUUID } from 'crypto';
import { logger } from '@/utils/core/logger';
import { ModuleService } from '@/services/testing/modules/module.service';
import { FlowService } from '@/services/testing/flows/flow.service';
import { PlatformService } from '@/services/testing/platforms/platform.service';
import type { IntentStep, IntentActionType } from '@/services/testing/ui/preview/preview.types';
import type {
  AllureTestResult,
  AllureContainer,
  AllureStep,
  AllureLabel,
} from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Action-type inference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Infer an IntentActionType from a step's display name.
 * Uses priority-ordered regex matching — first match wins.
 */
function inferActionType(stepName: string): IntentActionType {
  const n = stepName.toLowerCase();

  if (/navigate|open|go to|visit|url|launch|browse/i.test(n)) return 'navigate';
  if (/double.?click|dblclick/i.test(n))                        return 'dblclick';
  if (/right.?click|context.?menu/i.test(n))                   return 'contextmenu';
  if (/drag|drop/i.test(n))                                     return 'drag_and_drop';
  if (/upload|attach file/i.test(n))                            return 'upload';
  if (/hover|mouse.?over/i.test(n))                             return 'hover';
  if (/scroll/i.test(n))                                        return 'scroll';
  if (/type|fill|write|set text|enter.*(text|value|input)/i.test(n)) return 'type';
  if (/select|choose|pick|dropdown/i.test(n))                  return 'select';
  if (/check\s*box|tick\s*box|toggle.*on/i.test(n))            return 'check';
  if (/uncheck|untick|toggle.*off/i.test(n))                   return 'uncheck';
  if (/press|hit|key|enter\s*key/i.test(n))                    return 'press';
  if (/wait|pause|delay|sleep/i.test(n))                       return 'wait';
  if (/assert|verify|check|expect|should|see|validate|confirm/i.test(n)) return 'assert';
  if (/click|tap|submit|button/i.test(n))                      return 'click';

  // Generic fallback
  return 'click';
}

// ─────────────────────────────────────────────────────────────────────────────
// Step tree flattening
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively walk an Allure step tree and collect only **leaf** steps
 * (steps with no children) as IntentStep objects.
 * Parent grouping steps are skipped but their children are recursed into.
 */
function flattenSteps(allureSteps: AllureStep[]): IntentStep[] {
  const result: IntentStep[] = [];

  function recurse(steps: AllureStep[]): void {
    for (const step of steps) {
      const children = step.steps ?? [];

      if (children.length > 0) {
        // This is a grouping/parent step — recurse into children only
        recurse(children);
      } else {
        // Leaf step → convert to IntentStep
        const actionType = inferActionType(step.name);

        // Extract value from the first non-masked parameter (if any)
        const visibleParam = step.parameters?.find(
          (p) => p.mode !== 'masked' && p.mode !== 'hidden' && p.value,
        );
        const value = visibleParam?.value;

        const intentStep: IntentStep = {
          id: randomUUID(),
          type: actionType,
          description: step.name,
          ...(value !== undefined && { value }),
        };

        result.push(intentStep);
      }
    }
  }

  recurse(allureSteps);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Label extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractedLabels {
  epicName?: string;
  featureName?: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  tags: string[];
  descriptionSuffix: string; // Extra context from story/layer/owner labels
}

function extractLabels(labels: AllureLabel[]): ExtractedLabels {
  const byName = (name: string) =>
    labels.filter((l) => l.name === name).map((l) => l.value);

  const epicNames   = byName('epic');
  const featureNames = byName('feature');
  const severities  = byName('severity');
  const stories     = byName('story');
  const tagValues   = byName('tag');
  const layers      = byName('layer');
  const owners      = byName('owner');

  // Priority from severity
  const severity = severities[0]?.toLowerCase() ?? '';
  let priority: ExtractedLabels['priority'] = 'medium';
  if (severity === 'blocker' || severity === 'critical') priority = 'critical';
  else if (severity === 'minor' || severity === 'trivial') priority = 'low';
  else if (severity === 'normal' || severity === 'major') priority = 'medium';

  // Composite tags
  const tags: string[] = [
    ...tagValues,
    ...layers.map((l) => `layer:${l}`),
    ...owners.map((o) => `owner:${o}`),
  ];

  // Build description suffix from story labels
  const descriptionSuffix = stories.length > 0
    ? `\n\n**Story:** ${stories.join(', ')}`
    : '';

  return {
    epicName:    epicNames[0],
    featureName: featureNames[0],
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
      // Fetch all modules for this project and find by name (case-insensitive)
      const { items } = await ModuleService.listByProject(projectId, userId, {
        limit: 1000,
        platformId,
      });

      const existing = items.find(
        (m) => m.name.toLowerCase() === epicName.toLowerCase(),
      );

      if (existing) {
        this.moduleCache.set(cacheKey, existing.id);
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
      const flows = await FlowService.listByModule(moduleId, userId);

      const existing = flows.find(
        (f) => f.name.toLowerCase() === featureName.toLowerCase(),
      );

      if (existing) {
        this.flowCache.set(cacheKey, existing.id);
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
        description: `Auto-created from Allure feature label during import`,
      });

      logger.info('[AllureMapper] Created flow from Allure feature', {
        flowId: created.id,
        featureName,
        moduleId,
      });

      this.flowsCreated++;
      this.flowCache.set(cacheKey, created.id);
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
  /** Source UUID from Allure, for cross-referencing. */
  sourceUuid: string;
  /** Source testCaseId from Allure, for dedup checks. */
  sourceTestCaseId?: string;
}

export interface MapperOptions {
  projectId: string;
  userId: string;
  autoCreateModules: boolean;
  autoCreateFlows: boolean;
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
  const { projectId, userId, autoCreateModules, autoCreateFlows } = opts;

  // ── 1. Flatten steps ───────────────────────────────────────────────────────
  const steps = flattenSteps(result.steps);

  // ── 2. Extract labels ──────────────────────────────────────────────────────
  const { epicName, featureName, priority, tags, descriptionSuffix } =
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
  let flowId: string | undefined;

  if (epicName) {
    const moduleId = await cache.resolveModule({
      projectId,
      userId,
      platformId: webUiPlatformId,
      epicName,
      autoCreate: autoCreateModules,
    });

    if (moduleId && featureName) {
      const resolvedFlowId = await cache.resolveFlow({
        moduleId,
        userId,
        featureName,
        autoCreate: autoCreateFlows,
      });
      if (resolvedFlowId) flowId = resolvedFlowId;
    }
  }

  // ── 6. Compose create params ──────────────────────────────────────────────
  return {
    sourceUuid: result.uuid,
    sourceTestCaseId: result.testCaseId,
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
