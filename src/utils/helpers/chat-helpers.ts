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
