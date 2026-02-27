/**
 * Chat Utilities
 * Helper functions for chat message handling
 */

import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Message role types used in our database
 */
export type DatabaseRole = 'user' | 'ai' | 'system';

/**
 * Message role types accepted by OpenAI API
 */
export type OpenAIRole = 'user' | 'assistant' | 'system' | 'function' | 'tool' | 'developer';

/**
 * Convert database role to OpenAI-compatible role
 * IMPORTANT: Database uses 'ai', but OpenAI requires 'assistant'
 *
 * @param role - Role from database ('user' | 'ai' | 'system')
 * @returns OpenAI-compatible role ('user' | 'assistant' | 'system')
 */
export function convertRoleForOpenAI(role: string): OpenAIRole {
  if (role === 'ai') {
    return 'assistant';
  }

  // Valid OpenAI roles: 'user', 'assistant', 'system', 'function', 'tool', 'developer'
  const validRoles: OpenAIRole[] = ['user', 'assistant', 'system', 'function', 'tool', 'developer'];

  if (validRoles.includes(role as OpenAIRole)) {
    return role as OpenAIRole;
  }

  // Fallback to 'user' if role is unknown
  return 'user';
}

/**
 * Convert array of messages from database format to OpenAI format
 *
 * @param messages - Messages with database roles
 * @returns Messages with OpenAI-compatible roles
 */
export function convertMessagesForOpenAI(
  messages: Array<{ role: string; content: string; [key: string]: any }>
): ChatCompletionMessageParam[] {
  return messages.map(msg => ({
    role: convertRoleForOpenAI(msg.role),
    content: msg.content,
  })) as ChatCompletionMessageParam[];
}

// ── Temporal Markers ──────────────────────────────────────────────────────
// Inject time-awareness into conversation history so the AI understands
// when messages were sent and detects significant time gaps.

interface TimestampedMessage {
  role: 'user' | 'assistant';
  content: string;
  created_at: string; // ISO 8601
}

/**
 * Format a date as a compact, human-readable timestamp.
 * Output: "25 фев, 14:30" or "3 Jan, 09:15" (uses short month names).
 */
function formatDateCompact(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day} ${month}, ${hours}:${minutes}`;
}

/**
 * Format a time gap as a compact human-readable string.
 * Examples: "25m", "3h", "2d", "1w"
 */
export function formatRelativeGap(gapMs: number): string {
  const minutes = Math.round(gapMs / (60 * 1000));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(gapMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;

  const days = Math.round(gapMs / (24 * 60 * 60 * 1000));
  if (days < 7) return `${days}d`;

  const weeks = Math.round(days / 7);
  return `${weeks}w`;
}

/**
 * Inject temporal markers into conversation history.
 *
 * - First message always gets a date prefix: "[25 Feb, 14:30] content"
 * - When gap between consecutive messages exceeds threshold:
 *   1. Insert a system separator: "── 2d later ──"
 *   2. Add date prefix to the message after the gap
 * - Messages within the threshold are left unchanged (zero token overhead)
 *
 * @param messages - Messages with timestamps from DB
 * @param thresholdMs - Gap threshold in milliseconds (default: 4 hours)
 * @returns OpenAI-compatible messages array with temporal markers injected
 */
export function injectTemporalMarkers(
  messages: TimestampedMessage[],
  thresholdMs: number = 4 * 60 * 60 * 1000,
): ChatCompletionMessageParam[] {
  if (messages.length === 0) return [];

  const result: ChatCompletionMessageParam[] = [];
  let prevTime: Date | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTime = new Date(msg.created_at);

    if (i === 0) {
      // First message — always add date prefix
      result.push({
        role: msg.role,
        content: `[${formatDateCompact(msgTime)}] ${msg.content}`,
      });
    } else if (prevTime && (msgTime.getTime() - prevTime.getTime()) > thresholdMs) {
      // Significant gap — insert separator + date prefix
      const gap = msgTime.getTime() - prevTime.getTime();
      result.push({
        role: 'system' as const,
        content: `── ${formatRelativeGap(gap)} later ──`,
      });
      result.push({
        role: msg.role,
        content: `[${formatDateCompact(msgTime)}] ${msg.content}`,
      });
    } else {
      // Within threshold — pass through unchanged
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }

    prevTime = msgTime;
  }

  return result;
}

/**
 * Convert OpenAI role back to database format
 *
 * @param role - OpenAI role
 * @returns Database role
 */
export function convertRoleForDatabase(role: OpenAIRole): DatabaseRole {
  if (role === 'assistant') {
    return 'ai';
  }

  if (role === 'user' || role === 'system') {
    return role;
  }

  // For function/tool/developer roles, default to system
  return 'system';
}
