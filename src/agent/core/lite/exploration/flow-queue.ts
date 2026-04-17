/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOW QUEUE — Priority queue for flow exploration ordering
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Orders entry points for Phase 2 exploration:
 *   1. Authentication flows first (precondition for others)
 *   2. critical > high > medium > low
 *   3. Within same priority: simple > complex (quick wins first)
 *   4. Respects dependsOn chains
 *
 * Async-safe: concurrent sub-agents can enqueue new entry points.
 */

import type { EntryPoint, FlowPriority, FlowComplexity, QueueCheckpoint } from './types';
import type { StrategistOutput, StrategistFlowPlan } from './agents/agent-types';
import { PerPageBudget } from './per-page-budget';

/** Priority weights (higher = explore sooner) */
const PRIORITY_WEIGHT: Record<FlowPriority, number> = {
  critical: 40,
  high: 30,
  medium: 20,
  low: 10,
};

/** Complexity weights (simpler = explore sooner) */
const COMPLEXITY_WEIGHT: Record<FlowComplexity, number> = {
  simple: 3,
  medium: 2,
  complex: 1,
};

/** Jaccard threshold for dedup on enqueue (goal text similarity) */
const DEDUP_THRESHOLD = 0.5;

/** Name similarity threshold — catches near-identical names like "Contact Us" vs "Contact Us Form" */
const NAME_DEDUP_THRESHOLD = 0.6;

/** Optional callback for dedup decision tracing */
export type DedupTraceCallback = (data: {
  entryPointName: string;
  reason: 'exact_name' | 'name_similarity' | 'goal_similarity';
  matchedAgainst?: string;
  similarity?: number;
}) => void;

/** Optional callback for per-page saturation tracing */
export type PageSaturationTraceCallback = (data: {
  entryPointId: string;
  entryPointName: string;
  pageUrl: string;
  pageFlowCount: number;
}) => void;

export class FlowQueue {
  private queue: EntryPoint[] = [];
  private completed: Set<string> = new Set();
  private allGoals: Map<string, string> = new Map(); // id → goal (for dedup)
  private allNames: Set<string> = new Set();          // normalized names — dedup across all enqueued+completed
  private mutexPromise: Promise<void> = Promise.resolve();
  private dedupTrace?: DedupTraceCallback;
  private saturationTrace?: PageSaturationTraceCallback;
  /**
   * Per-page fairness cap. Null when disabled. Constructed by setPerPageBudget
   * before the queue is handed to FlowRunner. Mutated on every successful
   * dequeue — callers rely on the existing enqueue mutex to serialize writes.
   */
  private perPageBudget: PerPageBudget | null = null;

  // ═══════════════════════════════════════════════════════════════════════
  // CONSTRUCTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build queue from all discovered entry points, sorted by priority.
   */
  static fromEntryPoints(entryPoints: EntryPoint[]): FlowQueue {
    const q = new FlowQueue();
    for (const ep of entryPoints) {
      q.enqueueSync(ep, true); // skip sort during batch load
    }
    q.sort(); // sort once at the end
    return q;
  }

  /**
   * Build queue from Strategist output — AI-driven ordering replaces static formula.
   * Entry points not in the strategy plan are appended after planned ones.
   * Skipped flows are excluded.
   */
  static fromStrategyOutput(
    entryPoints: EntryPoint[],
    strategy: StrategistOutput,
  ): FlowQueue {
    const q = new FlowQueue();
    const skipIds = new Set(strategy.skipFlows.map((s) => s.id));
    const planMap = new Map(strategy.plan.map((p) => [p.entryPointId, p]));

    // Separate into planned (ordered by Strategist) and unplanned
    const planned: EntryPoint[] = [];
    const unplanned: EntryPoint[] = [];

    for (const ep of entryPoints) {
      if (skipIds.has(ep.id)) continue; // Strategist said skip
      if (planMap.has(ep.id)) {
        planned.push(ep);
      } else {
        unplanned.push(ep);
      }
    }

    // Sort planned by Strategist priority (1 = first)
    planned.sort((a, b) => {
      const pa = planMap.get(a.id)!.priority;
      const pb = planMap.get(b.id)!.priority;
      return pa - pb;
    });

    // Apply dependency overrides from Strategist
    for (const ep of planned) {
      const planEntry = planMap.get(ep.id);
      if (planEntry?.dependsOn) {
        ep.dependsOn = planEntry.dependsOn;
      }
    }

    // Enqueue: planned first (in Strategist order), then unplanned (in default score order)
    for (const ep of planned) {
      q.enqueueSync(ep, true);
    }
    for (const ep of unplanned) {
      q.enqueueSync(ep, true);
    }
    // Don't sort — planned order is intentional from Strategist

    return q;
  }

  /** Set optional trace callback for dedup decisions */
  setDedupTrace(cb: DedupTraceCallback): void {
    this.dedupTrace = cb;
  }

  /**
   * Install a per-page fairness cap. Must be called before runAll — enabling
   * the gate mid-run is a valid use case (e.g. user directive), but callers
   * should be aware that already-in-flight flows are not retroactively
   * counted. Passing null disables the gate.
   */
  setPerPageBudget(budget: PerPageBudget | null): void {
    this.perPageBudget = budget;
  }

  /** Optional trace callback for per-page saturation diagnostics */
  setSaturationTrace(cb: PageSaturationTraceCallback): void {
    this.saturationTrace = cb;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // QUEUE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add an entry point to the queue (async-safe for concurrent sub-agents).
   * Returns false if duplicate detected.
   */
  async enqueue(entryPoint: EntryPoint): Promise<boolean> {
    return this.withMutex(() => {
      return this.enqueueSync(entryPoint);
    });
  }

  /**
   * Get the next entry point to explore.
   *
   * Priority order when picking the next entry:
   *   1. Dependency satisfied AND source page still under its per-page cap.
   *   2. Dependency satisfied, even if the page is saturated.
   *      (Emit a saturation trace so the starvation is observable.)
   *   3. Anything, if every remaining entry has unmet deps
   *      (dependency-deadlock fallback — matches prior behaviour).
   *
   * The cap is only advisory on dequeue: when a saturated entry IS
   * returned, we still count it against the page budget so subsequent
   * dequeue calls prefer other pages. The alternative (starving forever
   * on a saturated page) would deadlock the whole run when one page
   * happens to hold every remaining entry — worse than letting a few
   * extras through.
   */
  dequeue(): EntryPoint | null {
    if (this.queue.length === 0) return null;

    let firstDepSatisfiedIdx = -1;

    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      const depsOk = !entry.dependsOn || this.completed.has(entry.dependsOn);
      if (!depsOk) continue;

      if (firstDepSatisfiedIdx === -1) firstDepSatisfiedIdx = i;

      const pageOk = !this.perPageBudget || this.perPageBudget.canReserve(entry);
      if (pageOk) {
        this.queue.splice(i, 1);
        this.perPageBudget?.reserve(entry);
        return entry;
      }
    }

    // No dependency-satisfied + page-fair entry. Prefer a dep-satisfied
    // (but saturated) entry over a dep-unsatisfied one.
    if (firstDepSatisfiedIdx !== -1) {
      const entry = this.queue.splice(firstDepSatisfiedIdx, 1)[0];
      this.emitSaturationTrace(entry);
      this.perPageBudget?.reserve(entry);
      return entry;
    }

    // All remaining entries have unmet dependencies — return first anyway
    // (the dependency might never complete, so don't deadlock).
    const entry = this.queue.shift()!;
    this.perPageBudget?.reserve(entry);
    return entry;
  }

  private emitSaturationTrace(entry: EntryPoint): void {
    if (!this.saturationTrace || !this.perPageBudget) return;
    try {
      this.saturationTrace({
        entryPointId: entry.id,
        entryPointName: entry.name,
        pageUrl: entry.sourcePageUrl,
        pageFlowCount: this.perPageBudget.countFor(entry.sourcePageUrl),
      });
    } catch { /* never let tracing break queue operation */ }
  }

  /**
   * Mark an entry point as completed (unblocks dependents).
   */
  markCompleted(entryPointId: string): void {
    this.completed.add(entryPointId);
  }

  /**
   * Check if an entry point has been completed.
   */
  isCompleted(entryPointId: string): boolean {
    return this.completed.has(entryPointId);
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  size(): number {
    return this.queue.length;
  }

  /**
   * Get all remaining entry points (for reporting skipped flows).
   */
  remaining(): EntryPoint[] {
    return [...this.queue];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REORDER (Strategist-driven)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Reorder the queue based on Strategist's updated plan.
   * Moves planned entries to front in Strategist priority order.
   * Removes entries marked as skip.
   */
  reorder(plan: StrategistFlowPlan[], skipIds?: string[]): void {
    const skipSet = new Set(skipIds || []);
    const planMap = new Map(plan.map((p) => [p.entryPointId, p]));

    // Remove skipped entries
    if (skipSet.size > 0) {
      this.queue = this.queue.filter((ep) => !skipSet.has(ep.id));
    }

    // Separate into entries that are in plan vs not
    const inPlan: EntryPoint[] = [];
    const notInPlan: EntryPoint[] = [];
    for (const ep of this.queue) {
      if (planMap.has(ep.id)) {
        // Apply dependency overrides
        const planEntry = planMap.get(ep.id)!;
        if (planEntry.dependsOn) ep.dependsOn = planEntry.dependsOn;
        inPlan.push(ep);
      } else {
        notInPlan.push(ep);
      }
    }

    // Sort in-plan by Strategist priority (1 = first)
    inPlan.sort((a, b) => {
      const pa = planMap.get(a.id)?.priority ?? 999;
      const pb = planMap.get(b.id)?.priority ?? 999;
      return pa - pb;
    });

    // Rebuild queue: Strategist-ordered first, then remainder
    this.queue = [...inPlan, ...notInPlan];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHECKPOINT / RESUME
  // ═══════════════════════════════════════════════════════════════════════

  toCheckpoint(): QueueCheckpoint {
    return {
      queue: [...this.queue],
      completed: Array.from(this.completed),
      allGoals: Array.from(this.allGoals.entries()),
      allNames: Array.from(this.allNames),
    };
  }

  static fromCheckpoint(cp: QueueCheckpoint): FlowQueue {
    const q = new FlowQueue();
    q.queue = [...cp.queue];
    for (const id of cp.completed) q.completed.add(id);
    for (const [id, goal] of cp.allGoals) q.allGoals.set(id, goal);
    for (const name of (cp.allNames ?? [])) q.allNames.add(name);
    return q;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════════════════════

  private enqueueSync(entryPoint: EntryPoint, skipSort = false): boolean {
    const normalizedName = entryPoint.name.toLowerCase().trim();

    // Dedup check 1: exact name — covers all ever-enqueued (including already dequeued/completed)
    if (this.allNames.has(normalizedName)) {
      this.dedupTrace?.({ entryPointName: entryPoint.name, reason: 'exact_name', matchedAgainst: normalizedName });
      return false;
    }

    // Dedup check 2: name similarity — catches "Form Submission" vs "First name Submission"
    for (const existingName of this.allNames) {
      const sim = this.jaccardSimilarity(existingName, normalizedName);
      if (sim >= NAME_DEDUP_THRESHOLD) {
        this.dedupTrace?.({ entryPointName: entryPoint.name, reason: 'name_similarity', matchedAgainst: existingName, similarity: sim });
        return false;
      }
    }

    // Dedup check 3: Jaccard similarity on goal text
    for (const [, existingGoal] of this.allGoals) {
      const sim = this.jaccardSimilarity(existingGoal, entryPoint.goal);
      if (sim >= DEDUP_THRESHOLD) {
        this.dedupTrace?.({ entryPointName: entryPoint.name, reason: 'goal_similarity', matchedAgainst: existingGoal.slice(0, 80), similarity: sim });
        return false;
      }
    }

    this.allNames.add(normalizedName);
    this.allGoals.set(entryPoint.id, entryPoint.goal);
    this.queue.push(entryPoint);
    if (!skipSort) this.sort();
    return true;
  }

  private sort(): void {
    this.queue.sort((a, b) => this.score(b) - this.score(a));
  }

  private score(ep: EntryPoint): number {
    let score = PRIORITY_WEIGHT[ep.priority] + COMPLEXITY_WEIGHT[ep.estimatedComplexity];

    // Authentication flows get a bonus (they're often preconditions)
    if (ep.category === 'authentication') {
      score += 50;
    }

    // Entries without dependencies score higher (can start immediately)
    if (!ep.dependsOn) {
      score += 5;
    }

    return score;
  }

  private jaccardSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.toLowerCase().split(/\s+/));
    const tokensB = new Set(b.toLowerCase().split(/\s+/));

    let intersection = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) intersection++;
    }

    const union = tokensA.size + tokensB.size - intersection;
    if (union === 0) return 1;
    return intersection / union;
  }

  private async withMutex<T>(fn: () => T): Promise<T> {
    const prev = this.mutexPromise;
    let resolve: () => void;
    this.mutexPromise = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      return fn();
    } finally {
      resolve!();
    }
  }
}
