import { supabaseAdmin } from '@/db/supabase';
import { generateEmbedding } from '@/services/ai/core/embedding.service';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WORKSPACE MEMORY SERVICE (Persistent Agent Memory)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Provides persistent semantic memory for workspace agents.
 * Inspired by OpenClaw's memory architecture.
 *
 * Features:
 * - CRUD operations on workspace memories
 * - Semantic search via vector embeddings
 * - Memory categories for filtering
 * - Usage tracking for LRU eviction
 * - Context formatting for system prompts
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type MemoryCategory = 'fact' | 'preference' | 'test_pattern' | 'bug_pattern' | 'integration_context';
export type MemorySource = 'agent_written' | 'auto_extracted' | 'user_provided';

export interface WorkspaceMemory {
  id: string;
  workspace_id: string;
  user_id: string;
  category: MemoryCategory;
  key: string;
  content: string;
  embedding?: number[];
  source: MemorySource;
  confidence: number;
  access_count: number;
  last_accessed_at: string;
  injection_count: number;
  last_injected_at?: string;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}

export interface MemorySearchResult extends WorkspaceMemory {
  similarity: number;
}

export class WorkspaceMemoryService {
  /**
   * Write a memory to workspace (upsert by key)
   * Generates embedding automatically
   */
  static async writeMemory(
    workspaceId: string,
    userId: string,
    key: string,
    content: string,
    category: MemoryCategory,
    source: MemorySource = 'agent_written',
    metadata: Record<string, any> = {},
    confidence: number = 1.0,
    expiresAt?: Date
  ): Promise<WorkspaceMemory> {
    try {
      // Validate inputs
      if (!workspaceId || !userId || !key || !content || !category) {
        throw new Error('Missing required fields: workspaceId, userId, key, content, category');
      }

      if (confidence < 0 || confidence > 1) {
        throw new Error('Confidence must be between 0.0 and 1.0');
      }

      logger.info('[WORKSPACE_MEMORY] Writing memory', {
        workspaceId,
        userId,
        key,
        category,
        source,
        contentLength: content.length,
      });

      // Generate embedding
      const embedding = await generateEmbedding(content);

      // Upsert memory (by workspace_id + key)
      const { data, error } = await supabaseAdmin
        .from('workspace_memory')
        .upsert({
          workspace_id: workspaceId,
          user_id: userId,
          key,
          content,
          embedding,
          category,
          source,
          confidence,
          metadata,
          expires_at: expiresAt?.toISOString(),
          // NOTE: do not reset access_count / injection_count on write — usage
          // history must survive a content edit (re-upsert by key). New rows get
          // the column DEFAULT 0; existing rows keep their accumulated counts.
        }, {
          onConflict: 'workspace_id,key', // Unique constraint
        })
        .select()
        .single();

      if (error) {
        logger.error('[WORKSPACE_MEMORY] Failed to write memory', {
          error: error.message,
          workspaceId,
          key,
        });
        throw error;
      }

      logger.info('[WORKSPACE_MEMORY] Memory written successfully', {
        memoryId: data.id,
        workspaceId,
        key,
      });

      return data as WorkspaceMemory;
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] Write memory error', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        key,
      });
      throw error;
    }
  }

  /**
   * Read a memory by key
   */
  static async readMemory(
    workspaceId: string,
    key: string
  ): Promise<WorkspaceMemory | null> {
    try {
      logger.debug('[WORKSPACE_MEMORY] Reading memory', { workspaceId, key });

      const { data, error } = await supabaseAdmin
        .from('workspace_memory')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('key', key)
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE_MEMORY] Failed to read memory', {
          error: error.message,
          workspaceId,
          key,
        });
        throw error;
      }

      if (!data) {
        return null;
      }

      // Update access tracking (fire and forget)
      this.updateAccessTracking(data.id).catch(err => {
        logger.warn('[WORKSPACE_MEMORY] Failed to update access tracking', {
          memoryId: data.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return data as WorkspaceMemory;
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] Read memory error', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        key,
      });
      throw error;
    }
  }

  /**
   * Delete a memory by key
   */
  static async deleteMemory(
    workspaceId: string,
    key: string
  ): Promise<boolean> {
    try {
      logger.info('[WORKSPACE_MEMORY] Deleting memory', { workspaceId, key });

      const { error } = await supabaseAdmin
        .from('workspace_memory')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('key', key);

      if (error) {
        logger.error('[WORKSPACE_MEMORY] Failed to delete memory', {
          error: error.message,
          workspaceId,
          key,
        });
        throw error;
      }

      logger.info('[WORKSPACE_MEMORY] Memory deleted successfully', {
        workspaceId,
        key,
      });

      return true;
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] Delete memory error', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        key,
      });
      throw error;
    }
  }

  /**
   * List memories for a workspace
   */
  static async listMemories(
    workspaceId: string,
    category?: MemoryCategory,
    limit: number = 50
  ): Promise<WorkspaceMemory[]> {
    try {
      logger.debug('[WORKSPACE_MEMORY] Listing memories', {
        workspaceId,
        category,
        limit,
      });

      let query = supabaseAdmin
        .from('workspace_memory')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(limit);

      // Filter by category if provided
      if (category) {
        query = query.eq('category', category);
      }

      const { data, error } = await query;

      if (error) {
        logger.error('[WORKSPACE_MEMORY] Failed to list memories', {
          error: error.message,
          workspaceId,
        });
        throw error;
      }

      return (data || []) as WorkspaceMemory[];
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] List memories error', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      throw error;
    }
  }

  /**
   * Semantic search for memories using vector similarity
   */
  static async searchMemory(
    workspaceId: string,
    query: string,
    category?: MemoryCategory,
    matchCount: number = 5,
    threshold: number = 0.5
  ): Promise<MemorySearchResult[]> {
    try {
      logger.info('[WORKSPACE_MEMORY] Searching memories', {
        workspaceId,
        queryLength: query.length,
        category,
        matchCount,
        threshold,
      });

      // Generate embedding for query
      const queryEmbedding = await generateEmbedding(query);

      // Call RPC function for vector search
      const { data, error } = await supabaseAdmin.rpc('search_workspace_memory', {
        p_workspace_id: workspaceId,
        p_query_embedding: queryEmbedding,
        p_match_count: matchCount,
        p_match_threshold: threshold,
        p_category: category || null,
      });

      if (error) {
        logger.error('[WORKSPACE_MEMORY] Failed to search memories', {
          error: error.message,
          workspaceId,
        });
        throw error;
      }

      const results = (data || []) as MemorySearchResult[];

      logger.info('[WORKSPACE_MEMORY] Search completed', {
        workspaceId,
        resultsCount: results.length,
        avgSimilarity: results.length > 0
          ? (results.reduce((sum, r) => sum + r.similarity, 0) / results.length).toFixed(2)
          : 0,
      });

      // Update access tracking for found memories (fire and forget)
      results.forEach(result => {
        this.updateAccessTracking(result.id).catch(err => {
          logger.warn('[WORKSPACE_MEMORY] Failed to update access tracking', {
            memoryId: result.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });

      return results;
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] Search memory error', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      throw error;
    }
  }

  /**
   * Get formatted memory context for system prompt injection
   * Combines most accessed + most recent memories
   */
  static async getMemoryForContext(
    workspaceId: string,
    maxChars: number = 2000
  ): Promise<string> {
    try {
      logger.debug('[WORKSPACE_MEMORY] Getting memory for context', {
        workspaceId,
        maxChars,
      });

      // Get top memories by access count
      const { data: topAccessed, error: accessError } = await supabaseAdmin
        .from('workspace_memory')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('access_count', { ascending: false })
        .limit(5);

      if (accessError) {
        logger.error('[WORKSPACE_MEMORY] Failed to get top accessed memories', {
          error: accessError.message,
        });
        return '';
      }

      // Get most recent memories
      const { data: recent, error: recentError } = await supabaseAdmin
        .from('workspace_memory')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (recentError) {
        logger.error('[WORKSPACE_MEMORY] Failed to get recent memories', {
          error: recentError.message,
        });
        return '';
      }

      // Combine, deduplicate, filter out disabled memories and bug_pattern (moved to Patterns)
      const allMemories = [...(topAccessed || []), ...(recent || [])];
      const uniqueMemories = (Array.from(
        new Map(allMemories.map(m => [m.id, m])).values()
      ) as WorkspaceMemory[]).filter(m => m.metadata?.enabled !== false && m.category !== 'bug_pattern');

      // Sort by relevance (access_count + recency bonus)
      // Recency: newer memories get a higher score (created_at timestamp as bonus)
      uniqueMemories.sort((a, b) => {
        const scoreA = a.access_count + new Date(a.created_at).getTime() / 1000000000;
        const scoreB = b.access_count + new Date(b.created_at).getTime() / 1000000000;
        return scoreB - scoreA;
      });

      // Format memories for context
      const formatted: string[] = [];
      const injectedIds: string[] = [];
      let totalChars = 0;

      for (const memory of uniqueMemories) {
        const entry = `[${memory.category}] ${memory.key}: ${memory.content}`;
        const entryLength = entry.length + 2; // +2 for newlines

        if (totalChars + entryLength > maxChars) {
          break;
        }

        formatted.push(entry);
        injectedIds.push(memory.id);
        totalChars += entryLength;
      }

      const context = formatted.join('\n');

      // Track that these memories were actually injected into the agent context.
      // This is the PRIMARY "used" signal (most runs feed skills this way, not via
      // the explicit search tool). Fire-and-forget — never block context assembly.
      if (injectedIds.length > 0) {
        this.updateInjectionTracking(injectedIds).catch(err => {
          // error (not warn): if the RPC is missing or failing, usage counters
          // stop tracking — that should be observable, not silently swallowed.
          logger.error('[WORKSPACE_MEMORY] Injection tracking failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
            memoryCount: injectedIds.length,
          });
        });
      }

      logger.info('[WORKSPACE_MEMORY] Memory context generated', {
        workspaceId,
        memoriesIncluded: formatted.length,
        contextLength: context.length,
      });

      return context;
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] Get memory for context error', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return ''; // Return empty string on error (non-fatal)
    }
  }

  /**
   * Read a memory by its UUID
   */
  static async readMemoryById(id: string): Promise<WorkspaceMemory | null> {
    try {
      logger.debug('[WORKSPACE_MEMORY] Reading memory by id', { id });

      const { data, error } = await supabaseAdmin
        .from('workspace_memory')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE_MEMORY] Failed to read memory by id', {
          error: error.message,
          id,
        });
        throw error;
      }

      return data as WorkspaceMemory | null;
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] Read memory by id error', {
        error: error instanceof Error ? error.message : String(error),
        id,
      });
      throw error;
    }
  }

  /**
   * Update a memory by its UUID (partial update)
   * Regenerates embedding if content changes
   */
  static async updateMemoryById(
    id: string,
    updates: Partial<{
      key: string;
      content: string;
      category: MemoryCategory;
      metadata: Record<string, any>;
      confidence: number;
    }>
  ): Promise<WorkspaceMemory> {
    try {
      logger.info('[WORKSPACE_MEMORY] Updating memory by id', {
        id,
        fields: Object.keys(updates),
      });

      const updatePayload: Record<string, any> = {
        ...updates,
        updated_at: new Date().toISOString(),
      };

      // Regenerate embedding if content changed
      if (updates.content) {
        updatePayload.embedding = await generateEmbedding(updates.content);
      }

      const { data, error } = await supabaseAdmin
        .from('workspace_memory')
        .update(updatePayload)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        logger.error('[WORKSPACE_MEMORY] Failed to update memory by id', {
          error: error.message,
          id,
        });
        throw error;
      }

      logger.info('[WORKSPACE_MEMORY] Memory updated successfully', { id });

      return data as WorkspaceMemory;
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] Update memory by id error', {
        error: error instanceof Error ? error.message : String(error),
        id,
      });
      throw error;
    }
  }

  /**
   * Delete a memory by its UUID
   */
  static async deleteMemoryById(id: string): Promise<boolean> {
    try {
      logger.info('[WORKSPACE_MEMORY] Deleting memory by id', { id });

      const { error } = await supabaseAdmin
        .from('workspace_memory')
        .delete()
        .eq('id', id);

      if (error) {
        logger.error('[WORKSPACE_MEMORY] Failed to delete memory by id', {
          error: error.message,
          id,
        });
        throw error;
      }

      logger.info('[WORKSPACE_MEMORY] Memory deleted by id successfully', { id });

      return true;
    } catch (error) {
      logger.error('[WORKSPACE_MEMORY] Delete memory by id error', {
        error: error instanceof Error ? error.message : String(error),
        id,
      });
      throw error;
    }
  }

  /**
   * Update access tracking for a memory (internal)
   */
  private static async updateAccessTracking(memoryId: string): Promise<void> {
    // Use RPC for atomic increment to avoid read-then-write race condition
    const { error: rpcError } = await supabaseAdmin.rpc('increment_memory_access_count', {
      p_memory_id: memoryId,
    });

    if (rpcError) {
      // Fallback: non-atomic read-then-write (acceptable for access tracking)
      const { data } = await supabaseAdmin
        .from('workspace_memory')
        .select('access_count')
        .eq('id', memoryId)
        .single();

      await supabaseAdmin
        .from('workspace_memory')
        .update({
          access_count: (data?.access_count || 0) + 1,
          last_accessed_at: new Date().toISOString(),
        })
        .eq('id', memoryId);
    }
  }

  /**
   * Increment injection tracking for the memories that were injected into the
   * agent context (batch). Atomic RPC with a non-atomic fallback. Internal.
   */
  private static async updateInjectionTracking(memoryIds: string[]): Promise<void> {
    if (!memoryIds.length) return;

    const { error: rpcError } = await supabaseAdmin.rpc('increment_memory_injection_count', {
      p_memory_ids: memoryIds,
    });

    if (rpcError) {
      // Fallback only if the atomic RPC is unavailable. Best-effort: a per-id
      // read-then-write can lose increments under heavy concurrency, but usage
      // counts are non-critical and the RPC is the normal path (this branch is a
      // safety net, e.g. before the migration is applied). The .catch in the
      // caller logs at error level so a persistent RPC outage is visible.
      const now = new Date().toISOString();
      await Promise.all(
        memoryIds.map(async (memoryId) => {
          const { data } = await supabaseAdmin
            .from('workspace_memory')
            .select('injection_count')
            .eq('id', memoryId)
            .single();

          await supabaseAdmin
            .from('workspace_memory')
            .update({
              injection_count: (data?.injection_count || 0) + 1,
              last_injected_at: now,
            })
            .eq('id', memoryId);
        })
      );
    }
  }
}
