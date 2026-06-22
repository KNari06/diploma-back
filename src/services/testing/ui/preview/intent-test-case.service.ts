/**
 * Intent Test Case Service
 * CRUD operations for user-authored intent-based test cases
 * V2: Added step-level updates for runtime heal persistence
 */

import * as intentTestCaseDb from './db/intent-test-case.db';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { COMMAND_EXECUTOR_CONFIG } from '@/config/testing/playwright-tuning';
import type { CompiledStepPlan, IntentStep, IntentTestCase, StepEvidence } from './preview.types';
import { injectAutoWaitForSteps } from './auto-wait-for.utils';
import { emitTestCaseMutated } from '@/websocket/helpers/project-mutation-emit';
import { validateTriggers, sanitizeTriggers } from '@/services/mobile/trigger-validation.util';

// ═══════════════════════════════════════════════════════════════════════════
// Per-testCase in-memory mutex (prevents concurrent read-modify-write races)
// Pattern from flow-queue.ts / budget-tracker.ts
// ═══════════════════════════════════════════════════════════════════════════
const testCaseMutexes = new Map<string, Promise<void>>();

function withTestCaseMutex<T>(testCaseId: string, fn: () => Promise<T>): Promise<T> {
  const prev = testCaseMutexes.get(testCaseId) || Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  testCaseMutexes.set(testCaseId, next);
  return prev.then(fn).finally(() => {
    resolve!();
    // Clean up if this is the last waiter
    if (testCaseMutexes.get(testCaseId) === next) {
      testCaseMutexes.delete(testCaseId);
    }
  });
}

/**
 * Verify caller can write to a test case.
 *
 * Stops cross-test-case writes when the client sends a stale `intentTestCaseId`
 * (localStorage cache, React state desync) that resolves to a different
 * workspace than the one the user is currently in.
 *
 * Returns true if either the user owns the test case directly or is an active
 * member of the workspace that hosts the test case's project.
 */
async function canWriteTestCase(
  testCaseOwnerId: string,
  testCaseProjectId: string,
  userId: string,
): Promise<boolean> {
  if (testCaseOwnerId === userId) return true;

  try {
    const { data: project } = await intentTestCaseDb.getProjectWorkspaceRow(testCaseProjectId);

    const workspaceId = (project as any)?.workspace_id as string | undefined;
    if (!workspaceId) return false;

    const { WorkspaceAccessService } = await import('@/services/core/workspace-access.service');
    return await WorkspaceAccessService.isMember(userId, workspaceId);
  } catch (err) {
    logger.warn('[INTENT_TEST_CASE] Access check failed — denying write', {
      testCaseProjectId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Service for managing intent test cases
 */
export class IntentTestCaseService {
  /**
   * Create a new intent test case
   * This is the unified table for UI test cases - both draft and published.
   */
  static async create(params: {
    projectId: string;
    userId: string;
    name: string;
    description?: string;
    startUrl?: string;
    steps: IntentStep[];
    flowId?: string;
    status?: 'draft' | 'published' | 'archived';
    kind?: 'standalone' | 'regression_member';
    platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
    /**
     * Curator-set priority. Defaults to 'medium' so newly-created tests
     * have a sensible bucket out of the box (sort-by-priority, Jira
     * mapping, notification badges, executions-list color). Old rows
     * inserted before this default landed remain NULL until a curator
     * updates them — downstream code already treats NULL as "no
     * preference" everywhere (see resolve-test-case-priority.util.ts).
     * Pass `null` explicitly to opt out of the default (rare; used by
     * import paths that genuinely want "no opinion").
     */
    priority?: 'critical' | 'high' | 'medium' | 'low' | null;
    /**
     * Preconditions (free-text bullets) persisted to the `preconditions`
     * TEXT[] column. Used by import paths (e.g. Allure) that carry
     * before-fixture / prerequisite text. Omitted → column defaults to `{}`.
     */
    preconditions?: string[];
    /**
     * Import provenance (set only by import paths — Allure, etc.):
     * - importId       → FK to allure_imports; lets /details filter exactly by
     *                     import instead of a created_at window.
     * - sourceStatus   → source run verdict (Allure passed/failed/broken/skipped),
     *                     distinct from the lifecycle `status` column.
     * - stepsDegraded  → AI step conversion fell back to all-'click'; types unreliable.
     * All omitted for normal (non-import) creates → columns stay NULL / default false.
     */
    importId?: string;
    sourceStatus?: string;
    stepsDegraded?: boolean;
  }): Promise<IntentTestCase> {
    const {
      projectId, userId, name, description, startUrl, steps, flowId,
      status = 'draft', kind = 'standalone', platform = 'web',
      preconditions, importId, sourceStatus, stepsDegraded,
    } = params;
    // Explicit `null` from the caller means "no opinion" → store NULL.
    // Anything else (undefined / valid enum) falls back to 'medium'.
    const priority: 'critical' | 'high' | 'medium' | 'low' | null =
      params.priority === null
        ? null
        : (params.priority ?? 'medium');

    logger.info('[INTENT_TEST_CASE] Creating test case', {
      projectId,
      userId,
      name,
      stepsCount: steps.length,
      flowId,
      status,
      kind,
      priority,
    });

    // Auto-attach workspace-configured resources (Login, Environment, etc)
    // that match the test's scope. Fulfils the "use for all new tests on
    // this site" UX promise set when the user created the resource.
    // Best-effort — if lookup fails, we still create the test without
    // bindings; user can attach manually.
    //
    // mobile_flutter is intentionally skipped — no resource adapter
    // supports it yet; enriching with a web/android fallback would
    // silently bind the wrong profile.
    let resourceBindings: Array<{ kind: string; resource_id: string; required?: boolean }> = [];
    const scopePlatform: 'web' | 'android' | 'ios' | null =
      platform === 'web'
        ? 'web'
        : platform === 'mobile_android'
          ? 'android'
          : platform === 'mobile_ios'
            ? 'ios'
            : null;
    if (scopePlatform !== null) {
      try {
        const { enrichBindingsWithDefaults } = await import('@/services/test-resource/test-resource.service');
        resourceBindings = (await enrichBindingsWithDefaults({
          userId,
          projectId,
          bindings: [],
          scope: {
            platform: scopePlatform,
            url: startUrl ?? null,
          },
        })) as Array<{ kind: string; resource_id: string; required?: boolean }>;
      } catch (enrichErr) {
        logger.warn('[INTENT_TEST_CASE] enrichBindingsWithDefaults failed (non-fatal)', {
          error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
        });
      }
    }

    const { data, error } = await intentTestCaseDb.insertTestCaseRow({
      project_id: projectId,
      user_id: userId,
      name,
      description: description || null,
      start_url: startUrl || null,
      steps_json: this.normalizeSteps(steps),
      flow_id: flowId || null,
      status,
      kind,
      platform,
      // 'medium' by default (see params.priority comment above);
      // explicit null leaves the DB column NULL.
      priority,
      // Only set when the caller supplied preconditions — otherwise let the
      // column default ('{}') apply rather than writing an explicit empty array.
      ...(preconditions !== undefined && { preconditions }),
      // Import provenance — only written by import paths; omitted otherwise so
      // the columns stay NULL / default for manually-created tests.
      ...(importId !== undefined && { import_id: importId }),
      ...(sourceStatus !== undefined && { source_status: sourceStatus }),
      ...(stepsDegraded !== undefined && { steps_degraded: stepsDegraded }),
      resource_bindings: resourceBindings,
    });

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to create', { error });
      throw new Error(`Failed to create test case: ${error.message}`);
    }

    // Invalidate flow mode cache (test case list changed)
    if (flowId) {
      await cache.delByPattern(`qait:cache:ptree:flow:${flowId}:*`);
    }

    // Live cache invalidation for other open editors (best-effort).
    emitTestCaseMutated({
      projectId,
      action: 'created',
      id: data.id,
      name,
      flowId: flowId || undefined,
    });

    return this.mapToIntentTestCase(data);
  }

  /**
   * Get a test case by ID
   */
  static async getById(id: string, userId: string): Promise<IntentTestCase | null> {
    const { data, error } = await intentTestCaseDb.getTestCaseRowByIdForUser(id, userId);

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      logger.error('[INTENT_TEST_CASE] Failed to get by ID', { error, id });
      throw new Error(`Failed to get test case: ${error.message}`);
    }

    const item = this.mapToIntentTestCase(data);

    // Resolve dependency names in a single query
    if (item.dependsOn && item.dependsOn.length > 0) {
      const { data: depRows } = await intentTestCaseDb.getTestCaseNamesByIds(item.dependsOn);

      item.resolvedDependencies = (item.dependsOn || []).map((depId) => {
        const dep = depRows?.find((r: any) => r.id === depId);
        return { id: depId, name: dep?.name || 'Unknown' };
      });
    }

    return item;
  }

  /**
   * Collect the steps of ALL transitive dependencies (preconditions) of a test
   * case, ordered dependency-first, deduped, and cycle-safe. Returns an empty
   * array when the case has no dependencies.
   *
   * Each returned step is tagged with `_preconditionSource` (the owning
   * test-case id) so post-run compiled-plan writeback can exclude borrowed
   * steps from the target's persisted `steps_json`. The root's OWN steps are
   * NOT included — the caller appends them after these.
   *
   * Access is assumed pre-validated on the root by the caller; dependencies are
   * constrained to the same project/owner at save time, so they are fetched by
   * id without a per-user filter.
   */
  static async collectPreconditionSteps(rootId: string): Promise<IntentStep[]> {
    const MAX_NODES = 200; // safety bound against pathological fan-out

    // 1. Fetch the whole dependency closure — one query per depth level (no N+1).
    const byId = new Map<string, { dependsOn: string[]; steps: IntentStep[] }>();
    let frontier = [rootId];
    while (frontier.length > 0) {
      const { data, error } = await intentTestCaseDb.getDependencyClosureRows(frontier);

      if (error) {
        logger.error('[INTENT_TEST_CASE] Failed to load dependency closure', { error, rootId });
        throw new Error(`Failed to resolve preconditions: ${error.message}`);
      }

      const next: string[] = [];
      for (const row of data || []) {
        const deps: string[] = row.depends_on || [];
        byId.set(row.id, { dependsOn: deps, steps: (row.steps_json as IntentStep[]) || [] });
        for (const d of deps) if (!byId.has(d)) next.push(d);
      }

      if (byId.size > MAX_NODES) {
        logger.warn('[INTENT_TEST_CASE] Precondition closure exceeded cap — truncating', {
          rootId,
          nodes: byId.size,
          cap: MAX_NODES,
        });
        break;
      }

      frontier = [...new Set(next)];
    }

    // 2. Post-order DFS: deps emitted before dependents, each once, cycle-safe
    // via `visited` (a cycle simply stops recursing, never loops).
    const visited = new Set<string>();
    const order: string[] = [];
    const dfs = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = byId.get(id);
      if (!node) return;
      for (const dep of node.dependsOn) dfs(dep);
      if (id !== rootId) order.push(id); // root's own steps are appended by the caller
    };
    dfs(rootId);

    // 3. Flatten in dependency-first order. Namespace each borrowed step id
    // (`pre_<sourceId>_<originalId>`) so it can NEVER collide with the target's
    // own step ids. `batchUpdateStepsFromRun` merges compiled plans by id
    // against the target's saved `steps_json`; without the namespace a shared
    // step id (e.g. a login flow duplicated into both cases) would let a
    // dependency's plan overwrite a same-id target step. The prefix also keeps
    // borrowed steps from writing back onto the SOURCE case. `_preconditionSource`
    // is retained purely for run reporting / debugging.
    return order.flatMap((id) =>
      (byId.get(id)?.steps || []).map((s) => ({
        ...s,
        id: `pre_${id}_${s.id}`,
        _preconditionSource: id,
      })),
    );
  }

  /**
   * Like `collectPreconditionSteps`, but grouped by owning dependency for UI
   * display — one entry per dependency in execution order, each with its name
   * and its steps. Namespaced step ids are preserved so the editor's run panel
   * can map `preview:run:step` events back to these rows. Empty when none.
   */
  static async collectPreconditionGroups(
    rootId: string,
  ): Promise<Array<{ testCaseId: string; name: string; steps: IntentStep[] }>> {
    const steps = await this.collectPreconditionSteps(rootId);
    if (steps.length === 0) return [];

    // DFS emits each source's steps contiguously — collect distinct source ids
    // in execution order.
    const orderedSourceIds: string[] = [];
    for (const s of steps) {
      const src = s._preconditionSource;
      if (src && orderedSourceIds[orderedSourceIds.length - 1] !== src) {
        orderedSourceIds.push(src);
      }
    }

    const { data } = await intentTestCaseDb.getTestCaseNamesByIds(orderedSourceIds);
    const nameById = new Map<string, string>(
      ((data as Array<{ id: string; name: string }>) || []).map((r) => [r.id, r.name]),
    );

    return orderedSourceIds.map((id) => ({
      testCaseId: id,
      name: nameById.get(id) || 'Unknown',
      steps: steps.filter((s) => s._preconditionSource === id),
    }));
  }

  /**
   * List test cases for a project
   */
  static async listByProject(params: {
    projectId: string;
    userId: string;
    flowId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: IntentTestCase[]; total: number }> {
    const { projectId, userId, flowId, limit = 50, offset = 0 } = params;

    // Get total count
    const { count, error: countError } = await intentTestCaseDb.countTestCaseRowsForProject(
      projectId,
      userId,
      flowId,
    );

    if (countError) {
      logger.error('[INTENT_TEST_CASE] Failed to count', { error: countError });
      throw new Error(`Failed to list test cases: ${countError.message}`);
    }

    // Get items
    const { data, error } = await intentTestCaseDb.listTestCaseDataForProject(
      projectId,
      userId,
      flowId,
      limit,
      offset,
    );

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to list', { error });
      throw new Error(`Failed to list test cases: ${error.message}`);
    }

    const items = (data || []).map((row) => this.mapToIntentTestCase(row));

    // Batch resolve dependency names
    const allDepIds = new Set<string>();
    for (const item of items) {
      for (const depId of item.dependsOn || []) {
        allDepIds.add(depId);
      }
    }

    if (allDepIds.size > 0) {
      const { data: depRows } = await intentTestCaseDb.getTestCaseNamesByIds([...allDepIds]);

      const depNameMap = new Map<string, string>();
      for (const row of depRows || []) {
        depNameMap.set(row.id, row.name);
      }

      for (const item of items) {
        if (item.dependsOn && item.dependsOn.length > 0) {
          item.resolvedDependencies = item.dependsOn
            .map((depId) => ({ id: depId, name: depNameMap.get(depId) || 'Unknown' }));
        }
      }
    }

    return { items, total: count || 0 };
  }

  /**
   * Update a test case
   * Supports updating lifecycle status, kind, and other unified fields.
   */
  static async update(params: {
    id: string;
    userId: string;
    name?: string;
    description?: string;
    startUrl?: string | null;
    url?: string | null;
    steps?: IntentStep[];
    flowId?: string;
    status?: 'draft' | 'published' | 'archived';
    kind?: 'standalone' | 'regression_member';
    tags?: string[];
    priority?: 'critical' | 'high' | 'medium' | 'low';
    /**
     * Optional replacement for the full resource bindings array
     * (Login / Environment / Secret / ...). Sending `[]` detaches all
     * resources. Undefined leaves the column untouched.
     */
    resourceBindings?: Array<{ kind: string; resource_id: string; required?: boolean }>;
    /**
     * Optional replacement for the full triggers array (user-defined
     * event→action rules forwarded to the mobile runner). Sending `[]`
     * clears all triggers. Undefined leaves the column untouched. Validated
     * against the canonical contract here (service layer), NOT the route —
     * a malformed entry throws and surfaces as a 400.
     */
    triggers?: unknown;
  }): Promise<IntentTestCase> {
    // Serialize concurrent writes to the same test case via the same in-process
    // mutex used by updateStepFromPreviewApply / updateStepAfterHeal /
    // batchUpdateStepsFromRun. Without it, a manual Save issued during an
    // in-flight auto-persist could race and overwrite compiled/evidence fields
    // that the runner just wrote. No reentrancy risk — none of the already-
    // mutex'd methods call update() internally.
    return withTestCaseMutex(params.id, async () => {
      const { id, userId, name, description, startUrl, url, steps, flowId, status, kind, tags, priority, resourceBindings, triggers } = params;

      const updates: Record<string, any> = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (startUrl !== undefined) updates.start_url = startUrl;
      if (url !== undefined) updates.url = url;
      if (resourceBindings !== undefined) {
        // Allow [] to detach all; reject non-array.
        if (!Array.isArray(resourceBindings)) {
          throw new Error('resourceBindings must be an array');
        }
        updates.resource_bindings = resourceBindings;
      }
      if (triggers !== undefined) {
        // Validate against the canonical cross-repo contract. Throws a
        // ValidationError on the first malformed entry — the controller maps
        // that to a 400. `[]` is valid and clears all triggers.
        updates.triggers = validateTriggers(triggers) ?? [];
      }
      if (steps !== undefined) {
        let mergedSteps = this.normalizeSteps(steps);

        // V16: Merge compiled/evidence/bindingHints from DB for steps that don't include them.
        // Frontend state often lacks these backend-generated fields (compiled plans from apply/run,
        // evidence from execution). Without this merge, any PATCH that includes steps (reorder,
        // rename, add step) would wipe compiled plans and force LLM fallback on next background run.
        const hasStepsMissingBackendFields = mergedSteps.some(s =>
          !s.compiled || !s.evidence || !s.recordedFingerprint
        );

        if (hasStepsMissingBackendFields) {
          try {
            const { data: existingRow } = await intentTestCaseDb.getStepsJsonRow(id);

            if (existingRow?.steps_json) {
              const existingById = new Map<string, IntentStep>();
              for (const existing of existingRow.steps_json as IntentStep[]) {
                existingById.set(existing.id, existing);
              }

              let preserved = 0;
              let invalidatedCompiled = 0;
              mergedSteps = mergedSteps.map(step => {
                const existing = existingById.get(step.id);
                if (!existing) return step;

                let changed = false;
                const merged = { ...step };

                // V27 — Description-change compiled invalidation for fill-class
                // actions.
                //
                // Without this, the "Save without Apply" workflow can leave a
                // poisoned compiled plan in the DB even after the user fixed
                // the description:
                //   1. user creates manual-add type step "email"
                //   2. first Apply on a half-loaded page picks <span>"Русский",
                //      compiled.targetFingerprint = {tag:"span",text:"Русский"}
                //   3. user notices and edits description → "email поле для ввода"
                //   4. user hits Save (skips Apply) → frontend's
                //      `toIntentStepForSave` strips compiled because the step
                //      is `intentStepDirty: true` → PATCH arrives without compiled
                //   5. THIS merge block kicks in, restores the poisoned compiled
                //      from the DB → Save persists "new description + old
                //      poisoned compiled" pair
                //   6. Apply All reads the DB and runs the poisoned compiled
                //      as compiled-shortcut (fast path skips LLM)
                //
                // Fix: when description changes for a fill action (type), drop
                // the cached compiled. Next Apply will rebuild it from a fresh
                // resolver decision. Cost is one extra LLM resolve per
                // description-edit on a type step (~500ms, cached after first
                // hit), bought against permanent DB poisoning.
                //
                // Scoped to `type` only because:
                //   - type's failure mode (poisoned span/anchor) is the
                //     observed bug; click's resolver has wider candidate
                //     latitude (button/a/div/span/svg are all legitimate
                //     click targets) so a description-edit on click rarely
                //     wants to repoint at a different element.
                //   - bindingHints are kept either way — they bias the
                //     resolver toward the recorded target type and the user
                //     manually maintains them through the same edit UI.
                const descriptionChanged =
                  typeof step.description === 'string'
                  && typeof existing.description === 'string'
                  && step.description !== existing.description;
                const isFillActionForInvalidation = step.type === 'type';
                const dropCompiledForDescChange =
                  descriptionChanged && isFillActionForInvalidation && !!existing.compiled;

                if (!step.compiled && existing.compiled && !dropCompiledForDescChange) {
                  merged.compiled = existing.compiled;
                  changed = true;
                } else if (dropCompiledForDescChange) {
                  // Explicit: do NOT carry the old compiled forward. Next
                  // Apply will rebuild via the resolver waterfall.
                  invalidatedCompiled++;
                }
                if (!step.evidence && existing.evidence) {
                  merged.evidence = existing.evidence;
                  changed = true;
                }
                // V27 — bindingHints also drop on description change for
                // `type`. They're the resolver's hint set; if they were
                // backfilled from a wrong element (pre-V27 backfill gate),
                // they would still bias the resolver toward the wrong target
                // even after compiled and recordedFingerprint are gone.
                // Manual-add bindingHints (placeholder/name from user input)
                // are stored on the FE side and re-sent in the PATCH payload
                // anyway — so the loss here is bounded to backfill-derived
                // ones.
                const dropBindingHintsForDescChange =
                  descriptionChanged && isFillActionForInvalidation && !!existing.bindingHints;
                if (!step.bindingHints && existing.bindingHints && !dropBindingHintsForDescChange) {
                  merged.bindingHints = existing.bindingHints;
                  changed = true;
                }
                // recordedFingerprint comes from one of two origins:
                //   1. recorder probe at click time (genuine recording)
                //   2. preview-step-apply.service.ts:buildSyntheticFingerprintFromNode
                //      after the first successful manual-step apply
                // Frontend's `toIntentStepForSave` never serializes this
                // field (manual draft conversion path strips it), so any
                // frontend-driven PATCH would otherwise wipe a synthesized
                // fingerprint. Preserve it from DB just like compiled /
                // evidence / bindingHints — same backend-owned policy.
                //
                // V27 — same description-change invalidation as `compiled`
                // above. If the user edits a type step's description, the
                // SYNTHETIC fingerprint stored from the prior Apply may be
                // pointing at a wrong element (the very thing the edit is
                // trying to fix). Drop it so the next Apply re-anchors via
                // the resolver waterfall. Genuine recorder fingerprints are
                // dropped too — but for `type` the recorder also wouldn't
                // have captured a meaningful identity (typing into an input
                // doesn't probe the input itself, only the keystroke target),
                // so the loss is symmetric with the manual-add case.
                const dropFingerprintForDescChange =
                  descriptionChanged && isFillActionForInvalidation && !!existing.recordedFingerprint;
                if (!step.recordedFingerprint && existing.recordedFingerprint && !dropFingerprintForDescChange) {
                  merged.recordedFingerprint = existing.recordedFingerprint;
                  changed = true;
                }

                if (changed) preserved++;
                return merged;
              });

              if (preserved > 0) {
                logger.info('[INTENT_TEST_CASE] Preserved backend fields from DB during update', {
                  id,
                  preservedCount: preserved,
                  totalSteps: mergedSteps.length,
                });
              }
              if (invalidatedCompiled > 0) {
                logger.info('[INTENT_TEST_CASE] Invalidated compiled plans for description-changed fill steps', {
                  id,
                  invalidatedCount: invalidatedCompiled,
                  totalSteps: mergedSteps.length,
                });
              }
            }
          } catch (mergeError) {
            logger.warn('[INTENT_TEST_CASE] Failed to merge backend fields (non-fatal, saving as-is)', {
              id,
              error: mergeError instanceof Error ? mergeError.message : String(mergeError),
            });
          }
        }

        updates.steps_json = mergedSteps;
      }
      if (flowId !== undefined) updates.flow_id = flowId;
      if (status !== undefined) updates.status = status;
      if (kind !== undefined) updates.kind = kind;
      if (tags !== undefined) updates.tags = tags;
      if (priority !== undefined) updates.priority = priority;

      if (Object.keys(updates).length === 0) {
        throw new Error('No fields to update');
      }

      logger.info('[INTENT_TEST_CASE] Updating test case', {
        id,
        updatedFields: Object.keys(updates),
      });

      const { data, error } = await intentTestCaseDb.updateTestCaseRowForUser(id, userId, updates);

      if (error) {
        logger.error('[INTENT_TEST_CASE] Failed to update', { error, id });
        throw new Error(`Failed to update test case: ${error.message}`);
      }

      // Invalidate flow mode cache
      if (data.flow_id) {
        await cache.delByPattern(`qait:cache:ptree:flow:${data.flow_id}:*`);
      }

      // Live cache invalidation for other open editors (best-effort). Only emit
      // when a field the editor's cached lists display changed (name / flow /
      // status) — NOT for pure steps_json persistence from auto-heal / run,
      // which would spam the room without changing any list-visible data.
      const listVisibleChanged =
        name !== undefined || flowId !== undefined || status !== undefined;
      if (listVisibleChanged && data.project_id) {
        emitTestCaseMutated({
          projectId: data.project_id,
          action: 'updated',
          id,
          name: data.name,
          flowId: data.flow_id || undefined,
        });
      }

      // Mark related negative test cases as stale when steps change
      if (steps !== undefined) {
        this.markNegativesStale(id).catch((err) => {
          logger.warn('[INTENT_TEST_CASE] Failed to mark negatives stale', {
            testCaseId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return this.mapToIntentTestCase(data);
    });
  }

  /**
   * Delete a test case
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[INTENT_TEST_CASE] Deleting test case', { id });

    // Fetch flow_id and project_id before delete for cache invalidation
    const { data: tc } = await intentTestCaseDb.getTestCaseFlowProjectForUser(id, userId);

    // Clean up regression plan items referencing this test case
    const { error: planCleanupError } = await intentTestCaseDb.deletePlanItemsForTestCase(id);

    if (planCleanupError) {
      logger.warn('[INTENT_TEST_CASE] Failed to cleanup plan items for deleted test case', {
        error: planCleanupError, id,
      });
    }

    const { error } = await intentTestCaseDb.deleteTestCaseRowForUser(id, userId);

    if (error) {
      logger.error('[INTENT_TEST_CASE] Failed to delete', { error, id });
      throw new Error(`Failed to delete test case: ${error.message}`);
    }

    // Invalidate flow mode cache
    if (tc?.flow_id) {
      await cache.delByPattern(`qait:cache:ptree:flow:${tc.flow_id}:*`);
    }

    // Invalidate plans cache — deleting a test case removes its regression_plan_items as side-effect
    if (tc?.project_id) {
      await cache.delByPattern(`qait:cache:plans:proj:${tc.project_id}:*`);
    }

    // Live cache invalidation for other open editors (best-effort).
    if (tc?.project_id) {
      emitTestCaseMutated({
        projectId: tc.project_id,
        action: 'deleted',
        id,
        flowId: tc.flow_id || undefined,
      });
    }

    return true;
  }

  /**
   * Normalize legacy steps: replace 'fill' with 'type' (server-side migration)
   */
  private static normalizeSteps(steps: IntentStep[]): IntentStep[] {
    return steps.map(step => {
      if ((step.type as any) === 'fill') {
        return {
          ...step,
          type: 'type' as any,
        };
      }
      return step;
    });
  }

  /**
   * Map database row to IntentTestCase type
   * Supports all unified fields including status, kind, replay data, etc.
   */
  private static mapToIntentTestCase(row: any): IntentTestCase {
    // Normalize steps on read (migrate-on-read strategy)
    const stepsJson = this.normalizeSteps(row.steps_json || []);

    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      name: row.name,
      description: row.description || undefined,

      // URL fields
      startUrl: row.start_url || undefined,
      url: row.url || undefined,

      // Steps
      stepsJson,

      // Lifecycle
      status: row.status || 'draft',
      kind: row.kind || 'standalone',
      platform: row.platform || 'web',

      // Replay data
      replayStrategy: row.replay_strategy || undefined,
      commands: row.commands || undefined,
      graphRef: row.graph_ref || undefined,
      parametersSchema: row.parameters_schema || undefined,

      // Organization
      flowId: row.flow_id || undefined,
      flowName: row.test_flows?.name || undefined,
      dependsOn: row.depends_on || undefined,

      // Metadata
      goal: row.goal || undefined,
      tags: row.tags || undefined,
      priority: row.priority || undefined,
      preconditions: row.preconditions || undefined,
      setupSteps: row.setup_steps || undefined,
      teardownSteps: row.teardown_steps || undefined,
      expectedResult: row.expected_result || undefined,

      // Test Resources bindings (Login / Environment / Secret / ...)
      // Surfaced so the editor's Login picker can read/write the current
      // selection without a separate fetch.
      resourceBindings: Array.isArray(row.resource_bindings)
        ? row.resource_bindings
        : [],

      // User-defined triggers (event→action rules forwarded to the mobile
      // runner). Sanitized on read so a stale/legacy row never surfaces a
      // malformed entry to the editor. Defaults to [] for rows predating the
      // column (column default is already '[]', this guards null/legacy too).
      triggers: sanitizeTriggers(row.triggers),

      // Provenance
      sourceTestId: row.source_test_id || undefined,
      sourceIntelligentSessionId: row.source_intelligent_session_id || undefined,

      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V2: Step-level updates for runtime heal persistence
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update a single step's compiled plan after successful high-confidence heal
   * Called from runtime when heal succeeds with confidence ≥ 0.9
   *
   * @param intentTestCaseId The test case ID
   * @param stepId The step ID within the test case
   * @param compiled New compiled plan from healed selector
   * @param evidence Updated evidence with new lastSuccessRef
   */
  static async updateStepAfterHeal(params: {
    intentTestCaseId: string;
    stepId: string;
    compiled: CompiledStepPlan;
    evidence: StepEvidence;
    userId?: string;
  }): Promise<boolean> {
    return withTestCaseMutex(params.intentTestCaseId, async () => {
    const { intentTestCaseId, stepId, compiled, evidence, userId } = params;

    logger.info('[INTENT_TEST_CASE] Updating step after successful heal', {
      intentTestCaseId,
      stepId,
      newLocatorCount: compiled.locatorPlan?.length,
    });

    try {
      // Fetch steps + ownership fields in one round-trip so the access
      // check below (when userId is supplied) doesn't cost an extra query.
      const { data: row, error: fetchError } = await intentTestCaseDb.getStepsJsonWithOwnerRow(intentTestCaseId);

      if (fetchError || !row) {
        logger.warn('[INTENT_TEST_CASE] Test case not found for heal update', {
          intentTestCaseId,
          error: fetchError?.message,
        });
        return false;
      }

      if (userId) {
        const allowed = await canWriteTestCase(row.user_id, row.project_id, userId);
        if (!allowed) {
          logger.warn('[INTENT_TEST_CASE] Heal update rejected — user not in test case workspace', {
            intentTestCaseId,
            stepId,
            userId,
            ownerId: row.user_id,
            projectId: row.project_id,
          });
          return false;
        }
      }

      const steps: IntentStep[] = row.steps_json || [];
      const stepIndex = steps.findIndex(s => s.id === stepId);

      if (stepIndex === -1) {
        logger.warn('[INTENT_TEST_CASE] Step not found for heal update', {
          intentTestCaseId,
          stepId,
        });
        return false;
      }

      // Update the step with new compiled and evidence
      // Merge compiled to preserve action and other fields if not provided
      const existingCompiled = steps[stepIndex].compiled;
      const mergedCompiled: CompiledStepPlan = {
        ...existingCompiled,
        ...compiled,
        // Ensure action is preserved
        action: compiled.action || existingCompiled?.action || { type: 'click' },
        // Merge context
        context: {
          ...existingCompiled?.context,
          ...compiled.context,
        },
        // Merge meta with required fields
        meta: compiled.meta || existingCompiled?.meta || {
          compiledVersion: '1.0.0',
          resolverVersion: '3.0.0',
        },
      };

      // Track heal count for flakiness detection
      const currentHealCount = steps[stepIndex].evidence?.healCount || 0;
      const newHealCount = currentHealCount + 1;
      const needsReview = newHealCount >= COMMAND_EXECUTOR_CONFIG.healCountReviewThreshold;

      if (needsReview) {
        logger.warn('[INTENT_TEST_CASE] Step healed multiple times — flagged for review', {
          intentTestCaseId, stepId, healCount: newHealCount,
        });
      }

      steps[stepIndex] = {
        ...steps[stepIndex],
        compiled: mergedCompiled,
        evidence: {
          ...steps[stepIndex].evidence,
          ...evidence,
          healCount: newHealCount,
          lastHealedAt: new Date().toISOString(),
          needsReview: needsReview || steps[stepIndex].evidence?.needsReview,
        },
      };

      // Save back to DB
      const { error: updateError } = await intentTestCaseDb.updateStepsJsonRow(intentTestCaseId, steps);

      if (updateError) {
        logger.error('[INTENT_TEST_CASE] Failed to update step after heal', {
          intentTestCaseId,
          stepId,
          error: updateError.message,
        });
        return false;
      }

      logger.info('[INTENT_TEST_CASE] Step updated after heal', {
        intentTestCaseId,
        stepId,
      });

      return true;
    } catch (error) {
      logger.error('[INTENT_TEST_CASE] Exception updating step after heal', {
        intentTestCaseId,
        stepId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    }); // withTestCaseMutex
  }

  /**
   * Update a single step after successful preview apply
   * Replaces the step with appliedStep (which has compiled/evidence/bindingHints)
   *
   * @param intentTestCaseId The test case ID
   * @param appliedStep The full IntentStep from preview:step:apply:result
   * @param userId Optional — when supplied, rejects the write if the user
   *               neither owns the test case nor is a member of its workspace.
   *               Prevents cross-test-case writes from stale client state.
   */
  static async updateStepFromPreviewApply(params: {
    intentTestCaseId: string;
    appliedStep: IntentStep;
    userId?: string;
  }): Promise<boolean> {
    return withTestCaseMutex(params.intentTestCaseId, async () => {
      const { intentTestCaseId, appliedStep, userId } = params;

      logger.info('[INTENT_TEST_CASE] Updating step from preview apply', {
        intentTestCaseId,
        stepId: appliedStep.id,
        hasCompiled: !!appliedStep.compiled,
        hasEvidence: !!appliedStep.evidence,
        hasBindingHints: !!appliedStep.bindingHints,
      });

      try {
        // Fetch steps + ownership fields in one round-trip so the access
        // check below doesn't cost an extra query.
        const { data: row, error: fetchError } = await intentTestCaseDb.getStepsJsonWithOwnerRow(intentTestCaseId);

        if (fetchError || !row) {
          logger.warn('[INTENT_TEST_CASE] Test case not found for preview apply update', {
            intentTestCaseId,
            error: fetchError?.message,
          });
          return false;
        }

        // Access gate: only when caller passes userId. Existing internal
        // callers (background auto-heal paths) keep working unchanged.
        if (userId) {
          const allowed = await canWriteTestCase(row.user_id, row.project_id, userId);
          if (!allowed) {
            logger.warn('[INTENT_TEST_CASE] Preview apply rejected — user not in test case workspace', {
              intentTestCaseId,
              stepId: appliedStep.id,
              userId,
              ownerId: row.user_id,
              projectId: row.project_id,
            });
            return false;
          }
        }

        const steps: IntentStep[] = row.steps_json || [];
        const stepIndex = steps.findIndex(s => s.id === appliedStep.id);

        if (stepIndex === -1) {
          // V16: Step not yet in DB (manually added on frontend, applied before Save).
          // Append to preserve compiled/evidence — the next PATCH from frontend will
          // merge via the V16 merge logic in update(), keeping compiled intact.
          logger.info('[INTENT_TEST_CASE] Step not in DB yet, appending from preview apply', {
            intentTestCaseId,
            stepId: appliedStep.id,
            hasCompiled: !!appliedStep.compiled,
          });
          steps.push(appliedStep);
        } else {
          // Replace, but PRESERVE backend-owned metadata that the new apply
          // legitimately doesn't carry. Without this merge a failed apply
          // (no compiled emitted), or a planStaleReason apply (compiled
          // intentionally stripped — see mobile-step-apply.service.ts), or
          // a vision-coordinates apply (no node → no plan) wipes the
          // perfectly-good compiled plan that previous successful applies
          // wrote to DB. Next regression run then re-pays full LLM cost
          // for a step that already had a working fast-path plan.
          //
          // Mirrors the merge logic in update() (lines 365-393) so the
          // preview-apply path can't degrade what a PATCH would preserve.
          //
          // Replace semantics when the new apply DID emit the field — fresh
          // is always better than stale (newer fingerprint, refreshed
          // bindingHints from runtime, etc.).
          const existing = steps[stepIndex];
          const merged: IntentStep = { ...appliedStep };

          // Compiled plan: three cases
          //   1. New is missing  → preserve existing (no-info case)
          //   2. Both present    → keep stronger one (avoid downgrade — see
          //      shouldUpgradeCompiledPlan; "stronger" means new strategy
          //      type or higher-ranked primary). Without this guard a
          //      lint that happened to return only label_exact would
          //      overwrite a previously-recorded resource_id plan.
          //   3. Existing missing → replace as usual (fresh wins)
          if (!appliedStep.compiled && existing.compiled) {
            merged.compiled = existing.compiled;
          } else if (appliedStep.compiled && existing.compiled) {
            // Lazy import to keep this service free of mobile-specific deps
            // when the test case isn't a mobile one. Tree-shakes for web.
            const { shouldUpgradeCompiledPlan } = await import('@/services/mobile/mobile-step-apply.service');
            const upgrade = shouldUpgradeCompiledPlan(
              existing.compiled as any,
              appliedStep.compiled as any,
            );
            if (!upgrade) {
              merged.compiled = existing.compiled;
            }
          }
          if (!appliedStep.evidence && existing.evidence) {
            merged.evidence = existing.evidence;
          }
          if (
            (!appliedStep.bindingHints || Object.keys(appliedStep.bindingHints).length === 0)
            && existing.bindingHints
            && Object.keys(existing.bindingHints).length > 0
          ) {
            merged.bindingHints = existing.bindingHints;
          }
          if (!appliedStep.recordedFingerprint && existing.recordedFingerprint) {
            merged.recordedFingerprint = existing.recordedFingerprint;
          }

          steps[stepIndex] = merged;
        }

        // Note: auto-wait injection removed here (V8). Auto-waits are now injected:
        // 1. In batchUpdateStepsFromRun() — once after run completes
        // 2. In preview.controller.ts PATCH — when user saves via REST API
        // 3. In IntentTestCaseService.update() — when fully updating test case

        // Save back to DB
        const { error: updateError } = await intentTestCaseDb.updateStepsJsonTouchRow(intentTestCaseId, steps);

        if (updateError) {
          logger.error('[INTENT_TEST_CASE] Failed to update step from preview apply', {
            intentTestCaseId,
            stepId: appliedStep.id,
            error: updateError.message,
          });
          return false;
        }

        logger.info('[INTENT_TEST_CASE] Step updated from preview apply', {
          intentTestCaseId,
          stepId: appliedStep.id,
          locatorCount: appliedStep.compiled?.locatorPlan?.length,
        });

        return true;
      } catch (error) {
        logger.error('[INTENT_TEST_CASE] Exception updating step from preview apply', {
          intentTestCaseId,
          stepId: appliedStep.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    });
  }

  /**
   * Batch-update multiple steps after a preview run completes.
   * Single read-modify-write cycle instead of N individual updates.
   * Auto-wait injection runs once on the final merged array.
   *
   * @param intentTestCaseId The test case ID
   * @param enrichedSteps Map of stepId → enriched IntentStep (with compiled/evidence/bindingHints)
   */
  static async batchUpdateStepsFromRun(params: {
    intentTestCaseId: string;
    enrichedSteps: Map<string, IntentStep>;
  }): Promise<boolean> {
    return withTestCaseMutex(params.intentTestCaseId, async () => {
      const { intentTestCaseId, enrichedSteps } = params;

      logger.info('[INTENT_TEST_CASE] Batch-updating steps from run', {
        intentTestCaseId,
        enrichedCount: enrichedSteps.size,
      });

      try {
        const { data: row, error: fetchError } = await intentTestCaseDb.getStepsJsonRow(intentTestCaseId);

        if (fetchError || !row) {
          logger.warn('[INTENT_TEST_CASE] Test case not found for batch update', {
            intentTestCaseId,
            error: fetchError?.message,
          });
          return false;
        }

        const steps: IntentStep[] = row.steps_json || [];
        let updated = 0;

        // Merge all enriched steps into the array.
        //
        // Three concerns layered on top of plain replacement:
        //
        //   (a) preserve-on-missing: a regression-run apply that intentionally
        //       strips `compiled` (VTE mismatch with planStaleReason, vision-
        //       coordinates result with no node-based plan, etc.) must not
        //       wipe the previous run's working plan.
        //
        //   (b) avoid plan downgrade: when both old and new plans exist, keep
        //       the stronger one (resource_id beats label_exact, etc.). A
        //       single bad regression run could otherwise replace a stable
        //       resource_id-keyed plan with a label_exact-only plan that
        //       breaks on the next localization push.
        //
        //   (c) preserve-on-missing for the other backend-owned fields
        //       (evidence / bindingHints / recordedFingerprint) — same reason.
        //
        // Mirrors updateStepFromPreviewApply above so REST apply and
        // regression run write the same shape to DB.
        const { shouldUpgradeCompiledPlan } = await import('@/services/mobile/mobile-step-apply.service');
        for (let i = 0; i < steps.length; i++) {
          const enriched = enrichedSteps.get(steps[i].id);
          if (!enriched) continue;
          const existing = steps[i];
          const merged: IntentStep = { ...enriched };

          // Compiled plan upgrade gate.
          if (!enriched.compiled && existing.compiled) {
            merged.compiled = existing.compiled;
          } else if (enriched.compiled && existing.compiled) {
            const upgrade = shouldUpgradeCompiledPlan(
              existing.compiled as any,
              enriched.compiled as any,
            );
            if (!upgrade) merged.compiled = existing.compiled;
          }
          if (!enriched.evidence && existing.evidence) merged.evidence = existing.evidence;
          if (
            (!enriched.bindingHints || Object.keys(enriched.bindingHints).length === 0)
            && existing.bindingHints
            && Object.keys(existing.bindingHints).length > 0
          ) {
            merged.bindingHints = existing.bindingHints;
          }
          if (!enriched.recordedFingerprint && existing.recordedFingerprint) {
            merged.recordedFingerprint = existing.recordedFingerprint;
          }
          steps[i] = merged;
          updated++;
        }

        if (updated === 0) {
          logger.debug('[INTENT_TEST_CASE] No steps to batch-update', { intentTestCaseId });
          return false;
        }

        // Single auto-wait injection pass on the final merged array
        const stepsWithAutoWaits = injectAutoWaitForSteps(steps);

        const { error: updateError } = await intentTestCaseDb.updateStepsJsonTouchRow(intentTestCaseId, stepsWithAutoWaits);

        if (updateError) {
          logger.error('[INTENT_TEST_CASE] Failed to batch-update steps from run', {
            intentTestCaseId,
            error: updateError.message,
          });
          return false;
        }

        logger.info('[INTENT_TEST_CASE] Batch-updated steps from run', {
          intentTestCaseId,
          updatedCount: updated,
          totalSteps: stepsWithAutoWaits.length,
        });

        // Mark related negatives as stale (best-effort, non-blocking)
        this.markNegativesStale(intentTestCaseId).catch((err) => {
          logger.warn('[INTENT_TEST_CASE] Failed to mark negatives stale after batch update', {
            testCaseId: intentTestCaseId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        return true;
      } catch (error) {
        logger.error('[INTENT_TEST_CASE] Exception batch-updating steps from run', {
          intentTestCaseId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    });
  }

  /**
   * Get test case by ID without user check (for internal runtime use)
   * Use with caution - only for system-level operations
   */
  static async getByIdInternal(id: string): Promise<IntentTestCase | null> {
    const { data, error } = await intentTestCaseDb.getTestCaseRowByIdInternal(id);

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[INTENT_TEST_CASE] Failed to get by ID (internal)', { error, id });
      return null;
    }

    return this.mapToIntentTestCase(data);
  }

  /**
   * Mark all negative test cases derived from a source test case as stale.
   * Called when the parent happy-path steps change.
   */
  private static async markNegativesStale(sourceTestCaseId: string): Promise<void> {
    const { error, count } = await intentTestCaseDb.markNegativesStaleByParent(sourceTestCaseId);

    if (error) {
      logger.warn('[INTENT_TEST_CASE] Failed to mark negatives stale', {
        sourceTestCaseId,
        error: error.message,
      });
      return;
    }

    if (count && count > 0) {
      logger.info('[INTENT_TEST_CASE] Marked negatives as stale', {
        sourceTestCaseId,
        staleCount: count,
      });
    }
  }
}
