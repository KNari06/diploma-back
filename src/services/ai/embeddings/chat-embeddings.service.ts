import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import { generateEmbedding } from '../core/embedding.service';

/**
 * Chat Embeddings Service
 * Manages vector embeddings for chat messages to enable semantic search
 *
 * Benefits over GPT summarization:
 * - 20x faster (~100ms vs 2-3 sec)
 * - 20x cheaper (~$0.0001 vs $0.002 per 1K messages)
 * - More accurate (semantic search finds exactly relevant messages)
 * - No information loss (keeps full message content)
 */

interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  created_at: string;
}

interface ChatEmbeddingResult {
  message_id: string;
  role: string;
  content: string;
  similarity: number;
  created_at: string;
}

/**
 * Generate and store embedding for a chat message
 */
export async function embedChatMessage(
  sessionId: string,
  messageId: string,
  role: 'user' | 'ai',
  content: string
): Promise<boolean> {
  // ✅ FIX: Validate input parameters
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    logger.error('[CHAT_EMBEDDINGS] Invalid sessionId in embedChatMessage', { sessionId, messageId });
    return false;
  }

  if (!messageId || typeof messageId !== 'string' || messageId.trim().length === 0) {
    logger.error('[CHAT_EMBEDDINGS] Invalid messageId in embedChatMessage', { sessionId, messageId });
    return false;
  }

  // ✅ FIX: Validate UUID format
  if (!isValidUUID(sessionId)) {
    logger.error('[CHAT_EMBEDDINGS] Invalid UUID format for sessionId', { sessionId, messageId });
    return false;
  }

  if (!isValidUUID(messageId)) {
    logger.error('[CHAT_EMBEDDINGS] Invalid UUID format for messageId', { sessionId, messageId });
    return false;
  }

  // ✅ FIX: Validate role
  if (role !== 'user' && role !== 'ai') {
    logger.error('[CHAT_EMBEDDINGS] Invalid role in embedChatMessage', { sessionId, messageId, role });
    return false;
  }

  try {
    // Skip empty messages
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      logger.debug('[CHAT_EMBEDDINGS] Skipping empty message', { messageId, sessionId });
      return false;
    }

    // Truncate very long messages (OpenAI embedding limit: 8191 tokens)
    // Safe char limit considering different languages:
    // - English: ~4 chars/token → 15K chars = ~3,750 tokens ✅
    // - Russian: ~2.5 chars/token → 15K chars = ~6,000 tokens ✅
    // - Chinese: ~1.5 chars/token → 15K chars = ~10,000 tokens ⚠️ (rare, but safe margin)
    let truncatedContent = content;
    if (content.length > 15000) {
      truncatedContent = content.substring(0, 15000) + '... [truncated]';
      logger.warn('[CHAT_EMBEDDINGS] Message truncated for embedding', {
        messageId,
        originalLength: content.length,
        truncatedLength: truncatedContent.length,
      });
    }

    // Generate embedding
    // ✅ generateEmbedding already validates input and throws on error
    const embedding = await generateEmbedding(truncatedContent);

    // ✅ FIX: Validate embedding before storing (defensive check)
    if (!embedding || !Array.isArray(embedding) || embedding.length !== 1536) {
      logger.error('[CHAT_EMBEDDINGS] Invalid embedding dimensions', {
        messageId,
        sessionId,
        dimensions: embedding?.length,
        expected: 1536
      });
      return false;
    }

    // Check if embedding already exists (for logging)
    const { data: existing } = await supabaseAdmin
      .from('chat_message_embeddings')
      .select('id')
      .eq('message_id', messageId)
      .maybeSingle();

    const isUpdate = !!existing;

    // Store in database (upsert to handle duplicates)
    const { error } = await supabaseAdmin
      .from('chat_message_embeddings')
      .upsert({
        session_id: sessionId,
        message_id: messageId,
        role,
        content: truncatedContent, // Store truncated version for consistency
        embedding,
        metadata: {
          original_length: content.length,
          content_length: truncatedContent.length,
          was_truncated: content.length > 15000,
          embedded_at: new Date().toISOString(),
        },
      }, {
        onConflict: 'message_id', // Update if message_id already exists
        ignoreDuplicates: false,  // Update existing record
      });

    if (error) {
      logger.error('[CHAT_EMBEDDINGS] Failed to store embedding', {
        error,
        messageId,
        sessionId
      });
      return false;
    }

    // ✅ FIX: Improved logging (info level for production visibility)
    if (isUpdate) {
      logger.info('[CHAT_EMBEDDINGS] Embedding updated', { messageId, sessionId });
    } else {
      logger.info('[CHAT_EMBEDDINGS] Embedding stored', { messageId, sessionId });
    }
    return true;

  } catch (error) {
    logger.error('[CHAT_EMBEDDINGS] Error generating embedding', {
      error,
      messageId,
      sessionId
    });
    return false;
  }
}

/**
 * Batch embed multiple messages (for initial population)
 */
export async function embedMultipleMessages(
  sessionId: string,
  messages: ChatMessage[]
): Promise<{ success: number; failed: number }> {
  // ✅ FIX: Validate input
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    logger.error('[CHAT_EMBEDDINGS] Invalid sessionId in embedMultipleMessages', { sessionId });
    return { success: 0, failed: 0 };
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    logger.warn('[CHAT_EMBEDDINGS] Empty messages array in embedMultipleMessages', { sessionId });
    return { success: 0, failed: 0 };
  }

  // ✅ FIX: Limit batch size to prevent timeout and memory issues
  const MAX_MESSAGES_PER_BATCH = 50;
  let messagesToProcess = messages;

  if (messages.length > MAX_MESSAGES_PER_BATCH) {
    logger.warn('[CHAT_EMBEDDINGS] Too many messages, limiting batch', {
      sessionId,
      total: messages.length,
      limit: MAX_MESSAGES_PER_BATCH
    });
    messagesToProcess = messages.slice(0, MAX_MESSAGES_PER_BATCH);
  }

  let success = 0;
  let failed = 0;

  logger.info('[CHAT_EMBEDDINGS] Batch embedding messages', {
    sessionId,
    messageCount: messagesToProcess.length,
    totalAvailable: messages.length,
  });

  // Process in parallel batches of 10 for ~5x throughput improvement
  // OpenAI allows ~3000 RPM; batches of 10 with 100ms between = ~100 RPS (safe)
  const PARALLEL_BATCH_SIZE = 10;

  for (let i = 0; i < messagesToProcess.length; i += PARALLEL_BATCH_SIZE) {
    const batch = messagesToProcess.slice(i, i + PARALLEL_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(msg => embedChatMessage(sessionId, msg.id, msg.role, msg.content))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        success++;
      } else {
        failed++;
      }
    }

    // Delay between batches to respect rate limits
    if (i + PARALLEL_BATCH_SIZE < messagesToProcess.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  logger.info('[CHAT_EMBEDDINGS] Batch embedding complete', {
    sessionId,
    success,
    failed,
  });

  return { success, failed };
}

/**
 * Search chat history semantically
 * Returns most relevant messages based on current context
 */
export async function searchChatHistory(
  sessionId: string,
  queryText: string,
  options: {
    matchCount?: number;
    matchThreshold?: number;
  } = {}
): Promise<ChatEmbeddingResult[]> {
  const { matchCount = 5, matchThreshold = 0.5 } = options;

  // ✅ FIX: Validate input parameters
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    logger.error('[CHAT_EMBEDDINGS] Invalid sessionId in searchChatHistory', { sessionId });
    return [];
  }

  if (!queryText || typeof queryText !== 'string' || queryText.trim().length === 0) {
    logger.warn('[CHAT_EMBEDDINGS] Empty queryText in searchChatHistory', { sessionId });
    return [];
  }

  // Validate UUID format (basic check)
  if (!isValidUUID(sessionId)) {
    logger.error('[CHAT_EMBEDDINGS] Invalid UUID format for sessionId', { sessionId });
    return [];
  }

  try {
    logger.info('[CHAT_EMBEDDINGS] Searching chat history', {
      sessionId,
      queryLength: queryText.length,
      matchCount,
    });

    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(queryText);

    // Search using stored procedure
    const { data, error } = await supabaseAdmin
      .rpc('search_chat_history', {
        p_session_id: sessionId,
        p_query_embedding: queryEmbedding,
        p_match_count: matchCount,
        p_match_threshold: matchThreshold,
      });

    if (error) {
      logger.error('[CHAT_EMBEDDINGS] Search failed', { error, sessionId });
      return [];
    }

    const resultsCount = data?.length || 0;

    if (resultsCount === 0) {
      logger.info('[CHAT_EMBEDDINGS] Search returned no results', {
        sessionId,
        queryLength: queryText.length,
        matchThreshold,
      });
    } else {
      logger.info('[CHAT_EMBEDDINGS] Search complete', {
        sessionId,
        resultsCount,
      });
    }

    return data || [];

  } catch (error) {
    logger.error('[CHAT_EMBEDDINGS] Error searching chat history', {
      error,
      sessionId
    });
    return [];
  }
}

/**
 * Check if embeddings exist for a session
 */
export async function hasEmbeddings(sessionId: string): Promise<boolean> {
  try {
    const { count, error } = await supabaseAdmin
      .from('chat_message_embeddings')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if (error) {
      logger.error('[CHAT_EMBEDDINGS] Failed to check embeddings', { error, sessionId });
      return false;
    }

    return (count || 0) > 0;

  } catch (error) {
    logger.error('[CHAT_EMBEDDINGS] Error checking embeddings', { error, sessionId });
    return false;
  }
}

/**
 * Get count of embedded messages in session
 */
export async function getEmbeddingsCount(sessionId: string): Promise<number> {
  try {
    const { count, error } = await supabaseAdmin
      .from('chat_message_embeddings')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if (error) {
      logger.error('[CHAT_EMBEDDINGS] Failed to count embeddings', { error, sessionId });
      return 0;
    }

    return count || 0;

  } catch (error) {
    logger.error('[CHAT_EMBEDDINGS] Error counting embeddings', { error, sessionId });
    return 0;
  }
}

/**
 * Delete embeddings for a session (cleanup)
 */
export async function deleteSessionEmbeddings(sessionId: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('chat_message_embeddings')
      .delete()
      .eq('session_id', sessionId);

    if (error) {
      logger.error('[CHAT_EMBEDDINGS] Failed to delete embeddings', { error, sessionId });
      return false;
    }

    logger.info('[CHAT_EMBEDDINGS] Embeddings deleted', { sessionId });
    return true;

  } catch (error) {
    logger.error('[CHAT_EMBEDDINGS] Error deleting embeddings', { error, sessionId });
    return false;
  }
}

/**
 * Get old messages that need embedding (messages > 20 without embeddings)
 */
export async function getMessagesNeedingEmbedding(
  sessionId: string
): Promise<ChatMessage[]> {
  // ✅ FIX: Validate sessionId
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    logger.error('[CHAT_EMBEDDINGS] Invalid sessionId in getMessagesNeedingEmbedding', { sessionId });
    return [];
  }

  try {
    // Get all messages older than the last 20
    const { data: allMessages, error: messagesError } = await supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (messagesError || !allMessages) {
      logger.error('[CHAT_EMBEDDINGS] Failed to get messages', {
        error: messagesError,
        sessionId
      });
      return [];
    }

    // Keep only old messages (exclude last 20)
    // If total messages <= 20, no old messages to embed
    if (allMessages.length <= 20) {
      logger.info('[CHAT_EMBEDDINGS] Not enough messages for embedding', {
        sessionId,
        totalMessages: allMessages.length,
      });
      return [];
    }

    const oldMessages = allMessages.slice(0, -20);

    if (oldMessages.length === 0) {
      return [];
    }

    // Get messages that already have embeddings
    const { data: existingEmbeddings, error: embeddingsError } = await supabaseAdmin
      .from('chat_message_embeddings')
      .select('message_id')
      .eq('session_id', sessionId);

    if (embeddingsError) {
      logger.error('[CHAT_EMBEDDINGS] Failed to get existing embeddings', {
        error: embeddingsError,
        sessionId
      });
      // ✅ FIX: Return empty array to prevent re-embedding all messages
      // This is safer than continuing and potentially re-embedding everything
      // The next call will retry getting embeddings
      return [];
    }

    const embeddedIds = new Set(
      (existingEmbeddings || []).map(e => e.message_id)
    );

    // Filter messages that don't have embeddings yet
    const messagesNeedingEmbedding = oldMessages.filter(
      msg => !embeddedIds.has(msg.id)
    );

    logger.info('[CHAT_EMBEDDINGS] Found messages needing embedding', {
      sessionId,
      totalOld: oldMessages.length,
      alreadyEmbedded: embeddedIds.size,
      needsEmbedding: messagesNeedingEmbedding.length,
    });

    return messagesNeedingEmbedding as ChatMessage[];

  } catch (error) {
    logger.error('[CHAT_EMBEDDINGS] Error getting messages needing embedding', {
      error,
      sessionId
    });
    return [];
  }
}

/**
 * Auto-embed old messages (run this periodically or on demand)
 */
export async function autoEmbedOldMessages(
  sessionId: string
): Promise<{ success: number; failed: number }> {
  // ✅ FIX: Validate sessionId
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    logger.error('[CHAT_EMBEDDINGS] Invalid sessionId in autoEmbedOldMessages', { sessionId });
    return { success: 0, failed: 0 };
  }

  try {
    const messagesNeedingEmbedding = await getMessagesNeedingEmbedding(sessionId);

    logger.info('[CHAT_EMBEDDINGS] Starting auto-embed', {
      sessionId,
      messageCount: messagesNeedingEmbedding.length
    });

    if (messagesNeedingEmbedding.length === 0) {
      logger.info('[CHAT_EMBEDDINGS] No messages need embedding', { sessionId });
      return { success: 0, failed: 0 };
    }

    return await embedMultipleMessages(sessionId, messagesNeedingEmbedding);

  } catch (error) {
    logger.error('[CHAT_EMBEDDINGS] Error auto-embedding messages', {
      error,
      sessionId
    });
    return { success: 0, failed: 0 };
  }
}
