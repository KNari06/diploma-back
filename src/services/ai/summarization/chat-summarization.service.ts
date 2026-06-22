import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { CONSTANTS } from '@/api/chat/shared/constants';
import { logger } from '@/utils/core/logger';
import { redactCredentials } from '@/utils/security/redact-credentials';

/**
 * Chat Summarization Service — "Agent Memory"
 *
 * Since there's only 1 chat per workspace, history grows indefinitely.
 * This service auto-summarizes old messages into compact summaries
 * stored in `chat_summaries`, then deletes the original messages.
 *
 * Flow:
 * 1. shouldSummarize(sessionId) — check if total messages > threshold
 * 2. summarizeOldMessages(sessionId) — compress oldest N messages → summary → delete originals
 * 3. getSummariesForContext(sessionId) — load summaries for AI context injection
 */

const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarizer for a QA testing platform chat.
Summarize the following chat messages into a concise summary (~300 words max).

Extract and preserve:
- Key decisions made by the user
- Test results (pass/fail, URLs tested, browsers used)
- User preferences and recurring topics
- Technical details (APIs tested, test configurations, credentials mentioned without values)
- Any ongoing tasks or unresolved issues

Format: Write in clear, structured paragraphs. Use bullet points for lists of results.
Do NOT include timestamps or message IDs. Focus on what matters for future context.`;

/**
 * Check if a session needs summarization
 */
export async function shouldSummarize(sessionId: string): Promise<boolean> {
  try {
    const { count } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    const totalMessages = count || 0;
    return totalMessages > CONSTANTS.SUMMARIZE_THRESHOLD;
  } catch (error) {
    logger.error('[SUMMARIZATION] Failed to check message count', {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
    return false;
  }
}

/**
 * Summarize oldest messages for a session.
 * Keeps the most recent KEEP_RECENT messages untouched.
 * Compresses MESSAGES_TO_SUMMARIZE oldest messages into a summary.
 * Deletes summarized messages and their embeddings.
 */
export async function summarizeOldMessages(sessionId: string): Promise<void> {
  try {
    // Get total message count
    const { count: totalCount } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    const total = totalCount || 0;
    if (total <= CONSTANTS.SUMMARIZE_THRESHOLD) {
      logger.debug('[SUMMARIZATION] Not enough messages to summarize', { sessionId, total });
      return;
    }

    // Calculate how many to summarize (never touch last KEEP_RECENT)
    const summarizeCount = Math.min(
      CONSTANTS.MESSAGES_TO_SUMMARIZE,
      total - CONSTANTS.KEEP_RECENT
    );

    if (summarizeCount <= 0) {
      logger.debug('[SUMMARIZATION] No messages eligible for summarization', { sessionId, total });
      return;
    }

    // Fetch oldest messages to summarize (ordered by created_at ASC)
    const { data: oldMessages, error: fetchError } = await supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(summarizeCount);

    if (fetchError || !oldMessages || oldMessages.length === 0) {
      logger.warn('[SUMMARIZATION] Failed to fetch old messages', { fetchError, sessionId });
      return;
    }

    logger.info('[SUMMARIZATION] Starting summarization', {
      sessionId,
      totalMessages: total,
      messagesToSummarize: oldMessages.length,
    });

    // Build conversation text for GPT. Redact secrets (pasted bot tokens /
    // webhook URLs) before they land in the long-lived summary — the verbatim
    // value stays in chat_messages, but the summary must not carry it.
    const conversationText = oldMessages
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${redactCredentials(msg.content)}`)
      .join('\n\n');

    // Truncate if very long (cap at ~12K chars to stay within GPT context)
    const truncated = conversationText.length > 12000
      ? conversationText.substring(0, 12000) + '\n\n[... truncated for summarization]'
      : conversationText;

    // Generate summary via GPT
    const result = await getChatCompletionWithMessages(
      [
        { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
        { role: 'user', content: `Summarize these ${oldMessages.length} messages:\n\n${truncated}` },
      ],
      {
        temperature: 0.3,
        max_tokens: 800,
        model: AI_TASK_MODELS.summarization, // Centralized model config
      }
    );

    const summary = result.content;
    if (!summary || summary.trim().length === 0) {
      logger.warn('[SUMMARIZATION] Empty summary generated', { sessionId });
      return;
    }

    // Store summary in chat_summaries
    const oldestAt = oldMessages[0].created_at;
    const newestAt = oldMessages[oldMessages.length - 1].created_at;

    const { error: insertError } = await supabaseAdmin
      .from('chat_summaries')
      .insert({
        session_id: sessionId,
        summary,
        messages_summarized: oldMessages.length,
        oldest_message_at: oldestAt,
        newest_message_at: newestAt,
        token_count: Math.ceil(summary.length / 4), // rough token estimate
        metadata: {
          summarized_at: new Date().toISOString(),
          original_message_count: oldMessages.length,
        },
      });

    if (insertError) {
      logger.error('[SUMMARIZATION] Failed to save summary', { insertError, sessionId });
      return;
    }

    // Delete embeddings for summarized messages
    const messageIds = oldMessages.map(m => m.id);
    const { error: embedDeleteError } = await supabaseAdmin
      .from('chat_message_embeddings')
      .delete()
      .in('message_id', messageIds);

    if (embedDeleteError) {
      logger.warn('[SUMMARIZATION] Failed to delete embeddings for summarized messages', {
        embedDeleteError,
        sessionId,
      });
    }

    // Delete the summarized messages
    const { error: deleteError } = await supabaseAdmin
      .from('chat_messages')
      .delete()
      .in('id', messageIds);

    if (deleteError) {
      logger.error('[SUMMARIZATION] Failed to delete summarized messages', {
        deleteError,
        sessionId,
      });
      return;
    }

    logger.info('[SUMMARIZATION] Summarization complete', {
      sessionId,
      messagesSummarized: oldMessages.length,
      summaryLength: summary.length,
      oldestDate: oldestAt,
      newestDate: newestAt,
    });
  } catch (error) {
    logger.error('[SUMMARIZATION] Critical error during summarization', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      sessionId,
    });
  }
}

/**
 * Load all summaries for a session and format for AI context injection.
 * Caps at MAX_SUMMARY_TOKENS (~8000 chars) to control context size.
 */
export async function getSummariesForContext(sessionId: string): Promise<string> {
  try {
    const { data: summaries, error } = await supabaseAdmin
      .from('chat_summaries')
      .select('summary, newest_message_at')
      .eq('session_id', sessionId)
      .order('newest_message_at', { ascending: true });

    if (error || !summaries || summaries.length === 0) {
      return '';
    }

    // Combine summaries, newest last
    let combined = summaries.map(s => s.summary).join('\n\n---\n\n');

    // Cap at MAX_SUMMARY_TOKENS (rough: 1 token ≈ 4 chars)
    const maxChars = CONSTANTS.MAX_SUMMARY_TOKENS * 4;
    if (combined.length > maxChars) {
      // Keep the most recent summaries (trim from the beginning)
      combined = '...' + combined.slice(combined.length - maxChars);
    }

    return combined;
  } catch (error) {
    logger.warn('[SUMMARIZATION] Failed to load summaries', {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
    return '';
  }
}
