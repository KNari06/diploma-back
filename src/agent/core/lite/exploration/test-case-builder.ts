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
import type { ExplorationTree } from './exploration-tree';
import type { BudgetTracker } from './budget-tracker';

/** Categories that typically involve form submission */
const FORM_CATEGORIES: TestFlowCategory[] = [
  'authentication',
  'form_submission',
  'user_management',
  'e_commerce',
];

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
      case 'skipped':
      case 'timeout':
        status = 'not_explored';
        break;
      default:
        status = 'failed';
    }

    const tags: string[] = [ep.category, ep.priority, 'positive'];
    if (ep.requiresAuth) tags.push('requires-auth');
    if (task.errorClassification === 'app_bug') tags.push('bug-detected');
    if (isBlocked) tags.push('blocked', `blocker-${task.blockerType || 'other'}`);

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

    return {
      id: ep.id,
      name: isBlocked ? `${ep.name} [BLOCKED: ${task.blockerType || 'other'}]` : ep.name,
      description: ep.goal,
      category: ep.category,
      priority: ep.priority,
      testType: 'positive',
      explored: task.status === 'completed' || task.status === 'failed' || task.status === 'blocked',
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
          description: `Click "${submitStep.ref || 'submit button'}" without filling required fields`,
          action: 'click',
          ref: submitStep.ref,
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

    // Build discovered pages for history view
    const pages = tree.getAllNodes().map((node) => ({
      url: node.url,
      title: node.title,
      pageType: node.pageType,
      entryPointCount: node.entryPoints.length,
      depth: node.depth,
    }));

    // Build individual flow results for history view
    const flows = testCases
      .filter((tc) => tc.explored)
      .map((tc) => ({
        name: tc.name,
        category: tc.category,
        status: tc.status,
        durationMs: tc.estimatedDurationMs,
        stepsCount: tc.steps.length,
        blockerType: tc.blocker?.type,
        errorMessage: tc.blocker?.reason || tc.errors?.[0]?.message,
        steps: tc.steps.map((s) => ({
          stepNumber: s.stepNumber,
          action: s.action,
          description: s.description,
          value: s.isSensitive ? undefined : s.value,
          pageUrl: s.pageUrl,
        })),
      }));

    return {
      pagesSurveyed: tree.getNodeCount(),
      entryPointsDiscovered: tree.getAllEntryPoints().length + branchPointCount,
      flowsExplored: flowTasks.filter((t) =>
        t.status === 'completed' || t.status === 'failed' || t.status === 'blocked',
      ).length,
      flowsPassed: flowTasks.filter((t) => t.goalAchieved).length,
      flowsFailed: flowTasks.filter((t) => t.status === 'failed' && !t.goalAchieved).length,
      flowsBlocked: flowTasks.filter((t) => t.status === 'blocked').length,
      flowsSkipped: skippedEntryPoints.length + flowTasks.filter((t) => t.status === 'skipped').length,
      totalStepsDiscovered: testCases.reduce((sum, tc) => sum + tc.steps.length, 0),
      uniquePages: uniquePages.size,
      categories: Array.from(categories),
      pages,
      flows,
    };
  }
}
