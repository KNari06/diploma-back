import { supabaseAdmin } from '@/db/supabase';
import { TestPlan } from '@/services/testing/plans/test-plan-generator.service';
import { ExplorationResult } from '@/services/testing/ui/autonomous/autonomous-explorer.service';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Save exploration result to cache
 */
export async function saveExplorationToCache(
  exploration: ExplorationResult,
  userId: string,
  projectId: string
): Promise<{ id: string; success: boolean }> {
  try {
    // FIX: Only valid UUIDs allowed (no anonymous users)
    const validUserId = userId && userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      ? userId
      : null;

    const { data, error } = await supabaseAdmin
      .from('exploration_cache')
      .insert({
        user_id: validUserId,
        project_id: projectId,
        url: exploration.url,
        scope: exploration.pageInfo.title || 'Unknown',
        screenshot: exploration.screenshot,
        visual_analysis: exploration.visualAnalysis,
        dom_analysis: exploration.domAnalysis,
        page_info: exploration.pageInfo,
        recommendations: exploration.recommendations,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to save exploration to cache', { error });
      throw error;
    }

    logger.info('Exploration saved to cache', {
      id: data.id,
      url: exploration.url,
    });

    return { id: data.id, success: true };
  } catch (error) {
    logger.error('Error saving exploration to cache', { error });
    throw error;
  }
}

/**
 * Get cached exploration by URL
 */
export async function getCachedExploration(
  url: string,
  projectId: string
): Promise<ExplorationResult | null> {
  try {
    // ✅ VALIDATION: Validate inputs
    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      logger.warn('Invalid URL provided to getCachedExploration', { url });
      return null;
    }

    if (!projectId || typeof projectId !== 'string' || projectId.trim().length === 0) {
      logger.warn('Invalid projectId provided to getCachedExploration', { projectId });
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from('exploration_cache')
      .select('*')
      .eq('url', url.trim())
      .eq('project_id', projectId.trim())
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      // Handle "not found" as normal case (not an error)
      if (error.code === 'PGRST116') {
        logger.debug('No cached exploration found', { url, projectId });
        return null;
      }
      logger.error('Database error getting cached exploration', {
        error: error instanceof Error ? error.message : String(error),
        errorCode: error.code,
        url,
        projectId,
      });
      return null;
    }

    if (!data) {
      return null;
    }

    // ✅ VALIDATION: Check required fields exist
    if (!data.url || !data.created_at) {
      logger.error('Invalid cached exploration data structure', {
        id: data.id,
        hasUrl: !!data.url,
        hasCreatedAt: !!data.created_at,
      });
      return null;
    }

    // Increment hit count (non-blocking, don't fail if this errors)
    Promise.resolve(
      supabaseAdmin
        .from('exploration_cache')
        .update({ hit_count: (data.hit_count || 0) + 1 })
        .eq('id', data.id)
    ).catch((updateError: unknown) => {
      logger.warn('Failed to increment hit_count', {
        error: updateError instanceof Error ? updateError.message : String(updateError),
        id: data.id,
      });
    });

    logger.info('Retrieved cached exploration', {
      id: data.id,
      url,
      hitCount: (data.hit_count || 0) + 1,
    });

    return {
      url: data.url,
      timestamp: data.created_at,
      screenshot: data.screenshot || null,
      visualAnalysis: data.visual_analysis || null,
      domAnalysis: data.dom_analysis || null,
      pageInfo: data.page_info || null,
      recommendations: data.recommendations || [],
    };
  } catch (error) {
    logger.warn('Failed to get cached exploration', {
      error: error instanceof Error ? error.message : String(error),
      url,
      projectId,
    });
    return null;
  }
}

/**
 * Save test plan awaiting confirmation
 * FIXED: Added validation, new fields support, and centralized UUID validation
 */
export async function saveTestPlan(
  testPlan: TestPlan,
  userId: string,
  projectId: string,
  explorationId?: string
): Promise<{ success: boolean }> {
  try {
    logger.info('[SAVE_TEST_PLAN] Starting to save test plan', {
      planId: testPlan.id,
      userId: userId.substring(0, 8) + '...',
      projectId: projectId.substring(0, 8) + '...',
      scope: testPlan.scope,
      status: testPlan.status,
      explorationId: explorationId ? explorationId.substring(0, 8) + '...' : 'none',
    });
    // FIX #1: Input validation
    if (!testPlan) {
      throw new Error('TestPlan is required');
    }

    if (!testPlan.id || typeof testPlan.id !== 'string' || testPlan.id.trim().length === 0) {
      throw new Error('TestPlan ID is required');
    }

    if (!testPlan.url || typeof testPlan.url !== 'string' || testPlan.url.trim().length === 0) {
      throw new Error('TestPlan URL is required');
    }

    if (!testPlan.scope || typeof testPlan.scope !== 'string' || testPlan.scope.trim().length === 0) {
      throw new Error('TestPlan scope is required');
    }

    if (!Array.isArray(testPlan.steps) || testPlan.steps.length === 0) {
      throw new Error('TestPlan must have at least one step');
    }

    // FIX #2: Centralized UUID validation (consistent with other services)
    const validUserId = isValidUUID(userId) ? userId : null;

    if (!validUserId) {
      logger.warn('[SAVE_TEST_PLAN] Invalid userId provided, saving without user association', {
        userId: userId?.substring(0, 8) + '...',
        testPlanId: testPlan.id,
      });
    }

    // FIX #3: Validate projectId
    if (!projectId || typeof projectId !== 'string' || projectId.trim().length === 0) {
      throw new Error('ProjectId is required');
    }

    // FIX #4: Validate explorationId if provided
    if (explorationId && !isValidUUID(explorationId)) {
      logger.warn('[SAVE_TEST_PLAN] Invalid explorationId provided, ignoring', {
        explorationId: explorationId.substring(0, 8) + '...',
        testPlanId: testPlan.id,
      });
      explorationId = undefined;
    }

    logger.info('[SAVE_TEST_PLAN] Saving test plan', {
      planId: testPlan.id,
      userId: validUserId?.substring(0, 8) + '...',
      projectId: projectId.substring(0, 8) + '...',
      stepsCount: testPlan.steps.length,
      commandsCount: testPlan.commands?.length || 0,
      intelligentMode: testPlan.intelligentMode,
    });

    // FIX #5: Include all TestPlan fields (including new AI-generated fields)
    const { error } = await supabaseAdmin
      .from('test_plans')
      .insert({
        id: testPlan.id,
        user_id: validUserId,
        project_id: projectId,
        url: testPlan.url,
        scope: testPlan.scope,
        summary: testPlan.summary,
        steps: testPlan.steps,
        commands: testPlan.commands || [],
        estimated_duration: testPlan.estimatedDuration,
        what_will_be_tested: testPlan.whatWillBeTested || [],
        what_will_not_be_tested: testPlan.whatWillNotBeTested || [],
        risks: testPlan.risks || [],
        notes: testPlan.notes || null, // NEW: Support notes field
        status: 'pending_confirmation',
        exploration_id: explorationId,
        expires_at: testPlan.expiresAt,
        // NEW: AI-generated fields support
        intelligent_mode: testPlan.intelligentMode || false,
        estimated_pages: testPlan.estimatedPages,
        estimated_cost: testPlan.estimatedCost,
        mode: ((testPlan.mode as string) === 'editor' ? 'lite' : testPlan.mode) || 'lite', // Test execution mode (only 'lite' or 'pro')
      });

    if (error) {
      logger.error('[SAVE_TEST_PLAN] Database insert failed', {
        error: error.message,
        errorCode: error.code,
        errorDetails: error.details,
        errorHint: error.hint,
        testPlanId: testPlan.id,
        userId: validUserId?.substring(0, 8) + '...',
        projectId: projectId.substring(0, 8) + '...',
        planIdFormat: testPlan.id.includes('-') ? 'UUID' : 'INVALID_FORMAT',
        planIdLength: testPlan.id.length,
      });
      throw new Error(`Failed to save test plan: ${error.message}`);
    }

    logger.info('[SAVE_TEST_PLAN] ✅ Test plan saved successfully to database', {
      planId: testPlan.id,
      stepsCount: testPlan.steps.length,
      commandsCount: testPlan.commands?.length || 0,
      intelligentMode: testPlan.intelligentMode,
      estimatedDuration: testPlan.estimatedDuration,
      scope: testPlan.scope,
      status: 'pending_confirmation',
    });

    return { success: true };

  } catch (error) {
    logger.error('[SAVE_TEST_PLAN] Error saving test plan', {
      error: error instanceof Error ? error.message : String(error),
      testPlanId: testPlan?.id,
      userId: userId?.substring(0, 8) + '...',
      projectId: projectId?.substring(0, 8) + '...',
    });
    throw error;
  }
}

/**
 * Get latest pending test plan for user (fallback when conversationId not provided)
 */
export async function getLatestPendingTestPlan(
  userId: string
): Promise<TestPlan | null> {
  try {
    // FIX: Remove anonymous logic - only valid UUIDs allowed
    if (!isValidUUID(userId)) {
      logger.warn('[GET_LATEST_PENDING] Invalid userId, cannot fetch plan', {
        userId,
        reason: 'userId must be a valid UUID',
      });
      return null;
    }

    const query = supabaseAdmin
      .from('test_plans')
      .select('*')
      .eq('status', 'pending_confirmation')
      .eq('user_id', userId) // Always filter by valid userId
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);

    const { data, error } = await query.maybeSingle();

    // ✅ FIX: Better error handling - distinguish between "not found" and "database error"
    if (error) {
      if (error.code === 'PGRST116') {
        // Record not found - this is normal
        logger.info('[GET_LATEST_PENDING] No pending plan found', { userId });
        return null;
      }
      // Other database error
      logger.error('[GET_LATEST_PENDING] Database error', {
        error: error instanceof Error ? error.message : String(error),
        errorCode: error.code,
        userId,
      });
      return null;
    }

    if (!data) {
      logger.info('[GET_LATEST_PENDING] No pending plan found', { userId });
      return null;
    }

    // ✅ FIX: Check status after retrieval (race condition protection)
    if (data.status !== 'pending_confirmation') {
      logger.warn('[GET_LATEST_PENDING] Plan status changed', {
        planId: data.id,
        status: data.status,
        userId,
      });
      return null;
    }

    // ✅ FIX: Check expires_at after retrieval (defensive check)
    if (data.expires_at && new Date(data.expires_at) <= new Date()) {
      logger.warn('[GET_LATEST_PENDING] Plan expired', {
        planId: data.id,
        userId,
        expiresAt: data.expires_at,
        now: new Date().toISOString(),
      });
      return null;
    }

    logger.info('[PENDING_PLAN] Found latest pending test plan', {
      planId: data.id,
      userId,
      createdAt: data.created_at,
    });

    // ✅ FIX: Return complete TestPlan with all fields (matching getTestPlan)
    return {
      id: data.id,
      status: data.status,
      url: data.url,
      scope: data.scope,
      summary: data.summary,
      steps: data.steps || [],
      commands: data.commands || [],
      estimatedDuration: data.estimated_duration,
      whatWillBeTested: data.what_will_be_tested || [],
      whatWillNotBeTested: data.what_will_not_be_tested || [],
      risks: data.risks || [],
      notes: data.notes || null, // ✅ Added: Support notes field
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      // ✅ Added: Missing optional fields
      intelligentMode: data.intelligent_mode || false,
      estimatedPages: data.estimated_pages,
      estimatedCost: data.estimated_cost,
    };
  } catch (error) {
    logger.error('Error getting latest pending test plan', { error });
    return null;
  }
}

/**
 * Get test plan by ID
 * FIX: Improved validation, error handling, and field coverage
 */
export async function getTestPlan(
  planId: string,
  userId: string
): Promise<TestPlan | null> {
  try {
    // FIX #3: Validate planId is a valid UUID
    if (!isValidUUID(planId)) {
      logger.warn('[GET_TEST_PLAN] Invalid planId format', {
        planId,
        userId,
      });
      return null;
    }

    // FIX #1: Use centralized UUID validation
    const isValidUserId = isValidUUID(userId);

    // FIX #4: If userId is invalid, return null (no anonymous plans support)
    if (!isValidUserId) {
      logger.warn('[GET_TEST_PLAN] Invalid userId, cannot fetch plan', {
        planId,
        userId,
        reason: 'userId must be a valid UUID',
      });
      return null;
    }

    // Query with proper filters
    const { data, error } = await supabaseAdmin
      .from('test_plans')
      .select('*')
      .eq('id', planId)
      .eq('user_id', userId)
      .single();

    // FIX #2: Better error handling
    if (error) {
      // PGRST116 = Record not found (expected)
      if (error.code === 'PGRST116') {
        logger.info('[GET_TEST_PLAN] Test plan not found', {
          planId,
          userId,
          errorCode: error.code,
        });
        return null;
      }

      // Unexpected error (network, permission, etc.)
      logger.error('[GET_TEST_PLAN] Unexpected error fetching test plan', {
        error,
        planId,
        userId,
        errorCode: error.code,
        errorMessage: error.message,
      });
      return null;
    }

    if (!data) {
      logger.info('[GET_TEST_PLAN] Test plan not found (no data)', {
        planId,
        userId,
      });
      return null;
    }

    // ✅ FIX: Check expires_at to prevent using expired plans
    if (data.expires_at && new Date(data.expires_at) <= new Date()) {
      logger.warn('[GET_TEST_PLAN] Test plan expired', {
        planId,
        userId,
        expiresAt: data.expires_at,
        now: new Date().toISOString(),
      });
      // Optionally update status to expired (non-blocking)
      // ✅ FIX: Convert PromiseLike to Promise and add proper error typing
      Promise.resolve(
        supabaseAdmin
          .from('test_plans')
          .update({ status: 'expired' })
          .eq('id', planId)
          .eq('user_id', userId)
      )
        .then(() => {
          logger.info('[GET_TEST_PLAN] Plan status updated to expired', { planId });
        })
        .catch((error: unknown) => {
          logger.warn('[GET_TEST_PLAN] Failed to update plan status', {
            error: error instanceof Error ? error.message : String(error),
            planId
          });
        });
      return null;
    }

    // FIX #5: Return complete TestPlan with all fields
    return {
      id: data.id,
      status: data.status,
      url: data.url,
      scope: data.scope,
      summary: data.summary,
      steps: data.steps || [],
      commands: data.commands || [],
      estimatedDuration: data.estimated_duration,
      whatWillBeTested: data.what_will_be_tested || [],
      whatWillNotBeTested: data.what_will_not_be_tested || [],
      risks: data.risks || [],
      notes: data.notes || null, // NEW: Support notes field
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      // FIX #5: Add missing optional fields
      intelligentMode: data.intelligent_mode || false,
      estimatedPages: data.estimated_pages,
      estimatedCost: data.estimated_cost,
      mode: data.mode || 'lite', // Test execution mode
    };
  } catch (error) {
    logger.error('[GET_TEST_PLAN] Critical error getting test plan', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      planId,
      userId,
    });
    return null;
  }
}


/**
 * Confirm test plan
 */
export async function confirmTestPlan(
  planId: string,
  userId: string
): Promise<{ success: boolean; plan?: TestPlan }> {
  try {
    // FIX: Remove anonymous logic - validate both IDs
    if (!isValidUUID(planId) || !isValidUUID(userId)) {
      logger.warn('[CONFIRM_TEST_PLAN] Invalid UUID format', {
        planId,
        userId,
        reason: 'Both planId and userId must be valid UUIDs',
      });
      return { success: false };
    }

    const query = supabaseAdmin
      .from('test_plans')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', planId)
      .eq('user_id', userId) // Always filter by valid userId
      .eq('status', 'pending_confirmation'); // Only confirm if still pending

    const { data, error } = await query.select().single();

    if (error || !data) {
      logger.warn('Failed to confirm test plan', { planId, userId, error });
      return { success: false };
    }

    logger.info('Test plan confirmed', { planId });

    return {
      success: true,
      plan: {
        id: data.id,
        status: data.status,
        url: data.url,
        scope: data.scope,
        summary: data.summary,
        steps: data.steps,
        commands: data.commands,
        estimatedDuration: data.estimated_duration,
        whatWillBeTested: data.what_will_be_tested,
        whatWillNotBeTested: data.what_will_not_be_tested,
        risks: data.risks,
        createdAt: data.created_at,
        expiresAt: data.expires_at,
      },
    };
  } catch (error) {
    logger.error('Error confirming test plan', { error });
    return { success: false };
  }
}

/**
 * Reject test plan
 */
export async function rejectTestPlan(
  planId: string,
  userId: string,
  reason?: string
): Promise<{ success: boolean }> {
  try {
    // FIX: Remove anonymous logic - validate both IDs
    if (!isValidUUID(planId) || !isValidUUID(userId)) {
      logger.warn('[REJECT_TEST_PLAN] Invalid UUID format', {
        planId,
        userId,
        reason: 'Both planId and userId must be valid UUIDs',
      });
      return { success: false };
    }

    const query = supabaseAdmin
      .from('test_plans')
      .update({
        status: 'rejected',
        rejected_at: new Date().toISOString(),
        rejection_reason: reason,
      })
      .eq('id', planId)
      .eq('user_id', userId) // Always filter by valid userId
      .eq('status', 'pending_confirmation');

    const { error } = await query;

    if (error) {
      logger.error('Failed to reject test plan', { error });
      return { success: false };
    }

    logger.info('Test plan rejected', { planId, reason });
    return { success: true };
  } catch (error) {
    logger.error('Error rejecting test plan', { error });
    return { success: false };
  }
}
