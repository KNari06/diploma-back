/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION BLACKBOARD — Factory & Helpers
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Creates and manages the shared state between all exploration agents.
 *
 * Usage:
 *   const bb = createBlackboard(config, budget, rateLimiter, trace, emitProgress);
 *   // All agents read/write to bb
 */

import type {
  ExplorationBlackboard,
  ExplorationWorkingMemory,
  FlowExecutionResult,
  FlowSummary,
  BlockedFlowSummary,
  BudgetSummary,
  ExplorationTreeSummary,
  CartographerInsight,
} from './agent-types';
import type { ExplorationConfig, ExplorationProgressCallback, FlowExplorationTask } from '../types';
import type { BudgetTracker } from '../budget-tracker';
import type { RateLimiter } from '../rate-limiter';
import type { ExplorationTree } from '../exploration-tree';
import type { FlowQueue } from '../flow-queue';
import type { ExplorationTraceService } from '../exploration-trace.service';

/**
 * Create a new ExplorationBlackboard with initial state.
 */
export function createBlackboard(
  config: ExplorationConfig,
  budget: BudgetTracker,
  rateLimiter: RateLimiter,
  trace: ExplorationTraceService,
  emitProgress: ExplorationProgressCallback,
): ExplorationBlackboard {
  return {
    // Immutable
    config,
    explorationId: config.explorationId,
    entryUrl: config.entryUrl,
    scopeHint: config.scopeHint,
    hasCredentials: !!(config.credentials?.password),

    // Page Graph (null until Phase 1 completes)
    tree: null,
    pageInsights: new Map(),

    // Strategy
    currentStrategy: undefined,
    // null until Phase 1.5 completes
    queue: null,

    // Execution Results
    completedFlows: [],
    activeFlows: new Map(),

    // Branch Discovery
    discoveredBranches: [],

    // Coverage
    coverageAssessment: undefined,

    // Auth
    auth: {
      loginCompleted: false,
      loginAttempted: false,
      authStateJson: undefined,
      detectedLoginPages: [],
    },

    // Working Memory
    workingMemory: createWorkingMemory(),

    // User Intervention
    userDirectives: [],

    // Infrastructure
    budget,
    rateLimiter,
    trace,
    emitProgress,
  };
}

function createWorkingMemory(): ExplorationWorkingMemory {
  return {
    visitedPages: {},
    accomplishments: [],
    categoriesExplored: new Set(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BLACKBOARD HELPERS — Extract summarized views for agent prompts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a condensed tree summary for Strategist/Sentinel prompts.
 * Avoids sending full snapshot data — only structural info.
 */
export function buildTreeSummary(tree: ExplorationTree | null): ExplorationTreeSummary {
  if (!tree) return { pages: [], totalPages: 0, totalEntryPoints: 0 };
  const nodes = tree.getAllNodes();
  return {
    pages: nodes.map((node) => ({
      id: node.id,
      url: node.url,
      pageType: node.pageType,
      entryPointCount: node.entryPoints.length,
      requiresAuth: node.requiresAuth,
      depth: node.depth,
    })),
    totalPages: nodes.length,
    totalEntryPoints: tree.getAllEntryPoints().length,
  };
}

/**
 * Convert completed flows to condensed summaries for agent prompts.
 */
export function buildFlowSummaries(flows: FlowExecutionResult[]): FlowSummary[] {
  return flows.map((f) => ({
    entryPointId: f.entryPointId,
    name: f.name,
    category: f.category,
    status: f.status,
    goalAchieved: f.goalAchieved,
    stepsCount: f.stepsCount,
    errorsCount: f.errors.length,
    durationMs: f.durationMs,
  }));
}

/**
 * Extract blocked flows from completed results.
 */
export function buildBlockedFlowSummaries(flows: FlowExecutionResult[]): BlockedFlowSummary[] {
  return flows
    .filter((f) => f.status === 'blocked' && f.blockerType)
    .map((f) => ({
      entryPointId: f.entryPointId,
      name: f.name,
      blockerType: f.blockerType!,
      reason: f.blockedReason || 'Unknown blocker',
      canUserHelp: f.canUserHelp ?? false,
    }));
}

/**
 * Build budget summary for agent prompts.
 */
export function buildBudgetSummary(budget: BudgetTracker): BudgetSummary {
  return {
    timeRemainingMs: budget.remainingTimeMs(),
    flowsRemaining: budget.remainingFlows(),
    roundsRemaining: budget.remainingPipelineRounds(),
  };
}

/**
 * Get all page insights as array for agent prompts.
 */
export function getPageInsightsArray(bb: ExplorationBlackboard): CartographerInsight[] {
  return Array.from(bb.pageInsights.values());
}

/**
 * Get categories actually covered so far.
 * Skipped flows (budget exhausted, never executed) do NOT count as coverage —
 * including them would hide real gaps from the Sentinel.
 */
export function getCategoriesCovered(bb: ExplorationBlackboard): string[] {
  const categories = new Set<string>();
  for (const flow of bb.completedFlows) {
    if (flow.status === 'skipped') continue;
    categories.add(flow.category);
  }
  return Array.from(categories);
}

/**
 * Convert a FlowExplorationTask to FlowExecutionResult for blackboard storage.
 */
export function taskToFlowResult(task: FlowExplorationTask): FlowExecutionResult {
  let status: FlowExecutionResult['status'];
  if (task.status === 'completed') {
    status = task.goalAchieved ? 'passed' : 'failed';
  } else if (task.status === 'blocked') {
    status = 'blocked';
  } else if (task.status === 'timeout') {
    status = 'timeout';
  } else if (task.status === 'skipped') {
    // Skipped = never executed (budget exhausted). Must NOT collapse into
    // 'failed' — otherwise Sentinel counts it as explored coverage and as a
    // real failure, distorting the score, gaps and risk areas.
    status = 'skipped';
  } else {
    status = 'failed';
  }

  return {
    entryPointId: task.entryPoint.id,
    name: task.entryPoint.name,
    category: task.entryPoint.category,
    status,
    goalAchieved: task.goalAchieved,
    steps: task.discoveredSteps,
    stepsCount: task.discoveredSteps.length,
    durationMs: task.durationMs,
    errors: task.errors,
    errorClassification: task.errorClassification,
    blockerType: task.blockerType,
    blockedReason: task.blockedReason,
    canUserHelp: task.canUserHelp,
    progressScore: task.progressScore,
    roundsUsed: task.roundsUsed,
    // Real post-flow URL captured by the runner; fall back to the source page
    // only when the runner couldn't record it (e.g. infra-failed tasks).
    finalUrl: task.finalUrl ?? task.entryPoint.sourcePageUrl,
    rawTask: task,
  };
}

/**
 * Record a page visit in working memory.
 */
export function recordPageVisit(
  bb: ExplorationBlackboard,
  url: string,
  pageType: string,
): void {
  const existing = bb.workingMemory.visitedPages[url];
  if (existing) {
    existing.visitCount++;
    existing.lastVisitedAt = Date.now();
  } else {
    bb.workingMemory.visitedPages[url] = {
      pageType,
      visitCount: 1,
      lastVisitedAt: Date.now(),
    };
  }
}

/**
 * Add an accomplishment to working memory (bounded to last 50).
 */
export function recordAccomplishment(bb: ExplorationBlackboard, accomplishment: string): void {
  bb.workingMemory.accomplishments.push(accomplishment);
  if (bb.workingMemory.accomplishments.length > 50) {
    bb.workingMemory.accomplishments = bb.workingMemory.accomplishments.slice(-50);
  }
}
