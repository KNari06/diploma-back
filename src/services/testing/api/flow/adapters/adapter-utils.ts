/**
 * Shared post-processing for spec adapters.
 */

import type { ParsedEndpoint } from '../flow.types';

/**
 * Guarantee every endpoint's `operationId` is unique, appending `_2`, `_3`, …
 * to collisions (in spec order, so the first occurrence keeps the bare name).
 *
 * WHY this is load-bearing: a node's `id` IS its `operationId`
 * (`seedNodesFromSpec`), and the whole DAG keys nodes by id — the executor's
 * `new Map(dag.nodes.map(n => [n.id, n]))`, `stepIndexOf`, and React Flow's
 * node keys all collapse duplicate ids to ONE. Adapters that derive the id from
 * a request NAME (Postman, Insomnia) or from a punctuation-stripped path (cURL,
 * HAR) can emit the same id twice — two "Login" requests, `/users` vs `/users/`
 * — which would silently drop an endpoint from every run with no error. Run each
 * adapter's output through this so that invariant holds for every source format.
 *
 * Mutates in place (endpoints are freshly built by the adapter) and returns the
 * same array for call-site convenience. O(n) amortised — the suffix loop only
 * runs on an actual collision.
 */
export function ensureUniqueOperationIds(endpoints: ParsedEndpoint[]): ParsedEndpoint[] {
  const seen = new Set<string>();
  for (const ep of endpoints) {
    if (seen.has(ep.operationId)) {
      let suffix = 2;
      while (seen.has(`${ep.operationId}_${suffix}`)) suffix++;
      ep.operationId = `${ep.operationId}_${suffix}`;
    }
    seen.add(ep.operationId);
  }
  return endpoints;
}
