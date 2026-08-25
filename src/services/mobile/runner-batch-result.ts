/**
 * Detecting a FAILED command inside a runner batch response.
 *
 * The runner never signals a command failure through the transport. Its
 * `executeBatch` converts a thrown handler into `{ success: false, error }`,
 * pushes it, and the `/commands/:sessionId/batch` route answers HTTP 200 with
 * the results either way — so `executeBatchCommands` RESOLVES on failure and a
 * caller that only awaits it cannot tell a working command from a broken one.
 *
 * That is not a hypothetical: on 2026-08-24 an `install_app` and its data wipe
 * failed this way during app prep, prep reported success, and the regression
 * run's first test opened on the previous session's logged-in screen and still
 * reported a pass.
 *
 * This module is deliberately POLICY-FREE — it reports what the body says and
 * lets each caller decide whether that is fatal. App prep gates on a flag while
 * the live failure rate is measured; an interactive editor action may prefer to
 * surface the error to the user instead. Every caller of
 * `executeBatchCommands` can adopt it; `src/api/chat/mobile_agent/tools.ts`
 * open-codes the same check today.
 */

export interface RunnerBatchFailure {
  /** Position in the batch, matching the index of the command that produced it. */
  index: number;
  /** The command type at that index, e.g. `install_app`. The searchable token. */
  command: string;
  /** The runner's own error text, or a stand-in when it reported none. */
  error: string;
}

/**
 * Find the first failed command in a runner batch response.
 *
 * @param raw       The resolved value of `executeBatchCommands`.
 * @param commands  The command TYPES that were sent, in order — used to name
 *                  the failure. Pass `commands.map((c) => String(c.type))`.
 * @returns The first failure, or `null` when the batch looks healthy.
 */
export function findRunnerBatchFailure(
  raw: unknown,
  commands: string[],
): RunnerBatchFailure | null {
  const results = (raw as { results?: unknown } | null | undefined)?.results;

  // Shape drift is not a failure signal — a body we cannot read tells us
  // nothing about whether the command worked, and guessing "broken" here would
  // fail callers that are working fine.
  if (!Array.isArray(results)) return null;

  // Only an EXPLICIT `success: false` counts. Several handlers answer with a
  // bare `data` payload and no `success` key at all (`check_package` among
  // them), and reading those as broken would fail healthy batches.
  const failedIndex = results.findIndex(
    (r) => (r as { success?: boolean } | null | undefined)?.success === false,
  );
  if (failedIndex !== -1) {
    const failed = results[failedIndex] as { error?: string } | undefined;
    return {
      index: failedIndex,
      command: commands[failedIndex] ?? `command #${failedIndex}`,
      error: failed?.error || '(runner reported no error text)',
    };
  }

  // A short array with no explicit failure means a command produced no result
  // at all. `executeBatch` breaks out of its loop on the first failure, so the
  // normal short-array case is already covered above WITH its marker — reaching
  // here short means something dropped a command silently, and treating it as
  // success would report an app as launched when `launch_app` never ran.
  if (results.length < commands.length) {
    return {
      index: results.length,
      command: commands[results.length] ?? `command #${results.length}`,
      error: `runner returned ${results.length} result(s) for ${commands.length} command(s) — this command produced none`,
    };
  }

  return null;
}
