/**
 * Step-options helper: user-pinned raw CSS selector resolution.
 *
 * Extracted from CommandExecutor to keep step.options.cssSelector handling
 * out of the resolver waterfall in tryGetLocatorForIntentCommand.
 *
 * When the user manually overrode the selector via step.options.cssSelector
 * (forwarded to intentMeta.cssSelectorOverride by the converter), the
 * executor must short-circuit the resolver waterfall (compiled → evidence
 * shortcut → LLM → self-heal) and use the literal selector — failing the
 * step with a clear error if the locator does not match. No AI fallback,
 * since the user explicitly pinned this. Mirrors
 * preview-step-apply.service.ts:2093.
 *
 * Behaviour is bit-for-bit identical to the inline block that previously
 * lived around command-executor.ts:3490.
 */
import type { Frame, Locator, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import type { IntentPlaywrightCommand } from '@/services/testing/ui/preview/intent-step-converter.service';
import type { StepRuntimeMeta } from '@/services/testing/ui/preview/preview.types';

export interface PinnedCssResult {
  locator: Locator;
  runtimeMeta: StepRuntimeMeta;
}

/**
 * Attempt the user-pinned CSS override path.
 *
 * @returns A resolved `{ locator, runtimeMeta }` when the override fired
 *          (caller should `return` it from the resolver immediately), or
 *          `null` when no override was set (caller should continue to the
 *          normal resolver waterfall).
 *
 * Throws when the override IS set but the locator does not match — that
 * failure is intentional: the user pinned this selector, so we surface
 * the error rather than falling back to AI.
 */
export async function tryPinnedCssLocator(
  command: IntentPlaywrightCommand,
  page: Page,
  resolveFrame: (iframeSelector: string, timeout: number) => Promise<Frame>,
  timeout: number,
  startTime: number,
): Promise<PinnedCssResult | null> {
  const intentMeta = command.intentMeta;
  const cssOverride = intentMeta?.cssSelectorOverride;
  // Note: when `cssSelectorOverride` is set, the converter guarantees
  // `command.selector` is the same pinned string (intent-step-converter
  // line ~325). The narrowing here is for TypeScript's benefit; at
  // runtime the && command.selector branch is the override path.
  if (!cssOverride || !command.selector) {
    return null;
  }

  const iframeSelector = intentMeta?.iframeSelector;
  const stepId = intentMeta?.stepId || 'unknown';

  const overrideContext = iframeSelector
    ? await resolveFrame(iframeSelector, Math.min(timeout, 10000))
    : page;
  const overrideLocator = overrideContext.locator(command.selector).first();
  try {
    await overrideLocator.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `User-pinned CSS selector did not match a visible element: ${command.selector} — ${message}`,
    );
  }
  const runtimeMeta: StepRuntimeMeta = {
    runtimeStatus: 'executed',
    source: 'resolver',
    confidenceTier: 'high',
    executionMs: Date.now() - startTime,
    usedLocatorStrategy: 'user_pinned_css',
    resolutionPath: 'compiled',
  };
  logger.info('[COMMAND_EXECUTOR] Using user-pinned CSS selector (resolver bypass)', {
    stepId,
    selector: command.selector.slice(0, 80),
    iframe: !!iframeSelector,
  });
  return { locator: overrideLocator, runtimeMeta };
}
