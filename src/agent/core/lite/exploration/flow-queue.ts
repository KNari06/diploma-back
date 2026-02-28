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

import type { EntryPoint, FlowPriority, FlowComplexity } from './types';

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

/** Jaccard threshold for dedup on enqueue */
const DEDUP_THRESHOLD = 0.7;

export class FlowQueue {
  private queue: EntryPoint[] = [];
  private completed: Set<string> = new Set();
  private allGoals: Map<string, string> = new Map(); // id → goal (for dedup)
  private mutexPromise: Promise<void> = Promise.resolve();

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
   * Skips entries whose dependencies haven't been completed yet (re-queues them).
   */
  dequeue(): EntryPoint | null {
    // Find first entry without unmet dependencies
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (!entry.dependsOn || this.completed.has(entry.dependsOn)) {
        this.queue.splice(i, 1);
        return entry;
      }
    }

    // All remaining entries have unmet dependencies — return first anyway
    // (the dependency might never complete, so don't deadlock)
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }

    return null;
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
  // INTERNAL
  // ═══════════════════════════════════════════════════════════════════════

  private enqueueSync(entryPoint: EntryPoint, skipSort = false): boolean {
    // Dedup check: Jaccard similarity on goal text
    for (const [, existingGoal] of this.allGoals) {
      if (this.jaccardSimilarity(existingGoal, entryPoint.goal) >= DEDUP_THRESHOLD) {
        return false;
      }
    }

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
