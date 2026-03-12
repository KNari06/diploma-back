import { getPreviewSessionService, getPreviewDevToolsRegistry } from '@/services/testing/ui/preview';
import type { InteractiveNode } from '@/services/testing/ui/preview/preview.types';
import type { PreviewConsoleEntry, PreviewNetworkItem } from '@/websocket/types/types';
import { logger } from '@/utils/core/logger';
import { PREVIEW_SESSION_CONFIG } from '@/config/testing/playwright-tuning';

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
  consoleErrors?: string;    // Recent console errors/warnings
  networkSummary?: string;   // Failed/slow network requests
  contentSummary?: string;   // Headings, images, table headers
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

    // 1. Collect a fresh snapshot FIRST so DOM nodes are up-to-date.
    //    Snapshot must come before DevTools to ensure both reflect the same page state.
    //    (If DevTools is collected first and user navigates during the 100-500ms snapshot,
    //    we'd have console/network from URL A + DOM from URL B.)
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

    // 2. Capture DevTools data AFTER snapshot so both are from the same page state.
    let consoleErrors: string | undefined;
    let networkSummary: string | undefined;
    try {
      const devtools = getPreviewDevToolsRegistry().get(previewSessionId);
      if (devtools) {
        consoleErrors = compressConsoleForChat(devtools.getConsoleEntries());
        networkSummary = compressNetworkForChat(devtools.getNetworkItems());
      }
    } catch (devtoolsError) {
      logger.warn('[EDITOR_CONTEXT] Failed to collect devtools data (non-critical)', {
        error: devtoolsError instanceof Error ? devtoolsError.message : String(devtoolsError),
      });
    }

    // 3. Compress DOM nodes into a compact summary
    const domSummary = compressDomForChat(pageState.domNodes || []);

    // Extract non-interactive content summary (headings, images, tables)
    // Called after snapshot so page is fresh and loaded
    const contentSummary = await extractContentSummary(previewSessionId, userId);

    // 4. Truncate pageText to prevent token budget overrun (~5000 chars ≈ 1250 tokens)
    const MAX_PAGE_TEXT = 5000;
    let pageText = pageState.pageText;
    if (pageText && pageText.length > MAX_PAGE_TEXT) {
      logger.debug('[EDITOR_CONTEXT] Truncating pageText', {
        previewSessionId,
        originalLength: pageText.length,
        truncatedTo: MAX_PAGE_TEXT,
      });
      pageText = pageText.substring(0, MAX_PAGE_TEXT) + `\n[... truncated — showing ${MAX_PAGE_TEXT} of ${pageState.pageText!.length} chars]`;
    }

    return {
      url: pageState.url?.trim() || session.startUrl?.trim() || 'about:blank',
      title: undefined,
      domSummary,
      pageText,
      consoleErrors,
      networkSummary,
      contentSummary,
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
 * Caps at 150 most relevant elements (viewport-first).
 * Truncates text to 30 chars.
 * Target: ~3750 tokens max.
 */
export function compressDomForChat(nodes: InteractiveNode[]): string {
  if (!nodes || nodes.length === 0) {
    return 'No interactive elements detected on page.';
  }

  // Filter to visible, interactive nodes only
  const visible = nodes.filter(n => n.isVisible !== false && !n.isDisabled);

  // Sort by viewport priority: elements within viewport first, then off-viewport
  const sorted = [...visible].sort((a, b) => {
    const aInViewport = (a.boundingBox?.y ?? Infinity) < PREVIEW_SESSION_CONFIG.viewport.height ? 0 : 1;
    const bInViewport = (b.boundingBox?.y ?? Infinity) < PREVIEW_SESSION_CONFIG.viewport.height ? 0 : 1;
    return aInViewport - bInViewport;
  });

  // Cap at 150 most relevant
  const capped = sorted.slice(0, 150);

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
 * Compress console entries into a compact summary for AI context.
 * Filters to error + warn level, last 15 entries, ~500 tokens budget.
 */
export function compressConsoleForChat(entries: PreviewConsoleEntry[]): string | undefined {
  if (!entries || entries.length === 0) return undefined;

  const filtered = entries
    .filter(e => e.level === 'error' || e.level === 'warn')
    .slice(-15);

  if (filtered.length === 0) return undefined;

  return filtered
    .map(e => {
      const level = e.level === 'error' ? 'ERROR' : 'WARN';
      const raw = e.text || '';
      const text = raw.length > 120 ? raw.substring(0, 120) + '...' : raw;
      const loc = e.location ? ` (${e.location})` : '';
      return `[${level}] ${text}${loc}`;
    })
    .join('\n');
}

/**
 * Compress network items into a compact summary for AI context.
 * Filters to failed (status >= 400), errored, or slow (> 3s) requests.
 * Last 15 entries, ~500 tokens budget.
 */
export function compressNetworkForChat(items: PreviewNetworkItem[]): string | undefined {
  if (!items || items.length === 0) return undefined;

  const filtered = items
    .filter(item =>
      (item.status && item.status >= 400) ||
      item.phase === 'error' ||
      (item.durationMs && item.durationMs > 3000)
    )
    .slice(-15);

  if (filtered.length === 0) return undefined;

  return filtered
    .map(item => {
      const status = item.status ?? 'ERR';
      const duration = item.durationMs ? ` (${item.durationMs}ms)` : '';
      let path = item.path;
      if (!path) {
        try { path = new URL(item.url || '', 'http://localhost').pathname; } catch { path = item.url?.slice(0, 60) || '/unknown'; }
      }
      return `[${status}] ${item.method || 'GET'} ${path}${duration}`;
    })
    .join('\n');
}

/**
 * Extract non-interactive content summary from the page.
 * Headings (h1-h6), images with alt text, table column headers.
 * ~400 tokens budget. Non-critical — returns undefined on failure.
 *
 * Guards: checks page.isClosed(), wraps evaluate with 5s timeout,
 * catches navigation/CSP errors silently.
 */
async function extractContentSummary(previewSessionId: string, userId?: string): Promise<string | undefined> {
  try {
    const service = getPreviewSessionService();
    const page = service.getPage(previewSessionId, userId);
    if (!page || page.isClosed()) return undefined;

    type BrowserElementLike = {
      tagName?: string;
      textContent?: string | null;
      alt?: string | null;
    };
    type BrowserDocumentLike = {
      querySelectorAll: (selector: string) => ArrayLike<BrowserElementLike>;
    };
    type ExtractedContentSummary = {
      headings: string[];
      images: string[];
      columns: string[];
    };

    // Timeout wrapper: page.evaluate can hang on complex/stuck pages
    // Uses globalThis cast to stay compatible with server-side TS config (no DOM lib).
    const evaluateWithTimeout = Promise.race([
      page.evaluate(() => {
        const doc = (globalThis as { document?: BrowserDocumentLike }).document;
        if (!doc) return null;

        const toArray = (nodes: ArrayLike<BrowserElementLike>): BrowserElementLike[] => Array.from(nodes);
        const headings: string[] = [];
        toArray(doc.querySelectorAll('h1, h2, h3, h4, h5, h6')).forEach((el, i) => {
          if (i >= 10) return;
          const tag = (el.tagName || '').toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 80);
          if (text) headings.push('[' + tag + '] ' + text);
        });

        const images: string[] = [];
        toArray(doc.querySelectorAll('img[alt]')).forEach((el, i) => {
          if (i >= 8) return;
          const alt = (el.alt || '').trim().slice(0, 60);
          if (alt) images.push('[' + alt + ']');
        });

        const columns: string[] = [];
        const seen = new Set<string>();
        toArray(doc.querySelectorAll('th')).forEach((el) => {
          const text = (el.textContent || '').trim().slice(0, 40);
          if (text && !seen.has(text) && seen.size < 10) {
            seen.add(text);
            columns.push(text);
          }
        });

        return { headings, images, columns };
      }) as Promise<ExtractedContentSummary | null>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);

    const content = await evaluateWithTimeout;
    if (!content) return undefined;

    const parts: string[] = [];
    if (content.headings.length > 0) parts.push(`HEADINGS: ${content.headings.join(', ')}`);
    if (content.images.length > 0) parts.push(`IMAGES: ${content.images.join(', ')}`);
    if (content.columns.length > 0) parts.push(`TABLE COLUMNS: ${content.columns.join(', ')}`);

    return parts.length > 0 ? parts.join('\n') : undefined;
  } catch {
    // Expected: navigation in progress, page closed, CSP violation — all non-critical
    return undefined;
  }
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

  if (pageContext.contentSummary) {
    result += `\nPage Content Structure:\n${pageContext.contentSummary}\n`;
  }

  if (pageContext.consoleErrors) {
    result += `\nConsole Errors/Warnings:\n${pageContext.consoleErrors}\n`;
  }

  if (pageContext.networkSummary) {
    result += `\nFailed/Slow Network Requests:\n${pageContext.networkSummary}\n`;
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
