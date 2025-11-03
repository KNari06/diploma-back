import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { ExplorationResult } from '@/services/autonomous-explorer.service';
import { TestPlan } from '@/services/test-plan-generator.service';

/**
 * Save exploration result to cache
 */
export async function saveExplorationToCache(
  exploration: ExplorationResult,
  userId: string,
  projectId: string
): Promise<{ id: string; success: boolean }> {
  try {
    const { data, error } = await supabaseAdmin
      .from('exploration_cache')
      .insert({
        user_id: userId,
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
    const { data, error } = await supabaseAdmin
      .from('exploration_cache')
      .select('*')
      .eq('url', url)
      .eq('project_id', projectId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return null;
    }

    // Increment hit count
    await supabaseAdmin
      .from('exploration_cache')
      .update({ hit_count: (data.hit_count || 0) + 1 })
      .eq('id', data.id);

    logger.info('Retrieved cached exploration', {
      id: data.id,
      url,
      hitCount: data.hit_count + 1,
    });

    return {
      url: data.url,
      timestamp: data.created_at,
      screenshot: data.screenshot,
      visualAnalysis: data.visual_analysis,
      domAnalysis: data.dom_analysis,
      pageInfo: data.page_info,
      recommendations: data.recommendations,
    };
  } catch (error) {
    logger.warn('Failed to get cached exploration', { error });
    return null;
  }
}

/**
 * Save test plan awaiting confirmation
 */
export async function saveTestPlan(
  testPlan: TestPlan,
  userId: string,
  projectId: string,
  explorationId?: string
): Promise<{ success: boolean }> {
  try {
    const { error } = await supabaseAdmin
      .from('test_plans')
      .insert({
        id: testPlan.id,
        user_id: userId,
        project_id: projectId,
        url: testPlan.url,
        scope: testPlan.scope,
        summary: testPlan.summary,
        steps: testPlan.steps,
        commands: testPlan.commands,
        estimated_duration: testPlan.estimatedDuration,
        what_will_be_tested: testPlan.whatWillBeTested,
        what_will_not_be_tested: testPlan.whatWillNotBeTested,
        risks: testPlan.risks,
        status: 'pending_confirmation',
        exploration_id: explorationId,
        expires_at: testPlan.expiresAt,
      });

    if (error) {
      logger.error('Failed to save test plan', { error });
      throw error;
    }

    logger.info('Test plan saved', {
      planId: testPlan.id,
      stepsCount: testPlan.steps.length,
    });

    return { success: true };
  } catch (error) {
    logger.error('Error saving test plan', { error });
    throw error;
  }
}

/**
 * Get test plan by ID
 */
export async function getTestPlan(
  planId: string,
  userId: string
): Promise<TestPlan | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('test_plans')
      .select('*')
      .eq('id', planId)
      .eq('user_id', userId) // Security: only owner can access
      .single();

    if (error || !data) {
      return null;
    }

    return {
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
    };
  } catch (error) {
    logger.error('Error getting test plan', { error });
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
    const { data, error } = await supabaseAdmin
      .from('test_plans')
      .update({
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', planId)
      .eq('user_id', userId)
      .eq('status', 'pending_confirmation') // Only confirm if still pending
      .select()
      .single();

    if (error || !data) {
      logger.warn('Failed to confirm test plan', { planId, error });
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
    const { error } = await supabaseAdmin
      .from('test_plans')
      .update({
        status: 'rejected',
        rejected_at: new Date().toISOString(),
        rejection_reason: reason,
      })
      .eq('id', planId)
      .eq('user_id', userId)
      .eq('status', 'pending_confirmation');

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
