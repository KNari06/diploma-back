import { ChatContext } from '@/api/chat/chat.types';

/**
 * Build chat prompt from user message and optional context
 * @param params - Chat context with message and optional context
 * @returns Formatted prompt string
 */
export function buildChatPrompt({ message, context }: ChatContext): string {
  let prompt = message;

  // Add context if provided (for RAG integration)
  if (context) {
    // Handle both string and object context
    const contextStr = typeof context === 'string' ? context : JSON.stringify(context);
    prompt = `${contextStr}\n\nВопрос: ${message}`;
  }

  return prompt;
}
