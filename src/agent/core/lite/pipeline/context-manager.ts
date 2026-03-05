/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONTEXT MANAGER — Smart Token Window Management
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prevents context overflow in the Executor's messages[] array.
 * Only compresses when approaching the token limit.
 *
 * Strategy:
 * - Keep: system prompt + last 2 tool rounds fully intact
 * - Compress: older rounds into concise summaries
 * - Summaries use semantic labels ("filled email on login page")
 *   instead of raw refs ("e5")
 *
 * Better than current LiteEngine rolling compression because:
 * - Model had full context when making each decision
 * - Compression only happens at token boundary
 * - Blackboard still stores full history (agents read that for replanning)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import type { ChatCompletionMessageParam } from 'openai/resources';

/** Approximate max tokens before compression triggers */
const MAX_CONTEXT_TOKENS = 80000; // ~80k tokens (gpt-4.1 has 128k window)

/** How many recent tool rounds to keep fully intact */
const KEEP_RECENT_ROUNDS = 2;

/** Approximate tokens per character (conservative estimate for English + JSON) */
const CHARS_PER_TOKEN = 3.5;

export class ContextManager {
  /**
   * Estimate token count for a messages array.
   * Uses character-based heuristic (fast, no API call needed).
   */
  static estimateTokens(messages: ChatCompletionMessageParam[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      }
      // Count tool call arguments
      if ('tool_calls' in msg && Array.isArray((msg as any).tool_calls)) {
        for (const tc of (msg as any).tool_calls) {
          totalChars += (tc.function?.arguments || '').length;
          totalChars += (tc.function?.name || '').length;
        }
      }
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  /**
   * Compress messages if approaching token limit.
   * Mutates the messages array in place.
   *
   * Strategy:
   * 1. Always keep: system message (index 0) + first user message (index 1)
   * 2. Keep last N tool rounds fully intact
   * 3. Compress older rounds into a single summary message
   */
  static compressIfNeeded(messages: ChatCompletionMessageParam[]): void {
    const estimatedTokens = ContextManager.estimateTokens(messages);

    if (estimatedTokens < MAX_CONTEXT_TOKENS) {
      return; // No compression needed
    }

    logger.debug('[CONTEXT] Compressing messages', {
      estimatedTokens,
      messageCount: messages.length,
    });

    // Find tool round boundaries
    // A "round" starts with an assistant message with tool_calls
    const roundStartIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && 'tool_calls' in msg && (msg as any).tool_calls?.length > 0) {
        roundStartIndices.push(i);
      }
    }

    if (roundStartIndices.length <= KEEP_RECENT_ROUNDS) {
      return; // Not enough rounds to compress
    }

    // Keep system + user (first 2 messages) + last N rounds
    const keepFromIndex = roundStartIndices[roundStartIndices.length - KEEP_RECENT_ROUNDS];
    const oldMessages = messages.slice(2, keepFromIndex); // Between system+user and recent rounds

    if (oldMessages.length === 0) return;

    // Build summary of old rounds
    const summary = ContextManager.summarizeOldMessages(oldMessages);

    // Remove old messages and insert summary
    const newMessages: ChatCompletionMessageParam[] = [
      messages[0], // system
      messages[1], // initial user message
      { role: 'user', content: `[PREVIOUS ACTIONS SUMMARY]\n${summary}` },
      ...messages.slice(keepFromIndex), // recent rounds
    ];

    // Mutate in place (array replacement)
    messages.length = 0;
    messages.push(...newMessages);

    const newTokens = ContextManager.estimateTokens(messages);
    logger.debug('[CONTEXT] Compression complete', {
      before: estimatedTokens,
      after: newTokens,
      removedMessages: oldMessages.length,
    });
  }

  /**
   * Summarize old tool round messages into concise text.
   * Extracts: what commands were called, success/failure, key results.
   *
   * Uses tool_call_id mapping to correctly pair batched tool calls
   * with their corresponding tool results (fixes misalignment when
   * assistant sends multiple tool_calls in one message).
   */
  private static summarizeOldMessages(messages: ChatCompletionMessageParam[]): string {
    const actions: string[] = [];
    // Map tool_call_id → index in actions[] for correct result pairing
    const toolCallIdToIndex = new Map<string, number>();

    for (const msg of messages) {
      if (msg.role === 'assistant' && 'tool_calls' in msg) {
        const toolCalls = (msg as any).tool_calls || [];
        for (const tc of toolCalls) {
          const name = tc.function?.name || 'unknown';
          let argsSummary = '';

          try {
            const args = JSON.parse(tc.function?.arguments || '{}');
            // Build semantic summary instead of raw args
            if (name === 'fill_field') {
              argsSummary = args.is_sensitive
                ? `credential field ${args.ref}`
                : `field ${args.ref} with "${(args.value || '').slice(0, 20)}"`;
            } else if (name === 'click_element') {
              argsSummary = `element ${args.ref}`;
            } else if (name === 'navigate_to') {
              argsSummary = args.url?.slice(0, 50) || '';
            } else if (name === 'observe_page') {
              argsSummary = 'page snapshot taken';
            } else {
              argsSummary = JSON.stringify(args).slice(0, 40);
            }
          } catch {
            argsSummary = 'parse error';
          }

          const index = actions.length;
          actions.push(`${name}: ${argsSummary}`);
          // Track which index corresponds to this tool_call_id
          if (tc.id) {
            toolCallIdToIndex.set(tc.id, index);
          }
        }
      }

      if (msg.role === 'tool') {
        try {
          const result = JSON.parse(typeof msg.content === 'string' ? msg.content : '{}');
          const status = result.success ? '✓' : '✗';
          const detail = result.error || result.output?.slice(0, 50) || '';
          // Find the correct action by tool_call_id (handles batched tool calls correctly)
          const toolCallId = (msg as any).tool_call_id;
          const actionIndex = toolCallId ? toolCallIdToIndex.get(toolCallId) : undefined;
          if (actionIndex !== undefined) {
            actions[actionIndex] += ` ${status} ${detail}`;
          } else if (actions.length > 0) {
            // Fallback: append to last action if no ID match
            actions[actions.length - 1] += ` ${status} ${detail}`;
          }
        } catch {
          // Skip unparseable tool results
        }
      }
    }

    return actions.join('\n');
  }
}
