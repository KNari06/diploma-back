import type { MobileIntentStepOptions } from './mobile-runner.types';

/**
 * Fold a runner "this action changed the screen" observation into the step's
 * options as `expectsTransition`.
 *
 * ONE-WAY on purpose. Only a `true` observation writes anything; `false` and
 * `undefined` leave the options untouched. The editor's Run loop applies steps
 * too, so a run in which the tap MISSED would otherwise record
 * `expectsTransition: false` and pin that step to the guard's lenient branch
 * permanently — teaching the system that a navigational step does not
 * navigate, which is precisely the false-green this signal exists to end.
 *
 * Absence therefore keeps today's behaviour, which is also the migration story:
 * every step authored before this landed simply has no value here until it is
 * re-applied in the editor.
 */
export function withExpectsTransition(
  options: MobileIntentStepOptions | undefined,
  transitionDetected: boolean | undefined,
): MobileIntentStepOptions | undefined {
  if (transitionDetected !== true) return options;
  if (options?.expectsTransition === true) return options;
  return { ...(options || {}), expectsTransition: true };
}
