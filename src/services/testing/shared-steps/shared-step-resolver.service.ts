/**
 * Shared Step Resolver Service
 *
 * Resolves shared_steps commands by recursively expanding references to other test cases.
 * Provides safeguards against circular references, excessive depth, and command bloat.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

// Configuration
const MAX_RECURSION_DEPTH = 3;
const MAX_TOTAL_COMMANDS = 200;

interface ResolvedCommands {
  commands: any[];
  warnings: string[];
}

interface LoadedTestCase {
  id: string;
  projectId: string;
  commands: any[] | null;
  name: string;
  parametersSchema: Record<string, any> | null;
}

export class SharedStepResolverService {
  /**
   * Resolve all shared_steps commands in a command array.
   * Recursively expands references to other test cases' commands.
   *
   * @param commands - Array of commands (may contain shared_steps actions)
   * @param projectId - Project ID for access control (referenced TC must belong to same project)
   * @param depth - Current recursion depth (internal, starts at 0)
   * @param visited - Set of visited test_case_ids for circular reference detection
   * @returns Expanded commands array with shared_steps replaced by actual commands, plus warnings
   */
  static async resolveCommands(
    commands: any[],
    projectId: string,
    depth: number = 0,
    visited: Set<string> = new Set()
  ): Promise<ResolvedCommands> {
    const resolvedCommands: any[] = [];
    const warnings: string[] = [];

    for (const command of commands) {
      // Pass through non-shared_steps commands as-is
      if (command.action !== 'shared_steps') {
        resolvedCommands.push(command);
        continue;
      }

      // Handle shared_steps command
      const testCaseId = command.test_case_id;
      const description = command.description || `Shared step: ${testCaseId}`;

      // Check depth limit
      if (depth >= MAX_RECURSION_DEPTH) {
        const warning = `Skipping shared step "${description}" - max recursion depth (${MAX_RECURSION_DEPTH}) exceeded`;
        warnings.push(warning);
        logger.warn('[SHARED_STEP_RESOLVER] Depth limit exceeded', {
          testCaseId,
          depth,
          maxDepth: MAX_RECURSION_DEPTH,
        });
        continue;
      }

      // Check circular reference
      if (visited.has(testCaseId)) {
        const warning = `Skipping shared step "${description}" - circular reference detected`;
        warnings.push(warning);
        logger.warn('[SHARED_STEP_RESOLVER] Circular reference detected', {
          testCaseId,
          visited: Array.from(visited),
        });
        continue;
      }

      // Load referenced test case
      const testCase = await this.loadTestCase(testCaseId);

      if (!testCase) {
        const warning = `Skipping shared step "${description}" - referenced test case not found or deleted`;
        warnings.push(warning);
        logger.warn('[SHARED_STEP_RESOLVER] Test case not found', { testCaseId });
        continue;
      }

      // Verify project access
      if (testCase.projectId !== projectId) {
        const warning = `Skipping shared step "${description}" - cross-project reference (access denied)`;
        warnings.push(warning);
        logger.warn('[SHARED_STEP_RESOLVER] Cross-project reference blocked', {
          testCaseId,
          expectedProjectId: projectId,
          actualProjectId: testCase.projectId,
        });
        continue;
      }

      // Verify commands exist
      if (!testCase.commands || testCase.commands.length === 0) {
        const warning = `Skipping shared step "${description}" - referenced test case has no commands`;
        warnings.push(warning);
        logger.warn('[SHARED_STEP_RESOLVER] Test case has no commands', {
          testCaseId,
          testCaseName: testCase.name,
        });
        continue;
      }

      // Recursively resolve the referenced test case's commands
      visited.add(testCaseId);

      const { commands: expandedCommands, warnings: nestedWarnings } =
        await this.resolveCommands(testCase.commands, projectId, depth + 1, new Set(visited));

      visited.delete(testCaseId);

      // Append expanded commands
      resolvedCommands.push(...expandedCommands);
      warnings.push(...nestedWarnings);

      logger.info('[SHARED_STEP_RESOLVER] Expanded shared step', {
        testCaseId,
        testCaseName: testCase.name,
        commandsAdded: expandedCommands.length,
        depth,
      });
    }

    // Check total command limit
    if (resolvedCommands.length > MAX_TOTAL_COMMANDS) {
      const originalLength = resolvedCommands.length;
      resolvedCommands.splice(MAX_TOTAL_COMMANDS);
      const warning = `Total commands exceeded limit (${MAX_TOTAL_COMMANDS}). Truncated from ${originalLength} to ${MAX_TOTAL_COMMANDS}.`;
      warnings.push(warning);
      logger.warn('[SHARED_STEP_RESOLVER] Command limit exceeded, truncating', {
        originalLength,
        truncatedTo: MAX_TOTAL_COMMANDS,
      });
    }

    return { commands: resolvedCommands, warnings };
  }

  /**
   * Load a test case for shared step resolution.
   * Only loads commands and project_id -- minimal query for performance.
   *
   * @param testCaseId - UUID of the intent_test_cases row
   * @returns Test case data or null if not found
   */
  private static async loadTestCase(testCaseId: string): Promise<LoadedTestCase | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, project_id, commands, name, parameters_schema')
        .eq('id', testCaseId)
        .single();

      if (error || !data) {
        return null;
      }

      return {
        id: data.id,
        projectId: data.project_id,
        commands: data.commands,
        name: data.name,
        parametersSchema: data.parameters_schema,
      };
    } catch (error) {
      logger.error('[SHARED_STEP_RESOLVER] Error loading test case', {
        error: error instanceof Error ? error.message : String(error),
        testCaseId,
      });
      return null;
    }
  }
}
