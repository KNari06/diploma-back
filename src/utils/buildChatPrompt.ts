import { ChatContext } from '@/api/chat/chat.types';

/**
 * Build chat prompt from user message and optional context
 * @param params - Chat context with message and optional context
 * @returns Formatted prompt string
 */
export function buildChatPrompt({ message, context }: ChatContext): string {
  let prompt = message;

  // Add context if provided (for future RAG integration)
  if (context) {
    prompt = `${context}\n\nВопрос: ${message}`;
  }

  return prompt;
}
