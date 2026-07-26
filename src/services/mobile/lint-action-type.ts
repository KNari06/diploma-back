/**
 * Frontend step kind → mobile-runner `actionType`.
 *
 * The action type is not cosmetic: it selects how the runner RESOLVES the
 * element. `tap` means clickable-only resolution (`clickable && enabled`), so a
 * step kind that lands on the wrong action type can make a perfectly visible
 * element unresolvable. That is exactly what happened to `extract_text` — it
 * had no entry, fell to the `'tap'` default, and the runner answered
 * "vision NO MATCH: not clickable" for a plain text node (live on a Flutter
 * screen, 2026-07-26).
 *
 * Extracted out of `session.controller.ts` because this is resolution policy,
 * not request handling — the controller's job is to parse and delegate
 * (.claude/rules/architecture.md). The runner has the mirror of this map in
 * `resolve-constants.ts`; when adding a step kind, add it in BOTH or Find and
 * Run will resolve the same step differently.
 */

const ACTION_TYPE_BY_STEP_KIND: Readonly<Record<string, string>> = {
  // Core actions
  tap: 'tap',
  click: 'tap',
  type: 'type_text',
  fill: 'type_text',
  scroll: 'scroll',
  swipe: 'swipe',
  long_press: 'long_press',
  double_tap: 'double_tap',
  drag: 'drag',
  press: 'press_key',
  // Assertions
  assert: 'assert_visible',
  ai_check: 'assert_visible',
  // Reads an element's text into a scratchpad variable — never taps, so it must
  // NOT fall to the 'tap' default. The runner maps this to its non-clickable
  // 'other' semantics, matching what the Run path has always done.
  extract_text: 'extract_text',
  // Navigation (no element resolution needed, but pass through)
  go_back: 'go_back',
  go_home: 'go_home',
  // `dismiss` closes the top modal without resolving an element. The actionType
  // here only tells the resolver what the user intended; for dismiss there is
  // nothing to resolve, but we still pass it through so the schema validator
  // accepts the step.
  dismiss: 'dismiss',
  navigate: 'open_url',
  open_app: 'launch_app',
  close_app: 'close_app',
  // Device actions (no element resolution needed)
  biometric: 'biometric',
  otp: 'otp',
  permission: 'permission_dialog',
  network: 'set_network_condition',
  pinch: 'pinch_zoom',
  clipboard: 'set_clipboard',
  upload: 'upload_file',
};

/**
 * Resolve a frontend step kind to the runner's action type.
 *
 * Unknown kinds fall back to `'tap'` — the historic default. An own-property
 * check rather than a bare index, so `'constructor'` / `'toString'` can't
 * resolve off Object.prototype and reach the runner as a function.
 * (`Object.hasOwn` needs lib es2022; this repo targets lower.)
 */
export function toRunnerActionType(stepKind: unknown): string {
  if (typeof stepKind === 'string' && Object.prototype.hasOwnProperty.call(ACTION_TYPE_BY_STEP_KIND, stepKind)) {
    return ACTION_TYPE_BY_STEP_KIND[stepKind];
  }
  return 'tap';
}
