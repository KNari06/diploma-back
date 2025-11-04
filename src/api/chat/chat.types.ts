import { IntentResult } from '@/types';

export interface ChatRequest {
  message: string;
  context?: string | { projectId?: string; [key: string]: any }; // For RAG integration with projectId
  sessionId?: string; // Existing chat session ID
  conversationId?: string; // For multi-turn conversations (questions/answers)
  answers?: Record<string, any>; // Answers to clarifying questions
  userId?: string; // Optional userId for testing/dev (when no auth token)
}

export interface ChatResponse {
  reply: string;
  timestamp?: string;
  parsedIntent?: IntentResult | null;
  needsMoreInfo?: boolean; // Autonomous mode: needs clarification
  questions?: any[]; // Clarifying questions
  conversationId?: string; // For tracking multi-turn conversations
  testPlan?: any; // Test plan awaiting confirmation
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  userId?: string;
  message: string;
  context?: string | { projectId?: string; [key: string]: any };
}
