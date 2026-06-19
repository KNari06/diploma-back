/**
 * Regression level-dispatch helpers.
 *
 * `topologicalSort` groups test cases into dependency LEVELS that the
 * orchestrator runs in order, with a barrier between them (a dependent waits for
 * its dependency's standalone run). Because a dependent already inlines its
 * dependency's steps as preconditions, that wait is redundant for setup-style
 * deps and just caps parallelism. When the level barrier is disabled, all tests
 * collapse into a single level so they dispatch together (bounded only by worker
 * concurrency). Cycle nodes are excluded from `levels` upstream, so flattening
 * never resurrects a cycle.
 */

/**
 * Collapse all dependency levels into a single level when `disabled` is true.
 * Returns the input unchanged when the barrier is enabled or there is nothing to
 * flatten (preserves the empty-run shape, never produces `[[]]`).
 */
export function collapseLevelsIfBarrierDisabled<T>(levels: T[][], disabled: boolean): T[][] {
  if (!disabled) return levels;
  if (levels.length === 0) return levels;
  return [levels.flat()];
}
