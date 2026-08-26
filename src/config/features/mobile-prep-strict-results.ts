import { env } from '@/config/environment/env';

/**
 * Feature flag: treat a runner-reported command failure during app prep as
 * fatal, instead of only logging it.
 *
 * `MobileRunner.executeBatch` turns a thrown command handler into
 * `{ success: false, error }` and the batch route still answers HTTP 200, so
 * `executeBatchCommands` resolves normally. `prepApp` never inspected the body,
 * which made an install that never ran — or a `pm clear` that never wiped —
 * indistinguishable from success. On 2026-08-24 that let a regression run's
 * first test open on the previous session's logged-in screen and report a
 * false green.
 *
 * Default OFF (warn-only). The failure rate on real traffic is unknown, and if
 * it is as common as the ~590ms `runner_install` timings suggest, flipping this
 * straight to fatal would fail a large share of regression runs at SETUP the
 * moment it deploys. Shadow mode measures that first; ops flips the env var
 * once the log volume says what the true rate is.
 *
 * **`install_app` is NOT governed by this flag.** It is fatal either way — see
 * the `alwaysFatal` call site in `MobileAppPrepService`. Shadow mode is for
 * failures whose consequence is unknown; a refused install has a known and
 * total one (every subsequent step runs against the wrong build, in whatever
 * state the last run left it), so there was never anything to measure. The
 * flag still governs the wipe/launch commands.
 */
export const MobilePrepStrictResultsFeature = {
  isEnabled(): boolean {
    return env.MOBILE_PREP_STRICT_RESULTS;
  },
};
