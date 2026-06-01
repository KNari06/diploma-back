import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PATTERNS QUERY SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read-only analytics queries against intelligent test execution data.
 * Powers the "Patterns" tab in the Knowledge Base UI.
 *
 * Data sources:
 * - intelligent_test_sessions — test run metadata
 * - intelligent_page_visits — pages visited during tests
 * - intelligent_test_actions — element interactions
 * - intelligent_test_findings — bugs/errors found
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface PatternsOverview {
  totalSessions: number;
  passedSessions: number;
  failedSessions: number;
  totalPages: number;
  totalActions: number;
  totalFindings: number;
  avgDurationMs: number;
}

export interface PagePattern {
  url: string;
  visitCount: number;
  pageType: string | null;
  lastVisited: string;
}

export interface ErrorPattern {
  errorType: string;
  errorMessage: string;
  count: number;
  lastSeen: string;
}

export interface ElementPattern {
  selector: string;
  actionType: string;
  interactionCount: number;
  successRate: number;
  lastUsed: string;
}

export class PatternsQueryService {
  /**
   * Get overview stats for a project's test execution history
   */
  static async getOverview(projectId: string): Promise<PatternsOverview> {
    try {
      // Get session counts and averages
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id, status, success, duration_ms, pages_visited, actions_taken')
        .eq('project_id', projectId);

      if (sessionsError) {
        logger.error('[PATTERNS] Failed to query sessions', { error: sessionsError.message });
        throw sessionsError;
      }

      const all = sessions || [];
      const passed = all.filter(s => s.success === true).length;
      const failed = all.filter(s => s.success === false).length;
      const totalPages = all.reduce((sum, s) => sum + (s.pages_visited || 0), 0);
      const totalActions = all.reduce((sum, s) => sum + (s.actions_taken || 0), 0);
      const validDurations = all.filter(s => s.duration_ms > 0);
      const avgDuration = validDurations.length > 0
        ? Math.round(validDurations.reduce((sum, s) => sum + s.duration_ms, 0) / validDurations.length)
        : 0;

      // Get findings count (batched to avoid URL length limits)
      const sessionIds = all.map(s => s.id);
      let totalFindings = 0;

      const batchSize = 100;
      const findingsBatches: PromiseLike<any>[] = [];
      for (let i = 0; i < sessionIds.length; i += batchSize) {
        const batch = sessionIds.slice(i, i + batchSize);
        findingsBatches.push(
          supabaseAdmin
            .from('intelligent_test_findings')
            .select('id', { count: 'exact', head: true })
            .in('session_id', batch)
        );
      }
      const findingsResults = await Promise.all(findingsBatches);
      for (const { count, error: findingsError } of findingsResults) {
        if (!findingsError && count !== null) {
          totalFindings += count;
        }
      }

      return {
        totalSessions: all.length,
        passedSessions: passed,
        failedSessions: failed,
        totalPages,
        totalActions,
        totalFindings,
        avgDurationMs: avgDuration,
      };
    } catch (error) {
      logger.error('[PATTERNS] getOverview error', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
      });
      throw error;
    }
  }

  /**
   * Get most frequently visited pages across all test sessions
   */
  static async getPagePatterns(projectId: string, limit: number = 20): Promise<PagePattern[]> {
    try {
      // Get session IDs for this project
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id')
        .eq('project_id', projectId);

      if (sessionsError || !sessions || sessions.length === 0) {
        return [];
      }

      const sessionIds = sessions.map(s => s.id);

      // Get all page visits for these sessions (batched to avoid URL length limits)
      const batchSize = 100;
      const visitsBatches: PromiseLike<any>[] = [];
      for (let i = 0; i < sessionIds.length; i += batchSize) {
        const batch = sessionIds.slice(i, i + batchSize);
        visitsBatches.push(
          // Column is `visited_at`, not `created_at` — see schema in
          // supabase-migrations/features/intelligent-test-scenarios.sql:84.
          // The mistake produced `column intelligent_page_visits.created_at
          // does not exist` on every prod call and silently returned 0
          // visits → degraded KB pattern signal.
          supabaseAdmin
            .from('intelligent_page_visits')
            .select('url, page_type, visited_at')
            .in('session_id', batch)
            .order('visited_at', { ascending: false })
        );
      }
      const visitsResults = await Promise.all(visitsBatches);
      const visits: any[] = [];
      for (const { data, error: visitsError } of visitsResults) {
        if (visitsError) {
          logger.error('[PATTERNS] Failed to query page visits batch', { error: visitsError.message });
        } else if (data) {
          visits.push(...data);
        }
      }

      if (visits.length === 0) {
        return [];
      }

      // Group by URL and count
      const urlMap = new Map<string, { count: number; pageType: string | null; lastVisited: string }>();

      for (const visit of visits) {
        const existing = urlMap.get(visit.url);
        if (existing) {
          existing.count++;
          // Keep the most recent visit date.
          // Field is `visited_at` per schema; aliasing to `lastVisited`
          // here for the result struct so external API stays stable.
          if (visit.visited_at > existing.lastVisited) {
            existing.lastVisited = visit.visited_at;
          }
        } else {
          urlMap.set(visit.url, {
            count: 1,
            pageType: visit.page_type,
            lastVisited: visit.visited_at,
          });
        }
      }

      // Sort by count descending and limit
      return Array.from(urlMap.entries())
        .map(([url, data]) => ({
          url,
          visitCount: data.count,
          pageType: data.pageType,
          lastVisited: data.lastVisited,
        }))
        .sort((a, b) => b.visitCount - a.visitCount)
        .slice(0, limit);
    } catch (error) {
      logger.error('[PATTERNS] getPagePatterns error', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
      });
      return [];
    }
  }

  /**
   * Get recurring errors across test sessions
   */
  static async getErrorPatterns(projectId: string, limit: number = 20): Promise<ErrorPattern[]> {
    try {
      // Get session IDs for this project
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id')
        .eq('project_id', projectId);

      if (sessionsError || !sessions || sessions.length === 0) {
        return [];
      }

      const sessionIds = sessions.map(s => s.id);

      // Get all findings (batched, parallel to avoid URL length limits)
      const batchSize = 100;
      const findingsBatches: PromiseLike<any>[] = [];
      for (let i = 0; i < sessionIds.length; i += batchSize) {
        const batch = sessionIds.slice(i, i + batchSize);
        findingsBatches.push(
          supabaseAdmin
            .from('intelligent_test_findings')
            .select('finding_type, description, found_at')
            .in('session_id', batch)
            .order('found_at', { ascending: false })
        );
      }
      const findingsResults = await Promise.all(findingsBatches);
      const findings: any[] = [];
      for (const { data, error: findingsError } of findingsResults) {
        if (findingsError) {
          logger.error('[PATTERNS] Failed to query findings batch', { error: findingsError.message });
        } else if (data) {
          findings.push(...data);
        }
      }

      if (findings.length === 0) {
        return [];
      }

      // Group by finding_type + truncated description
      const errorMap = new Map<string, { type: string; message: string; count: number; lastSeen: string }>();

      for (const finding of findings) {
        // Use first 100 chars of description as grouping key
        const shortDesc = (finding.description || 'Unknown error').substring(0, 100);
        const groupKey = `${finding.finding_type || 'error'}::${shortDesc}`;

        const existing = errorMap.get(groupKey);
        if (existing) {
          existing.count++;
          if (finding.found_at > existing.lastSeen) {
            existing.lastSeen = finding.found_at;
          }
        } else {
          errorMap.set(groupKey, {
            type: finding.finding_type || 'error',
            message: shortDesc,
            count: 1,
            lastSeen: finding.found_at,
          });
        }
      }

      return Array.from(errorMap.values())
        .map(data => ({
          errorType: data.type,
          errorMessage: data.message,
          count: data.count,
          lastSeen: data.lastSeen,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    } catch (error) {
      logger.error('[PATTERNS] getErrorPatterns error', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
      });
      return [];
    }
  }

  /**
   * Get most interacted elements across test sessions
   */
  static async getElementPatterns(projectId: string, limit: number = 20): Promise<ElementPattern[]> {
    try {
      // Get session IDs for this project
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id')
        .eq('project_id', projectId);

      if (sessionsError || !sessions || sessions.length === 0) {
        return [];
      }

      const sessionIds = sessions.map(s => s.id);

      // Get page visit IDs
      const { data: pageVisits, error: pvError } = await supabaseAdmin
        .from('intelligent_page_visits')
        .select('id')
        .in('session_id', sessionIds);

      if (pvError || !pageVisits || pageVisits.length === 0) {
        return [];
      }

      const pageVisitIds = pageVisits.map(pv => pv.id);

      // Get actions — query in parallel batches if too many page visits
      const batchSize = 100;
      const actionsBatches: PromiseLike<any>[] = [];
      for (let i = 0; i < pageVisitIds.length; i += batchSize) {
        const batch = pageVisitIds.slice(i, i + batchSize);
        actionsBatches.push(
          // Column is `executed_at`, not `created_at` — see schema in
          // supabase-migrations/features/intelligent-test-scenarios.sql.
          // Same mistake as the page-visits query above.
          supabaseAdmin
            .from('intelligent_test_actions')
            .select('action_type, selector, success, executed_at')
            .in('page_visit_id', batch)
        );
      }
      const actionsResults = await Promise.all(actionsBatches);
      const allActions: any[] = [];
      for (const { data: actions, error: actionsError } of actionsResults) {
        if (!actionsError && actions) {
          allActions.push(...actions);
        }
      }

      if (allActions.length === 0) {
        return [];
      }

      // Group by selector + action_type
      const elementMap = new Map<string, {
        selector: string;
        actionType: string;
        total: number;
        successes: number;
        lastUsed: string;
      }>();

      for (const action of allActions) {
        if (!action.selector) continue;

        const groupKey = `${action.selector}::${action.action_type || 'unknown'}`;
        const existing = elementMap.get(groupKey);

        if (existing) {
          existing.total++;
          if (action.success) existing.successes++;
          // Field is `executed_at` per schema; aliasing to `lastUsed`
          // here for the result struct so external API stays stable.
          if (action.executed_at > existing.lastUsed) {
            existing.lastUsed = action.executed_at;
          }
        } else {
          elementMap.set(groupKey, {
            selector: action.selector,
            actionType: action.action_type || 'unknown',
            total: 1,
            successes: action.success ? 1 : 0,
            lastUsed: action.executed_at,
          });
        }
      }

      return Array.from(elementMap.values())
        .map(data => ({
          selector: data.selector,
          actionType: data.actionType,
          interactionCount: data.total,
          successRate: data.total > 0 ? Math.round((data.successes / data.total) * 100) : 0,
          lastUsed: data.lastUsed,
        }))
        .sort((a, b) => b.interactionCount - a.interactionCount)
        .slice(0, limit);
    } catch (error) {
      logger.error('[PATTERNS] getElementPatterns error', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
      });
      return [];
    }
  }
}
