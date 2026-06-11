import { createHash } from 'crypto';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * Persistence for the public B2C "Ask Me Anything" chat.
 *
 * Conversations are anonymous (no user_id). We store privacy-safe context only:
 * a SALTED HASH of the IP (never the raw IP), coarse country, and the UA.
 *
 * Every write is BEST-EFFORT: it must never throw into, block, or slow down the
 * chat reply. All methods swallow errors with a warning. The widget keeps
 * working even if the DB is down — only the admin audit trail degrades.
 */

const IP_SALT = process.env.PUBLIC_CHAT_IP_SALT || 'qait-public-chat';
const MAX_UA_LENGTH = 400;
const MAX_PREVIEW_LENGTH = 200;

/** One-way salted hash so the same visitor groups together without storing PII. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${IP_SALT}:${ip}`).digest('hex').slice(0, 32);
}

export interface PublicChatTurn {
  sessionId: string;
  lang?: string;
  ip?: string;
  country?: string;
  userAgent?: string;
  userMessage: string;
  assistantMessage: string;
}

export class PublicChatPersistence {
  /**
   * Record one user↔assistant exchange. Finds (or creates) the conversation for
   * this session, appends both messages, and refreshes the denormalized
   * counters/preview. Fire-and-forget from the controller.
   */
  static async recordTurn(turn: PublicChatTurn): Promise<void> {
    try {
      const conversationId = await this.upsertConversation(turn);
      if (!conversationId) return;

      const now = new Date().toISOString();
      const { error: msgErr } = await supabaseAdmin
        .from('public_chat_messages')
        .insert([
          { conversation_id: conversationId, role: 'user', content: turn.userMessage, created_at: now },
          { conversation_id: conversationId, role: 'assistant', content: turn.assistantMessage, created_at: now },
        ]);
      if (msgErr) throw msgErr;

      // Refresh denormalized fields (preview + counters) on the conversation.
      // Read the current count to keep message_count accurate without a trigger.
      const { count } = await supabaseAdmin
        .from('public_chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId);

      await supabaseAdmin
        .from('public_chat_conversations')
        .update({
          message_count: count ?? undefined,
          last_message: turn.userMessage.slice(0, MAX_PREVIEW_LENGTH),
          last_message_at: now,
        })
        .eq('id', conversationId);
    } catch (err) {
      logger.warn('[PUBLIC_CHAT] Failed to persist conversation turn (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
        sessionId: turn.sessionId,
      });
    }
  }

  /** Find the conversation for this session id, or create it. Returns its id. */
  private static async upsertConversation(turn: PublicChatTurn): Promise<string | null> {
    const { data: existing } = await supabaseAdmin
      .from('public_chat_conversations')
      .select('id')
      .eq('session_id', turn.sessionId)
      .maybeSingle();

    if (existing?.id) return existing.id;

    const { data, error } = await supabaseAdmin
      .from('public_chat_conversations')
      .insert({
        session_id: turn.sessionId,
        lang: turn.lang ?? null,
        ip_hash: hashIp(turn.ip),
        country: turn.country ?? null,
        user_agent: turn.userAgent ? turn.userAgent.slice(0, MAX_UA_LENGTH) : null,
      })
      .select('id')
      .single();

    if (error) throw error;
    return data?.id ?? null;
  }
}
