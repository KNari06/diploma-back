/**
 * Default Suite Service
 * Ensures module-scoped default suites exist for simplified flow/test case creation
 */

import { supabaseAdmin } from '@/db/supabase';
import type { PlatformKey, SuiteType } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

/**
 * Service for managing default suites within modules
 * Each module has one "Default" suite as a technical container for flows
 */
export class DefaultSuiteService {
  /**
   * Ensure a default suite exists for the given module
   * Resolves existing suite or creates a new one with correct suite_type matching platform
   * 
   * @param moduleId - Module ID to ensure default suite for
   * @param userId - User ID for ownership and access control
   * @returns Suite ID of the default suite
   * @throws Error if module not found or platform mismatch
   */
  static async ensureDefaultSuite(moduleId: string, userId: string): Promise<string> {
    logger.info('[DEFAULT_SUITE_SERVICE] Ensuring default suite exists', {
      moduleId,
      userId,
    });

    // 1. Load module with platform information
    const { data: module, error: moduleError } = await supabaseAdmin
      .from('test_modules')
      .select('id, project_id, platform_id, test_platforms!inner(platform_key)')
      .eq('id', moduleId)
      .eq('user_id', userId)
      .single();

    if (moduleError || !module) {
      logger.error('[DEFAULT_SUITE_SERVICE] Module not found', {
        error: moduleError,
        moduleId,
      });
      throw new Error(`Module not found: ${moduleId}`);
    }

    const platformKey: PlatformKey = (module.test_platforms as any).platform_key;
    const suiteType: SuiteType = platformKey === 'web_ui' ? 'ui' : 'api';

    logger.info('[DEFAULT_SUITE_SERVICE] Module platform resolved', {
      moduleId,
      platformKey,
      suiteType,
    });

    // 2. Find existing default suite
    const { data: existingSuite, error: findError } = await supabaseAdmin
      .from('regression_suites')
      .select('id, suite_type')
      .eq('module_id', moduleId)
      .eq('user_id', userId)
      .eq('name', 'Default')
      .maybeSingle();

    if (findError) {
      logger.error('[DEFAULT_SUITE_SERVICE] Error finding existing suite', {
        error: findError,
        moduleId,
      });
      throw new Error(`Failed to query default suite: ${findError.message}`);
    }

    // 3. If suite exists, verify suite_type matches platform (should be enforced by DB trigger)
    if (existingSuite) {
      if (existingSuite.suite_type !== suiteType) {
        logger.error('[DEFAULT_SUITE_SERVICE] Suite type mismatch', {
          moduleId,
          expectedSuiteType: suiteType,
          actualSuiteType: existingSuite.suite_type,
        });
        throw new Error(
          `Default suite exists but has wrong type: expected ${suiteType}, found ${existingSuite.suite_type}`
        );
      }

      logger.info('[DEFAULT_SUITE_SERVICE] Default suite already exists', {
        suiteId: existingSuite.id,
        moduleId,
      });
      return existingSuite.id;
    }

    // 4. Create new default suite
    const { data: newSuite, error: createError } = await supabaseAdmin
      .from('regression_suites')
      .insert({
        project_id: module.project_id,
        user_id: userId,
        module_id: moduleId,
        name: 'Default',
        suite_type: suiteType,
        description: 'Auto-created default suite for flows and test cases',
      })
      .select('id')
      .single();

    if (createError || !newSuite) {
      logger.error('[DEFAULT_SUITE_SERVICE] Failed to create default suite', {
        error: createError,
        moduleId,
      });
      throw new Error(`Failed to create default suite: ${createError?.message}`);
    }

    logger.info('[DEFAULT_SUITE_SERVICE] Default suite created', {
      suiteId: newSuite.id,
      moduleId,
      suiteType,
    });

    return newSuite.id;
  }
}
