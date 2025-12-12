import { dbAdminService } from '@/db/supabase';
import { TestJobData } from '@/types';
import { logger } from '@/utils/logger';
import { TestHint } from '../types/intelligent-testing.types';

/**
 * Convert commands to hints for AI guidance
 */
export function buildHintsFromCommands(commands?: any[]): TestHint[] {
  if (!commands || commands.length === 0) {
    return [];
  }

  return commands.map((cmd, i) => ({
    id: `cmd_${i}`,
    description: cmd.description || `${cmd.action} on ${cmd.selector || 'page'}`,
    action: cmd.action,
    target: cmd.selector,
    value: cmd.value !== undefined ? String(cmd.value) : undefined,
    priority: 'medium' as const,
  }));
}

/**
 * Clean and validate selector string
 */
function cleanSelector(selector: string): string | null {
  if (!selector) return null;
  const cleaned = selector.trim();
  // Remove surrounding quotes if present
  const unquoted = cleaned.replace(/^["'`](.*)["'`]$/, '$1').trim();
  // Validate: not empty, not too long, not just whitespace
  if (unquoted.length === 0 || unquoted.length > 200 || /^\s+$/.test(unquoted)) {
    return null;
  }
  return unquoted;
}

/**
 * Extract failed selectors from error messages
 */
function extractFailedSelectors(errors: string[]): Set<string> {
  const failedSelectors = new Set<string>();

  for (const msg of errors) {
    // Pattern 1: "Selector not found: <selector> (failed X times)" or "Selector not found: <selector>"
    let match = msg.match(/Selector not found:\s*([^()]+?)(?:\s*\(|$)/i);
    if (match?.[1]) {
      const selector = cleanSelector(match[1]);
      if (selector) failedSelectors.add(selector);
      continue;
    }

    // Pattern 2: "Element not found: <selector>" (generic)
    match = msg.match(/Element not found:\s*([^\n\r]+?)(?:\s*$|\.|,|;)/i);
    if (match?.[1]) {
      const selector = cleanSelector(match[1]);
      if (selector) failedSelectors.add(selector);
      continue;
    }

    // Pattern 3: "Input element not found: <selector>"
    match = msg.match(/Input element not found:\s*([^\n\r]+?)(?:\s*$|\.|,|;)/i);
    if (match?.[1]) {
      const selector = cleanSelector(match[1]);
      if (selector) failedSelectors.add(selector);
      continue;
    }

    // Pattern 4: "Checkbox not found: <selector>"
    match = msg.match(/Checkbox not found:\s*([^\n\r]+?)(?:\s*$|\.|,|;)/i);
    if (match?.[1]) {
      const selector = cleanSelector(match[1]);
      if (selector) failedSelectors.add(selector);
      continue;
    }

    // Pattern 5: "Select element not found: <selector>"
    match = msg.match(/Select element not found:\s*([^\n\r]+?)(?:\s*$|\.|,|;)/i);
    if (match?.[1]) {
      const selector = cleanSelector(match[1]);
      if (selector) failedSelectors.add(selector);
      continue;
    }

    // Pattern 6: "Element not found after click: <selector>"
    match = msg.match(/Element not found after click:\s*([^\n\r]+?)(?:\s*$|\.|,|;)/i);
    if (match?.[1]) {
      const selector = cleanSelector(match[1]);
      if (selector) failedSelectors.add(selector);
      continue;
    }

    // Pattern 7: Generic "not found" with selector-like pattern (fallback)
    match = msg.match(/(?:selector|element|input|checkbox|select|button|link)\s+not\s+found[:\s]+([a-zA-Z0-9#.\[\]()_\-=:"'`\s]+?)(?:\s*$|\.|,|;|\(|\[)/i);
    if (match?.[1]) {
      const potentialSelector = cleanSelector(match[1]);
      if (potentialSelector) {
        // Additional validation for fallback pattern
        const lowerSelector = potentialSelector.toLowerCase();
        if (!lowerSelector.includes('error') &&
            !lowerSelector.includes('exception') &&
            !lowerSelector.includes('stack') &&
            !lowerSelector.includes('trace') &&
            (potentialSelector.includes('#') ||
             potentialSelector.includes('.') ||
             potentialSelector.includes('=') ||
             potentialSelector.includes('[') ||
             potentialSelector.includes('role=') ||
             potentialSelector.includes('text=') ||
             potentialSelector.includes('label=') ||
             /^[a-zA-Z0-9_\-]+$/.test(potentialSelector))) {
          failedSelectors.add(potentialSelector);
        }
      }
    }
  }

  return failedSelectors;
}

/**
 * Build feedback hints from previous test results (for retries)
 */
export async function buildFeedbackHints(
  testData: TestJobData,
  retryCount: number
): Promise<TestHint[]> {
  if (retryCount === 0) {
    return [];
  }

  const feedbackHints: TestHint[] = [];

  try {
    const previous = await dbAdminService.getTestResultByTestAndBrowser(
      testData.testId,
      String(testData.browser)
    );

    const rawErrors = (previous as any)?.errors;
    const previousErrors: string[] = Array.isArray(rawErrors)
      ? rawErrors
          .map((e) => {
            if (!e) return '';
            if (typeof e === 'string') return e;
            if (typeof e.message === 'string') return e.message;
            return '';
          })
          .filter(Boolean)
      : [];

    // Extract failed selectors
    const failedSelectors = extractFailedSelectors(previousErrors);

    // Add error context hint
    const previousErrorsPreview = previousErrors.slice(0, 3);
    if (previousErrorsPreview.length > 0) {
      feedbackHints.push({
        id: `retry_ctx_prev_errors_${Date.now()}`,
        description:
          `Retry context: previous run had errors. Avoid repeating the same failing approach. Recent errors: ` +
          previousErrorsPreview.map((m) => `"${m}"`).join(' | '),
        priority: 'high',
        optional: true,
      });
    }

    // Add failed selector hints
    const failedSelectorsPreview = Array.from(failedSelectors).slice(0, 3);
    for (let i = 0; i < failedSelectorsPreview.length; i++) {
      const selector = failedSelectorsPreview[i];
      feedbackHints.push({
        id: `retry_ctx_failed_selector_${i}_${Date.now()}`,
        description:
          `Retry context: selector previously failed: "${selector}". Prefer robust locators (role/label/text) and adapt to actual elements.`,
        priority: 'high',
        optional: true,
      });
    }

    // Add about:blank hint if detected
    const hadAboutBlank = previousErrors.some((m) => m.includes('about:blank') || m.includes('about:'));
    if (hadAboutBlank) {
      feedbackHints.push({
        id: `retry_ctx_about_blank_${Date.now()}`,
        description:
          'Retry context: previous run hit about:blank/navigation issues. Prefer stable navigation, and recover via goBack or navigating to startUrl if needed.',
        priority: 'high',
        optional: true,
      });
    }
  } catch (dbError) {
    // Non-blocking: retry enrichment should never fail the test execution
    logger.debug('[HINTS_BUILDER] Failed to load previous result for retry context', {
      testId: testData.testId,
      browser: testData.browser,
      retryCount,
      error: dbError instanceof Error ? dbError.message : String(dbError),
    });
  }

  return feedbackHints;
}

/**
 * Build all hints (commands + feedback)
 */
export async function buildAllHints(
  testData: TestJobData,
  retryCount: number
): Promise<TestHint[]> {
  const hintsFromCommands = buildHintsFromCommands(testData.commands);
  const feedbackHints = await buildFeedbackHints(testData, retryCount);

  return [...hintsFromCommands, ...feedbackHints];
}

/**
 * Build all hints with metadata for logging
 */
export async function buildAllHintsWithMetadata(
  testData: TestJobData,
  retryCount: number
): Promise<{
  hints: TestHint[];
  hintsFromCommandsCount: number;
  feedbackHintsCount: number;
}> {
  const hintsFromCommands = buildHintsFromCommands(testData.commands);
  const feedbackHints = await buildFeedbackHints(testData, retryCount);

  return {
    hints: [...hintsFromCommands, ...feedbackHints],
    hintsFromCommandsCount: hintsFromCommands.length,
    feedbackHintsCount: feedbackHints.length,
  };
}
