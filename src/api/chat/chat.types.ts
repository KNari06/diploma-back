import { IntentResult } from '@/types';

export interface ChatRequest {
  userId?: string;
  message: string;
  context?: string; // For future RAG integration
  sessionId?: string; // Existing chat session ID
}

export interface ChatResponse {
  reply: string;
  timestamp?: string;
  parsedIntent?: IntentResult | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  userId?: string;
  message: string;
  context?: string;
}
