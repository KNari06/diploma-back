import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { getTelegramToken, sendMessage as sendTelegramMessage } from '@/services/api/telegram.service';
import { env } from '@/config/environment/env';
import * as crypto from 'crypto';
import type {
  AutomationAction,
  AutomationEventContext,
  CreateAutomationActionParams,
  UpdateAutomationActionParams,
  TelegramNotifyConfig,
  WebhookPostConfig,
  TriggerEvent,
} from '@/types/automation.types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTOMATION ACTION SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Universal post-event automation engine.
 * - CRUD for automation_actions table
 * - fireEvent(): find matching actions for an event → execute → log
 * - Action-specific executors (Telegram, Slack, Jira, Webhook, ShareLink)
 *
 * Non-blocking: fireEvent() catches all errors internally.
 * Called from TestCompletionHandlerService via .catch(() => {}).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */


export class AutomationActionService {

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════════════════════

  static async create(params: CreateAutomationActionParams): Promise<AutomationAction> {
    const { data, error } = await supabaseAdmin
      .from('automation_actions')
      .insert({
        user_id: params.userId,
        project_id: params.projectId || null,
        schedule_id: params.scheduleId || null,
        plan_id: params.planId || null,
        trigger_event: params.triggerEvent,
        action_type: params.actionType,
        condition: params.condition || 'always',
        config: params.config,
        name: params.name || null,
        priority: params.priority ?? 100,
      })
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to create automation action: ${error?.message}`);
    }

    logger.info('[AUTOMATION] Created action', { id: data.id, triggerEvent: params.triggerEvent, actionType: params.actionType });
    return this.mapRow(data);
  }

  static async update(params: UpdateAutomationActionParams): Promise<AutomationAction> {
    const updates: Record<string, any> = {};
    if (params.triggerEvent !== undefined) updates.trigger_event = params.triggerEvent;
    if (params.actionType !== undefined) updates.action_type = params.actionType;
    if (params.condition !== undefined) updates.condition = params.condition;
    if (params.config !== undefined) updates.config = params.config;
    if (params.name !== undefined) updates.name = params.name;
    if (params.isActive !== undefined) updates.is_active = params.isActive;
    if (params.priority !== undefined) updates.priority = params.priority;

    const { data, error } = await supabaseAdmin
      .from('automation_actions')
      .update(updates)
      .eq('id', params.id)
      .eq('user_id', params.userId)
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(`Failed to update automation action: ${error?.message}`);
    }

    logger.info('[AUTOMATION] Updated action', { id: params.id });
    return this.mapRow(data);
  }

  static async delete(id: string, userId: string): Promise<boolean> {
    const { error } = await supabaseAdmin
      .from('automation_actions')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to delete automation action: ${error.message}`);
    }

    logger.info('[AUTOMATION] Deleted action', { id });
    return true;
  }

  static async getById(id: string, userId: string): Promise<AutomationAction | null> {
    const { data, error } = await supabaseAdmin
      .from('automation_actions')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      logger.error('[AUTOMATION] getById error', { error: error.message, id });
      return null;
    }

    return data ? this.mapRow(data) : null;
  }

  static async listByProject(projectId: string, userId: string): Promise<AutomationAction[]> {
    const { data, error } = await supabaseAdmin
      .from('automation_actions')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[AUTOMATION] listByProject error', { error: error.message, projectId });
      return [];
    }

    return (data || []).map(this.mapRow);
  }

  static async listByUser(userId: string): Promise<AutomationAction[]> {
    const { data, error } = await supabaseAdmin
      .from('automation_actions')
      .select('*')
      .eq('user_id', userId)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      logger.error('[AUTOMATION] listByUser error', { error: error.message });
      return [];
    }

    return (data || []).map(this.mapRow);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EVENT FIRING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Main entry point: find all matching actions for an event and execute them.
   * Non-blocking — catches all errors internally.
   */
  static async fireEvent(ctx: AutomationEventContext): Promise<void> {
    try {
      const actions = await this.findMatchingActions(ctx);

      if (actions.length === 0) return;

      logger.info('[AUTOMATION] Firing actions', {
        triggerEvent: ctx.triggerEvent,
        sourceEntityId: ctx.sourceEntityId,
        matchingActions: actions.length,
      });

      // Execute all matching actions (concurrently, non-blocking)
      await Promise.allSettled(
        actions.map(action => this.executeAction(action, ctx))
      );
    } catch (error) {
      logger.error('[AUTOMATION] fireEvent error', {
        error: error instanceof Error ? error.message : String(error),
        triggerEvent: ctx.triggerEvent,
        sourceEntityId: ctx.sourceEntityId,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNALS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Find active actions matching the event context.
   * Expands triggers: run_failed also matches run_completed actions.
   * Filters by scope: schedule_id > plan_id > project_id > user-global.
   */
  private static async findMatchingActions(ctx: AutomationEventContext): Promise<AutomationAction[]> {
    // Expand triggers: specific events also match generic ones
    const triggers: TriggerEvent[] = [ctx.triggerEvent];
    if (ctx.triggerEvent === 'run_passed' || ctx.triggerEvent === 'run_failed') {
      triggers.push('run_completed');
    }
    if (ctx.triggerEvent === 'test_failed') {
      triggers.push('test_completed');
    }

    const { data, error } = await supabaseAdmin
      .from('automation_actions')
      .select('*')
      .eq('user_id', ctx.userId)
      .in('trigger_event', triggers)
      .eq('is_active', true)
      .order('priority', { ascending: true });

    if (error || !data) {
      // PGRST205 = table not found (expected if migration not applied yet)
      if ((error as any)?.code === 'PGRST205') {
        logger.debug('[AUTOMATION] automation_actions table not available (migration pending)');
      } else {
        logger.error('[AUTOMATION] findMatchingActions error', { error: error?.message });
      }
      return [];
    }

    // Filter by scope: action must be scoped to this event's scope or broader
    return data
      .filter(row => {
        // If action is scoped to a specific schedule, it only fires for that schedule
        if (row.schedule_id && row.schedule_id !== ctx.scheduleId) return false;
        // If action is scoped to a specific plan, it only fires for that plan
        if (row.plan_id && row.plan_id !== ctx.planId) return false;
        // If action is scoped to a specific project, it only fires for that project
        if (row.project_id && row.project_id !== ctx.projectId) return false;
        // Condition filter
        return this.matchesCondition(row.condition, ctx.eventData.status);
      })
      .map(this.mapRow);
  }

  /**
   * Execute a single action and log the result.
   */
  private static async executeAction(
    action: AutomationAction,
    ctx: AutomationEventContext
  ): Promise<void> {
    const idempotencyKey = `${action.id}:${ctx.sourceEntityType}:${ctx.sourceEntityId}`;
    const startedAt = new Date().toISOString();

    try {
      // Check dedup
      if (await this.isDuplicate(idempotencyKey)) {
        logger.debug('[AUTOMATION] Skipping duplicate', { actionId: action.id, idempotencyKey });
        return;
      }

      let responseData: any = null;

      switch (action.actionType) {
        case 'telegram_notify':
          responseData = await this.executeTelegramNotify(action.config as TelegramNotifyConfig, ctx);
          break;
        case 'webhook_post':
          responseData = await this.executeWebhookPost(action.config as WebhookPostConfig, ctx);
          break;
        case 'generate_share_link':
          responseData = await this.executeGenerateShareLink(ctx);
          break;
        case 'slack_notify':
          // Delegates to Slack skill — placeholder for future implementation
          responseData = { skipped: true, reason: 'Slack executor not yet implemented' };
          break;
        case 'jira_create_issue':
          // Delegates to Jira skill — placeholder for future implementation
          responseData = { skipped: true, reason: 'Jira executor not yet implemented' };
          break;
      }

      // Log success
      await this.logExecution(action.id, ctx, idempotencyKey, 'success', startedAt, null, responseData);

      logger.info('[AUTOMATION] Action executed', {
        actionId: action.id,
        actionType: action.actionType,
        triggerEvent: ctx.triggerEvent,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Log failure (non-blocking)
      await this.logExecution(action.id, ctx, idempotencyKey, 'failed', startedAt, errorMsg, null)
        .catch(() => {}); // Double safety: log failure never throws

      logger.error('[AUTOMATION] Action execution failed', {
        actionId: action.id,
        actionType: action.actionType,
        error: errorMsg,
      });
    }
  }

  // ── Action-specific executors ──────────────────────────────────────────

  private static async executeTelegramNotify(
    config: TelegramNotifyConfig,
    ctx: AutomationEventContext
  ): Promise<any> {
    const tokenData = await getTelegramToken(ctx.userId);
    if (!tokenData) throw new Error('Telegram not connected');

    const chatId = config.chat_id || tokenData.external_id;
    if (!chatId) throw new Error('No chat_id configured and no default chat_id in integration');

    // Auto-generate share link if requested
    let shareUrl = ctx.eventData.shareUrl;
    if (config.include_share_link && ctx.eventData.runId && !shareUrl) {
      try {
        const result = await this.executeGenerateShareLink(ctx);
        shareUrl = result.shareUrl;
      } catch {
        // Continue without share link
      }
    }

    // Build message
    const title = ctx.eventData.title || `Automation: ${ctx.triggerEvent}`;
    const body = ctx.eventData.message || '';
    const shareSection = shareUrl ? `\n\n<a href="${shareUrl}">View full report</a>` : '';
    const htmlMessage = `<b>${title}</b>\n\n${body}${shareSection}`;

    await sendTelegramMessage(tokenData.access_token, chatId, htmlMessage, 'HTML');

    return { chatId, hasShareLink: !!shareUrl };
  }

  private static async executeWebhookPost(
    config: WebhookPostConfig,
    ctx: AutomationEventContext
  ): Promise<any> {
    const method = config.method || 'POST';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.headers || {}),
    };

    const response = await fetch(config.url, {
      method,
      headers,
      body: JSON.stringify({
        event: ctx.triggerEvent,
        sourceType: ctx.sourceEntityType,
        sourceId: ctx.sourceEntityId,
        ...ctx.eventData,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    return { statusCode: response.status, ok: response.ok };
  }

  private static async executeGenerateShareLink(
    ctx: AutomationEventContext
  ): Promise<{ shareToken: string; shareUrl: string }> {
    const runId = ctx.eventData.runId;
    if (!runId) throw new Error('No runId for share link generation');

    const { data: run } = await supabaseAdmin
      .from('regression_runs')
      .select('share_token')
      .eq('id', runId)
      .single();

    let shareToken = run?.share_token;

    if (!shareToken) {
      shareToken = crypto.randomBytes(16).toString('hex');

      await supabaseAdmin
        .from('regression_runs')
        .update({ share_token: shareToken })
        .eq('id', runId)
        .is('share_token', null);

      // Re-fetch for race safety
      const { data: refreshed } = await supabaseAdmin
        .from('regression_runs')
        .select('share_token')
        .eq('id', runId)
        .single();

      if (refreshed?.share_token) shareToken = refreshed.share_token;
    }

    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    const shareUrl = `${frontendUrl}/shared/report/${shareToken}`;

    return { shareToken: shareToken!, shareUrl };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private static matchesCondition(condition: string, eventStatus?: string): boolean {
    if (condition === 'always') return true;
    if (condition === 'on_failure') return eventStatus === 'failed';
    if (condition === 'on_success') return eventStatus === 'passed' || eventStatus === 'completed';
    return false;
  }

  private static async isDuplicate(idempotencyKey: string): Promise<boolean> {
    const { data } = await supabaseAdmin
      .from('automation_action_logs')
      .select('id')
      .eq('idempotency_key', idempotencyKey)
      .neq('status', 'failed')
      .limit(1)
      .maybeSingle();

    return !!data;
  }

  private static async logExecution(
    actionId: string,
    ctx: AutomationEventContext,
    idempotencyKey: string,
    status: 'success' | 'failed' | 'skipped',
    startedAt: string,
    errorMessage: string | null,
    responseData: any
  ): Promise<void> {
    await supabaseAdmin
      .from('automation_action_logs')
      .insert({
        action_id: actionId,
        trigger_event: ctx.triggerEvent,
        source_entity_type: ctx.sourceEntityType,
        source_entity_id: ctx.sourceEntityId,
        status,
        error_message: errorMessage,
        response_data: responseData,
        idempotency_key: idempotencyKey,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      });
  }

  private static mapRow(row: any): AutomationAction {
    return {
      id: row.id,
      userId: row.user_id,
      projectId: row.project_id,
      scheduleId: row.schedule_id,
      planId: row.plan_id,
      triggerEvent: row.trigger_event,
      actionType: row.action_type,
      condition: row.condition,
      config: row.config,
      name: row.name,
      isActive: row.is_active,
      priority: row.priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
