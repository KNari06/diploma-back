/**
 * Context Compressor
 * Smart compression of test context when prompts exceed token limits
 * Keeps recent history in full, summarizes old history
 */

import { logger } from '@/utils/core/logger';
import { PageVisit, TestState } from '../../types/intelligent-testing.types';

const CHARS_PER_TOKEN = 4; // Rough estimate: 4 characters ≈ 1 token
const MAX_TOKENS = 8000; // Threshold for compression
const RECENT_PAGES_COUNT = 10; // Keep last 10 pages in full detail
const RECENT_ACTIONS_COUNT = 20; // Keep last 20 actions in full detail

export interface CompressedContext {
  recentPages: PageVisit[];
  oldPagesSummary: string;
  recentActions: any[];
  oldActionsSummary: string;
  recentErrors: string[];
  totalPagesVisited: number;
  totalActionsCompleted: number;
}

/**
 * Estimate token count from text
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Compress test context for prompts if it exceeds token limit
 */
export function compressContextForPrompt(state: TestState): CompressedContext {
  const totalPages = state.visitedPages?.length || 0;
  const totalActions = state.completedActions?.length || 0;

  // If context is small, no compression needed
  const estimatedSize = estimateTokenCount(JSON.stringify(state));

  if (estimatedSize < MAX_TOKENS) {
    logger.debug('[CONTEXT_COMPRESSOR] Context size OK, no compression needed', {
      estimatedTokens: estimatedSize,
      maxTokens: MAX_TOKENS,
    });

    return {
      recentPages: state.visitedPages || [],
      oldPagesSummary: '',
      recentActions: state.completedActions || [],
      oldActionsSummary: '',
      recentErrors: (state.errors || []).map(e => e.message || String(e)),
      totalPagesVisited: totalPages,
      totalActionsCompleted: totalActions,
    };
  }

  // Apply compression
  logger.info('[CONTEXT_COMPRESSOR] Compressing context', {
    estimatedTokens: estimatedSize,
    maxTokens: MAX_TOKENS,
    totalPages,
    totalActions,
  });

  // Keep recent pages in full, summarize old ones
  const recentPages = (state.visitedPages || []).slice(-RECENT_PAGES_COUNT);
  const oldPages = (state.visitedPages || []).slice(0, -RECENT_PAGES_COUNT);

  const oldPagesSummary = oldPages.length > 0
    ? summarizeOldPages(oldPages)
    : '';

  // Keep recent actions in full, summarize old ones
  const recentActions = (state.completedActions || []).slice(-RECENT_ACTIONS_COUNT);
  const oldActions = (state.completedActions || []).slice(0, -RECENT_ACTIONS_COUNT);

  const oldActionsSummary = oldActions.length > 0
    ? summarizeOldActions(oldActions)
    : '';

  // Always keep all errors (they're important)
  const recentErrors = (state.errors || []).map(e => e.message || String(e));

  const compressed: CompressedContext = {
    recentPages,
    oldPagesSummary,
    recentActions,
    oldActionsSummary,
    recentErrors,
    totalPagesVisited: totalPages,
    totalActionsCompleted: totalActions,
  };

  const compressedSize = estimateTokenCount(JSON.stringify(compressed));
  logger.info('[CONTEXT_COMPRESSOR] Compression complete', {
    originalTokens: estimatedSize,
    compressedTokens: compressedSize,
    compressionRatio: ((1 - compressedSize / estimatedSize) * 100).toFixed(1) + '%',
  });

  return compressed;
}

/**
 * Summarize old page visits into concise text
 */
function summarizeOldPages(pages: PageVisit[]): string {
  if (pages.length === 0) return '';

  const pageTypeCounts: Record<string, number> = {};
  const uniqueUrls = new Set<string>();

  pages.forEach(page => {
    pageTypeCounts[page.pageType] = (pageTypeCounts[page.pageType] || 0) + 1;
    uniqueUrls.add(page.url);
  });

  const summary: string[] = [
    `Visited ${pages.length} pages earlier:`,
  ];

  // Page type distribution
  const typesSummary = Object.entries(pageTypeCounts)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  summary.push(`- Pages: ${typesSummary}`);

  // Unique URLs (first 5)
  const urlsSummary = Array.from(uniqueUrls)
    .slice(0, 5)
    .map(url => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })
    .join(', ');
  summary.push(`- URLs: ${urlsSummary}${uniqueUrls.size > 5 ? ` + ${uniqueUrls.size - 5} more` : ''}`);

  return summary.join('\n');
}

/**
 * Summarize old actions into concise text
 */
function summarizeOldActions(actions: any[]): string {
  if (actions.length === 0) return '';

  const actionTypeCounts: Record<string, number> = {};
  let successCount = 0;
  let failureCount = 0;

  actions.forEach(action => {
    const type = action.action?.action || 'unknown';
    actionTypeCounts[type] = (actionTypeCounts[type] || 0) + 1;
    if (action.success) {
      successCount++;
    } else {
      failureCount++;
    }
  });

  const summary: string[] = [
    `Completed ${actions.length} actions earlier:`,
  ];

  // Action type distribution
  const typesSummary = Object.entries(actionTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  summary.push(`- Actions: ${typesSummary}`);

  // Success/failure ratio
  summary.push(`- Success rate: ${successCount}/${actions.length} (${((successCount / actions.length) * 100).toFixed(0)}%)`);

  if (failureCount > 0) {
    summary.push(`- Failures: ${failureCount}`);
  }

  return summary.join('\n');
}

/**
 * Build history summary for prompts with compression
 */
export function buildHistorySummary(state: TestState): string {
  const compressed = compressContextForPrompt(state);

  const parts: string[] = [];

  // Old pages summary (if any)
  if (compressed.oldPagesSummary) {
    parts.push(compressed.oldPagesSummary);
  }

  // Recent pages (last 10)
  if (compressed.recentPages.length > 0) {
    parts.push(`\nRecent pages (last ${compressed.recentPages.length}):`);
    compressed.recentPages.forEach((page, idx) => {
      const actionsCount = page.actionResults?.length || 0;
      const successCount = page.actionResults?.filter(a => a.success).length || 0;
      parts.push(`${idx + 1}. ${page.pageType} - ${page.url} (${successCount}/${actionsCount} actions succeeded)`);
    });
  }

  // Old actions summary (if any)
  if (compressed.oldActionsSummary) {
    parts.push(`\n${compressed.oldActionsSummary}`);
  }

  // Recent actions (last 20)
  if (compressed.recentActions.length > 0 && compressed.recentActions.length <= RECENT_ACTIONS_COUNT) {
    parts.push(`\nRecent actions (last ${compressed.recentActions.length}):`);
    compressed.recentActions.slice(-10).forEach((action, idx) => {
      const status = action.success ? '✓' : '✗';
      const actionType = action.action?.action || 'unknown';
      const description = action.action?.description || '';
      parts.push(`${status} ${actionType}: ${description}`);
    });
  }

  // Errors (always include all)
  if (compressed.recentErrors.length > 0) {
    parts.push(`\nErrors (${compressed.recentErrors.length}):`);
    compressed.recentErrors.slice(-5).forEach(error => {
      parts.push(`- ${error}`);
    });
  }

  return parts.join('\n');
}
