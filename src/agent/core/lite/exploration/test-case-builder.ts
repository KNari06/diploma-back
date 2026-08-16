/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST CASE BUILDER — Converts exploration results to DiscoveredTestCase[]
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Takes Phase 1 (ExplorationTree) + Phase 2 (FlowExplorationTask[])
 * and produces the final ExplorationResult with:
 *   - DiscoveredTestCase[] with positive + basic negative cases
 *   - Steps convertible to IntentStep[] format (via toIntentSteps())
 *   - ExplorationSummary
 *   - Budget usage
 *
 * Negative test cases generated:
 *   - For form flows: "Submit empty form" (click submit without filling)
 *   - Verifies validation errors are shown
 */

import type {
  ExplorationConfig,
  ExplorationResult,
  ExplorationSummary,
  DiscoveredTestCase,
  DiscoveredStep,
  FlowExplorationTask,
  EntryPoint,
  TestFlowCategory,
  BlockerType,
} from './types';
import { elementLabelOr } from './element-label';
import type { ExplorationTree } from './exploration-tree';
import type { BudgetTracker } from './budget-tracker';
import { buildAssertionsFromSteps } from './network-assertions';

/** Categories that typically involve form submission */
const FORM_CATEGORIES: TestFlowCategory[] = [
  'authentication',
  'form_submission',
  'user_management',
  'e_commerce',
];

/**
 * Canonical identity for counting unique PAGES: origin + pathname, with query
 * and hash dropped and the trailing slash normalized. This is deliberately
 * coarser than `url-pattern.ts` (which also replaces path ids) and finer than
 * origin-only — `/login?next=x` and `/login#form` are the same page, but
 * `/login` and `/signup` are not. On a parse failure the raw string is used so
 * two identical malformed URLs still dedup instead of throwing.
 */
function canonicalPageKey(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

export class TestCaseBuilder {
  /**
   * Build the final ExplorationResult from survey tree and flow tasks.
   */
  build(
    tree: ExplorationTree,
    flowTasks: FlowExplorationTask[],
    budget: BudgetTracker,
    config: ExplorationConfig,
    startTime: number,
    skippedEntryPoints: EntryPoint[],
  ): ExplorationResult {
    // Build positive test cases from explored flows
    const testCases: DiscoveredTestCase[] = flowTasks.map((task) =>
      this.taskToTestCase(task),
    );

    // Generate basic negative test cases for form-based flows
    const negativeCases = this.generateNegativeCases(flowTasks);
    testCases.push(...negativeCases);

    // Add unexplored entry points as not_explored test cases
    for (const ep of skippedEntryPoints) {
      testCases.push(this.entryPointToTestCase(ep));
    }

    // Build summary
    const summary = this.buildSummary(tree, flowTasks, skippedEntryPoints, testCases);

    return {
      explorationId: config.explorationId,
      entryUrl: config.entryUrl,
      durationMs: Date.now() - startTime,
      tree: tree.toJSON(),
      testCases,
      summary,
      budgetUsed: budget.getUsage(),
      skippedFlows: skippedEntryPoints.map((ep) => ({
        entryPoint: ep,
        reason: 'Budget exhausted',
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POSITIVE TEST CASE CONVERSION
  // ═══════════════════════════════════════════════════════════════════════

  private taskToTestCase(task: FlowExplorationTask): DiscoveredTestCase {
    const ep = task.entryPoint;
    const isBlocked = task.status === 'blocked';

    let status: DiscoveredTestCase['status'];
    switch (task.status) {
      case 'completed':
        status = task.goalAchieved ? 'passed' : 'failed';
        break;
      case 'blocked':
        status = 'blocked';
        break;
      case 'failed':
        status = 'failed';
        break;
      case 'timeout':
        // Timeouts with partial steps are salvageable — keep them as 'failed'
        // so the discovered steps remain visible. Only truly-empty timeouts
        // (no steps recorded at all) are 'not_explored'.
        status = task.discoveredSteps.length > 0 ? 'failed' : 'not_explored';
        break;
      case 'skipped':
        status = 'not_explored';
        break;
      default:
        status = 'failed';
    }

    const tags: string[] = [ep.category, ep.priority, 'positive'];
    if (ep.requiresAuth) tags.push('requires-auth');
    if (task.errorClassification === 'app_bug') tags.push('bug-detected');
    if (isBlocked) tags.push('blocked', `blocker-${task.blockerType || 'other'}`);
    // Carry the exploration OUTCOME onto the row. `intent_test_cases.status` is a
    // lifecycle column constrained to draft|published|archived (see
    // 20260201_001_intent_test_cases_unify.sql), so it cannot hold passed/failed —
    // a discovered case is legitimately a 'draft' regardless of how it ran. Without
    // this tag the outcome was lost entirely on persist: a flow that PASSED and one
    // that FAILED produced identical rows, so the user could not tell which
    // discovered tests actually worked.
    tags.push(`explored-${status}`);

    // Build expected result from the LAST verify step (not first)
    const verifySteps = task.discoveredSteps.filter((s) => s.action === 'verify');
    const lastVerifyStep = verifySteps.length > 0 ? verifySteps[verifySteps.length - 1] : undefined;
    const expectedResult = isBlocked
      ? `Flow blocked at step ${task.discoveredSteps.length}: ${task.blockedReason || 'Unknown blocker'}`
      : lastVerifyStep?.expectedOutcome || `${ep.name} completes successfully`;

    // Build preconditions
    const preconditions: string[] = [];
    if (ep.requiresAuth) preconditions.push('User must be logged in');
    if (ep.sourcePageUrl) preconditions.push(`Start from ${ep.sourcePageUrl}`);
    if (isBlocked && task.canUserHelp) {
      preconditions.push(`Requires manual unblock: ${task.blockerType || 'unknown'} (${task.blockedReason})`);
    }

    // Build blocker info
    const blocker = isBlocked
      ? {
          type: (task.blockerType || 'other') as BlockerType,
          reason: task.blockedReason || 'Unknown blocker',
          atStep: task.discoveredSteps.length + 1,
          canUserHelp: task.canUserHelp ?? false,
        }
      : undefined;

    // Derive network-level assertions from calls captured during execution.
    // Only emit assertions for flows that actually executed steps — a failed
    // or skipped flow with no steps produces no trustworthy assertions.
    const assertions = task.discoveredSteps.length > 0
      ? buildAssertionsFromSteps(task.discoveredSteps)
      : [];

    return {
      id: ep.id,
      name: isBlocked ? `${ep.name} [BLOCKED: ${task.blockerType || 'other'}]` : ep.name,
      description: ep.goal,
      category: ep.category,
      priority: ep.priority,
      testType: 'positive',
      // A salvageable `timeout` (status→'failed', partial steps kept) is a real,
      // persisted, runnable case, so it belongs in the explored set — it was
      // missing from this list, which dropped it from the rendered `flows` while
      // its row was still saved and counted (one source of the count mismatch).
      // Runnability is enforced separately by the `steps.length > 0` filter on
      // `flows` + persistence, so a zero-step flow here is harmless.
      explored:
        task.status === 'completed' ||
        task.status === 'failed' ||
        task.status === 'blocked' ||
        task.status === 'timeout',
      status,
      steps: task.discoveredSteps, // Partial steps up to the block point are preserved
      entryUrl: ep.sourcePageUrl,
      requiresAuth: ep.requiresAuth,
      tags,
      estimatedDurationMs: task.durationMs > 0 ? task.durationMs : undefined,
      errors: task.errors,
      errorClassification: task.errorClassification,
      sourcePageUrl: ep.sourcePageUrl,
      expectedResult,
      preconditions,
      blocker,
      assertions: assertions.length > 0 ? assertions : undefined,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NEGATIVE TEST CASE GENERATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Generate basic negative test cases for form-based flows.
   * For each form flow, creates an "empty submit" test case.
   */
  private generateNegativeCases(flowTasks: FlowExplorationTask[]): DiscoveredTestCase[] {
    const negativeCases: DiscoveredTestCase[] = [];

    for (const task of flowTasks) {
      const ep = task.entryPoint;

      // Only generate negative cases for form-based categories
      if (!FORM_CATEGORIES.includes(ep.category)) continue;

      // Only if the positive flow was explored (including blocked — they have partial steps)
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'blocked') continue;

      // Find fill steps — if there are any, this is a form
      const fillSteps = task.discoveredSteps.filter(
        (s) => s.action === 'fill' || s.action === 'select',
      );
      if (fillSteps.length === 0) continue;

      // Find submit step (last click step, likely the submit button)
      const clickSteps = task.discoveredSteps.filter((s) => s.action === 'click');
      const submitStep = clickSteps[clickSteps.length - 1];
      if (!submitStep) continue;

      // Generate "submit empty form" negative test case
      const negativeSteps: DiscoveredStep[] = [
        {
          stepNumber: 1,
          description: `Navigate to ${ep.sourcePageUrl}`,
          action: 'navigate',
          value: ep.sourcePageUrl,
          pageUrl: ep.sourcePageUrl,
        },
        {
          stepNumber: 2,
          // Recover the element's real name from the POSITIVE step's
          // description ("Clicked \"Sign in\" (button)"). `submitStep.ref` is a
          // snapshot-local id: meaningless to a reader, and dead the moment the
          // page re-renders — so it must never be the visible label.
          description: `Click "${elementLabelOr(submitStep.description, 'submit button')}" without filling required fields`,
          action: 'click',
          // The ref is still carried for the resolver's benefit, but it is a
          // HINT, not an identity: this case is `not_explored`, so replay
          // resolves the element from the description on first run.
          ref: submitStep.ref,
          selector: submitStep.selector,
          pageUrl: ep.sourcePageUrl,
        },
        {
          stepNumber: 3,
          description: 'Verify validation error messages are displayed for required fields',
          action: 'verify',
          pageUrl: ep.sourcePageUrl,
          expectedOutcome: 'Form shows validation errors for empty required fields. Form should NOT submit successfully.',
        },
      ];

      negativeCases.push({
        id: `${ep.id}-negative-empty`,
        name: `${ep.name} - Empty Submit Validation`,
        description: `Verify that submitting ${ep.name.toLowerCase()} form without filling required fields shows validation errors`,
        category: ep.category,
        priority: 'medium',
        testType: 'negative',
        explored: false,
        status: 'not_explored',
        steps: negativeSteps,
        entryUrl: ep.sourcePageUrl,
        requiresAuth: ep.requiresAuth,
        tags: [ep.category, 'medium', 'negative', 'validation'],
        errors: [],
        errorClassification: 'no_errors',
        sourcePageUrl: ep.sourcePageUrl,
        expectedResult: 'Form validation errors are displayed. The form does not submit.',
        preconditions: ep.requiresAuth ? ['User must be logged in'] : [],
      });
    }

    return negativeCases;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UNEXPLORED ENTRY POINTS
  // ═══════════════════════════════════════════════════════════════════════

  private entryPointToTestCase(ep: EntryPoint): DiscoveredTestCase {
    return {
      id: ep.id,
      name: ep.name,
      description: ep.goal,
      category: ep.category,
      priority: ep.priority,
      testType: 'positive',
      explored: false,
      status: 'not_explored',
      steps: [],
      entryUrl: ep.sourcePageUrl,
      requiresAuth: ep.requiresAuth,
      tags: [ep.category, ep.priority, 'not-explored'],
      errors: [],
      errorClassification: 'no_errors',
      sourcePageUrl: ep.sourcePageUrl,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════

  private buildSummary(
    tree: ExplorationTree,
    flowTasks: FlowExplorationTask[],
    skippedEntryPoints: EntryPoint[],
    testCases: DiscoveredTestCase[],
  ): ExplorationSummary {
    const uniquePages = new Set<string>();
    for (const node of tree.getAllNodes()) {
      uniquePages.add(node.url);
    }
    for (const task of flowTasks) {
      for (const step of task.discoveredSteps) {
        if (step.pageUrl) uniquePages.add(step.pageUrl);
      }
    }

    const categories = new Set<TestFlowCategory>();
    for (const tc of testCases) {
      categories.add(tc.category);
    }

    // entryPointsDiscovered: count from tree (survey phase) only.
    // skippedEntryPoints are a subset of the same queue, not additional discoveries.
    // Branch-detected entry points during flow exploration are additive.
    const branchPointCount = flowTasks.reduce((sum, t) => sum + t.branchPoints.length, 0);

    // Build discovered pages for history view.
    // Defensive: a malformed/legacy node may lack entryPoints — default to 0
    // rather than crashing the whole summary build.
    //
    // The rendered list (and the "N pages" counter derived from its length) must
    // reflect every page the run actually VISITED, not only the ones the BFS
    // survey nodified. When a flow navigates to a URL the survey never reached
    // (/signup, /verify-email, a workspace route behind a form), that page was
    // genuinely explored but showed up nowhere — the counter read "1 page" while
    // five were exercised. Tree nodes come first (they carry title/type/depth/
    // entry-point counts); flow-visited URLs absent from the tree are appended as
    // minimal entries. Identity is origin+path (query/hash stripped) so
    // /login?next=x and /login#form don't inflate the count.
    const pages = tree.getAllNodes().map((node) => ({
      url: node.url,
      title: node.title,
      pageType: node.pageType,
      entryPointCount: node.entryPoints?.length ?? 0,
      depth: node.depth,
    }));

    const seenPageKeys = new Set(pages.map((p) => canonicalPageKey(p.url)));
    for (const task of flowTasks) {
      for (const step of task.discoveredSteps) {
        if (!step.pageUrl) continue;
        const key = canonicalPageKey(step.pageUrl);
        if (seenPageKeys.has(key)) continue;
        seenPageKeys.add(key);
        pages.push({
          url: step.pageUrl,
          title: '',
          // Not surveyed → no Cartographer page-type classification. Marked so
          // the UI can distinguish a flow-visited page from a surveyed one.
          pageType: 'visited',
          entryPointCount: 0,
          // Depth is a survey-BFS concept; a flow-visited page has none.
          depth: 0,
        });
      }
    }

    // Build individual flow results for history view. Carries assertions +
    // blocker detail through the summary so the frontend renders them
    // without a second fetch against the DiscoveredTestCase.
    //
    // Filter = the PERSISTENCE rule: explored AND steps.length > 0. This is the
    // single reconciliation point for the whole feature — `flows` is what the
    // panel renders ("All (N)" + per-status tabs), `runnableTestCases`/
    // `test_cases_count` (the history card) is `flows.length`, and every outcome
    // count is derived from `flows` below. A flow that RAN but recorded no steps
    // (empty timeout, instant block) is NOT persisted (`saveTestCases` drops
    // steps.length === 0), so including it here would show a card/panel entry
    // that opens an empty test — exactly the "shown ≠ conducted" mismatch. Those
    // land in `flowsNotExplored` instead.
    const flows = testCases
      .filter((tc) => tc.explored && tc.steps.length > 0)
      .map((tc) => ({
        name: tc.name,
        category: tc.category,
        status: tc.status,
        durationMs: tc.estimatedDurationMs,
        stepsCount: tc.steps.length,
        blockerType: tc.blocker?.type,
        blockerReason: tc.blocker?.reason,
        canUserHelp: tc.blocker?.canUserHelp,
        errorMessage: tc.blocker?.reason || tc.errors?.[0]?.message,
        assertions: tc.assertions?.map((a) => ({ type: a.type, expect: a.expect })),
        steps: tc.steps.map((s) => ({
          stepNumber: s.stepNumber,
          action: s.action,
          description: s.description,
          value: s.isSensitive ? undefined : s.value,
          pageUrl: s.pageUrl,
        })),
      }));

    // skippedEntryPoints may contain entry points that ALSO appear as
    // status='skipped' tasks — dedup by id to avoid double-counting.
    const taskSkippedIds = new Set(
      flowTasks.filter((t) => t.status === 'skipped').map((t) => t.entryPoint.id),
    );
    const extraSkippedFromQueue = skippedEntryPoints.filter((ep) => !taskSkippedIds.has(ep.id)).length;

    // Outcome counts are derived from `flows` — the SAME collection the results
    // panel renders as "All (N)" and its per-status tabs — NOT from raw flowTasks.
    // Deriving them independently let the two diverge: a `timeout` task with no
    // steps maps to a `not_explored` test case that is excluded from `flows`
    // (via `tc.explored`), yet the old task-based `flowsFailed` still counted it,
    // so the header "Failed" could exceed the "Failed" tab and the history card's
    // total ("34 tests") could exceed the panel's total ("All (22)"). Counting off
    // `flows` makes the header, the tabs, and the card agree by construction.
    const flowsPassed = flows.filter((f) => f.status === 'passed').length;
    const flowsFailed = flows.filter((f) => f.status === 'failed').length;
    const flowsBlocked = flows.filter((f) => f.status === 'blocked').length;

    // Entry points that produced NO runnable test case — a never-run skip, or a
    // flow that ran (timeout / instant block / failure) but recorded zero steps.
    // Surfaced as its own bucket instead of being folded into `flowsFailed` (a
    // failure implies a test that ran and can be replayed; these can't) or
    // vanishing silently. `flows` already excludes them (explored === false).
    // Positive cases only — a `not_explored` NEGATIVE stub is a generated
    // template, not an un-explored flow, and must not inflate this count.
    const flowsSkipped = extraSkippedFromQueue + flowTasks.filter((t) => t.status === 'skipped').length;
    // Positive cases that did NOT make it into `flows` — same rule, negated:
    // never-run stubs (explored === false) plus ran-but-empty flows
    // (steps.length === 0). Positive only: a `not_explored` NEGATIVE stub is a
    // generated template, not an un-explored flow, and must not inflate this.
    const flowsNotExplored = testCases.filter(
      (tc) => tc.testType === 'positive' && !(tc.explored && tc.steps.length > 0),
    ).length;

    // Generated negative cases that will actually be WRITTEN. They are
    // `explored:false` (never executed), so they are correctly absent from
    // `flows` and from every outcome count — but they carry steps, so
    // `saveTestCases` persists them just like any other case. Counting them
    // here is what lets a surface report the true number of rows the project
    // received without claiming these flows ran. The predicate mirrors the
    // persistence gate exactly (`steps.length > 0`), so the two cannot drift.
    const negativeTestCases = testCases.filter(
      (tc) => tc.testType === 'negative' && tc.steps.length > 0,
    ).length;

    return {
      pagesSurveyed: tree.getNodeCount(),
      entryPointsDiscovered: tree.getAllEntryPoints().length + branchPointCount,
      // The two halves of the number above, reported separately because their
      // sum is unreadable next to `pagesSurveyed`: "181 entry points / 2 pages"
      // suggests 90 flows per page, when in truth the survey found 28 across
      // those 2 pages and Scout contributed ~153 branch points DURING flows.
      // Same total, but now a reader can tell breadth-of-survey from
      // depth-of-exploration instead of inferring a broken survey.
      surveyEntryPoints: tree.getAllEntryPoints().length,
      branchEntryPoints: branchPointCount,
      // flowsExplored = the flows that actually produced a runnable test case,
      // i.e. exactly what `flows` holds. Same source as the outcome counts, so
      // passed + failed + blocked === flowsExplored always holds.
      flowsExplored: flows.length,
      flowsPassed,
      flowsFailed,
      flowsBlocked,
      flowsSkipped,
      flowsNotExplored,
      totalStepsDiscovered: testCases.reduce((sum, tc) => sum + tc.steps.length, 0),
      // Runnable test cases = what the panel's flow list shows. Kept distinct
      // from testCases.length, which still includes not_explored placeholders.
      runnableTestCases: flows.length,
      negativeTestCases,
      // What actually lands in intent_test_cases: explored flows WITH steps plus
      // the generated negatives (also step-bearing). Anything reporting "test
      // cases added to your project" must read this, or it under-reports by one
      // row per form flow.
      persistedTestCases: flows.length + negativeTestCases,
      uniquePages: uniquePages.size,
      categories: Array.from(categories),
      pages,
      flows,
    };
  }
}
