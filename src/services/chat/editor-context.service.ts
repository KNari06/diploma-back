import { getPreviewSessionService } from '@/services/testing/ui/preview';
import type { InteractiveNode } from '@/services/testing/ui/preview/preview.types';
import { logger } from '@/utils/core/logger';

/**
 * Editor Context Service
 *
 * Extracts and compresses page context from active preview sessions
 * for injection into the workspace chat when mode === 'editor'.
 *
 * This allows the AI agent to understand what the user is currently
 * looking at in the AI Editor (preview browser) and reference page elements.
 */

export interface PageContext {
  url: string;
  title?: string;
  domSummary: string;
  pageText?: string;
  testSteps?: Array<{ id: string; type: string; description: string }>;
}

/**
 * Get page context from an active preview session.
 * Returns null if session not found or no DOM data available.
 */
export async function getPageContext(previewSessionId: string, userId?: string): Promise<PageContext | null> {
  try {
    const service = getPreviewSessionService();

    // Verify session ownership if userId provided
    if (userId && !service.isSessionOwned(previewSessionId, userId)) {
      logger.warn('[EDITOR_CONTEXT] Preview session not owned by user', { previewSessionId, userId });
      return null;
    }

    const session = service.getSession(previewSessionId);
    if (!session) {
      logger.warn('[EDITOR_CONTEXT] Preview session not found', { previewSessionId });
      return null;
    }

    // Collect a fresh snapshot so DOM nodes are up-to-date
    try {
      await service.getSnapshot(previewSessionId, userId, { force: true, includeDomNodes: true });
    } catch (snapshotError) {
      logger.warn('[EDITOR_CONTEXT] Fresh snapshot failed, using cached pageState', {
        error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        previewSessionId,
      });
    }

    const pageState = session.pageState;
    if (!pageState) {
      logger.warn('[EDITOR_CONTEXT] No page state in session', { previewSessionId });
      return null;
    }

    // Compress DOM nodes into a compact summary
    const domSummary = compressDomForChat(pageState.domNodes || []);

    return {
      url: pageState.url || session.startUrl,
      title: undefined,
      domSummary,
      pageText: pageState.pageText,
    };
  } catch (error) {
    logger.error('[EDITOR_CONTEXT] Failed to get page context', {
      error: error instanceof Error ? error.message : String(error),
      previewSessionId,
    });
    return null;
  }
}

/**
 * Compress InteractiveNode[] into a compact text summary for AI context.
 *
 * Groups elements by role (buttons, inputs, links, etc.).
 * Includes ref + text + type for each element.
 * Skips invisible/disabled nodes.
 * Caps at 50 most relevant elements.
 * Truncates text to 30 chars.
 * Target: ~1500 tokens max.
 */
export function compressDomForChat(nodes: InteractiveNode[]): string {
  if (!nodes || nodes.length === 0) {
    return 'No interactive elements detected on page.';
  }

  // Filter to visible, interactive nodes only
  const visible = nodes.filter(n => n.isVisible !== false && !n.isDisabled);

  // Cap at 50 most relevant
  const capped = visible.slice(0, 50);

  // Group by category
  const buttons: string[] = [];
  const inputs: string[] = [];
  const links: string[] = [];
  const selects: string[] = [];
  const other: string[] = [];

  for (const node of capped) {
    const label = truncate(
      node.text || node.ariaLabel || node.labelText || node.placeholder || node.name || node.id || node.tag,
      30
    );
    const ref = node.ref ? `ref=${node.ref}` : 'no-ref';
    const typeInfo = node.type ? `, type=${node.type}` : '';

    const entry = `[${label} (${ref}${typeInfo})]`;

    if (node.tag === 'button' || node.role === 'button' || node.tag === 'submit') {
      buttons.push(entry);
    } else if (node.tag === 'input' || node.tag === 'textarea') {
      inputs.push(entry);
    } else if (node.tag === 'a' || node.role === 'link') {
      links.push(entry);
    } else if (node.tag === 'select' || node.role === 'combobox' || node.role === 'listbox') {
      selects.push(entry);
    } else {
      other.push(entry);
    }
  }

  const parts: string[] = [];
  if (buttons.length > 0) parts.push(`BUTTONS: ${buttons.join(', ')}`);
  if (inputs.length > 0) parts.push(`INPUTS: ${inputs.join(', ')}`);
  if (links.length > 0) parts.push(`LINKS: ${links.join(', ')}`);
  if (selects.length > 0) parts.push(`SELECTS: ${selects.join(', ')}`);
  if (other.length > 0) parts.push(`OTHER: ${other.join(', ')}`);

  const totalShown = capped.length;
  const totalAvailable = visible.length;
  const suffix = totalAvailable > totalShown
    ? `\n(Showing ${totalShown} of ${totalAvailable} interactive elements)`
    : '';

  return parts.join('\n') + suffix;
}

function truncate(text: string, maxLen: number): string {
  if (!text) return '(unnamed)';
  return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
}

/**
 * Format page context as a system message for AI context injection.
 */
export function formatPageContextForChat(pageContext: PageContext): string {
  let result = '--- CURRENT PAGE CONTEXT (AI Editor) ---\n';
  result += `URL: ${pageContext.url}\n`;

  if (pageContext.title) {
    result += `Page: ${pageContext.title}\n`;
  }

  result += `Interactive Elements:\n${pageContext.domSummary}\n`;

  if (pageContext.pageText) {
    result += `\nVisible Page Text:\n${pageContext.pageText}\n`;
  }

  if (pageContext.testSteps && pageContext.testSteps.length > 0) {
    result += `Test Steps:\n`;
    for (const step of pageContext.testSteps) {
      result += `  ${step.id}. [${step.type}] ${step.description}\n`;
    }
  }

  result += '\nYou are in AI Editor mode. The user can see this page in their browser preview. Reference elements by their ref IDs when suggesting actions.';

  return result;
}
