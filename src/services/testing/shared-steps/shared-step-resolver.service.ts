/**
 * Shared Step Resolver Service — DEPRECATED in Phase B (May 2026)
 *
 * Originally planned to inline-expand `action: 'shared_steps'` PlaywrightCommand
 * references to other test cases. The producer side (UI / AI / importer that
 * would create such commands) was never built — production has zero rows with
 * this action type. Replaced by `scenario_setup` test_resource bindings, which
 * deliver the same "reuse a sequence of steps across many tests" capability at
 * the IntentStep layer with full lifecycle (validate / apply / heal / capture).
 *
 * What this file is now:
 *   - A pass-through stub. `resolveCommands` returns the input commands unchanged.
 *   - If a stray shared_steps command ever surfaces in production (e.g. from a
 *     hand-crafted SQL insert), it now flows through to the executor as an
 *     unknown PlaywrightCommand → emits a runtime warning. Visible, not silent.
 *
 * Original implementation:
 *   - Preserved in git history at commit immediately before this Phase B change.
 *   - Phase C will physically delete this file once a release cycle confirms
 *     no rollback is needed.
 *
 * Rollback procedure:
 *   1. `git show HEAD~1:src/services/testing/shared-steps/shared-step-resolver.service.ts`
 *      to recover the original code.
 *   2. Restore the file.
 *   3. Re-enable the two callsites:
 *        - regression-run.service.ts (search "Phase B (May 2026) — shared_steps resolver is deactivated")
 *        - test-case-resolver.service.ts (search "Phase B (May 2026) — shared_steps resolution removed")
 */

export class SharedStepResolverService {
  /**
   * Phase B stub: pass-through. Returns the input commands unchanged with no
   * warnings. See file header for rationale.
   */
  static async resolveCommands(
    commands: any[],
    _projectId: string,
  ): Promise<{ commands: any[]; warnings: string[] }> {
    return { commands, warnings: [] };
  }
}
