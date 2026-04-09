/**
 * Measurement fixtures — designed to probe where dependency-resolver.service.ts
 * alters (or fails to alter) an "ideal" AI output.
 *
 * Each fixture pairs:
 *   - spec:          A ParsedApiSpec that the resolver receives as input.
 *   - idealAiOutput: What a *perfect* Architect agent would return. We feed
 *                    this to the resolver via a mock of getChatCompletionWithMessages.
 *   - expectedOrder: A *human-readable* expected execution order (as operationId
 *                    sequence or as an ordering constraint). Used for assertions.
 *
 * The experiment: mock AI to return idealAiOutput, run the resolver, compare
 * the final executionOrder to expectedOrder. Any diff comes from our
 * post-processing stages (removePhantomNodes, autoWireAuth, autoWireCrud,
 * topologicalSort, orphan-append). That diff IS the measurement.
 */

import type { ParsedApiSpec } from '../flow.types';

export interface ResolverFixture {
  name: string;
  description: string;
  spec: ParsedApiSpec;
  idealAnalystOutput: any;
  idealArchitectOutput: any;
  /**
   * Ordering constraints: pairs [A, B] meaning "A must appear strictly before B
   * in the final executionOrder". This is stricter than a single canonical
   * order because it lets us allow parallel siblings but forbid wrong CRUD
   * orderings.
   */
  orderingConstraints: Array<[string, string]>;
  /** Nodes we expect to see in the final executionOrder (any order). */
  expectedNodeIds: string[];
}
